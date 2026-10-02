// The AppifactRepl tool's built-in SDK. Runs the code on stdin once, as one async function;
// claude.use("db"), claude.use("files") and claude.use("assets") calls and what claude.see() shows go to the tool over the descriptor in CLAUDE_CODE_ARTIFACT_FD.
// One function, so run inline (node -e) none of its names are globals the code could touch.
;(() => {
'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const vm = require('node:vm')
const util = require('node:util')
const { createRequire } = require('node:module')

const OUTPUT_CAP = 30000
const LINE_MAX = 1 << 20
const SEES_MAX = 4
// A see line's text as sent: even fully escaped it stays under LINE_MAX, so a call's see line is never the one that cannot go.
const TEXT_SENT_MAX = 100000
const IMAGES_MAX = 4
const IMAGE_MAX_BYTES = 750000
const CODE_FILE = 'code.js'
const CODE_LINE = /code\.js:(\d+)/

const artifactUrl = process.env.APPIFACT_ARTIFACT_URL
const counts = { reads: 0, writes: 0 }
const printed = []
let code = ''
let failed = false
let flushed = false

// ---- the pipe: one JSON line per request; an ack line, then one result line, matched by id (the lines of claude.see() get no ack)
const pending = new Map()
let pipe
let closed = false
let partial = ''
let nextId = 0

function connect() {
  const fd = Number(process.env.CLAUDE_CODE_ARTIFACT_FD)
  if (!Number.isInteger(fd) || fd < 3) {
    throw new Error('this script runs only as the AppifactRepl tool\'s child (no pipe was given)')
  }
  pipe = new net.Socket({ fd, readable: true, writable: true })
  pipe.setEncoding('utf8')
  pipe.on('data', chunk => {
    partial += chunk
    let at
    while ((at = partial.indexOf('\n')) !== -1) {
      const line = partial.slice(0, at)
      partial = partial.slice(at + 1)
      if (line.trim() !== '') onLine(line)
    }
  })
  const gone = () => {
    closed = true
    for (const call of [...pending.values()]) refuse(call, 'the tool closed the pipe before answering')
  }
  pipe.on('error', gone)
  pipe.on('close', gone)
  pipe.unref()
}

// The pipe holds the process open only while a call is out, so code stuck on something
// else is caught by the never-finished check instead of sitting until the tool's limit.
function settle(call) {
  pending.delete(call.id)
  if (pending.size === 0 && !closed) pipe.unref()
}

function onLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg === null || typeof msg !== 'object' || msg.type !== 'artifact_result') return
  const call = pending.get(msg.id)
  if (call === undefined) return
  if (msg.ok) {
    settle(call)
    call.resolve(msg.result)
  } else {
    refuse(call, refusalText(call, msg.error || {}))
  }
}

// The error carries the stack of the line that made the call, so the excerpt finds it.
function refuse(call, why) {
  settle(call)
  const err = new Error(call.label + ': ' + why)
  err.why = why
  err.code = call.refusedAs
  err.stack = 'Error: ' + err.message + '\n' + call.site
  call.reject(err)
}

const request = (verb, args, label, keys) => send(id => ({ type: 'artifact_call', id, verb, args }), label, keys)

function send(frame, label, keys) {
  if (pipe === undefined) connect()
  const id = 'c' + ++nextId
  const line = JSON.stringify(frame(id))
  if (line.length >= LINE_MAX) {
    throw new Error(label + ': the call is ' + line.length + ' characters, over the ' + LINE_MAX + ' one call may carry; write less per call')
  }
  const call = { id, label, keys, site: String(new Error().stack).split('\n').slice(1).join('\n') }
  call.done = new Promise((resolve, reject) => Object.assign(call, { resolve, reject }))
  pending.set(id, call)
  if (closed) {
    refuse(call, 'the tool has closed the pipe')
  } else {
    pipe.ref()
    pipe.write(line + '\n')
  }
  return call.done
}

// A version refusal becomes one instruction; for a batch the tool's own words say which entry.
function refusalText(call, error) {
  call.refusedAs = error.code
  if (/version_(required|mismatch)$/.test(String(error.reason))) {
    const path = call.keys.length === 1 ? call.keys[0] : undefined
    return 'nothing was written: ' + (path || 'one of its documents') + ' already exists and this run has not read it, or it changed after this run read it. Read it with db.doc(' + (path ? JSON.stringify(path) : 'path') + ').get(), apply the change to what that returns, and write again.' + (path ? '' : ' The tool said: ' + error.message)
  }
  return (error.code || 'error') + ': ' + (error.message || 'the call failed')
}

// ---- the db handle: claude.use("db")
const versions = new Map()

function remember(path, version) {
  if (Number.isInteger(version) && version > 0) versions.set(path, version)
  else versions.delete(path)
}

// "<collection>/<id>": the id is the last segment, the collection everything before it.
function split(path) {
  const at = typeof path === 'string' ? path.lastIndexOf('/') : -1
  if (at <= 0 || at === path.length - 1) {
    throw new TypeError('a document path is "<collection>/<id>", got ' + JSON.stringify(path))
  }
  return { collection: path.slice(0, at), doc_id: path.slice(at + 1) }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

function snapshot(collection, doc) {
  remember(collection + '/' + doc.id, doc.version)
  const data = deepFreeze(doc.data)
  return Object.freeze({ id: doc.id, exists: true, data: () => data })
}

function dbHandle() {
  const url = artifactUrl
  if (!url) {
    throw new Error('no Artifact is bound to this run: name it in the tool call\'s "artifact" input')
  }
  const call = (verb, args, label, keys) => request(verb, { url, ...args }, label, keys)

  function pinned(entry) {
    const version = versions.get(entry.collection + '/' + entry.doc_id)
    return version === undefined ? entry : { ...entry, if_version: version }
  }

  async function write(op, path, data) {
    const args = pinned(op === 'delete' ? split(path) : { ...split(path), data })
    const result = await call(op, args, 'db.doc("' + path + '").' + op + '()', [path])
    counts.writes++
    remember(path, op === 'delete' ? undefined : result && result.db_write && result.db_write.version)
  }

  function doc(path) {
    const at = split(path)
    return {
      async get() {
        const result = await call('get', at, 'db.doc("' + path + '").get()', [path])
        counts.reads++
        const found = result && result.db_read && result.db_read.docs && result.db_read.docs[0]
        if (found) return snapshot(at.collection, found)
        versions.delete(path)
        return Object.freeze({ id: at.doc_id, exists: false, data: () => undefined })
      },
      set: data => write('set', path, data),
      update: data => write('update', path, data),
      delete: () => write('delete', path),
    }
  }

  function collection(name) {
    return {
      doc: id => doc(name + '/' + id),
      async get() {
        const docs = []
        let cursor
        let limit = 50
        for (;;) {
          const query = cursor === undefined ? { limit } : { limit, cursor }
          let result
          try {
            result = await call('list', { collection: name, query }, 'db.collection("' + name + '").get()', [])
          } catch (err) {
            // A page too large for one reply line is asked for again, smaller.
            if (err.code !== 'too_large' || limit === 1) throw err
            limit = Math.max(1, limit >> 2)
            continue
          }
          counts.reads++
          const page = (result && result.db_read) || {}
          for (const d of page.docs || []) docs.push(snapshot(name, d))
          cursor = page.next_cursor || undefined
          if (cursor === undefined) break
        }
        return Object.freeze({ docs: Object.freeze(docs) })
      },
    }
  }

  async function batch(writes) {
    if (!Array.isArray(writes)) throw new TypeError('db.batch([...]) takes an array of writes: {op, path, data}')
    const entries = writes.map(w => {
      const entry = { op: w.op, ...split(w.path) }
      return pinned(w.op === 'delete' ? entry : { ...entry, data: w.data })
    })
    const keys = entries.map(e => e.collection + '/' + e.doc_id)
    const result = await call('batch', { writes: entries }, 'db.batch([' + entries.length + ' writes])', keys)
    const results = (result && result.db_write && result.db_write.results) || []
    counts.writes += entries.length
    entries.forEach((e, i) => remember(keys[i], e.op === 'delete' ? undefined : results[i] && results[i].version))
  }

  return Object.freeze({ doc, collection, batch })
}

// ---- the files handle: claude.use("files")
let publishDir

// The one folder a publish may read from: made under the working directory on first use,
// kept out of git by its own ignore file, removed when the run exits.
function ownDir() {
  if (publishDir !== undefined) return publishDir
  publishDir = fs.mkdtempSync(path.join(process.cwd(), '.appifact-publish-'))
  process.on('exit', () => {
    try {
      fs.rmSync(publishDir, { recursive: true, force: true })
    } catch {}
  })
  fs.writeFileSync(path.join(publishDir, '.gitignore'), '*\n')
  return publishDir
}

function filesHandle() {
  const url = artifactUrl
  if (!url) {
    throw new Error('no Artifact is bound to this run: name it in the tool call\'s "artifact" input')
  }
  const call = (verb, args, label) => request(verb, { url, ...args }, label, [])

  // The saved copy must still be the file the tool read: its bytes are checked against the digest in the same answer.
  function savedText(fileRead, label) {
    // A live file answers with its working copy, which the digest (of what was fetched) does not describe.
    if (fileRead.working_copy) throw new Error(label + ': this is a live file, answered with its working copy, which cannot be checked against what the tool read; read it with the Artifact tool instead')
    const bytes = fs.readFileSync(fileRead.saved_to)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== fileRead.sha256) {
      throw new Error(label + ': the saved copy is not the file that was read (it changed on disk after it was saved), so it is not safe to use; run the program again')
    }
    return bytes.toString('utf8')
  }

  // The text of one published file, from the copy the tool saved: that copy holds the exact bytes.
  async function read(file) {
    const result = await call('read_file', { path: file }, 'files.read(' + JSON.stringify(file) + ')')
    counts.reads++
    // Saved as served, the page may hold the service's own runtime block: not a copy to edit and publish back.
    if (result.file_read.as_served) throw new Error('files.read(' + JSON.stringify(file) + '): the saved copy could not be checked against the listing, so it is not safe to edit and publish back; run again once, and if it says the same, tell the user and stop')
    return savedText(result.file_read, 'files.read(' + JSON.stringify(file) + ')')
  }

  // Several files in few calls (32 a call), their texts in the order asked; each file is still its own permission decision.
  async function readMany(paths) {
    if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('files.readMany([paths]) takes the published paths to read, at least one')
    const texts = []
    for (let from = 0; from < paths.length; from += 32) {
      const some = paths.slice(from, from + 32)
      const result = await call('read_files', { paths: some }, 'files.readMany([' + paths.length + ' paths])')
      counts.reads += some.length
      for (const [at, read] of result.files_read.entries()) {
        if (read.as_served) throw new Error('files.readMany: the saved copy of ' + JSON.stringify(some[at]) + ' could not be checked against the listing, so it is not safe to edit and publish back; run again once, and if it says the same, tell the user and stop')
        texts.push(savedText(read, 'files.readMany: ' + JSON.stringify(some[at])))
      }
    }
    return texts
  }

  async function list() {
    const result = await call('list_files', {}, 'files.list()')
    counts.reads++
    return (result && result.file_list && result.file_list.files) || []
  }

  // file_path and the sources in files are paths inside dir(); a null in files removes that published path.
  async function publish(spec) {
    if (spec === null || typeof spec !== 'object' || typeof spec.file_path !== 'string') {
      throw new TypeError('files.publish({file_path, files}): file_path is required: the path, inside files.dir(), of one file you changed; the others go in files')
    }
    const dir = ownDir()
    const result = await call('publish', { root: dir, file_path: path.resolve(dir, spec.file_path), files: spec.files }, 'files.publish()')
    counts.writes += 1 + Object.keys(spec.files || {}).length
    return result
  }

  return Object.freeze({ read, readMany, list, dir: ownDir, publish })
}

// ---- the assets handle: claude.use("assets")
function assetsHandle() {
  const artifact = artifactUrl
  if (!artifact) {
    throw new Error('no Artifact is bound to this run: name it in the tool call\'s "artifact" input')
  }
  const call = (verb, args, label) => request(verb, { url: artifact, ...args }, label, [])

  // One file inside files.dir() goes to the artifact's asset store; the answer's url is what a slide or board names.
  async function upload(file) {
    if (typeof file !== 'string' || file === '') throw new TypeError('assets.upload(path) takes the path, inside files.dir(), of the one file to upload')
    const result = await call('upload_asset', { file_path: path.resolve(ownDir(), file) }, 'assets.upload(' + JSON.stringify(file) + ')')
    counts.writes++
    const { id, url, content_type, size_bytes } = result.asset_upload
    return { id, url, content_type, size_bytes }
  }

  // One asset, copied into files.dir() from the copy the tool saved, once those bytes match the digest the tool gave.
  async function download(id) {
    const label = 'assets.download(' + JSON.stringify(id) + ')'
    const { asset_read: read } = await call('read_asset', { asset_id: id }, label)
    counts.reads++
    const bytes = fs.readFileSync(read.path)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== read.sha256) {
      throw new Error(label + ': the saved copy is not the file that was read (it changed on disk after it was saved), so it is not safe to use; run the program again')
    }
    const to = path.join(ownDir(), path.basename(read.path))
    // A fresh file: whatever sits at that name, a link included, is removed and never written through.
    fs.rmSync(to, { force: true })
    fs.writeFileSync(to, bytes, { flag: 'wx' })
    return { id: read.id, path: to, content_type: read.content_type, size_bytes: read.size_bytes, sha256: read.sha256 }
  }

  return Object.freeze({ upload, download })
}

// ---- claude.see({text, images}): one `see` line with the text, then one `image` line per picture; they come back in the result, in order
let seeCalls = 0
let imagesSent = 0

function imageType(b) {
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
}

const unknownKey = (value, known) => Object.keys(value).find(key => !known.includes(key))
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// What is wrong with the argument's shape, naming the key; undefined when it is fine. A wrong shape sends nothing.
function seeShape(arg) {
  if (!isRecord(arg)) return 'give one object: claude.see({text, images: [{path or buffer, label}]})'
  const extra = unknownKey(arg, ['text', 'images'])
  if (extra !== undefined) return 'unknown key ' + JSON.stringify(extra) + ': the keys are text and images'
  if (arg.text !== undefined && typeof arg.text !== 'string') return 'text must be a string'
  if (arg.text && arg.text.length > TEXT_SENT_MAX) return 'text is ' + arg.text.length + ' characters, over the ' + TEXT_SENT_MAX + ' one call may carry (the result shows only the first 2000)'
  if (arg.images !== undefined && !Array.isArray(arg.images)) return 'images must be an array'
  if (!arg.text && !(arg.images && arg.images.length > 0)) return 'give text, images, or both'
  for (const [i, image] of (arg.images || []).entries()) {
    const at = 'images[' + i + ']'
    if (!isRecord(image)) return at + ' must be an object: {path or buffer, label}'
    const odd = unknownKey(image, ['path', 'buffer', 'label'])
    if (odd !== undefined) return at + '.' + odd + ' is an unknown key: the keys are path, buffer and label'
    if ((image.path === undefined) === (image.buffer === undefined)) return at + ' takes exactly one of path and buffer'
    if (image.path !== undefined && typeof image.path !== 'string') return at + '.path must be a string'
    if (image.buffer !== undefined && !util.types.isUint8Array(image.buffer)) return at + '.buffer must be a Buffer or Uint8Array'
    if (image.label !== undefined && typeof image.label !== 'string') return at + '.label must be a string'
  }
}

// One picture's bytes and type, or why not. A path is judged before anything is read: a device, a pipe or a huge file is never opened.
function readImage(image) {
  if (image.path !== undefined) {
    const stat = fs.statSync(image.path)
    if (!stat.isFile()) return { why: 'not a regular file' }
    if (stat.size > IMAGE_MAX_BYTES) return { why: 'larger than ' + IMAGE_MAX_BYTES + ' bytes' }
  }
  if (image.buffer !== undefined && image.buffer.length > IMAGE_MAX_BYTES) return { why: 'larger than ' + IMAGE_MAX_BYTES + ' bytes' }
  const bytes = image.path !== undefined ? fs.readFileSync(image.path) : Buffer.from(image.buffer)
  if (bytes.length > IMAGE_MAX_BYTES) return { why: 'larger than ' + IMAGE_MAX_BYTES + ' bytes' }
  const media_type = imageType(bytes)
  if (media_type === undefined) return { why: 'not a PNG or JPEG' }
  return { media_type, bytes }
}

// What went wrong, in words, whatever was thrown (a script may throw null).
const said = err => String((err && (err.why || err.message)) || err)

// Resolves, never rejects: {ok, refused: [{index, reason}]}; index is the picture's place in images, -1 the call itself.
// Every line of one call is written before anything else runs, so two calls never mix; the size check keeps each line under the tool's limit.
async function see(arg) {
  const refused = []
  const no = (index, reason, printedAs) => {
    if (printedAs !== undefined) printed.push('[appifact_sdk] ' + printedAs + ' refused: ' + reason)
    refused.push({ index, reason })
  }
  const named = (i, image) => 'images[' + i + ']' + (image.label ? ' (' + JSON.stringify(image.label.slice(0, 80)) + ')' : '')
  try {
    const shape = seeShape(arg)
    if (shape !== undefined) no(-1, shape, 'see')
    else if (seeCalls >= SEES_MAX) no(-1, 'at most ' + SEES_MAX + ' claude.see() calls per result', 'see')
    else {
      const images = arg.images || []
      const lines = []
      for (const [i, image] of images.entries()) {
        // The fifth picture is refused unread.
        let ready = imagesSent >= IMAGES_MAX ? { why: 'at most ' + IMAGES_MAX + ' images per result' } : undefined
        try {
          ready = ready || readImage(image)
        } catch (err) {
          ready = { why: said(err) }
        }
        if (ready.why !== undefined) no(i, ready.why, named(i, image))
        else {
          imagesSent++
          const label = image.label === undefined ? undefined : image.label.slice(0, 200)
          lines.push([i, () => ({ type: 'image', media_type: ready.media_type, data: ready.bytes.toString('base64'), label })])
        }
      }
      // A call with nothing left to show sends nothing and uses none of the four calls.
      if (arg.text || lines.length > 0) {
        seeCalls++
        lines.unshift([-1, () => ({ type: 'see', text: arg.text || '' })])
      }
      // Each answer is caught where it is made: a refusal that lands while an earlier line is awaited is never unhandled.
      const sent = lines.map(([i, frame]) => {
        let answer
        try {
          answer = send(id => ({ id, ...frame() }), 'claude.see()', [])
        } catch (err) {
          answer = Promise.reject(err)
        }
        return [i, answer.then(() => undefined, err => err)]
      })
      for (const [i, outcome] of sent) {
        const err = await outcome
        if (err === undefined) continue
        // The tool's own refusal is already a line in its result.
        if (err && err.code === 'refused') no(i, err.why.replace(/^refused: /, ''))
        else no(i, said(err), i < 0 ? 'see' : named(i, images[i]))
      }
    }
  } catch (err) {
    no(-1, said(err), 'see')
  }
  refused.sort((a, b) => a.index - b.index)
  return { ok: refused.length === 0, refused }
}

const claude = Object.freeze({
  async use(name) {
    if (name === 'db') return dbHandle()
    if (name === 'files') return filesHandle()
    if (name === 'assets') return assetsHandle()
    throw new Error('claude.use(' + JSON.stringify(name) + ') is not available here: only claude.use("db"), claude.use("files") and claude.use("assets")')
  },
  see,
  log: (...args) => capture(...args),
})

// ---- the run: console is captured and printed once, then one summary line
function show(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return String(value.stack || value)
  try {
    const json = JSON.stringify(value)
    return json === undefined ? util.inspect(value) : json
  } catch {
    return util.inspect(value)
  }
}

// Every console method (log, warn, table, ...) records its arguments as one line.
const capture = (...args) => void printed.push(args.map(show).join(' '))
const assert = (ok, ...args) => void (ok || capture('Assertion failed:', ...args))
const scriptConsole = new Proxy({}, {
  get: (_, key) => (key === 'assert' ? assert : typeof key === 'string' && key !== 'then' ? capture : undefined),
})

function excerpt(err) {
  const hit = CODE_LINE.exec(String(err && err.stack))
  if (hit === null) return ''
  const lines = code.split('\n')
  const n = Number(hit[1])
  const out = []
  for (let i = Math.max(1, n - 1); i <= Math.min(lines.length, n + 1); i++) {
    out.push((i === n ? '> ' : '  ') + i + ' | ' + lines[i - 1].slice(0, 200))
  }
  return out.join('\n')
}

function fail(err) {
  failed = true
  printed.push('\u2717 Uncaught ' + (err instanceof Error ? err.name + ': ' + err.message : show(err)))
  const where = excerpt(err)
  if (where !== '') printed.push(where)
}

// Printed once; with a callback, the exit waits for the write to be taken.
function flush(done) {
  if (flushed) return
  flushed = true
  let text = printed.join('\n')
  if (text.length > OUTPUT_CAP) {
    const dropped = '\n[' + (text.length - OUTPUT_CAP) + ' characters dropped here: print less]\n'
    text = text.slice(0, OUTPUT_CAP / 2) + dropped + text.slice(-OUTPUT_CAP / 2)
  }
  // The tool puts the markers around everything this process printed.
  process.stdout.write(
    text + '\n[appifact_sdk] ' + counts.reads + ' reads, ' + counts.writes + ' writes' + (failed ? ', stopped at the error above' : '') + '\n',
    done,
  )
}

const finish = exitCode => flush(() => process.exit(exitCode))

async function main() {
  // Node's ExperimentalWarning (import()'s loader) stays out of the tool's [stderr].
  const emitWarning = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    const type = rest[0] !== null && typeof rest[0] === 'object' ? rest[0].type : rest[0]
    if (type !== 'ExperimentalWarning') emitWarning.call(process, warning, ...rest)
  }
  process.on('exit', () => flush())
  process.on('SIGTERM', () => finish(143))
  const stop = err => {
    fail(err)
    finish(1)
  }
  process.on('unhandledRejection', stop)
  process.on('uncaughtException', stop)
  process.on('beforeExit', () => {
    if (!flushed) stop(new Error('the code never finished: it awaits something that never settles'))
  })
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) code += chunk
  try {
    const fn = new vm.Script('(async (claude, console, require) => { "use strict";\n' + code + '\n})', {
      filename: CODE_FILE,
      lineOffset: -1,
      importModuleDynamically: vm.constants && vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }).runInThisContext()
    const value = await fn(claude, scriptConsole, createRequire(process.cwd() + '/'))
    if (value !== undefined) printed.push('\u2192 ' + show(value))
    // Calls the code did not await still land, and a refused one still ends the run as an error.
    do {
      await Promise.allSettled([...pending.values()].map(call => call.done))
      await new Promise(resolve => setImmediate(resolve))
    } while (pending.size > 0)
  } catch (err) {
    fail(err)
  }
  finish(failed ? 1 : 0)
}

main()
})()
