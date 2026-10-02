// Whiteboard write-back helper. Reads the board state the page embeds, appends
// Claude's elements, places each new element clear of everything already on
// the board, and writes the republishable page: the skill's template plus
// one inserted state line and one line of comment anchors. Serialization
// escapes every "<" the way the page's own serializer does, so board text can
// never close the embedded script block. Runs on node or bun, no dependencies.
//
// usage: node merge-state.mjs --state <fetched page, or a bare board state such as {"v":1,"els":[],"pingCount":0,"ping":null}>
//                             --add <file with a JSON array of elements to add>
//                             --template <path to template.html>
//                             --out <path to whiteboard.html>
//                             [--retire id1,id2]   (your own cl_ ids to remove)
//                             [--title "<topic> whiteboard"]     (name the board on first publish)
//                             [--store <dir>]      (the board's store dumped by read_db list els with out_dir: edits nobody has sent yet, applied before yours)
//                             [--place <file>]     (a JSON array of {id, x, y[, w, h]}: reposition existing elements of any author - position only, their words untouched; pictures take x, y only)
//          (an addition may carry "sug": true - it lands with a Suggested chip until someone on the board keeps or dismisses it; leave it off anything that answers an ask;
//           on a mark already on the board the board's keep/dismiss state wins, whatever the addition says)
//        node merge-state.mjs --state <fetched page> --extract-images <dir>
//                             (writes each picture on the board to <dir>/<id>.<ext> and lists them; no page is written)

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const FONT_SIZE = 17, STICKY_SIDE = 160, MARGIN = 36, STEP = 44 // clearances: additions land a comfortable gap from everything else
const MAX_ELS = 2000 // the page keeps this many elements (sanitize in template.html)

function arg(name){
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? undefined : process.argv[i + 1]
}
function fail(msg){ process.stderr.write('whiteboard merge: ' + msg + '\n'); process.exit(1) }
function read(p, what){
  try{ return readFileSync(p, 'utf8') }
  catch(e){ fail('cannot read ' + what + ' at ' + p + ' \u2014 pass the path you wrote it to (' + e.code + ')') }
}

const statePath = arg('state'), addPath = arg('add'), tplPath = arg('template'), outPath = arg('out'), extractDir = arg('extract-images')
if(!statePath || (!extractDir && (!addPath || !tplPath || !outPath))) fail('need --state, --add, --template and --out (or --state with --extract-images <dir>)')
const retire = new Set((arg('retire') || '').split(',').map(s => s.trim()).filter(Boolean))

// --- the page title: an explicit --title, else the one the board carries, else the default.
// titleFrom is the ONE place a candidate becomes a name: NFC-normalize; replace every DENIED code
// point (controls, invisible format chars except the ZWJ/ZWNJ a name can need, bidi overrides,
// LS/PS) with a space; collapse whitespace; cap by code point; strip BLANK runs (whitespace and
// joiners) from both edges; then a name exists only if some code point actually renders
// (VISIBLE) - the same emptiness test the rename guard relies on, so display and refusal agree
// (standalone sibling of sanitizeArtifactTitle in src/tools/ArtifactTool/constants.ts) ---
const DEFAULT_TITLE = 'Whiteboard'
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// reads back what escHtml writes and what the server's re-serialization writes (&#34; &#39; &#13;)
const unescHtml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;|&#34;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#13;/g, '\r').replace(/&amp;/g, '&')
// The server stores a published page with ` data-id="<16 chars>"` added to every open tag (last,
// on the tags read here): the one extra attribute a read-back page may carry (KEEP-IN-SYNC:
// dataIdAttrLen in the CLI)
const DATA_ID = '(?: data-id="(?!-)(?:(?!--)[A-Za-z0-9_-]){16}")?'
const DENIED = /(?![\u200c\u200d])[\p{C}\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu
const EDGE_BLANK = /^[\s\u200c\u200d]+|[\s\u200c\u200d]+$/gu
// blank to the eye: whitespace, joiners, combining marks without a base, and the fillers and
// blank glyphs that render as nothing - a name needs at least one code point outside all of it
const VISIBLE = /[^\s\u200c\u200d\p{M}\u2800\u3164\uffa0\u115f\u1160]/u
function titleFrom(plain){
  const t = String(plain || '').normalize('NFC').replace(DENIED, ' ').replace(/\s+/g, ' ')
  const capped = Array.from(t).slice(0, 120).join('') // cap by code point so no surrogate pair splits
  const name = capped.replace(EDGE_BLANK, '')
  return VISIBLE.test(name) ? escHtml(name) : ''
}
// the one gate for free text echoed into the session's context: JSON.parse errors quote a
// verbatim snippet of the failing input and image labels arrive from the board, so both are
// stripped like a title - no bidi override or zero-width byte can hide in the helper's voice -
// and capped by code point. Unlike a title, an echo has no emoji or joining-script needs, so
// the ZWJ/ZWNJ that DENIED spares are stripped here too.
const safeEcho = (s, cap = 160) => Array.from(String(s || '').normalize('NFC').replace(DENIED, ' ').replace(/[\u200c\u200d]/g, ' ').replace(/\s+/g, ' ')).slice(0, cap).join('').trim()

// --- the --template: authenticated by full content hash before any use. The two-line head
// check keeps the friendly wrong-file message; the pin makes a shaped file impossible - the
// page code spliced into the output comes ONLY from the template the skill shipped.
// Drift-pinned by whiteboardMpHelper.test.ts, which prints the new value when template.html
// changes. Line endings normalized so a CRLF checkout still matches. ---
const TEMPLATE_SHA256 = 'b3defee764d8fe2a6c9c1315c6e3cbcd63cff06ee40d536481276225d8d8cd4e'
let tplTextMemo
function templateText(){
  if(tplTextMemo !== undefined) return tplTextMemo
  let src
  if(tplPath) src = read(tplPath, 'the --template')
  else {
    // an extract run passes no --template: the check reads the template the skill ships
    // beside this helper; a helper copied away from its template keeps the structural
    // check alone (null - the one soft branch, strictly for a file that is simply not
    // there). Any other read error class (EACCES, EISDIR, EIO) is a broken extraction,
    // and a detection gate that skips on an error is an approval path - refuse instead.
    try{ src = readFileSync(new URL('template.html', import.meta.url), 'utf8') }
    catch(e){
      if(e && e.code === 'ENOENT'){ tplTextMemo = null; return null }
      fail('cannot read the template.html beside this helper (' + (e && e.code ? e.code : 'unknown') + ') \u2014 the page-code check needs it; re-extract the skill files')
    }
  }
  const t = src.replace(/\r\n/g, '\n')
  const head = t.split('\n', 2)
  // the fail copy names the source this run actually read: the flag, or the shipped sibling
  const which = tplPath ? 'the --template' : 'the template.html beside this helper'
  if(head[0] !== '<title>' + DEFAULT_TITLE + '</title>' || head[1] !== '<script>')
    fail(which + ' is not the skill template \u2014 ' + (tplPath ? 'pass template.html from the skill directory' : 're-extract the skill files'))
  if(createHash('sha256').update(t).digest('hex') !== TEMPLATE_SHA256)
    fail(which + ' does not match the template this helper shipped with \u2014 a board page or an edited copy can never be the page code; re-extract the skill files' + (tplPath ? ' and pass that template.html' : ''))
  tplTextMemo = t
  return t
}

// --- reading a fetched page: only the head a real board carries (what the page's publish, this helper and the
// server write) is accepted, so the block reached is the element the page's script reads as script#wb-state ---
const TAG_WS = ' \t\n\f\r'
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y, ATTR_NAME = /[a-zA-Z][a-zA-Z0-9_:.-]*/y, UNQUOTED_VALUE = /[^ \t\n\f\r"'=<>`]+/y
const DOCTYPE_RE = /<!doctype[ \t\n\f\r]+html[ \t\n\f\r]*>/iy
const DATA_ID_TOKEN = /^(?!-)(?:(?!--)[A-Za-z0-9_-]){16}$/
const FRAME_COMMENT_OPEN = ' frame-runtime ', FRAME_COMMENT_CLOSE = ' /frame-runtime '
// the wrapper's raw tags, byte-exact as the server writes them (lowercase, bare or
// double-quoted): the publish strips in src/frame/goCp.ts match lowercase bytes
// case-sensitively, so a case-varied or padded tag survives publish stored - it must be
// refused here, never read as server chrome. KEEP-IN-SYNC with FRAME_BASE_TAG_RE /
// FRAME_SCRIPT_OPEN / FRAME_SCRIPT_CLOSE in src/frame/whiteboardState.ts
// (byte-pinned by whiteboardMpHelper.test.ts)
const FRAME_BASE_TAG_RE = /^<base[\t\n\f\r ]+href="\/_f\/[A-Za-z0-9-]{1,64}\/"[\t\n\f\r ]*>$/
const FRAME_SCRIPT_OPEN = '<script>'
const FRAME_SCRIPT_CLOSE = '</script>'
// the wrapper opens only where the server splices it: the bytes ahead of its open comment
// must be, byte for byte, one of the genuine served materializations - bounded, no
// whitespace, nothing paddable. The publish strips excise a stored wrapper only inside
// their 8 KiB head window, so a reader accepting one at any offset would bless padded
// forgeries the strips leave stored; this pin makes the accepted set no wider than the
// stripped set. KEEP-IN-SYNC with SERVED_SPLICE_PREFIX_RE in src/frame/goCp.ts
// (byte-pinned by whiteboardMpHelper.test.ts)
const FRAME_SPLICE_PREFIX = /^(?:<!doctype html>|<!DOCTYPE html>)?<html(?: lang="(?=[^"]{1,35}")[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*")?(?: data-id="(?!-)(?:(?!--)[A-Za-z0-9_-]){16}")?><head(?: data-id="(?!-)(?:(?!--)[A-Za-z0-9_-]){16}")?>$/
// the served preamble's signature: the v1 lead then the ',' or '}' that continues or closes
// that object - KEEP-IN-SYNC with FRAME_PREAMBLE_LEAD / hasFramePreambleLead in
// src/frame/goCp.ts, so this reader never accepts a wrapper script the server strip
// would leave stored
const FRAME_PREAMBLE_LEAD = 'window.__FRAME_PREAMBLE={"v":1'
// the wrapper interior's cap and shape - KEEP-IN-SYNC with FRAME_WRAPPER_MAX_INTERIOR /
// frameInteriorMeasurable in src/frame/whiteboardState.ts (the served runtime cap plus
// the base/preamble margin; the genuine interior is one line of printable ASCII)
const FRAME_WRAPPER_MAX_INTERIOR = (256 << 10) + (4 << 10)
const FRAME_INTERIOR_SHAPE = /^[\x20-\x7e]*$/
// "&" starting anything a browser could read as a character reference, other than the exact
// references escHtml and the server write: the tab title would show text these bytes never spell
const TITLE_AMP = /&(?!(?:lt|gt|quot|amp|#34|#39|#13);)(?=[#A-Za-z0-9])/
const isTagWs = ch => ch !== undefined && TAG_WS.includes(ch)
// strict tag parse: a name, then single well-formed attributes; anything a browser would
// error-recover on (duplicate or malformed attribute, attribute on an end tag, "<" or NUL in a
// value, a character reference in an id, an unterminated tag) is null, and every caller refuses
function parseTag(html, at){
  const isEnd = html[at + 1] === '/'
  TAG_NAME.lastIndex = at + (isEnd ? 2 : 1)
  const nameMatch = TAG_NAME.exec(html)
  if(!nameMatch) return null
  let i = TAG_NAME.lastIndex, selfClosing = false
  const attrs = new Map()
  for(;;){
    const beforeWs = i
    while(isTagWs(html[i])) i++
    const ch = html[i]
    if(ch === undefined) return null
    if(ch === '>'){ i++; break }
    if(ch === '/'){ if(html[i + 1] !== '>') return null; selfClosing = true; i += 2; break }
    if(isEnd || i === beforeWs) return null
    ATTR_NAME.lastIndex = i
    const attrMatch = ATTR_NAME.exec(html)
    if(!attrMatch) return null
    const name = attrMatch[0].toLowerCase()
    if(attrs.has(name)) return null
    i = ATTR_NAME.lastIndex
    let value = ''
    if(html[i] === '='){
      i++
      const quote = html[i]
      if(quote === '"' || quote === "'"){
        const close = html.indexOf(quote, i + 1)
        if(close === -1) return null
        value = html.slice(i + 1, close); i = close + 1
      } else {
        UNQUOTED_VALUE.lastIndex = i
        const unquoted = UNQUOTED_VALUE.exec(html)
        if(!unquoted) return null
        value = unquoted[0]; i = UNQUOTED_VALUE.lastIndex
      }
      if(value.includes('<') || value.includes('\0') || (name === 'id' && value.includes('&'))) return null
    }
    attrs.set(name, value)
  }
  return { name: nameMatch[0].toLowerCase(), isEnd, attrs, selfClosing, end: i }
}
// attributes limited to the allowed names plus the server's data-id, which must be a token it mints
function attrsOnly(tag, allowed){
  for(const name of tag.attrs.keys()) if(name !== 'data-id' && !allowed.includes(name)) return false
  return !tag.attrs.has('data-id') || DATA_ID_TOKEN.test(tag.attrs.get('data-id'))
}
// where a script's raw text ends, honouring the tokenizer's escaped states ("<!--" then "<script"
// keeps a browser reading past "</script>" until "-->"); "<!--" is tolerated only inside the state
// block, whose text a board's words can shape - anywhere else it is refused. Null fails closed.
function scriptRawTextEnd(html, from, stateBlock){
  const token = /<!--|-->|<\/script(?=[ \t\n\f\r/>])|<script(?=[ \t\n\f\r/>])/gi
  token.lastIndex = from
  let state = 0 // 0 plain, 1 escaped, 2 double-escaped
  for(let m; (m = token.exec(html)); ){
    const t = m[0].toLowerCase()
    if(t === '<!--'){
      if(!stateBlock) return null
      let q = m.index + 4
      while(html[q] === '-') q++
      if(html[q] === '>'){ state = 0; token.lastIndex = q + 1 }
      else if(state === 0) state = 1
    }
    else if(t === '-->') state = 0
    else if(t === '<script'){ if(state === 1) state = 2 }
    else if(state === 2) state = 1
    else {
      const closeTag = parseTag(html, m.index)
      if(!closeTag || !closeTag.isEnd || closeTag.selfClosing) return null
      return { textEnd: m.index, end: closeTag.end }
    }
  }
  return null // never closed: a cut-off read, reported as such before this scan runs
}
// walks from the top to the state block; {at, text} for the block it reaches, null on anything a
// real board never carries ahead of it
function scanHead(html){
  let i = 0, frame = 0, preApp = true // frame: 0 none, 1 open comment, 2 base (the server may omit it), 3 preamble, 4 runtime, 5 closed
  const styles = [] // every style's content ahead of the block, byte-compared to the template sheet later
  let wrapped = false // a serve wrapper's scripts ran ahead of the block: page code the check must not skip
  let frameStart = -1 // just past the wrapper's open comment, for the interior cap at its close
  for(;;){
    const lt = html.indexOf('<', i)
    if(lt === -1) return null
    if(/[^ \t\n\f\r]/.test(html.slice(i, lt))) return null // stray text
    if(html.startsWith('<!--', lt)){
      if(html[lt + 4] === '>' || html.startsWith('->', lt + 4)) return null // abrupt close
      const close = /--!?>/g
      close.lastIndex = lt + 4
      const c = close.exec(html)
      if(!c || c[0] !== '-->') return null // unterminated, or the --!> close
      const content = html.slice(lt + 4, c.index)
      if(content === FRAME_COMMENT_OPEN){
        if(frame !== 0 || !preApp || !FRAME_SPLICE_PREFIX.test(html.slice(0, lt))) return null
        frame = 1; frameStart = c.index + 3
      }
      else if(content === FRAME_COMMENT_CLOSE){
        if(frame !== 4) return null
        const interior = html.slice(frameStart, lt)
        if(interior.length > FRAME_WRAPPER_MAX_INTERIOR || !FRAME_INTERIOR_SHAPE.test(interior)) return null
        frame = 5
      }
      else if(frame >= 1 && frame <= 4) return null // nothing else inside the wrapper
      preApp = false
      i = c.index + 3
      continue
    }
    if(html[lt + 1] === '!'){
      if(frame >= 1 && frame <= 4) return null
      DOCTYPE_RE.lastIndex = lt
      if(!DOCTYPE_RE.exec(html)) return null // anything else starting "<!" is a bogus comment
      i = DOCTYPE_RE.lastIndex
      continue
    }
    const tag = parseTag(html, lt)
    if(!tag) return null
    if(frame >= 1 && frame <= 4 && (tag.isEnd || !(tag.name === 'script' || (frame === 1 && tag.name === 'base')))) return null
    if(tag.isEnd){
      if(tag.name !== 'head') return null
      preApp = false; i = tag.end
      continue
    }
    switch(tag.name){
      case 'base':
        if(frame !== 1 || !FRAME_BASE_TAG_RE.test(html.slice(lt, tag.end))) return null
        frame = 2; i = tag.end
        break
      case 'html': case 'head': case 'body':
        if(tag.selfClosing || !attrsOnly(tag, tag.name === 'html' ? ['lang'] : [])) return null
        if(tag.name === 'body') preApp = false
        i = tag.end
        break
      case 'meta': {
        // the wrapper's charset meta, or the plain viewport meta buildPage and the template carry
        preApp = false
        if(!attrsOnly(tag, ['charset', 'name', 'content'])) return null
        const charset = tag.attrs.get('charset')
        if(charset !== undefined ? (charset.toLowerCase() !== 'utf-8' || tag.attrs.has('name') || tag.attrs.has('content'))
          : ((tag.attrs.get('name') || '').toLowerCase() !== 'viewport' || tag.attrs.get('content') !== 'width=device-width, initial-scale=1')) return null
        i = tag.end
        break
      }
      case 'style': { // raw text: a browser reads nothing inside it as markup, and neither does this
        preApp = false
        if(tag.selfClosing || !attrsOnly(tag, [])) return null
        const close = /<\/style(?=[ \t\n\f\r/>])/gi
        close.lastIndex = tag.end
        const c = close.exec(html), closeTag = c && parseTag(html, c.index)
        if(!closeTag || !closeTag.isEnd) return null
        styles.push(html.slice(tag.end, c.index))
        i = closeTag.end
        break
      }
      case 'title': {
        preApp = false
        if(tag.selfClosing || !attrsOnly(tag, [])) return null
        const close = /<\/title(?=[ \t\n\f\r/>])/gi
        close.lastIndex = tag.end
        const c = close.exec(html)
        if(!c) return null
        const inner = html.slice(tag.end, c.index)
        if(inner.includes('<') || TITLE_AMP.test(inner)) return null // a real title is escaped
        const closeTag = parseTag(html, c.index)
        if(!closeTag || !closeTag.isEnd) return null
        i = closeTag.end
        break
      }
      case 'script': {
        if(tag.selfClosing) return null
        if(frame >= 1 && frame <= 3 && html.startsWith(FRAME_SCRIPT_OPEN, lt)){ // the wrapper's two scripts, nowhere else, by their served bytes
          const raw = scriptRawTextEnd(html, tag.end, false)
          if(!raw || html.slice(raw.textEnd, raw.end) !== FRAME_SCRIPT_CLOSE) return null
          if(frame < 3 && !(html.startsWith(FRAME_PREAMBLE_LEAD, tag.end) && ',}'.includes(html[tag.end + FRAME_PREAMBLE_LEAD.length] ?? ' '))) return null
          frame = frame < 3 ? 3 : 4; wrapped = true; i = raw.end
          break
        }
        if(frame >= 1 && frame <= 4) return null
        // the only other script a head may carry is the block itself, by its exact open tag
        if(tag.attrs.get('id') !== 'wb-state' || tag.attrs.get('type') !== 'application/json' || !attrsOnly(tag, ['type', 'id'])) return null
        const raw = scriptRawTextEnd(html, tag.end, true)
        if(!raw) return null
        return { at: lt, text: html.slice(tag.end, raw.textEnd), styles, wrapped }
      }
      default:
        return null
    }
  }
}

// --- read the state: either a bare JSON object or the page carrying the wb-state block ---
// The block is matched only where a real board carries it - after the page's body comment
// (a sent board), after the title line (a page this helper wrote), or on its own - so the
// opener string inside the page's own script source can never be mistaken for it.
const raw = read(statePath, 'the --state board')
let stateText = raw.trim()
const bareState = stateText[0] === '{'
let stateAt = -1, blockEnd = -1, headStyles = [], headWrapped = false
if(!bareState){
  const anchor = '(?:^\\s*|<body' + DATA_ID + '>\\s*|-->\\s*|<\\/title>\\s*)<script type="application\\/json" id="wb-state"'
  // the first anchored opener, its text sliced to the next script close, so the read stays linear
  // in the page size however many openers a co-writer plants; no writer of this block puts
  // anything between its closing brace and the close, so a closed block shaped otherwise is
  // crafted and refused outright, not called a cut-off read to retry
  const open = new RegExp(anchor + DATA_ID + '>').exec(raw)
  const textStart = open ? open.index + open[0].length : -1
  const textEnd = open ? raw.indexOf('</script>', textStart) : -1
  const text = textEnd === -1 ? '' : raw.slice(textStart, textEnd)
  const closed = textEnd !== -1 && text[0] === '{'
  if(closed && text[text.length - 1] !== '}')
    fail('the wb-state block in ' + statePath + ' is not the one the page shows \u2014 the board cannot be written back safely; stop and tell the user')
  // a page that ends before any script closes, or an anchored opener with no closer (or cut
  // inside its own tag), is a sent board whose read was cut off; an opener carrying anything but
  // the server's attribute is a board this helper cannot read - neither is an unsent board
  const headOnly = !/<\/(?:script|body|html)>/i.test(raw) && /^\s*<(?:!doctype|html|head|meta|title)[\s>]/i.test(raw)
  if(!closed) fail(headOnly || new RegExp(anchor + '(?:' + DATA_ID + '>(?:\\{|$)|[^>]*$)').test(raw)
    ? 'the wb-state block in ' + statePath + ' is cut off \u2014 the board read is incomplete; read the full saved HTML by path and run again'
    : new RegExp(anchor + '[\\s/]').test(raw)
    ? 'the wb-state block in ' + statePath + ' carries attributes this helper does not read \u2014 the board cannot be written back safely; stop and tell the user'
    : raw.includes('id="sketchboard-published"')
    ? statePath + ' is a board from the single-player whiteboard, not a live one \u2014 it has no wb-state block to merge into. Rebuilding it on this skill is lossy: boxes, notes, text and arrows from the sketchboard-published JSON on the page can be redrawn as --add elements and will land as your marks, while freehand strokes, plain lines and pasted pictures cannot carry over \u2014 tell the user what a rebuild would lose and publish over the same artifact only on their yes'
    : 'no wb-state block in ' + statePath + ' \u2014 a board that has never been sent has no state to write back to; ask the user to send an ask from the board first')
  stateText = text; stateAt = open.index + open[0].indexOf('<script'); blockEnd = textEnd + '</script>'.length
  // the page hands its script the FIRST element with this id, so everything ahead of the block
  // must be the head a real board carries (scanHead below) and the block it arrives at must be
  // this one - else people would see a different board than the one written back
  const seen = scanHead(raw)
  if(!seen || seen.at !== stateAt || seen.text !== stateText)
    fail('the wb-state block in ' + statePath + ' is not the one the page shows \u2014 the board cannot be written back safely; stop and tell the user')
  headStyles = seen.styles; headWrapped = seen.wrapped
}
// a fetched PAGE names the board in the FIRST <title> of its head - the head is the content before
// the wb-state block, so a <title> literal later in the page's script source is never a name
let carried = ''
if(!bareState){
  const head = raw.slice(0, stateAt), t = new RegExp('<title' + DATA_ID + '>').exec(head)
  const textAt = t ? t.index + t[0].length : -1
  const closeAt = t ? head.indexOf('</title>', textAt) : -1
  if(closeAt !== -1) carried = titleFrom(unescHtml(head.slice(textAt, closeAt)))
}
let state
try{ state = JSON.parse(stateText) }
catch(e){ fail('the wb-state block does not parse \u2014 the board read is incomplete; stop and tell the user (' + safeEcho(e.message) + ')') }
if(!state || !Array.isArray(state.els)) fail('state has no els array')
// compacted at the door: the version is viewer-writable, and every pass below guards per entry (if(e)), so forged filler - null slots, or truthy junk the page's sanitize would drop (no string id, a type it never admits, an id past its 40-character key, a repeat of an id already kept, or a pen with no drawable point) - would flow through untouched while still counting toward raw length: the store loop's full-board refusal (its MAX_ELS check) must count real elements, or 2000 planted slots silently refuse every honest store doc while the board renders normal on every tab. The keep-set mirrors sanitize exactly - its positional budget first (it reads only the first MAX_ELS raw entries), then filter, slice and first-wins dedupe - so what counts here is what a page load would keep
const EL_TYPES = new Set(['rect', 'ellipse', 'cylinder', 'diamond', 'sticky', 'text', 'arrow', 'line', 'image', 'pen'])
// sanitize's per-type keep rule where it can drop an admitted type: a pen ships only with a finite point pair (one predicate for the door and the store loop)
const penOk = e => e.type !== 'pen' || (Array.isArray(e.pts) && e.pts.slice(0, 4000).some(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])))
const elSeen = new Set()
state.els = state.els.slice(0, MAX_ELS).filter(e => e && typeof e === 'object' && typeof e.id === 'string' && EL_TYPES.has(e.type) && penOk(e) && !elSeen.has(e.id = e.id.slice(0, 40)) && (elSeen.add(e.id), true))

// the additions are read up front so the store pass can recognise the ids this write-back owns: a
// mark the session drew live comes back in the store stamped author:'claude' by a witnessing tab,
// and the run's own --add (or --retire) of that id is the authoritative word on it, so the store's
// copy of such an id is skipped below rather than landed unattributed - landing it would then trip
// --add's loud "already belongs to another element" guard. Ids the run does not name are untouched.
let additions = null
if(!extractDir){
  try{ additions = JSON.parse(read(addPath, 'the --add additions file')) }
  catch(e){ fail('additions file is not valid JSON (' + safeEcho(e.message) + ')') }
  if(!Array.isArray(additions)) fail('additions must be a JSON array of elements')
}
const runIds = new Set(retire)
if(additions) for(const e of additions) if(e && typeof e.id === 'string') runIds.add(e.id)
// --- the page code after the block: what every open tab runs. A real board carries only the
// anchor line, the token sheet and the one app script (plus a rebuild's closing tags), and that
// script is verifiable byte-for-byte: a page this helper wrote carries the template's script,
// and a page a tab republished carries the ONE rebuild buildPage can emit - the two consts
// re-escaped and each function's exact source between fixed separators, reconstructed below
// from the hash-pinned template itself, so the comparison is equality and no rearrangement of
// template bytes can pass as a rebuild. Foreign page code is REPORTED, never spliced onward:
// the output below is always built from the skill's template, so the write-back is the
// restore. ---
const REBUILD_FNS = ['esc', 'escHtml', 'cdsTokenCss', 'tokenCssPublishable', 'anchorMarkup', 'buildPage', 'themeMirror', 'scheduleBoot', 'main', 'boot']
const REBUILD_TAIL = ';themeMirror();scheduleBoot();'
// the template's app script, its two backtick consts and the token sheet; null when the
// template cannot anchor the check (each declaration must be unique and the consts plain
// bytes - no escape, nested backtick or interpolation - which the shipped template satisfies
// and its tests pin)
function templateExpectations(){
  const t = templateText()
  const open = t.indexOf('<script>'), close = t.indexOf('</script>')
  if(open === -1 || close === -1) return null
  const app = t.slice(open + '<script>'.length, close)
  const lit = name => {
    const key = 'const ' + name + ' = `'
    const a = app.indexOf(key)
    const b = a === -1 ? -1 : app.indexOf('`', a + key.length)
    return b === -1 || /\\|\$\{/.test(app.slice(a + key.length, b)) ? null : app.slice(a + key.length, b)
  }
  for(const name of REBUILD_FNS){
    const at = app.indexOf('function ' + name + '(')
    if(at === -1 || app.indexOf('function ' + name + '(', at + 1) !== -1) return null
  }
  const css = lit('CSS'), markup = lit('MARKUP')
  const sheetOpen = t.indexOf('<style id="cds-tokens">', close)
  const sheetClose = sheetOpen === -1 ? -1 : t.indexOf('</style>', sheetOpen)
  if(sheetOpen === -1 || sheetClose === -1) return null
  const sheet = t.slice(sheetOpen + '<style id="cds-tokens">'.length, sheetClose)
  return css === null || markup === null ? null : { app, css, markup, sheet }
}
// the one script a rebuild can carry, byte for byte: buildPage emits the consts re-escaped
// with the page's own esc(), then toString() of each declaration - the exact source slice on
// every modern engine - joined by ';', then the boot tail. Evaluating the declarations here
// runs only bytes the hash pin already proved are the skill's own template; the two stubs
// keep its top-level themeMirror()/scheduleBoot() calls inert off-browser. null (check
// refused, page reported) if the template's script will not evaluate.
let rebuildInnerMemo
function expectedRebuildInner(expect){
  if(rebuildInnerMemo !== undefined) return rebuildInnerMemo
  rebuildInnerMemo = null
  const docStub = {
    readyState: 'loading',
    addEventListener(){},
    getElementById(){ return null },
    documentElement: { getAttribute(){ return null }, setAttribute(){}, removeAttribute(){} },
  }
  function ObserverStub(){}
  ObserverStub.prototype.observe = function(){}
  let fns
  try{ fns = new Function('document', 'MutationObserver', expect.app + ';return [' + REBUILD_FNS.join(',') + ']')(docStub, ObserverStub) }
  catch(_){ return null }
  const escJson = s => JSON.stringify(s).replace(/</g, '\\u003c')
  rebuildInnerMemo = '"use strict";const CSS=' + escJson(expect.css) + ';const MARKUP=' + escJson(expect.markup) + ';' + fns.map(f => f.toString()).join(';') + REBUILD_TAIL
  return rebuildInnerMemo
}
// everything after the state block, on the same strict terms as the head: the anchor line, at
// most one token sheet, exactly one plain script (captured for the check above), a rebuild's
// closing tags, comments - nothing else
function scanTail(html, from){
  const seen = { script: null, style: null, anchors: false, meta: false, split: false, closed: '' }
  let i = from
  for(;;){
    const lt = html.indexOf('<', i)
    if(/[^ \t\n\f\r]/.test(html.slice(i, lt === -1 ? html.length : lt))) return null
    if(lt === -1) return seen
    if(html.startsWith('<!--', lt)){
      if(html[lt + 4] === '>' || html.startsWith('->', lt + 4)) return null
      const close = /--!?>/g
      close.lastIndex = lt + 4
      const c = close.exec(html)
      if(!c || c[0] !== '-->') return null
      i = c.index + 3
      continue
    }
    const tag = parseTag(html, lt)
    if(!tag) return null
    if(tag.isEnd){
      if(tag.name === 'head' && !seen.split && seen.closed === ''){
        // the server stores a published fragment as a full document: the head it synthesized
        // closes somewhere after the state block, with body opening right behind it - before
        // the tail elements, or after them all when everything parsed as head content
        let j = tag.end
        while(isTagWs(html[j])) j++
        const body = html[j] === '<' ? parseTag(html, j) : null
        if(!body || body.isEnd || body.name !== 'body' || body.selfClosing || !attrsOnly(body, [])) return null
        seen.split = true
        i = body.end
        continue
      }
      if(tag.name === 'body' && seen.closed === '') seen.closed = 'body'
      else if(tag.name === 'html' && seen.closed === 'body') seen.closed = 'html'
      else return null
      i = tag.end
      continue
    }
    if(seen.closed) return null
    switch(tag.name){
      case 'div': { // the anchor line: empty comment-anchor markers only
        if(seen.anchors || tag.selfClosing || tag.attrs.get('id') !== 'wb-anchors' || tag.attrs.get('aria-hidden') !== 'true' || !attrsOnly(tag, ['id', 'aria-hidden'])) return null
        i = tag.end
        for(;;){
          while(isTagWs(html[i])) i++
          if(html[i] !== '<') return null
          const child = parseTag(html, i)
          if(!child) return null
          if(child.isEnd){
            if(child.name !== 'div') return null
            i = child.end
            break
          }
          if(child.name !== 'i' || child.selfClosing || child.attrs.get('class') !== 'wb-a' || !/^wb-a-[A-Za-z0-9_-]{1,40}$/.test(child.attrs.get('id') || '') || !attrsOnly(child, ['class', 'id'])) return null
          if(html[child.end] !== '<') return null
          const closeMark = parseTag(html, child.end)
          if(!closeMark || !closeMark.isEnd || closeMark.name !== 'i') return null
          i = closeMark.end
        }
        seen.anchors = true
        break
      }
      case 'meta': // the plain viewport meta the template places after the app script, at most once
        if(seen.meta || !attrsOnly(tag, ['name', 'content']) || (tag.attrs.get('name') || '').toLowerCase() !== 'viewport' || tag.attrs.get('content') !== 'width=device-width, initial-scale=1') return null
        seen.meta = true
        i = tag.end
        break
      case 'style': {
        if(seen.style !== null || tag.selfClosing || tag.attrs.get('id') !== 'cds-tokens' || !attrsOnly(tag, ['id'])) return null
        const close = /<\/style(?=[ \t\n\f\r/>])/gi
        close.lastIndex = tag.end
        const c = close.exec(html), closeTag = c && parseTag(html, c.index)
        if(!closeTag || !closeTag.isEnd) return null
        seen.style = html.slice(tag.end, c.index)
        i = closeTag.end
        break
      }
      case 'script': {
        // the app script's raw text is read the way a browser reads it (buildPage's source
        // carries a balanced comment-open, so the escaped states are in play here)
        if(seen.script !== null || tag.selfClosing || !attrsOnly(tag, [])) return null
        const rawText = scriptRawTextEnd(html, tag.end, true)
        if(!rawText) return null
        seen.script = html.slice(tag.end, rawText.textEnd)
        i = rawText.end
        break
      }
      default:
        return null
    }
  }
}
let pageCodeWhy = ''
// a --state that is only the wb-state block (the inline read result saved on its own is a
// documented input) carries no page code to judge - the same skip as a bare state. A style
// or serve-wrapper script AHEAD of the block is page code, so it keeps the check on even
// when nothing follows the block.
if(!bareState && (headStyles.length || headWrapped || /[^ \t\n\f\r]/.test(raw.slice(blockEnd)))){
  const tail = scanTail(raw, blockEnd)
  if(!tail || tail.script === null) pageCodeWhy = 'what follows the state block is not the board page'
  else if(templateText() !== null){
    const expected = templateExpectations()
    const app = tail.script.replace(/\r\n/g, '\n')
    if(!expected) pageCodeWhy = 'the template could not anchor the page-code check'
    else if(app !== expected.app && app !== expectedRebuildInner(expected))
      pageCodeWhy = 'its app script is neither the skill template nor the board rebuild'
    // the sheet is a byte carry-through (cdsTokenCss reads it off the DOM and buildPage
    // re-emits it raw), so on a real board it equals the template sheet exactly - and any
    // style the head carries ahead of the block is held to the same bytes; the one residual
    // ahead of the block is the serve wrapper's runtime bytes (server chrome, unpinnable
    // here, but held to the served preamble signature and interior cap in scanHead), which
    // the write-back never carries forward
    else if(tail.style === null || tail.style.replace(/\r\n/g, '\n') !== expected.sheet)
      pageCodeWhy = tail.style === null ? 'its token sheet is missing' : 'its token sheet is not the template sheet'
    else if(headStyles.some(s => s.replace(/\r\n/g, '\n') !== expected.sheet))
      pageCodeWhy = 'a style ahead of the state block is not the template sheet'
  }
}

// --- the store: edits made since this version, by anyone, that no Ask or Save has published yet ---
// Same rule as the page: a doc newer than the version replaces or removes its element (a tombstone
// carries `dead`); anything older is already spoken for by the version itself.
// the page identifies an element by the first 40 characters of its id, so ids are compared on that key
const idKey = id => typeof id === 'string' ? id.slice(0, 40) : id
// own-property reads only: a store doc parsed from JSON can carry an inherited author/by through a
// "__proto__" key (JSON.parse keeps it as an own property, and Object.assign's [[Set]] later revives
// it as a real prototype) - POISON_KEYS docs are dropped before that can happen, and reading own
// properties keeps a stray inherited value from ever counting as claude's ink
const POISON_KEYS = ['__proto__', 'constructor', 'prototype']
const isClaudes = el => !!el && (Object.hasOwn(el, 'author') && el.author === 'claude' || Object.hasOwn(el, 'by') && el.by === 'claude')
// The helper never reclaims claude ink from an id alone. A Save from a tab that could not vouch
// publishes claude's live marks unattributed; a session naming those ids in --add/--retire is not
// proof they are its own, because cl_ ids are not forge-proof - the wire and the client-writable
// store both keep a cl_-prefixed element a person planted (the page's netApply and this store loop
// only strip its claim, never its id). So an id-keyed reclaim would let a planted mark take claude
// ink or turn the authorship guards below tautological. The trusted record of claude's ink lives on
// the page instead: a witnessing tab restores it from its own local record on reload (loadState).
// Here the version's own attribution is the only word - an element it does not carry as claude's is
// not claude's, and the retire and in-place guards stay the loud stop they are.
const storeDir = arg('store')
let storeApplied = 0, storeSeen = 0, capIds = new Map(), capDump = new Set(), capMiss = new Map(), capRaw = new Map(), capDecay = Infinity, capSlice = Infinity, dumpRead = false, heldClaim = 0, sawValidDoc = false
// the page's floor rule (seeStamp/stamp in template.html): this run's marks are stamped above what honest skew carries - stamps within minutes of this clock - while a stamp planted near the day ceiling cannot drag them a day ahead
let stampFloor = 0
const seeStamp = t => { if(Number.isFinite(t) && t > stampFloor && t < Date.now() + 6e5) stampFloor = t }
const storeDead = new Set() // ids the dump says were deleted since the version: nothing in this write-back may bring them back
// a version stamp past the budget counts from the version's own trusted watermark (the page's bandTo-to-verAt rule), never from this clock - a reading of this clock is the newest possible in-band stamp and would beat every honest doc made before this run. One anchor bands elements and carried tombstones alike so their published order survives.
const bandRef = Date.now()
// the watermarks ride in viewer-writable state like every stamp - but unlike a stamp they gate the store cutoff below, and a rewrite to this clock would launder an over-band forgery into a trusted "now" that silences every honest doc, permanently (it reads as an ordinary past claim on every later run). Only a positive in-band number contributes: the rest fall to 0 (a forged -1e999 parses to -Infinity, dodging an over-band-only check), and the kept value is normalized to the coerced number - a numeric STRING passing here would ship verbatim in the write-out, where the page's wmTrust (typeof number) zeroes it, and helper and pages would judge one version under two trust regimes
for(const k of ['savedAt', 'builtAt', 'held']) state[k] = Number(state[k]) > 0 && Number(state[k]) < bandRef + 6e5 ? Number(state[k]) : 0
// no consumer matches a tombstone past the page's 40-character id rule, and a sliced key could alias another element's, so an over-long id never enters the carried set at all
const tombId = id => typeof id === 'string' && id.length <= 40
// the carried entries, normalized once: every tomb consumer below reads this one filtered view (bounded like the page bounds them), so the id rule cannot drift between consumers
const carriedTomb = Array.isArray(state.tomb) ? state.tomb.slice(-500).filter(p => Array.isArray(p) && tombId(p[0])) : []
// held rides the same door as its watermark siblings (a no-store run ships these verbatim, so this is the only gate): a zeroed hold drops whole, ids included, and the kept [id, stamp] pairs are bounded the way every reader bounds them - a pair's stamp obeys the same positive in-band rule as the scalar (honest producers clamp to their own clock), so a forged stamp cannot pin an unsheddable hold, and typed the way the page's filter types it (Number.isFinite, never a coerced numeric string): the full-list vouch below counts these pairs, and a string-stamped pair the page rejects must not vouch the anchor here - helper and pages judge one version under one trust regime. A pair's optional third slot counts consecutive doc-less dump runs (the decay contract at the carry-forward) and its fourth keeps the RAW claim where a write-out's floor lifted the shipped stamp (heldRaw below); each reads under one narrow rule or falls to nothing, so forging either only decays or widens the forger's own pair - powers a state writer already has outright
if(!state.held){ delete state.held; delete state.heldIds } else state.heldIds = Array.isArray(state.heldIds) ? state.heldIds.filter(p => Array.isArray(p) && tombId(p[0]) && Number.isFinite(p[1]) && p[1] > 0 && p[1] < bandRef + 6e5).map(p => { const m = Number.isInteger(p[2]) && p[2] > 0 ? Math.min(p[2], 2) : 0; const c = Number.isFinite(p[3]) && p[3] > 1 && p[3] < p[1] ? p[3] : 0; return c ? [p[0], p[1], m, c] : m ? [p[0], p[1], m] : [p[0], p[1]] }).slice(0, 500) : undefined
// the anchor a full slice shipped: every write-out mints its scalar one below its own pair minimum, so only a FULL 500-pair list - the shape a slice that evicted pairs ships, where the scalar still answers for the evicted docs - may floor this run's re-mint below its pairs. A shorter list's lower scalar is out of contract (state.held is viewer-writable): honoring it would let one forged tiny scalar latch through every later write-back, where healing to the pair minimum costs the forger exactly their own claim (the page's publish applies the same corroboration to embeddedHeld). The vouch checks shape, not provenance - any link holder can ship a full list of fabricated doc-less pairs no artifact ever sheds - so the carry-forward's decay below is what keeps the shape forgeable only at a running cost: a list that stays doc-less across consecutive doc-yielding dumps develops slack, unvouches on the next load, and the scalar heals
const heldAnchor = state.held && Array.isArray(state.heldIds) && state.heldIds.length >= 500 ? Math.min(state.held, bandRef) : Infinity
// each watermark component anchors on its own merits (a stale builtAt must not spoil an honest savedAt); with both out, the newest PAST stamp stands in. Anything ahead of this clock - watermark or stamp, even in-band - never anchors (a decoy near the band's edge would drag the anchor to this run's clock, a fiat win for every over-band copy) - but it does say the publish outruns every past stamp here: the pairs go incomparable and the write-out's fresh claim re-anchors
let inBandMax = 0, aheadMax = 0
const seeBand = t => { if(!Number.isFinite(t) || t >= bandRef + 6e5) return; if(t > bandRef){ if(t > aheadMax) aheadMax = t } else if(t > inBandMax) inBandMax = t }
for(const e of state.els) if(e) seeBand(Number(e.mv))
for(const p of carriedTomb) seeBand(Number(p[1]))
// post-zeroing each component is 0 or in-band, so only the in-band-future ones fall out here
let wmPast = 0, wmAhead = false
for(const v of [Number(state.savedAt), Number(state.builtAt)]) if(v > bandRef) wmAhead = true; else if(v > wmPast) wmPast = v
const verAnchor = wmPast || (wmAhead || aheadMax ? 0 : inBandMax)
const bandAt = t => t >= bandRef + 6e5 ? verAnchor : t
// raw over-band stamps are kept aside before banding: a store doc whose stamp is also over-band re-stamps to a later reading of this clock and would ALWAYS outrank the banded copy, so the store loop orders such a same-fast-clock-domain pair by its raw stamps. The raw stamp also rides the element (mvr), or the NEXT run has no raw side and the refused doc takes the win back. A rider is born wherever an over-band stamp is adopted, dies when a fresh stamp replaces its own, and feeds ONLY the raw-vs-raw compares - never seeBand/seeStamp or the in-band arms (ownMv marks entries whose own shipped stamp banded THIS run; only those go incomparable without an anchor). Raw-order power stops at the day ceiling at EVERY door - own stamp, rider, store doc - or a planted stamp is a permanent forged veto; past it a stamp bands and marks ownMv, raw-less. A caught-up rider graduates into the stamp, a non-finite mv falls to 0, and the page re-ships still-over-band riders only beside untouched stamps. coerced first: a string "9e99" would dodge a bare isFinite yet win every coerced compare below
const rideOk = r => r >= bandRef + 6e5 && r < bandRef + 864e5
// raw over-band tombstone stamps ride aside like rawMv, seeded before the element loop so a caught element rider graduates only past every tombstone raw that outranks it (the page's tombRaw gate): without the veto a version rider resurrects the fast era's own newer delete
const rawTomb = new Map(), ownTomb = new Set()
for(const p of carriedTomb) if(Number.isFinite(p[1])){ if(p[1] >= bandRef + 6e5){ ownTomb.add(p[0]); if(rideOk(p[1])) rawTomb.set(p[0], p[1]) } else if(Number.isFinite(p[2]) && rideOk(p[2])) rawTomb.set(p[0], p[2]) }
const rawMv = new Map(), ownMv = new Set()
for(const e of state.els) if(e){
  // raw-order power is strictly typed the way the page types it (rideIn and verMvRaw are
  // Number.isFinite, never a coerced numeric string; the tombstone third-slot doors above and below
  // read the same way): a string stamp or rider the page's raw doors drop must not hand the helper a
  // raw-order veto only the durable published record honors - and a coerced over-band e.mv must not
  // mint e.mvr as a genuine number, laundering the page-refused forgery into a rider every later load
  // honors - the two-trust-regimes split the watermark and heldIds doors already close. Only BANDING
  // stays coerced, because the page's bandEl coerces the same way (a string over-band mv bands to the
  // anchor on both judges, raw-less), and the rider-graduation compare below keeps the coerced m for
  // the same reason (the page's graduation gate reads Number(e.mv) || 0)
  const m = Number(e.mv), r = Number.isFinite(e.mvr) ? e.mvr : NaN
  if(Number.isFinite(e.mv) && e.mv >= bandRef + 6e5){
    ownMv.add(e.id)
    if(rideOk(e.mv)){ rawMv.set(e.id, e.mv); e.mvr = e.mv } else delete e.mvr
  }
  else if(rideOk(r)) rawMv.set(e.id, r)
  else{
    delete e.mvr
    const tr = rawTomb.get(e.id)
    if(Number.isFinite(r) && r < bandRef + 6e5 && !(Number.isFinite(m) && m >= r) && !(tr > r && tr - r < 864e5)) e.mv = r
  }
  const b = Number(e.mv)
  if(Number.isFinite(b)) e.mv = bandAt(b)
  else if(e.mv !== undefined) e.mv = 0
}
// deletes the version carries forward (state.tomb): what it carried plus this run's applied deletes and retires, newest kept per id, bounded like the page's copy. Built before the store loop so a store body races the version's own deletes as a live tab's write does: a body the tombstone outranks stays out; one that outranks sheds it
const tombs = new Map()
// an in-band rider graduates into the entry, as mvr does above - held below the version's own live same-id element (the write-out invariant read back: no honest version ships an element its tombstone outranks, so a rider that would is planted or stale and must not refuse honest store edits all run)
const liveMv = new Map(state.els.filter(e => e).map(e => [e.id, Number(e.mv) || 0]))
for(const p of carriedTomb) if(Number.isFinite(p[1])){ const lm = liveMv.get(p[0]); let g = Number.isFinite(p[2]) && p[2] < bandRef + 6e5 ? p[2] : 0; if(g && lm !== undefined && g >= lm) g = lm - 1; tombs.set(p[0], Math.max(bandAt(p[1]), g)) }
// which entries the version itself carried: the write-out below must not let store docs planted since evict them from the bounded carry (they are the record every stale draft and every skipped-a-version tab is checked against)
const verCarried = new Set(tombs.keys())
// store deletes with no evidence behind them - an element born and deleted between publishes leaves only its dead doc (the delete overwrote the upsert), so refusing these outright would drop a real delete; they ride the write-out at lowest eviction priority instead
const looseTombs = new Map()
// the version's published-id lineage (ids any publisher ever carried, bounded like the page's copy): the omission skip below trusts an omission only for an id the lineage knows - the page's gone() corroboration. The version's own els join at seed time: pub is bounded, an id can sit in els yet be evicted from pub, and an applied delete must not drop it from the lineage
const PUB_MAX = 4000
const pubIds = new Set()
if(Array.isArray(state.pub)) for(const id of state.pub.slice(-PUB_MAX)) if(tombId(id)) pubIds.add(id)
for(const e of state.els) if(e && tombId(e.id)) pubIds.add(e.id)
// a carried tombstone is itself proof its id was once published, so those ids join too: when the bounded carry later evicts the tombstone, the lineage record is what remains, and the ranked write-out below re-files it from covered to bare at that same moment - the omission record outlives the delete artifact
for(const p of carriedTomb) pubIds.add(p[0])
const storeHeld = new Map() // id to doc the dump carries that this run re-sends before any version does: standing marks, not fresh ones
if(storeDir){
  const { readdirSync } = await import('node:fs')
  const dir = storeDir.replace(/\/+$/, '') + '/els'
  let names = []
  try{ names = readdirSync(dir).filter(n => n.endsWith('.json')); dumpRead = true }
  catch(e){ if(e.code !== 'ENOENT') fail('cannot read the store dump at ' + dir + ' (' + e.code + ')') }
  // the cutoff never trusts a claimed future, and never trusts the band's width either: a watermark forged up to the band ahead of its publisher's clock reads as an ordinary past claim once this clock passes it, so the cutoff stands the band's full width behind the claim - a forgery never silences work made after it was published; an honest version loses only re-applied echoes. An in-band-future claim is honest skew: it counts, held to this clock. With both watermarks zeroed the newest past stamp stands in - UNLESS in-band-future stamps say the publish outran every past stamp here: the newest one (band-capped by seeBand, the skip pub-corroborated) bounds the skip instead - but ONLY there: past an honest watermark it would swallow post-publish writes from ordinarily-skewed tabs. The flip side is accepted: past an honest watermark a stale pre-publish doc stamped ahead of this clock replays - visibly, and a re-delete outranks it - where any wider bound silently swallows post-publish writes. An over-band doc is never judged by omission at all: the version's raw evidence collapses to one viewer-writable scalar a single near-ceiling rider dominates for a day across every omitted id, artifact-free - such docs ride as last-writer-wins, checked only by per-id artifacts (a tombstone, a live element)
  const trusted = v => { const n = Number(v) || 0; return n <= 0 || n >= Date.now() + 6e5 ? 0 : Math.min(n, Date.now()) }
  const wmClaim = Math.max(trusted(state.savedAt), trusted(state.builtAt))
  const claimed = wmClaim || Math.max(inBandMax, aheadMax)
  // the version's capacity hold widens only the replay cutoff (a doc the publisher's full board refused must be read again), never the omission bound (claimed): a forged tiny hold re-reads echoes per-id verdicts still judge, where a shrunken claim would resurrect deleted-by-omission ids. The held [id, stamp] pairs name which docs the hold covers and at what stamp, so the omission skip can exempt exactly them and a covering shed compares each doc's TRUE stamp, never the batch minimum (a scalar alone would let the skip swallow a replayed capacity-refused doc of a published-lineage id forever, and min-seeded ids would shed on deletes below the doc's real stamp); forging a pair here only exempts that id from the skip, the same power stripping it from pub already grants. The band is subtracted from the WATERMARK side only: the hold scalar is already one below the oldest covered doc's own store stamp, so no skew allowance is owed - and a banded hold would self-feed, each run's shipped scalar entitled to sit a band below the incoming claim, walking every reader's cutoff (and the 500 oldest pair slots) down a band per write-back
  heldClaim = trusted(state.held)
  // one pass, one id predicate, three views of the pairs: the shipped stamp (heldIds), the doc-less-run count (heldMiss, the decay contract), and the raw claim below
  // the pair's RAW claim (its fourth slot, minted where a write-out floored the shipped stamp at the scalar): the omission exemption judges here, never at the floored stamp - a forged in-band-future scalar lifts every uncovered shipped stamp above its doc, and judging there would silence the held doc through the very exemption meant to shield it, one laundering write-back later
  const heldIds = new Map(), heldMiss = new Map(), heldRaw = new Map()
  if(heldClaim && Array.isArray(state.heldIds)) for(const p of state.heldIds){ if(!Array.isArray(p) || typeof p[0] !== 'string' || p[0] !== idKey(p[0])) continue; heldIds.set(p[0], p[1]); if(p[2]) heldMiss.set(p[0], p[2]); heldRaw.set(p[0], p[3] || p[1]) }
  // the rank vouch (capDump below) anchors on THIS RUN'S OWN CLOCK - the one anchor no state writer
  // mints. The watermark is viewer-writable to any in-band-past value, so anchoring rank there lets
  // the same writer place the floor just below week-old plants (and the cutoff's inBandMax fallback,
  // minted from the version's own element stamps, is that hole one step removed). A refusal outside
  // the clock band is still recorded and replayable; it just ships unranked, bounding a flood's
  // forgeable age advantage at the band every honest skew already gets
  const bandFloor = Date.now() - 6e5
  const since = Math.max(0, Math.min((wmClaim || inBandMax) - 6e5, heldClaim || Infinity))
  const storeSeenIds = new Set()
  // sawValidDoc: whether this dump yielded at least one doc the door consumes - only such a run
  // advances the carry-forward's decay count below or spends the bare anchor at the write-out. The
  // per-id seen marks above the validity gate still stand (one doc per id, so even a junk copy under
  // a held id is the store's word for that id), but a junk-only copy proves nothing about the docs it
  // lacks. A dead doc counts deliberately: it skips the shape gate as a consumed store verdict, costs
  // a planter no less than a minimal live doc, and excluding it would let fabricated pairs ride an
  // honestly all-deleted board forever (no live doc ever arriving to advance their decay)
  for(const name of names){
    let doc; try{ doc = JSON.parse(readFileSync(dir + '/' + name, 'utf8')) }catch(_){ continue }
    if(!doc || typeof doc !== 'object') continue
    // a real element never carries these as own keys; a planted "__proto__": {author:'claude'} would
    // read as undefined here (so the claim-strip below never fires) yet ride Object.assign's [[Set]]
    // into a real prototype on the pushed element, inheriting claude's ink - drop any such doc outright
    if(POISON_KEYS.some(k => Object.hasOwn(doc, k))) continue
    // the page's store keeps one doc per id, saved under read_db's escaping of it ('~' -> '@' everywhere, ':' -> '%3A' in a Windows/WSL dump): a body claiming an id whose escaped spellings do not match the filename is a forgery vector (two files for one id could manufacture body-then-dead "evidence" for a junk tombstone) - dropped, and the first doc seen per id counts
    const base = name.slice(0, -5)
    let id = base
    if(typeof doc.id === 'string'){
      const esc = doc.id.replace(/~/g, '@')
      if(base !== esc && base !== esc.replace(/:/g, '%3A')) continue
      id = doc.id
    }
    if(storeSeenIds.has(id)) continue
    // the page never keeps an id longer than idKey's 40 characters, so a longer one in the dump is
    // forged: findIndex compares the full id (never a hit) while the claim guard keys on the idKey
    // prefix, so it would ride a claimed id's prefix into the board as a shadow element - drop it,
    // before it marks the dump as seen: a planted junk-id doc must not turn an otherwise empty copy
    // into a "doc-yielding" one that advances the carry-forward's decay count
    if(id !== idKey(id)) continue
    storeSeenIds.add(id)
    // the page's rule (sanitize/netApply in template.html): minutes of skew are kept as sent - floor-adopted tabs legitimately stamp ahead of this clock, and clamping their deletes below the elements they beat would resurrect deleted content - while a stamp past the floor's budget counts from arrival, one rule so nothing applied outranks this run's stamps
    let t = Number.isFinite(doc.dead) ? doc.dead : Number.isFinite(doc.mv) ? doc.mv : 0
    let rawT = t
    if(t >= Date.now() + 6e5){ t = Date.now(); if(Number.isFinite(doc.dead)) doc.dead = t; else doc.mv = t }
    // past the day ceiling a doc gets no raw-order power either: it re-homes to arrival outright, or the dump would be the one door where an unbounded forged stamp still won
    if(rawT !== t && !rideOk(rawT)) rawT = t
    // a body whose type or shape the page's sanitize never admits can land NOWHERE - pushed it would fill board slots this run only to be scrubbed by the door and every tab's sanitize next load, having capacity-refused honest docs - so it is refused up front; a dead doc has no type and rides (no capHold either: a doc that can never land must not freeze the hold)
    if(!Number.isFinite(doc.dead) && (!EL_TYPES.has(doc.type) || !penOk(doc))) continue
    sawValidDoc = true
    const i = state.els.findIndex(e => e && e.id === id)
    seeStamp(t)
    // the newest edit the dump carries, held to this clock: builtAt marks when the dump was taken, and an as-sent future stamp must not push the next run's cutoff past honest edits
    storeSeen = Math.max(storeSeen, Math.min(t, Date.now()))
    // a doc and a version copy that were BOTH over-band share the fast-clock domain, where raw order is honest (banded, the re-stamped doc would always win) - and an in-band doc inside the raw side's own band belongs to that domain too, or the fast era's superseded docs would win the moment this clock reads them as in-band. Below the band in-band work compares banded and lands: a planted rider's veto stops at its band and the day ceiling. A mixed pair compares banded (the copy sits at verAnchor); with no anchor a THIS-run-banded copy keeps its win on both sides - ownMv marks it
    const elRaw = i === -1 ? undefined : rawMv.get(state.els[i].id)
    const docBeats = fallback => elRaw !== undefined && (rawT !== t || rawT > elRaw - 6e5) ? rawT >= elRaw : !ownMv.has(id) || verAnchor ? fallback : false
    if(Number.isFinite(doc.dead)){
      // a delete stands when the version no longer carries the element (whenever it happened - a later
      // version confirms it by omission) or when it is newer than both the version and the element
      const elMv = i === -1 ? 0 : Number(state.els[i].mv) || 0, gone = i === -1 || (t > since && docBeats(elMv <= doc.dead))
      if(gone && i !== -1){ state.els.splice(i, 1); storeApplied++ }
      // a delete doc for an id neither the version nor its tombstones ever carried still rides the write-out, but as a loose entry (lowest eviction priority): the carried set is bounded, so junk delete docs planted in the store must never evict the real deletes - and storeDead still keeps such an id out of this run's additions
      if(gone){
        storeDead.add(idKey(id)); const prev = tombs.get(id)
        if(tombId(id)){
          // the winning delete brings its own provenance: an over-band dead doc's raw stamp becomes the rider, replaced only by a delete that outranks its raw side (a stale dead doc must not demote or shed a rider it never outranked). The banded stamp only advances: a refused in-band delete still raises it, a raw win never lowers it below copies it beat; a spliced element's stamp stays, its raw side riding
          if(i !== -1 || prev !== undefined){
            const pRaw = rawTomb.get(id)
            if(pRaw === undefined ? t >= (prev || 0) : rawT > pRaw || (rawT === t && t > (prev || 0))){ tombs.set(id, Math.max(t, prev || 0, elMv)); if(rawT !== t) rawTomb.set(id, rawT) }
            else if(elMv > (prev || 0)){ tombs.set(id, elMv); if(rawT !== t && pRaw === undefined) rawTomb.set(id, rawT) }
          }
          else{ looseTombs.set(id, Math.max(0, t)); if(rawT !== t) rawTomb.set(id, rawT) }
        }
      }
      continue
    }
    // a live doc for an id this run re-sends marks that id STANDING whatever verdict refuses its body
    // below (the replay cutoff, the omission skip, a losing tombstone race): the stash feeds only the
    // 27-character anchor gate and the sug-standing rule in the --add path - the body itself never
    // lands from the stash (the --add stays the word on content and geometry), and a planted doc's
    // missing sug only clears suggestion state, a power the store loop's own rule already grants a
    // store writer - so stashing a verdict-refused doc hands a forger nothing while an honest
    // standing mark keeps the id it has instead of failing the whole write-back as "fresh"
    if(runIds.has(id) && i === -1) storeHeld.set(id, doc)
    // a held doc passes the cutoff at its RAW claim even when a forged high scalar closed the window: skipped-but-seen would shed the pair at the carry-forward below with the doc never judged, erasing the hold in one run - exempted, the doc lands, is re-refused (dump-backed only when in-BAND - the watermark arm alone, never the scalar or claim arms: scalar, claim and doc are all plantable, so an admission below the band keeps carried rank - promoted there, 500 planted old docs under a forged tiny scalar or tiny-claim pairs would turn dump-backed at those stamps and front every oldest-first bound, evicting the holds real refusals earned), or meets a verdict, each an artifact the shed can trust (per-id echo replay is the power forging a pair already grants)
    if(t <= since && !(heldRaw.get(id) <= t)) continue
    // in the widened window (between since and the claim itself), an in-band upsert for an id the version omits is a delete by whoever saved - but only when the version's published-id lineage (pub) carries the id, the page's gone() corroboration: a bare omission gated by the viewer-writable claim alone would let a claim forged inside the band silently drop collaborators' NEW elements. A forger who can write pub can already write a tombstone (no new power); never-published ids ride the window as last-writer-wins, and a version too old to carry pub keeps no skip. A held id is exempt only AT OR ABOVE its pair's stamp: the hold vouches one refused doc at one stamp, and a wholesale exemption would let a forged pair above a real tombstone shield stale bodies below both - the delete's replay, once the bounded carry evicts the tombstone
    if(i === -1 && rawT === t && t <= claimed && !tombs.has(id) && pubIds.has(id) && !(heldRaw.get(id) <= t)) continue
    // the version's own deletes race a store body like the page's write-time check: a body the tombstone outranks stays out (a tie loses for a body), one that outranks it sheds it. An over-band pair - or an in-band body inside the raw side's band (the docBeats rule) - orders by the fast domain's raw stamps; an in-band body below the band compares banded, and a body against a riderless own tombstone with no anchor loses, as every tie does. A HELD doc losing this race keeps its hold (the page's store-only shed rule), re-stamped at the doc's OWN stamp, floored just above the scalar and THEN capped at the covering tombstone's: the dump vouches the doc's stamp, never the pair's viewer-writable claim - and when the floor's lift outruns the doc, the vouched stamp rides the fourth slot as the pair's raw claim (capRaw), or the shipped pair reads bare at the lifted stamp and every raw-claim judge - the cutoff and omission exemptions, the scalar mints, the next reader's capClaim - would take one forged scalar's lift for the claim and shed the hold with the doc never judged - 500 forged old pairs naming live docs would otherwise turn dump-backed at the forged stamps and front every oldest-first bound, evicting the holds real refusals earned - while any stamp above the tombstone's (a re-homed over-band body loses the raw race however new its banded stamp reads, and the floor's scalar is viewer-writable up to this clock, so the cap must have the last word) would ship the pair uncovered at every stamp compare, unpinning the verdict in both carries' cover tiers and exempting the pair from the drop below, exactly the eviction-then-replay this keep must never open; the carry-forward below and the page's load re-arm cap only their FLOOR (a doc-less pair's own stamp may honestly outrank an old tombstone - the re-add shape - and the at-or-above omission rule above denies an uncovered pair any reach below its claim) - and the dump still carries the id as a live body (one doc per id, so no store delete covers it) while the carried tombstone is room-raisable evidence with no provenance; the tombstone still outranks the doc at every judge, and both carries seed a held id's tombstone in their protected tier (the page keys its seeded tier on capRefused; here a racing tombstone is version-carried by construction), so the verdict outlives room floods - and should a flood breach the seeded tier anyway, the write-out ships a race-kept hold only while its covering tombstone ships (the tie below state.tomb), so hold and verdict die together and the kept hold costs replay width, never a resurrection
    const tv = tombs.get(id)
    if(tv !== undefined){
      const tRaw = rawTomb.get(id), bodyOver = rawT !== t
      const bodyWins = tRaw !== undefined && rawT > tRaw - 6e5 ? rawT > tRaw : bodyOver ? false : verAnchor || !ownTomb.has(id) ? t > tv : false
      // the rank pin needs BOTH stamps in-band - the doc's vouched stamp and the shipped one: a re-homed over-band body reads t = this clock (in-band by construction) while the tombstone cap ships kt at the tombstone's stamp, so gating on t alone would ship a capDump-ranked pair at a forged week-old stamp, the ranked-old shape the band exists to deny (the page's rule: rank and a below-band stamp never coexist on a shipped entry)
      if(!bodyWins){ if(heldIds.has(id)){ const kt = Math.min(Math.max(t, heldClaim + 1), tv); capIds.set(id, kt); if(t > bandFloor && kt > bandFloor) capDump.add(id); if(t > 1 && t < kt) capRaw.set(id, t) } continue }
    }
    // EVERY refusal refuses the body BEFORE consuming the records it outranked (the page's netApply rule): the refused path applies nothing. A full board must not let a store flood ship a version stripped of a delete it never displaced (that refusal sits at the top of the loop, ahead of the omission record); a --retire of an id the version carries only as a tombstone must not let one planted upsert shed that tombstone while the runIds skip refuses its body (the retire mint walks state.els, so nothing would restore it - the version would ship with neither element nor tombstone); a body the version's own copy outranks must not strip the losing delete record the carry still ships
    // this run adds or retires this id. Skip the store's copy only when the version does not already
    // carry the id (i === -1): there the copy would just collide with --add's guard or shadow the retire,
    // and the run's own --add/--retire is the authoritative word (it lands below with the session's
    // content). When the version does carry the id, the store copy holds a viewer's in-place edit to that
    // mark (a drag/resize, or a Keep that cleared sug) and must still land so the update below sees it.
    if(runIds.has(id) && i === -1) continue
    // a doc refused purely for capacity - and only past every per-id verdict above, which each embody a surviving record (the cutoff, the omission skip, a tombstone, this run's authoritative add or retire; the page orders its arms the same way) - is judged by NOTHING: it lands nowhere and leaves no tombstone, so the write-out ships the oldest such stamp minus one as state.held, keeping every reader's replay window open until the doc lands or a per-id artifact covers it, while builtAt keeps the full claim (a judged doc must never freeze the hold, and a hold must never shrink the omission bound). Every doc here already passed the cutoff (t > since, or a held doc exempted at its raw claim), which anchors on the claim and the hold - never on this clock: a Date.now() anchor refused a 15-minute-old honest doc with NO hold whenever the watermark collapsed (an over-band publisher), silencing it forever, while junk below the cutoff never reaches this arm and a pair at or below 1 dies at the write-out
    if(!Number.isFinite(doc.dead) && i === -1 && state.els.length >= MAX_ELS){ capIds.set(id, t); if(t > bandFloor) capDump.add(id); continue }
    if(i !== -1 && !docBeats((Number(state.els[i].mv) || 0) <= t)) continue
    // the body lands on both arms below: only now are the records it outranked consumed
    tombs.delete(id); rawTomb.delete(id)
    // the store is client-writable, so a doc's claude tag is only a claim: claude ink survives the dump
    // only for an id this version already attributes to claude (never on an id the doc names on its own).
    // A dump may clear suggestion state (a Keep on the board stands) but never grant it.
    const on = state.els[i]
    if(on && isClaudes(on)){ doc.author = 'claude'; delete doc.by; if(!(doc.sug === true && on.sug === true)) delete doc.sug }
    else if(isClaudes(doc) || doc.sug){ delete doc.author; delete doc.by; delete doc.sug }
    // the winner ships its own provenance: over-band bodies carry their raw stamp as the rider, any rider the doc itself claims is dropped rather than trusted - and a winner never ships below what it beat: not the replaced copy's banded stamp, and not the shed tombstone's (a tie loses for a body, so a stale draft still holding it would eat the win)
    const won = Object.assign({}, doc, {id})
    if(rawT !== t) won.mvr = rawT; else delete won.mvr
    if(tv >= t) won.mv = tv + 1
    if(i === -1){ state.els.push(won); storeApplied++ }
    else {
      // the store holds a placeholder for a picture too big for a doc: it never blanks bytes the version carries
      if(doc.type === 'image' && !doc.src && state.els[i].src) won.src = state.els[i].src
      won.mv = Math.max(Number(won.mv) || 0, Number(state.els[i].mv) || 0); state.els[i] = won; storeApplied++
    }
  }
  // a held id the dump yielded no doc for got no verdict this run: the store retains every doc, so absence means the DUMP is partial or stale (a mis-pathed or truncated read_db copy), never that the doc is gone - the version's own hold carries forward at its pair's stamp (floored just above the scalar, with only the FLOOR capped at the covering tombstone: the floor's scalar is viewer-writable and must not lift a pair above its verdict, but the pair's own stamp stands even above the tombstone - a deleted-then-re-added id whose re-add was refused honestly ships its pair above the old delete, and dragging it down would judge the hold at a stamp the refusal never had) unless the id is live on the board. A covering carried tombstone does NOT kill the carry: it is room-raisable evidence with no store provenance, and it still outranks the doc at every judge (seeded in both carries' protected tiers alongside the hold, so a room flood cannot strip the verdict while the hold keeps the doc replayable) - only the dump's own dead doc (store evidence at its stamp, which marks the id seen) sheds the hold. But absence-means-partial cannot hold forever, or 500 fabricated pairs for never-existing ids - which no doc, tombstone, or live element ever sheds - re-mint every run and keep a forged full list vouching its own tiny scalar permanently (the heldAnchor contract's must-not case, and the page's baseless-hold purge has no dump-side sibling): each pair rides a doc-less-run count in its third slot, incremented only when this dump yielded at least one VALID doc (sawValidDoc, set past every shape gate: an empty, unreadable, or junk-only copy proves nothing about the docs it lacks), reset wherever the dump vouches the id, and the pair decays at three consecutive misses. Decay ends the pair, never the doc's last chance: the decayed pair's raw claim still anchors this write-out's scalar (capDecay, shipped bare when no pair survives - a shape the door already reads and the next write-out heals as any unvouched scalar; the page carries a bare loaded scalar until its first server-backed view, so a Save cannot spend the generation unseen), keeping every reader's replay CUTOFF open one more generation for a complete dump to land the doc or re-refuse it dump-backed. The anchor re-opens only the cutoff: a pub-lineage id whose tombstone the carry evicted is still judged by the omission skip, the base rule's last word, and a real doc missing from that fourth consecutive doc-yielding copy too is the anomaly this trades away. Forging the count only hastens a shed a state writer could perform outright by omitting the pair, and the anchor bounds what the hastening buys
  if(dumpRead){ const liveIds = new Set(); for(const e of state.els) if(e) liveIds.add(e.id); const missInc = sawValidDoc ? 1 : 0; for(const [hid, hs] of heldIds){ const cv = tombs.get(hid); const hSt = Math.max(Number(hs), Math.min(heldClaim + 1, cv === undefined ? Infinity : cv)); if(!storeSeenIds.has(hid) && !capIds.has(hid) && !liveIds.has(hid)){ const ms = (heldMiss.get(hid) || 0) + missInc; if(ms >= 3){ const dc = Math.min(heldRaw.get(hid), Date.now()); if(dc > 1 && dc < capDecay) capDecay = dc; continue } capIds.set(hid, hSt); if(ms) capMiss.set(hid, ms); const cr = heldRaw.get(hid); if(cr < hSt) capRaw.set(hid, cr) } } }
}

// --- pictures: write them out for reading and stop; nothing about the board changes ---
if(extractDir){
  const { mkdirSync } = await import('node:fs')
  mkdirSync(extractDir, { recursive: true })
  const IMG = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/
  let n = 0
  const taken = new Set() // two ids can sanitize to one name; every picture still gets its own file
  for(const e of state.els){
    if(!e || e.type !== 'image' || typeof e.src !== 'string') continue
    const m = IMG.exec(e.src); if(!m) continue
    const base = String(e.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || ('img' + n)
    let safe = base
    for(let k = 2; taken.has(safe); k++) safe = base + '-' + k
    taken.add(safe)
    const file = extractDir.replace(/\/$/, '') + '/' + safe + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1])
    writeFileSync(file, Buffer.from(m[2], 'base64'))
    process.stdout.write(file + '\t' + [e.x, e.y, e.w, e.h].map(v => Math.round(Number(v) || 0)).join(',') + '\t' + (e.author === 'claude' ? 'claude' : 'user') + '\t' + JSON.stringify(safeEcho(e.label, 120)) + '\n')
    n++
  }
  if(!n) process.stdout.write('no images on the board\n')
  if(pageCodeWhy) process.stdout.write('page code: not this skill\'s own (' + pageCodeWhy + ') \u2014 an older version of the skill may have written it, or someone republished the board with altered page code; rebuild it clean with a write-back now and tell the user in one plain line\n')
  process.exit(0)
}

// --- enforce the authorship rules on the additions (read up front, beside the state read) ---
const onBoard = new Map(state.els.map((e, i) => [e && idKey(e.id), i]))
const batchIds = new Set()
for(const id of retire){
  const el = state.els.find(e => e && e.id === id)
  if(!el) continue
  if(!isClaudes(el)) fail('refusing to retire ' + id + ': not authored by claude')
}
const ADDABLE = new Set(['text', 'rect', 'ellipse', 'cylinder', 'diamond', 'sticky', 'arrow'])
// everything this run adds or changes is an edit made now: open tabs merge by newest edit per element, so "now" rides the same floor the page's stamp() does - above adopted honest skew; the band pass above the store loop keeps every state stamp adoptable, so "now" outranks all
for(const e of state.els) if(e) seeStamp(e.mv)
// the carried tombstones too (the page adopts its tomb stamps the same way): a mark re-added under a retired id must outrank the version's own tombstone, or it ships already-dead
for(const t of tombs.values()) seeStamp(t)
// minted with this run's own fraction, like the page's stamp(): riding the adopted stamp's fraction would exactly tie the next mint of the tab it was adopted from, and a cross-writer tie silently loses one side (delete wins a tie, and so does the version on reload)
const now = Math.max(Date.now(), Math.floor(stampFloor) + 1) + Math.random()
const fresh = [] // additions not on the board yet; the rest are marks of yours the board already carries
const inPlace = new Set()
let updated = 0, leftOut = 0
for(const e of additions){
  if(!e || typeof e !== 'object' || !ADDABLE.has(e.type)) fail('additions must be text, rect, ellipse, cylinder, diamond, sticky or arrow (got ' + JSON.stringify(e && e.type) + ')')
  e.author = 'claude'; e.mv = now; delete e.mvr // this run's own stamp carries no rider
  if(typeof e.id !== 'string' || !e.id.startsWith('cl_')) fail('every addition needs an id starting with cl_ (got ' + JSON.stringify(e.id) + ')')
  // the page keeps ids to 40 characters, so a longer one would no longer be unique on the board
  if(e.id.length > 40) fail('addition id ' + JSON.stringify(e.id.slice(0, 40)) + '\u2026 is over 40 characters \u2014 shorten it')
  if(batchIds.has(e.id)) fail('addition id ' + e.id + ' appears twice in this batch')
  batchIds.add(e.id)
  if(retire.has(e.id)) fail('addition id ' + e.id + ' is also being retired \u2014 do one or the other')
  if(storeDead.has(e.id)){ // someone deleted this mark since you drew it: the write-back must not bring it back
    process.stderr.write('whiteboard merge: ' + e.id + ' was deleted on the board since you drew it \u2014 left out; draw it again under a new id if it is still wanted\n')
    leftOut++; continue
  }
  // a fresh id over 27 characters overflows the comment anchor grammar ('wb-a-' + id must fit
  // 32), demoting that mark's comment pins to fallbacks; a standing mark keeps the id it has,
  // whether the version carries it or only the store dump does (a mark drawn live and re-sent
  // here, per the write-back rule) - after the storeDead leave-out so a deleted long id is
  // still left out quietly instead of failing the whole write-back
  if(e.id.length > 27 && !onBoard.has(e.id) && !storeHeld.has(e.id)) fail('addition id ' + JSON.stringify(e.id) + ' is over 27 characters \u2014 shorten it so comment pins can anchor to it')
  if(!Number.isInteger(e.seed)) e.seed = 1 + Math.floor(Math.random() * 1e9)
  // a text node may carry its font size; clamp it to the range the page itself accepts
  if(e.type === 'text'){
    if(Number.isFinite(e.size)) e.size = Math.max(8, Math.min(64, e.size))
    else delete e.size
  }
  const i = onBoard.get(e.id)
  if(i === undefined){
    // a store-held mark is standing (the 27-char gate above already treats it so), but the
    // store is client-writable: the --add stays the word on content AND geometry - a planted
    // doc must never steer where claude ink lands (the forge test pins this) - while a cleared
    // sug still stands, since a dump may clear suggestion state but never grant it (the store
    // loop's own rule); a viewer's Keep on a live-drawn suggestion therefore survives re-send
    const held = storeHeld.get(e.id)
    if(held && !(e.sug === true && held.sug === true)) delete e.sug
    fresh.push(e); continue
  }
  // a mark you drew live came back with the board: your write-back is the word on what it says,
  // the board on where it sits (for an arrow, what it is bound to is where it sits)
  const on = state.els[i]
  if(!isClaudes(on) || on.type !== e.type) fail('addition id ' + e.id + ' already belongs to another element on the board')
  if(e.type === 'arrow' && ((e.fromId ?? null) !== (on.fromId ?? null) || (e.toId ?? null) !== (on.toId ?? null)))
    process.stderr.write('whiteboard merge: ' + e.id + ' keeps the ends it has on the board \u2014 to point it elsewhere, retire it and draw a new arrow\n')
  for(const k of (e.type === 'arrow' ? ['x1', 'y1', 'x2', 'y2', 'fromId', 'toId'] : ['x', 'y', 'w', 'h']).concat(['seed']))
    if(on[k] !== undefined) e[k] = on[k]; else delete e[k]
  // and on suggestion state: a Keep or Dismiss made on the board must not be undone by a
  // write-back that re-states (or omits) sug
  if(on.sug === true) e.sug = true; else delete e.sug
  state.els[i] = e; inPlace.add(e.id); updated++
}
// --- an arrow binds only to a box, sticky, text node or picture on the board; the page clears anything else ---
const CONNECTABLE = new Set(['text', 'rect', 'ellipse', 'cylinder', 'diamond', 'sticky', 'image'])
const bindable = new Set(state.els.concat(fresh)
  .filter(e => e && !retire.has(e.id) && CONNECTABLE.has(e.type)).map(e => idKey(e.id)))
for(const e of additions){
  if(e.type !== 'arrow') continue
  for(const k of ['fromId', 'toId']){
    if(e[k] == null || bindable.has(e[k])) continue
    // a binding kept from the board: a retired target lets it go below, where it stood; a vanished one just lets go
    if(inPlace.has(e.id)){ if(!retire.has(e[k])) e[k] = null; continue }
    fail(e.id + ': ' + k + ' must name a box, sticky, text node or picture on the board (got ' + JSON.stringify(String(e[k]).slice(0, 40)) + ')')
  }
}

// --- geometry: the same boxes the page uses, with an estimate for unmeasured text ---
function textSize(txt, px){
  const lines = String(txt || '').split('\n')
  let cols = 0
  for(const l of lines) if(l.length > cols) cols = l.length
  return {w: Math.ceil(cols * px * 0.62 + 12), h: Math.ceil(lines.length * px * 1.35) + 8}
}
function bbox(e){
  switch(e.type){
    case 'arrow': case 'line':
      return {x: Math.min(e.x1, e.x2), y: Math.min(e.y1, e.y2), w: Math.abs(e.x1 - e.x2), h: Math.abs(e.y1 - e.y2)}
    case 'pen': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for(const p of e.pts || []){ x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
      return {x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0)}
    }
    case 'text': {
      const m = textSize(e.text, Number.isFinite(e.size) ? e.size : FONT_SIZE)
      return {x: e.x, y: e.y, w: e.w || m.w, h: e.h || m.h}
    }
    case 'sticky': // notes default to the page's square; the label wraps and shrinks inside it
      return {x: e.x, y: e.y, w: e.w || STICKY_SIDE, h: e.h || STICKY_SIDE}
    default: return {x: e.x, y: e.y, w: e.w || 120, h: e.h || 60}
  }
}
const intersects = (a, b, m) =>
  a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y

// --- repositioning (--place) runs first, so additions are placed against the board as it will be ---
// anyone's element may be moved when the board is being organized; nothing but its box changes
const finite = (...ns) => ns.every(n => Number.isFinite(n))
const placePath = arg('place')
let placed = 0
if(placePath){
  let moves; try{ moves = JSON.parse(read(placePath, 'the placements file')) }catch(e){ fail('placements file is not valid JSON (' + safeEcho(e.message) + ')') }
  if(!Array.isArray(moves)) fail('placements must be a JSON array of {id, x, y}')
  for(const mv of moves){
    if(!mv || typeof mv.id !== 'string') fail('every placement needs an id')
    const el = state.els.find(e => e && e.id === mv.id)
    if(!el) fail('placement for ' + mv.id + ': no such element on the board')
    if(el.type === 'arrow' || el.type === 'line' || el.type === 'pen') fail('placement for ' + mv.id + ': only boxes, notes, text and pictures are repositioned; connectors follow their boxes')
    if(!finite(mv.x, mv.y)) fail('placement for ' + mv.id + ' needs finite x and y')
    // a picture keeps its size: a new box would distort it
    if(el.type === 'image' && (mv.w !== undefined || mv.h !== undefined)) fail('placement for ' + mv.id + ': a picture is moved, never resized \u2014 give x and y only')
    const dx = mv.x - el.x, dy = mv.y - el.y
    el.x = mv.x; el.y = mv.y
    if(finite(mv.w) && mv.w > 0) el.w = mv.w
    if(finite(mv.h) && mv.h > 0) el.h = mv.h
    el.mv = now; delete el.mvr
    // connectors bound to it keep their attachment; free ends that sat on it travel with it
    for(const c of state.els){
      if(!c || (c.type !== 'arrow' && c.type !== 'line')) continue
      if(c.fromId === el.id){ c.x1 += dx; c.y1 += dy; c.mv = now; delete c.mvr }
      if(c.toId === el.id){ c.x2 += dx; c.y2 += dy; c.mv = now; delete c.mvr }
    }
    placed++
  }
}

// --- retire: a connector that survives lets go of a retired element where it stood, as the page's
// own delete does; its edit stamp is left alone - this keeps how it looked, and its owner's edits win ---
for(const g of state.els){
  if(!g || !retire.has(g.id) || !CONNECTABLE.has(g.type)) continue
  const b = bbox(g), cx = b.x + b.w / 2, cy = b.y + b.h / 2
  for(const a of state.els){
    if(!a || a.type !== 'arrow' || retire.has(a.id)) continue
    if(a.fromId === g.id){ a.x1 = cx; a.y1 = cy; a.fromId = null }
    if(a.toId === g.id){ a.x2 = cx; a.y2 = cy; a.toId = null }
  }
}
for(const e of state.els) if(e && retire.has(e.id) && tombId(e.id)){ tombs.set(e.id, now); rawTomb.delete(e.id) } // retire is a fresh delete: "now" outranks every draft copy's stamp, and no stale rider rides it
state.els = state.els.filter(e => e && !retire.has(e.id))

// --- place each new non-connector addition clear of the board and of each other ---
const occupied = state.els.filter(e => e.type !== 'arrow' && e.type !== 'line').map(bbox)
for(const e of fresh){
  if(e.type === 'arrow'){ // connectors ride their endpoints; they still need real coordinates
    if(!finite(e.x1, e.y1, e.x2, e.y2)) fail(e.id + ': arrows need finite x1,y1,x2,y2')
    continue
  }
  if(!finite(e.x, e.y)) fail(e.id + ': needs finite x and y')
  let box = bbox(e)
  if(!finite(box.w, box.h) || box.w <= 0 || box.h <= 0) fail(e.id + ': needs a positive width and height')
  // the estimated size is written back so the published element renders the way it was placed
  e.w = box.w; e.h = box.h
  let spot = box, found = false
  // scan down-then-right from the requested spot until the box is clear of everything occupied
  outer: for(let ring = 0; ring < 40; ring++){
    for(let dx = 0; dx <= ring; dx++){
      const dy = ring - dx
      const cand = {x: box.x + dx * STEP, y: box.y + dy * STEP, w: box.w, h: box.h}
      if(!occupied.some(o => intersects(cand, o, MARGIN))){ spot = cand; found = true; break outer }
    }
  }
  if(!found) fail('no clear spot near (' + box.x + ',' + box.y + ') for ' + e.id + ' \u2014 move it to open space')
  e.x = spot.x; e.y = spot.y
  occupied.push(spot)
}

// --- the send marker is carried forward bounded the same way the page bounds it: an integer
// count in 0..1e9 and a short timestamp string, so a write-back never re-emits a malformed one ---
// captured before bounding: the rename guard must judge the marker as the board carried it,
// and bounding normalizes a present-but-unparseable marker (string count, ping with no
// numeric n) to absent/null - any truthy marker, parseable or not, means the board was sent
const everSent = Boolean(state.pingCount || state.ping)
const pingN = v => Number.isFinite(v) ? Math.max(0, Math.min(1e9, Math.floor(v))) : null
// derive the count the way the page does - the explicit field, else the marker's n - and never
// write a count the board didn't carry, so an older board keyed only by ping.n keeps its place
const markN = state.ping ? pingN(state.ping.n) : null
const rawNote = state.ping ? state.ping.note : undefined
const countN = pingN(state.pingCount)
if(countN !== null) state.pingCount = countN
else if(markN !== null) state.pingCount = markN
else delete state.pingCount
state.ping = markN === null ? null
  : {n: markN, at: typeof state.ping.at === 'string' ? state.ping.at.slice(0, 64) : null}
// the user's note rides the marker it was sent with, bounded like the page bounds it
if(state.ping && typeof rawNote === 'string' && rawNote) state.ping.note = rawNote.slice(0, 500)

// --- merge: the board minus retired own elements (above), plus the new additions ---
state.els = state.els.concat(fresh)
// the page keeps the first 2000 elements; an answer past that would never render
if(fresh.length && state.els.length > MAX_ELS) fail('the board is full (' + state.els.length + ' elements with yours; the page keeps ' + MAX_ELS + ') \u2014 nothing more can be drawn on it; tell the user')
// builtAt marks a version this helper built, and is the moment through which it reflects the store (the dump handed to --store): open tabs overlay only what came after it; 0 leaves savedAt as the cutoff. A capacity-refused doc is NOT reflected: state.held pins every reader's replay window below the oldest refused stamp - never inside the claim's max, where a prior builtAt above the stamp would erase the hold and ship a claim reaching past a doc this run never merged. A store run recomputes the hold from what it refused (each held doc lands, is judged, re-held, or carried forward when the dump has no doc for it); an unreadable dump (ENOENT) proves nothing and the version's own hold stands, as on a run without --store. The shipped pairs clamp to this clock (a stamp honestly minutes ahead must not read over-band on a slower tab's wmTrust, which would drop the whole hold there and let its next Save erase it board-wide) and keep 500 with DUMP-BACKED holds pinned ahead (this run saw those docs; a carried doc-less pair is unverifiable - room-writable heldIds could otherwise flood every slot with old junk stamps and evict the one hold a real refused doc earned, silencing it through the omission skip forever), each tier oldest-first and the scalar anchored on the minimum over EVERY surviving pair at its RAW claim (a floored stamp must not close the very window the pair holds open; a forged tiny claim only widens replay, the accepted direction), sliced or not - computed by loop, never a spread: capIds is dump-sized, and a flood past the engine's argument cap must not crash the run (the page's own eviction rule: the minimum is what the field obeys - a slice allowed to raise the scalar would drop the evicted pairs' docs below every reader's replay cutoff and silence them for good, where losing the pair costs only the omission exemption) and floored at the loaded anchor while a full LOADED pair list vouches it (heldAnchor; an unvouched lower scalar heals to this run's own minimum). The vouched anchor rides even a sub-full ship: slack says nothing about the doc-less docs only the scalar answers for (this dump may simply not have yielded them), so the anchor ends one load later, when the sub-full list reads unvouched and heals - by then every still-refused doc this dump held has re-earned its own pair (the cutoff opens down to the anchor), and one the dump never held is the partial-dump residual the pair carry-forward already accepts; a pair at or below 1 is junk the arm's window let through only by membership and ships as no hold; a carried doc-less pair ships its miss count in the third slot (the carry-forward's decay contract) and its raw claim in the fourth wherever the floored carry outran it (the omission judge must survive the lift, or one unwitnessed write-back launders the forged scalar into the next reader's claim), while a dump-backed pair ships bare - the dump reset both. A pair the carry-forward decayed this run ships no pair at all, but its raw claim still floors the scalar (capDecay) - alone, with heldIds dropped, when nothing else survives: the one-generation anchor the decay contract owes the doc, healed by the next write-out like any unvouched scalar. The heal itself obeys the decay's own evidence rule (sawValidDoc): a loaded bare anchor meeting a dump that yielded no valid doc re-ships at its trusted stamp rather than dying to a copy that proved nothing - only a doc-yielding dump spends the generation
state.builtAt = Math.max(Number(state.builtAt) || 0, storeDir ? storeSeen : 0)
// rank and a below-band SHIPPED stamp never coexist (the page's demote rule): every add site gates on it, and this demote is the structural backstop at the one point all pairs ship - a future site whose shipped stamp diverges from the stamp it gated must not front the slice or pin a tombstone at a stamp the band never vouched
const shipFloor = Date.now() - 6e5
if(storeDir && dumpRead){ const hpAll = [...capIds].map(p => { const st = Math.min(p[1], Date.now()); if(st <= shipFloor) capDump.delete(p[0]); const m = capMiss.get(p[0]) || 0; const c = capRaw.get(p[0]); return c > 1 && c < st ? [p[0], st, m, c] : m ? [p[0], st, m] : [p[0], st] }).filter(p => p[1] > 1); const hp = hpAll.sort((a, b) => capDump.has(a[0]) !== capDump.has(b[0]) ? (capDump.has(a[0]) ? -1 : 1) : a[1] - b[1]).slice(0, 500); for(let si = 500; si < hpAll.length; si++){ const v = hpAll[si][3] || hpAll[si][1]; if(v < capSlice) capSlice = v } if(hp.length){ let hm = Infinity; for(const p of hpAll){ const v = p[3] || p[1]; if(v < hm) hm = v } if(capDecay < hm) hm = capDecay; if(heldAnchor + 1 < hm) hm = heldAnchor + 1; state.held = hm - 1; state.heldIds = hp } else if(capDecay < Infinity){ state.held = capDecay - 1; delete state.heldIds } else if(!sawValidDoc && heldClaim){ state.held = heldClaim; delete state.heldIds } else { delete state.held; delete state.heldIds } }
// a watermark still ahead of this run's clock must not ride the write-back: tabs read embeddedAt from it and would silence their own store overlay for the residual window; this output reflects the store through now, its honest ceiling
if(Number(state.savedAt) > Date.now()) state.savedAt = Date.now()
if(state.builtAt > Date.now()) state.builtAt = Date.now()
// an incomparable run kept the version's over-band survivors, but shipping them at the banded 0 would hand them to every stale draft and refused doc one load later - the choice must stick, so survivors mint once at this run's own stamp (above the adopted floor, which a bare clock reading sits below); later work outranks it, no anchor floats, and the riders keep the raw order
if(!verAnchor){ for(const e of state.els) if(e && ownMv.has(e.id) && !Number(e.mv)) e.mv = now; for(const [id, t] of tombs) if(ownTomb.has(id) && !Number(t)) tombs.set(id, now) }
// no version may carry a live element its own tombstone outranks: every tab's loadState would hide what state.els still counts (the element budget, the anchors, placement). A tombstone that lost to a live element rides strictly below it - banding both sides at one instant can still tie an over-band pair, and a tie goes to the delete everywhere else
for(const e of state.els){
  if(!e) continue
  const t = tombs.get(e.id)
  if(t !== undefined && t >= (Number(e.mv) || 0)) tombs.set(e.id, (Number(e.mv) || 0) - 1)
}
for(const e of fresh) tombs.delete(e.id) // an id this run re-adds sheds its old tombstone, as the page's own re-add does
// the cap is a budget, not a window writable store docs may scroll. Pins, strongest first: this run's own retires cannot be evicted by anything the store or a version minted; a tombstone covering a DUMP-BACKED hold pins NEXT, only into the room the retires and the evidenced floor leave (the covering stamps are store-influenceable, so they must never displace this run's own word or its store-delivered delete evidence) and compared at the stamp the pair ships (clamped to this clock - an in-band-future hold must not strand its shipped pair unprotected), because the hold sheds only to store evidence and ships as long as it lives: its evicted verdict would let the drop below kill an honest hold; the version's carried entries come next, but that viewer-writable lineage never takes the whole budget - a floor stays reserved for this run's evidenced deletes, a seeded set over its share sheds oldest first (no latch); evidenced store deletes next, loose ones take the rest
const pinnedTombs = [], holdPins = [], seededTombs = [], evidencedTombs = []
// ranked by stamp, not by insertion: the map fills in readdir/filename order, and eviction by that order would hand a store writer the window the cap exists to deny - "sheds oldest first" means oldest DELETE, so each tier's slice keeps the newest stamps
const byStamp = (a, b) => a[1] - b[1]
for(const p of [...tombs.entries()].sort(byStamp)) (retire.has(p[0]) ? pinnedTombs : capDump.has(p[0]) && Math.min(capIds.get(p[0]), Date.now()) <= p[1] ? holdPins : verCarried.has(p[0]) ? seededTombs : evidencedTombs).push(p)
const looseCarry = [...looseTombs.entries()].filter(p => !tombs.has(p[0])).sort(byStamp)
// the floor counts evidenced deletes only: loose entries are unevidenced and take leftover room, so planted junk dead docs can never displace the version's carried tombstones - and the cover pins stop above it too, since a store writer manufactures covered holds at will and must not flood the run's own delete evidence out of the carry
const keep = Math.min(100, evidencedTombs.length)
let carryOut = pinnedTombs.slice(-500), carryRoom = 500 - carryOut.length
if(carryRoom > keep){ const coverPins = holdPins.slice(-(carryRoom - keep)); carryOut = carryOut.concat(coverPins); carryRoom -= coverPins.length }
if(carryRoom > 0){
  const n = carryRoom - keep
  const s = n > 0 ? seededTombs.slice(-n) : []
  carryOut = carryOut.concat(s); carryRoom -= s.length
}
if(carryRoom > 0){ const a = evidencedTombs.slice(-carryRoom); carryOut = carryOut.concat(a); carryRoom -= a.length }
if(carryRoom > 0) carryOut = carryOut.concat(looseCarry.slice(-carryRoom))
// the raw rider (third slot) rides the carry; the page reads entries positionally and republishes pairs
state.tomb = carryOut.map(p => { const r = rawTomb.get(p[0]); return r === undefined ? p : [p[0], p[1], r] })
// a hold lives exactly as long as the covering tombstone that justified it (the page's publish rule), judged by the covering relation itself so it holds on EVERY write-back, store run or not - and judged AT THE PAIR'S RAW CLAIM: a scalar-lifted shipped stamp would read a real later delete as not-covering, keeping the hold past its verdict's eviction and replaying the deleted body through the claim-anchored window, while an honest re-add's claim sits above its old tombstone and still ships: a dump-backed hold's tombstone is pinned above, so this drop mostly reaches version-seeded pairs - whose verdict a no-store run (--retire filling the carry) or a junk flood can evict - plus any dump-backed overflow the retires and the evidenced floor squeezed out of the pins, which dies by the same rule - shipped past that eviction, the heldIds omission exemption would let the deleted body replay and land once room freed. Hold and verdict ship together or not at all; with both gone the pub-lineage omission record has the last word (the base rule), and if the doc is real the next store run re-refuses it dump-backed, re-arming an honest hold. The rebase mints from the surviving pairs, floored at the vouched anchor (heldAnchor), at any claim the write-out's own 500-slice evicted this run (capSlice) and at any decayed this run (capDecay) - the slice-evicted docs were never judged and the scalar still answers for them, so raising past their claims here would silence them for good: the drop judged only the dropped ids, and a no-store run's drop is exactly the slack that must not end the anchor this generation - the sub-full ship reads unvouched on the next load and heals there, after a store view has had its chance to re-arm what the anchor answered for
if(state.heldIds){ const keptIds = new Set(carryOut.map(p => p[0])); const hp2 = state.heldIds.filter(p => !(tombs.get(p[0]) >= (p[3] || p[1])) || keptIds.has(p[0])); if(hp2.length !== state.heldIds.length){ let bm = Infinity; for(const p of hp2){ const c = Math.min(p[3] || p[1], Date.now()); if(c > 1 && c < bm) bm = c } if(capDecay < bm) bm = capDecay; if(capSlice < bm) bm = capSlice; if(bm < Infinity && heldAnchor + 1 < bm) bm = heldAnchor + 1; if(hp2.length && bm < Infinity){ state.held = bm - 1; state.heldIds = hp2 } else if(Math.min(capDecay, capSlice) < Infinity){ state.held = Math.min(capDecay, capSlice) - 1; delete state.heldIds } else { delete state.held; delete state.heldIds } } }
// the published-id lineage rides every write-back, so a later omission reads as the delete it is on every tab and every future run of this helper. The bounded slice evicts by rank like the tombstone carry above: an id the carried tombstones still cover sheds first (the tombstone keeps it off), a pure omission record - no artifact left but this list - sheds last, and the published els ride the tail where the bound cannot reach them
const pubLive = new Set()
for(const e of state.els) if(e && tombId(e.id)) pubLive.add(e.id)
const pubCarried = new Set(carryOut.map(p => p[0]))
const pubCovered = [], pubBare = []
for(const id of pubIds) if(!pubLive.has(id)) (pubCarried.has(id) ? pubCovered : pubBare).push(id)
state.pub = pubCovered.concat(pubBare, [...pubLive]).slice(-PUB_MAX)

// --- write the page: template + one state line after its <title>, "<" escaped as the page does ---
const esc = s => JSON.stringify(s).replace(/</g, '\\u003c')
const line = '<script type="application/json" id="wb-state">' + esc(state) + '</script>'
// one empty anchor per element, as the page's own publish writes them: comment threads hang on
// these, and only ids that are a plain token reach the markup
const anchors = '<div id="wb-anchors" aria-hidden="true">' + state.els.map(e => typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.id) ? '<i class="wb-a" id="wb-a-' + e.id + '"></i>' : '').join('') + '</div>'
// The page code comes ONLY from the skill's own template, authenticated by content hash
// (templateText above), so a fetched or foreign page can never be laundered into the publish
const tpl = templateText().split('\n')
// the only template line the output varies is its <title>: explicit name, else the board's own, else the default
let explicit = arg('title')
if(explicit !== undefined && (/^\s*--/.test(explicit) || /<topic>/i.test(explicit)))
  fail('--title needs the board\'s name (e.g. "Ingest pipeline whiteboard"), got ' + JSON.stringify(explicit))
const explicitTitle = titleFrom(explicit)
const title = explicitTitle || carried || DEFAULT_TITLE
if(!explicitTitle && !carried){
  // a sent board is named where the user can see it; with no --title and nothing to carry,
  // writing the default would silently rename it, so refuse unless the board was never
  // sent - judged on the pre-bounding marker (everSent above), never the bounded one
  if(everSent){
    // bounding already ran: only a marker that bounded to a positive send count evidences
    // a send - anything that bounds to zero (unparseable, negative, sub-1 fractional) does not
    const evidenced = (state.pingCount || 0) > 0 || Boolean(state.ping && state.ping.n > 0)
    fail((evidenced
      ? 'this board has been sent but --state carries no <title> to keep'
      : 'this board carries a send marker that could not be read as a send count, so it may have been sent, and --state carries no <title> to keep')
      + ' \u2014 pass the saved page (head included) so the board keeps its name, or pass --title')
  }
  process.stderr.write('whiteboard merge: no --title and the board carries no name \u2014 using the default title\n')
}
writeFileSync(outPath, ['<title>' + title + '</title>', line, anchors].concat(tpl.slice(1)).join('\n'))
process.stdout.write('wrote ' + outPath + ' \u2014 ' + fresh.length + ' added, ' + (updated ? updated + ' of yours updated in place, ' : '') + (leftOut ? leftOut + ' left out (deleted on the board), ' : '') + retire.size + ' retired, ' + (storeDir ? storeApplied + ' unsent edits taken from the store, ' : '') + (placePath ? placed + ' repositioned, ' : '') + state.els.length + ' elements total\n')
if(pageCodeWhy) process.stdout.write('page code: not this skill\'s own (' + pageCodeWhy + ') \u2014 an older version of the skill may have written it, or someone republished the board with altered page code; this output is the clean rebuild, so publish it now and tell the user in one plain line\n')
