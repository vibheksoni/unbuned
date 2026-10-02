// Whiteboard helper. Reads the published board a whiteboard page embeds
// (a JSON island with the scene, a text island with a PNG snapshot), reports
// what is on it, and writes the republishable page: the skill's own template
// with the two islands filled in - Claude's additions merged into the scene,
// the user's snapshot carried forward byte-for-byte. The page code comes only
// from the template, never from the fetched page. Runs on node or bun, no
// dependencies.
//
// inspect: node board.mjs --base <fetched page | bare island JSON> --inspect --template <template.html> [--png-out <board.png>] [--scene-out <scene.json>] [--images-out <dir>]
//          (--template is required whenever the base is a fetched page - the page code is verified against it; a bare island JSON base needs none)
// write:   node board.mjs --base <fetched page | bare island JSON | omit for an empty board>
//                         --template <template.html> --out <board.html>
//                         [--add <additions.json>] [--retire cl_a,cl_b] [--note "..."] [--title "..."] [--ack]
//          (--ack marks the write as the acknowledgement that a fuller answer follows; open tabs
//          show "Claude is drawing back" until the next write without it lands)
//          (a fetched-page base must carry known-good page code - a page
//          --inspect would report pageCodeAuthentic: false is refused)
//
// Additions are a JSON array. Boxes: {id, type: rect|ellipse|diamond|cylinder|sticky, x, y, w, h, label?}
// (a label becomes a centred text element `<id>_t`); text: {id, type: text, x, y, text, fontSize?};
// connectors: {id, type: arrow|line, x1, y1, x2, y2}. Optional on any: stroke, fill,
// strokeWidth, strokeStyle (solid|dashed|dotted), fontSize. Every id starts with cl_.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const DEFAULT_TITLE = 'Whiteboard'
// The write path reproduces page code ONLY from the shipped template, so the
// template is authenticated by content, not by shape: its bytes (CRLF
// normalized) must hash to this value. KEEP-IN-SYNC: whiteboard.test.ts
// recomputes it from the shipped SKILL_FILES and names the new value when
// the template changes.
const TEMPLATE_SHA256 = '6aed147b6312c0c4860ee4dd1d098dd3866d021173ef2d932fdc4b562772505a'
// One serialization for hashing a scene on read and on write - scene
// identity only; the skill's echo check compares the full content hash below.
const sceneHash = sc => createHash('sha256').update(JSON.stringify(sc)).digest('hex')
// Canonical JSON: keys sorted at every depth, undefined dropped the way
// JSON.stringify drops it, so the same content hashes the same however the
// object was built or re-parsed.
function canonJson(v){
  if(Array.isArray(v)) return '[' + v.map(x => x === undefined ? 'null' : canonJson(x)).join(',') + ']'
  if(v && typeof v === 'object') return '{' + Object.keys(v).sort()
    .filter(k => v[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonJson(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
// One hash over EVERYTHING a publish carries - the whole data block
// (canonical), the page title, and the snapshot island's raw text - so the
// skill's echo check binds every byte a co-writer could swap (note, title,
// quick-answer fields, snapshot), not just the scene.
const contentHash = (isl, title, png) => createHash('sha256')
  .update(canonJson(isl)).update('\n').update(title).update('\n').update(png).digest('hex')
// the board palette's blue: Claude's ink unless an addition says otherwise; the user's default is INK
// the session's ink: orange, which the page's own palette does not offer, so its marks stay distinguishable
const CLAUDE_STROKE = '#e8590c', INK = '#1e1e1e'
const STYLE = { fill: 'transparent', fillStyle: 'hachure', strokeWidth: 1.75, strokeStyle: 'solid', roughness: 1, roundness: 'round', opacity: 100, fontSize: 24 }
const STROKE_STYLES = ['solid', 'dashed', 'dotted']
const LINE_HEIGHT = 1.3, CHAR_WIDTH = 0.5 // Kalam averages about half an em per character
// clearances for placement: additions land a comfortable gap from everything already there
const MARGIN = 36, STEP = 44
// a page read back from the server may carry ` data-id="<16 chars>"` last on every open tag: the one
// extra attribute the tags read here can have (KEEP-IN-SYNC: DATA_ID_ATTR_SRC in the CLI)
const DATA_ID_TOKEN = /^(?!-)(?:(?!--)[A-Za-z0-9_-]){16}$/
const ISLAND_OPEN = '<script type="application/json" id="sketchboard-published">'
const PNG_OPEN = '<script type="text/plain" id="sketchboard-published-png">'
const ISLAND_ID = 'sketchboard-published'
const PNG_ID = 'sketchboard-published-png'
const DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/

// Both flag spellings read the same: `--name value` and `--name=value`.
// A bare value-taking flag whose next token is missing or is itself a
// flag refuses loudly, and so does an empty `--name=` - never eats the
// next flag, never silently reads as absent (a --base or --title
// quietly dropped would misread the board).
function argIndex(name){
  return process.argv.findIndex(a => a === '--' + name || a.startsWith('--' + name + '='))
}
const hasArg = name => argIndex(name) !== -1
function arg(name){
  const i = argIndex(name)
  if(i === -1) return undefined
  const token = process.argv[i]
  if(token !== '--' + name){
    const value = token.slice(('--' + name + '=').length)
    if(value === '') fail('--' + name + '= needs a value after the equals sign')
    return value
  }
  const next = process.argv[i + 1]
  if(next === undefined || next.startsWith('--'))
    // --title never takes a value starting with -- (its own guard refuses
    // one), so the =-spelling hint would point at a spelling that also fails.
    fail('--' + name + ' needs a value' + (name === 'title' ? '' : ' (spell a value that starts with -- as --' + name + '=value)'))
  return next
}
function fail(msg){ process.stderr.write('board: ' + msg + '\n'); process.exit(1) }
function read(p, what){
  try{ return readFileSync(p, 'utf8') }
  catch(e){ fail('cannot read ' + what + ' at ' + p + ' (' + e.code + ')') }
}

// --- reading a fetched page against the canonical board-page grammar. The
// board app and the publish server only ever emit a fixed, known shape, so
// instead of approximating the HTML tokenizer's full grammar this scan
// ACCEPTS only the constructs a canonical page can carry ahead of the mount
// div and refuses everything else - bogus comments (<? and <!x), RAWTEXT
// containers other than the strictly-parsed <title>, <template>/<noscript>,
// end tags with attributes, malformed or duplicate attributes - so the
// whole parser-differential class fails closed instead of being modeled.
// Script open tags are matched SEMANTICALLY, the way a browser matches
// them: attributes are parsed case-, order- and quote-insensitively and an
// island is any script element whose id equals the island id. Script raw
// text follows the tokenizer's escaped states (the one construct canonical
// pages carry that needs them), and an independent raw-bytes read of the
// island scripts must still agree with the scan or the page is refused.
// (KEEP-IN-SYNC: the CLI's whiteboardState.ts carries the same scan;
// whiteboardHelper.test.ts drives both over one fixture set and against a
// spec-compliant parser.) ---
const TAG_WS = ' \t\n\f\r' // the five space characters the tokenizer honors inside tags
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y
const ATTR_NAME = /[a-zA-Z][a-zA-Z0-9_:.-]*/y
const UNQUOTED_VALUE = /[^ \t\n\f\r"'=<>`]+/y
const DOCTYPE = /<!doctype[ \t\n\f\r]+html[ \t\n\f\r]*>/iy
// The serve-time frame-runtime wrapper: the ONE non-app head sequence a
// REAL served artifact page carries ahead of the app content, emitted by
// the artifact server on the way out (never stored). Accepted only as the
// exact sequence, atomically and in order - the open comment, an OPTIONAL
// base whose single href is exactly the /_f/<version-token>/ shape (base
// rewrites relative URL resolution, so any other href is refused outright;
// the server omits the element entirely for a viewer whose drop-base flag
// is on), the attribute-less preamble script whose raw text opens with the
// served v1 signature, one attribute-less runtime script, and the close
// comment - opening exactly where the server splices it: the bytes ahead
// of the open comment must be, byte for byte, one of the genuine served
// materializations (FRAME_SPLICE_PREFIX: doctype, html[lang], head, as
// the CLI's compose / this page's own republish / the publish annotator
// write them - bounded, no whitespace, nothing paddable), and the interior
// must be printable ASCII (no line break), no longer in bytes than a
// served block's (frameInteriorMeasurable). So the two measures the publish-side
// strips judge - where the block opens and how long it runs - are fixed
// by construction on the prefix side and unit- and line-ending-stable on
// the interior side (this read's own CRLF normalization included). That
// is the safety argument for reading a page whose wrapper scripts are not
// ours: every accepted byte shape, at that one position, is one BOTH
// publish-side strips remove - the CLI's (goCp.ts stripStaleInjections,
// run to a fixpoint) and the artifact server's own strip + storage guard
// at the splice point - so nothing a co-writer can leave STORED reads as
// the wrapper, whichever client published it. Lowercase raw tags,
// double-quoted href, raw </script> closes, the signature, the prefix set
// and the interior bound are each the narrower side of those strips.
// Anything else that resembles it (a lone comment, a bare pre-mount
// script, a base anywhere else, a wrapper after anything but an exact
// prefix) stays refused, and the accepted wrapper is NOT recorded as page
// elements: it is excluded from the template comparison the way the
// doctype/html/head/body materialization is. KNOWN RESIDUAL: this reads
// the bytes it is handed; a wrapper-shaped plant stored OVER the strips'
// bounds (left stored, and refused here as stored and as served) reads as
// the wrapper only if something between the artifact read and this scan
// deleted the padding that put it over - a byte-deleting rewrite of the
// saved file, which is why the skill saves the read verbatim.
// KEEP-IN-SYNC: SERVED_SPLICE_PREFIX_RE and hasFramePreambleLead in the
// CLI's goCp.ts; FRAME_WRAPPER_MAX_INTERIOR in its whiteboardState.ts.
const FRAME_BEGIN = '<!-- frame-runtime -->'
const FRAME_COMMENT_OPEN = ' frame-runtime '
const FRAME_COMMENT_CLOSE = ' /frame-runtime '
// the exact served bytes ahead of the wrapper: doctype (lowercase as
// composed, uppercase as the annotator re-serializes it, absent on an
// annotated bare fragment), html with an optional lang and optional
// minted data-id, head with an optional data-id - nothing else, no spaces
const FRAME_SPLICE_PREFIX = /^(?:<!doctype html>|<!DOCTYPE html>)?<html(?: lang="(?=[^"]{1,35}")[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*")?(?: data-id="(?!-)(?:(?!--)[A-Za-z0-9_-]){16}")?><head(?: data-id="(?!-)(?:(?!--)[A-Za-z0-9_-]){16}")?>$/
// the longest interior (open-comment end to close-comment start) the
// server's own strip still removes: its 256 KiB runtime cap plus 4 KiB of
// base/preamble margin
const FRAME_MAX_INTERIOR = (256 << 10) + (4 << 10)
// the wrapper's raw tags, byte-exact as the server writes them
const FRAME_BASE_TAG = /^<base[\t\n\f\r ]+href="\/_f\/[A-Za-z0-9-]{1,64}\/"[\t\n\f\r ]*>$/
const FRAME_SCRIPT_OPEN = '<script>', FRAME_SCRIPT_CLOSE = '</script>'
// Whether the wrapper interior s[from, to) is printable ASCII (0x20-0x7E:
// no CR/LF, no control byte, nothing multi-byte) and no longer than a
// served block's: that makes code units bytes (the strips' unit) and
// leaves nothing a line-ending translation, a Unicode normalization or a
// control-byte cleanup could rewrite - the genuine interior (JSON
// preamble, minified kernel) is exactly that.
// (KEEP-IN-SYNC: whiteboardState.ts frameInteriorMeasurable.)
function frameInteriorMeasurable(s, from, to){
  if(to - from > FRAME_MAX_INTERIOR) return false
  for(let i = from; i < to; i++){
    const c = s.charCodeAt(i)
    if(c < 0x20 || c > 0x7e) return false
  }
  return true
}
// the served preamble's signature: the v1 lead, then the "," or "}" that continues or closes that object
const FRAME_PREAMBLE_LEAD = 'window.__FRAME_PREAMBLE={"v":1'
const hasFramePreambleLead = data => data.startsWith(FRAME_PREAMBLE_LEAD) && ',}'.includes(data[FRAME_PREAMBLE_LEAD.length] ?? ' ')
const isTagWs = ch => ch !== undefined && TAG_WS.includes(ch)
// Strict tag parse: name, then single well-formed attributes only. Anything
// a browser would error-recover on - duplicate or malformed attributes, an
// attribute on an end tag, "<" or NUL in a value, an unterminated tag -
// returns null so every caller fails closed.
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
    if(ch === '/'){
      if(html[i + 1] !== '>') return null
      selfClosing = true; i += 2; break
    }
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
        value = html.slice(i + 1, close)
        i = close + 1
      } else {
        UNQUOTED_VALUE.lastIndex = i
        const unquoted = UNQUOTED_VALUE.exec(html)
        if(!unquoted) return null
        value = unquoted[0]
        i = UNQUOTED_VALUE.lastIndex
      }
      if(value.includes('<') || value.includes('\0')) return null
      // An id value is an identity: a character reference in it would make
      // the browser resolve an id these raw bytes never spell, so refuse
      // the whole ambiguity class (canonical ids never carry "&").
      if(name === 'id' && value.includes('&')) return null
    }
    attrs.set(name, value)
  }
  return { name: nameMatch[0].toLowerCase(), isEnd, attrs, selfClosing, end: i }
}
const dataIdOk = tag => !tag.attrs.has('data-id') || DATA_ID_TOKEN.test(tag.attrs.get('data-id'))
function attrsOnly(tag, allowed){
  for(const name of tag.attrs.keys()) if(name !== 'data-id' && !allowed.includes(name)) return false
  return dataIdOk(tag)
}
// "&" sequences in title RCDATA other than the exact spellings escHtml and
// the server's re-serialization write.
const TITLE_AMP = /&(?!(?:lt|gt|quot|amp|#34|#39|#13);)/
// document.getElementById is tag-agnostic first-match: any pre-mount
// element claiming one of the page's identity ids that is not the
// canonical element would shadow it for the browser while a script-only
// scan still resolves the real one.
function shadowsReservedId(tag){
  const id = tag.attrs.get('id')
  if(id === ISLAND_ID || id === PNG_ID) return tag.name !== 'script'
  return id === 'sb-root' && tag.name !== 'div'
}
function scriptRawTextEnd(html, from, jsonIsland){
  // Script raw text honors the tokenizer's escaped states: after <!--, a
  // <script opens the double-escaped state, where </script no longer closes
  // the element until --> leaves it - the browser keeps reading, so this
  // scan must too. Canonical pages carry "<!--" in script raw text only
  // inside the JSON island (board text can spell it); anywhere else it is
  // refused outright rather than modeled. Null fails closed.
  const token = /<!--|-->|<\/script(?=[ \t\n\f\r/>])|<script(?=[ \t\n\f\r/>])/gi
  token.lastIndex = from
  let state = 0 // 0 plain, 1 escaped, 2 double-escaped
  for(let m; (m = token.exec(html)); ){
    const t = m[0].toLowerCase()
    if(t === '<!--'){
      if(!jsonIsland) return null
      // Abrupt closes: "<!--" followed by a run of "-" and then ">" puts
      // the tokenizer straight back in plain script data ("<!-->",
      // "<!--->") - the escaped state never takes hold. The same dashes
      // and ">" leave the escaped and double-escaped states too.
      let q = m.index + 4
      while(html[q] === '-') q++
      if(html[q] === '>'){ state = 0; token.lastIndex = q + 1 }
      else if(state === 0) state = 1
    }
    else if(t === '-->') state = 0
    else if(t === '<script'){ if(state === 1) state = 2 }
    else if(state === 2) state = 1
    else {
      // The close tag goes through the same strict parseTag as every other
      // tag - a browser parses script end tags quote-aware through
      // before-attribute-name, so an end tag carrying attributes (or any
      // malformed close) is refused, never approximated.
      const closeTag = parseTag(html, m.index)
      if(!closeTag || !closeTag.isEnd || closeTag.selfClosing) return null
      return { textEnd: m.index, end: closeTag.end }
    }
  }
  return { textEnd: html.length, end: html.length }
}
// The allowlist scan over everything ahead of the mount div. Returns
// { fail } on any construct a canonical page never carries; otherwise the
// pre-mount element records (for the template-authenticity check), the
// title texts, the two islands' raw texts, and where the mount div's open
// tag ends (-1 when the page ends before the mount).
function scanBoardHead(html){
  const elements = [], titles = []
  let island = null, png = null, i = 0
  // Frame wrapper progress: 0 none, 1 open comment, 2 base, 3 preamble
  // script, 4 runtime script, 5 closed. The base is optional, so 1 may
  // step straight to 3. frameOpenAt is where the open comment starts.
  let frame = 0, frameOpenAt = 0
  for(;;){
    const lt = html.indexOf('<', i)
    if(/[^ \t\n\f\r]/.test(html.slice(i, lt === -1 ? html.length : lt))) return { fail: 'markup' }
    if(lt === -1) return { mountEnd: -1, elements, titles, island, png }
    if(html.startsWith('<!--', lt)){
      if(html[lt + 4] === '>' || html.startsWith('->', lt + 4)) return { fail: 'markup' } // abrupt close
      const close = /--!?>/g
      close.lastIndex = lt + 4
      const c = close.exec(html)
      // unterminated, or the --!> close canonical pages never carry
      if(!c || c[0] !== '-->') return { fail: 'markup' }
      // Comments are accepted ONLY as the serve-time frame wrapper's two
      // exact delimiters: the open after an exact served prefix (the
      // server's splice point), the close after a measurable interior;
      // any other content or position is refused outright.
      const content = html.slice(lt + 4, c.index)
      if(content === FRAME_COMMENT_OPEN && frame === 0 && FRAME_SPLICE_PREFIX.test(html.slice(0, lt))){ frame = 1; frameOpenAt = lt }
      else if(content === FRAME_COMMENT_CLOSE && frame === 4 && frameInteriorMeasurable(html, frameOpenAt + FRAME_BEGIN.length, lt)) frame = 5
      else return { fail: 'markup' }
      i = c.index + 3
      continue
    }
    if(html[lt + 1] === '!'){
      if(frame >= 1 && frame <= 4) return { fail: 'markup' } // doctype interrupting the wrapper
      DOCTYPE.lastIndex = lt
      if(!DOCTYPE.exec(html)) return { fail: 'markup' } // bogus comment
      elements.push({ kind: 'doctype' })
      i = DOCTYPE.lastIndex
      continue
    }
    const tag = parseTag(html, lt)
    if(!tag) return { fail: 'markup' } // <?, bare <, or a malformed tag
    // An opened wrapper must run to its close before anything else: only
    // its own element kinds are accepted meanwhile, and each case below
    // checks its position in the sequence.
    if(frame >= 1 && frame <= 4){
      if(tag.isEnd || (tag.name !== 'script' && tag.name !== 'base')) return { fail: 'markup' }
    }
    if(!tag.isEnd && shadowsReservedId(tag)) return { fail: 'markup' }
    if(tag.isEnd){
      if(tag.name !== 'head') return { fail: 'markup' }
      elements.push({ kind: 'endhead' })
      i = tag.end
      continue
    }
    switch(tag.name){
      case 'base': {
        // Serve-time wrapper base only: the raw tag exactly as served -
        // single double-quoted href in the /_f/<version-token>/ shape -
        // directly after the open comment.
        if(frame !== 1 || !FRAME_BASE_TAG.test(html.slice(lt, tag.end))) return { fail: 'markup' }
        frame = 2
        i = tag.end
        break
      }
      case 'html': case 'head': case 'body': {
        if(tag.selfClosing || !attrsOnly(tag, tag.name === 'html' ? ['lang'] : [])) return { fail: 'markup' }
        elements.push({ kind: tag.name })
        i = tag.end
        break
      }
      case 'meta': case 'link': {
        // Only the canonical forms the template and the page's own
        // republish emit. `id` (getElementById shadowing), `http-equiv`,
        // and any charset other than the wrapper's exact utf-8 are
        // constructs a canonical page never carries.
        if(!attrsOnly(tag, tag.name === 'meta' ? ['charset', 'name', 'content'] : ['rel', 'href', 'crossorigin'])) return { fail: 'markup' }
        const charset = tag.attrs.get('charset')
        if(charset !== undefined && (charset.toLowerCase() !== 'utf-8' || tag.attrs.has('name') || tag.attrs.has('content'))) return { fail: 'markup' }
        elements.push({ kind: tag.name, attrs: tag.attrs })
        i = tag.end
        break
      }
      case 'title': {
        if(tag.selfClosing || !attrsOnly(tag, [])) return { fail: 'markup' }
        const close = /<\/title(?=[ \t\n\f\r/>])/gi
        close.lastIndex = tag.end
        const c = close.exec(html)
        if(!c) return { fail: 'markup' }
        const inner = html.slice(tag.end, c.index)
        // Markup-looking RCDATA: canonical titles are escaped. And the
        // browser's RCDATA tokenizer decodes EVERY character reference
        // while this reader decodes only the spellings escHtml and the
        // server write, so any other "&" sequence (numeric refs, smuggled
        // bidi overrides) renders a tab title these bytes never spell -
        // refuse the whole ambiguity class.
        if(inner.includes('<') || TITLE_AMP.test(inner)) return { fail: 'markup' }
        const closeTag = parseTag(html, c.index)
        if(!closeTag || !closeTag.isEnd) return { fail: 'markup' }
        titles.push(inner)
        elements.push({ kind: 'title' })
        i = closeTag.end
        break
      }
      case 'script': {
        if(tag.selfClosing || !dataIdOk(tag)) return { fail: 'markup' }
        const id = tag.attrs.get('id')
        const isIsland = id === ISLAND_ID, isPng = id === PNG_ID
        if(!isIsland && !isPng){
          // Pre-mount non-island scripts exist ONLY as the serve-time
          // frame wrapper's exact pair: the bare <script> open as served,
          // directly after the wrapper base (or the open comment when the
          // server omitted the base), the first one's raw text opening
          // with the served preamble signature, base or not. Any other
          // pre-mount script - any attribute, any position, arbitrary code
          // without the wrapper around it - is refused outright.
          if(!html.startsWith(FRAME_SCRIPT_OPEN, lt) || frame < 1 || frame > 3) return { fail: 'markup' }
          const wrapperRaw = scriptRawTextEnd(html, tag.end, false)
          if(wrapperRaw === null || html.slice(wrapperRaw.textEnd, wrapperRaw.end) !== FRAME_SCRIPT_CLOSE) return { fail: 'markup' }
          if(frame < 3){
            if(!hasFramePreambleLead(html.slice(tag.end, wrapperRaw.textEnd))) return { fail: 'markup' }
            frame = 3
          } else frame = 4
          // Wrapper code is not recorded: excluded from the template
          // comparison the way doctype/html/head/body are.
          i = wrapperRaw.end
          break
        }
        if(frame >= 1 && frame <= 4) return { fail: 'markup' } // an island interrupting the wrapper
        const rawEnd = scriptRawTextEnd(html, tag.end, isIsland)
        if(rawEnd === null) return { fail: 'markup' }
        const { textEnd, end } = rawEnd
        const rawText = html.slice(tag.end, textEnd)
        {
          // An island-id script whose attributes are anything but the
          // canonical open tag's is ambiguous - refuse, never guess.
          if(!attrsOnly(tag, ['type', 'id']) ||
             tag.attrs.get('type') !== (isIsland ? 'application/json' : 'text/plain')) return { fail: 'markup' }
          if(isIsland){
            if(island) return { fail: 'dup-island' }
            island = { text: rawText }
          } else {
            if(png) return { fail: 'markup' }
            png = { text: rawText }
          }
        }
        elements.push({ kind: isIsland ? 'island' : 'png', attrs: tag.attrs })
        i = end
        break
      }
      case 'div': {
        if(tag.selfClosing || tag.attrs.get('id') !== 'sb-root' || !attrsOnly(tag, ['id'])) return { fail: 'markup' }
        return { mountEnd: tag.end, elements, titles, island, png }
      }
      default:
        return { fail: 'markup' }
    }
  }
}
// Every script element's raw text whose open tag carries id=targetId, read
// from the bytes alone - inert regions deliberately NOT honored - so this
// is an independent extraction the scanned read is checked against. Null
// (fail closed) when any script open tag in the page fails the strict
// grammar.
function scriptRawTexts(html, targetId){
  const texts = [], open = /<script(?=[ \t\n\f\r/>])/gi
  let i = 0
  while(true){
    open.lastIndex = i
    const m = open.exec(html)
    if(!m) return texts
    const tag = parseTag(html, m.index)
    if(!tag) return null
    const rawEnd = scriptRawTextEnd(html, tag.end, tag.attrs.get('id') === ISLAND_ID)
    if(rawEnd === null) return null
    if(tag.attrs.get('id') === targetId) texts.push(html.slice(tag.end, rawEnd.textEnd))
    i = rawEnd.end
  }
}

// --- the page title, sanitized standalone: NFC, denied code points to spaces, whitespace
// collapsed, capped by code point, blank edges stripped, and a name exists only if something in
// it renders. Deliberately STRICTER than the CLI's sanitizeArtifactTitle (wider denied set,
// 120-rune cap, visible-glyph requirement) - do not "re-sync" it to the CLI's looser rules ---
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// reads back what escHtml writes and what the server's re-serialization writes (&#34; &#39; &#13;)
const unescHtml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;|&#34;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#13;/g, '\r').replace(/&amp;/g, '&')
const DENIED = /(?![\u200c\u200d])[\p{C}\p{Default_Ignorable_Code_Point}\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu
const EDGE_BLANK = /^[\s\u200c\u200d]+|[\s\u200c\u200d]+$/gu
const VISIBLE = /[^\s\u200c\u200d\p{M}\u2800\u3164\uffa0\u115f\u1160]/u
function titleFrom(plain){
  const t = String(plain || '').normalize('NFC').replace(DENIED, ' ').replace(/\s+/g, ' ')
  const name = Array.from(t).slice(0, 120).join('').replace(EDGE_BLANK, '')
  return VISIBLE.test(name) ? name : ''
}
// Denied and glyphless code points (titleFrom's set plus the invisible
// fillers), newline kept: stripped to spaces in every free-text field
// echoed into context, so tag-character payloads and bidi controls never
// ride in inside an element row, the note, a publisher claim, or an error
// echo.
const ROW_DENIED = /(?![\u200c\u200d\n])[\p{C}\p{Default_Ignorable_Code_Point}\u202a-\u202e\u2066-\u2069\u2028\u2029\u2800\u3164\uffa0\u115f\u1160]/gu
// JSON.parse messages embed a verbatim snippet of the failing input -
// co-writer island bytes on the --base paths - so an error message is
// echoed only stripped and capped, like every other co-writer byte.
// Newlines too (ROW_DENIED keeps them for --inspect's JSON-escaped
// fields): fail()'s stderr is line-oriented, so the echo must stay one
// line a smuggled "board: ..." can never forge a second of.
const safeErr = e => Array.from(String(e && e.message || e).replace(ROW_DENIED, ' ').replace(/[\n\r]/g, ' ')).slice(0, 80).join('')

// seq rides a strictly-monotone +1 lattice (Math.max(prev, floor) + 1),
// so only a safe integer well below 2^53 can ever be outbid - at 2^53 the
// +1 saturates and the board wedges silently. Every seq read is bounded
// BELOW this ceiling (exclusive); out-of-range values are refused, never
// carried - a claim at the ceiling itself would otherwise wedge the board
// for good, since no write could ever outbid it with a seq readers accept.
const SEQ_MAX = 1000000000
const saneSeq = n => Number.isSafeInteger(n) && n >= 0 && n < SEQ_MAX
// Publisher fields are co-writer claims: bounded known shapes only (an
// id-like token; an ISO timestamp), never a free-text side channel into
// context - anything else reads as null.
// Advisory seq claims (userSeq, pngFromSeq) ride the same bounded lattice:
// an out-of-range or fractional claim drops to 0 rather than refusing.
const seqOrZero = v => saneSeq(+v) ? +v : 0
// Line-ending translation (autocrlf, an editor save) must not change what
// a read hashes or compares - both the template and the --base page
// normalize through this before anything scans or hashes them.
const stripCrlf = s => s.replace(/\r\n/g, '\n')
const CLAIM_ID = /^[A-Za-z0-9_.:@-]{1,64}$/
// One sane element-id charset, shared by the write-side addition gate and
// the inspect-side row echo (rowId): ids land verbatim in the summary
// lines the session parses, so an id smuggling a newline or bidi override
// could forge extra summary lines and is refused / withheld instead.
const SANE_ID = /^[A-Za-z0-9_-]{1,40}$/
const CLAIM_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const claimString = (v, shape) => typeof v === 'string' && shape.test(v) ? v : null
// One spelling of the refusal-message seq hint - SKILL.md points the
// restore flow at "the seq the refusal line reports", so its wording
// must not fork between the refusal sites.
function seqHintText(verb, seq, publisherId){
  const pub = claimString(publisherId, CLAIM_ID)
  return ' (the board data ' + verb + ' seq ' + seq + (pub === null ? '' : ', publisher ' + JSON.stringify(pub)) + ' - a restore write must pass --seq-floor ' + seq + ' to outbid it)'
}
// Best-effort seq hint for pages the strict scan refuses, so the refusal
// message still surfaces the seq a restore write must outbid (--seq-floor).
// The scan refused these bytes, so no single island read is trustworthy: a
// low-seq decoy planted ahead of the real island (in a comment, another
// quoting of the id, a non-script carrier) would otherwise steer the hint
// LOW and the restore would mint a floor no tab ever adopts. So EVERY
// candidate carrier of the island id contributes - any tag, any quoting or
// case, content read to the next close tag - and the MAXIMUM sane seq is
// reported: over-flooring is harmless, under-flooring is the failure this
// hint exists to prevent. The restore write itself trusts nothing here
// beyond the floor it must exceed.
function refusedSeqHint(raw){
  try{
    const open = new RegExp('<[a-z][^>]*\\bid[ \\t\\n\\f\\r]*=[ \\t\\n\\f\\r]*(?:"' + ISLAND_ID + '"|\'' + ISLAND_ID + '\'|' + ISLAND_ID + '(?=[ \\t\\n\\f\\r/>]))[^>]*>', 'gi')
    let best = null, bestPub = null
    for(let m; (m = open.exec(raw)) !== null;){
      const start = m.index + m[0].length
      const end = raw.indexOf('</', start)
      try{
        const isl = JSON.parse(raw.slice(start, end === -1 ? raw.length : end))
        const n = isl === null ? NaN : +isl.seq
        if(saneSeq(n) && (best === null || n > best)){ best = n; bestPub = isl.publisherId }
      }catch(_){ /* not JSON - not a candidate */ }
      if(end === -1) break
      // Opens inside the span just read are its content (a browser reads
      // them as the element's text, not as carriers), and skipping them
      // keeps the whole scan linear on decoy-flooded pages.
      open.lastIndex = Math.max(open.lastIndex, end)
    }
    return best === null ? '' : seqHintText('claims', best, bestPub)
  }catch(_){ return '' }
}

// --- read the base: a fetched page (islands ahead of the mount div), a bare island object, or nothing ---
const basePath = arg('base')
let island = null, pngText = '', carriedTitle = '', rawTitle = ''
let baseScan = null, baseRaw = null, pageIslandText = null, pagePngText = ''
if(basePath){
  // CRLF-normalized like the template read: a line-ending-translated copy
  // of an authentic page must not read as tampered page code - the scan,
  // the authenticity comparison and every hash below see the LF bytes the
  // template pin was computed over. A lone \r still fails the scan.
  // (A serve wrapper is accepted only after an exact line-break-free
  // prefix and around a line-break-free interior, so this normalization
  // cannot move one across a bound.)
  const raw = stripCrlf(read(basePath, 'the --base page'))
  const trimmed = raw.trim()
  if(trimmed[0] === '{' || trimmed === 'null'){
    try{ island = JSON.parse(trimmed) }catch(e){ fail('the --base JSON does not parse (' + safeErr(e) + ')') }
  } else {
    const cutOrMissing = () => fail(raw.includes(ISLAND_ID)
      ? 'the page in ' + basePath + ' is cut off inside the board data - read the full saved HTML by path and run again'
      : 'no whiteboard page in ' + basePath + ' - pass the page read from the board artifact')
    if(!raw.includes('sb-root')) cutOrMissing()
    // Everything ahead of the mount div must scan as the canonical board
    // page grammar - anything a canonical page never carries is refused
    // outright rather than approximated, and the islands are matched
    // semantically the way a browser matches them (KEEP-IN-SYNC: the CLI's
    // whiteboardState.ts applies the same scan and refusals;
    // whiteboardHelper.test.ts drives both over one fixture set).
    const scan = scanBoardHead(raw)
    if(scan.fail === 'dup-island')
      fail('more than one board data block ahead of the mount div in ' + basePath + ' - the page cannot be read safely; stop and tell the user' + refusedSeqHint(raw))
    // Deliberate asymmetry: a cut landing INSIDE a pre-mount tag's own
    // bytes also fails here with the tamper-flavored message - the
    // window is a handful of bytes per tag (the islands' raw text and
    // the tail get the truncation guidance), and failing toward the
    // scarier message is the safe direction for markup this scan cannot
    // classify.
    if(scan.fail)
      fail('the page in ' + basePath + ' carries markup the board app never writes - the page cannot be read safely; stop and tell the user' + refusedSeqHint(raw))
    if(scan.mountEnd === -1) cutOrMissing()
    if(!scan.island) fail('the board data block in ' + basePath + ' is missing or cut off - read the full saved HTML by path and run again')
    // Fail closed on any divergence: the same blocks read from the raw
    // bytes alone (script-raw-text-faithful, whole page) must surface
    // exactly what the scan did, or crafted markup is making the helper
    // see different bytes than the browser - refuse rather than pick a
    // side.
    const rawIslands = scriptRawTexts(raw, ISLAND_ID)
    if(rawIslands === null || rawIslands.length !== 1 || rawIslands[0] !== scan.island.text)
      fail('the board data in ' + basePath + ' reads differently from the raw page bytes than from the rendered page - the page cannot be read safely; stop and tell the user')
    const rawPngs = scriptRawTexts(raw, PNG_ID)
    if(rawPngs === null || (scan.png ? rawPngs.length !== 1 || rawPngs[0] !== scan.png.text : rawPngs.length !== 0))
      fail('the snapshot block in ' + basePath + ' reads differently from the raw page bytes than from the rendered page - the page cannot be read safely; stop and tell the user')
    try{ island = JSON.parse(scan.island.text) }catch(e){ fail('the board data block does not parse - the read is incomplete; stop and tell the user (' + safeErr(e) + ')') }
    pagePngText = scan.png ? scan.png.text : ''
    pngText = pagePngText.trim()
    if(pngText && !DATA_URL.test(pngText)) fail('the snapshot block in ' + basePath + ' is not a base64 image data URL - the read may be cut off; read the full saved HTML and run again')
    // the board's name is the FIRST <title>, the one document.title (and
    // so every human's tab caption) resolves; the RAW unescaped bytes feed
    // the hashes, the sanitized form is only display
    rawTitle = unescHtml(scan.titles[0] ?? '')
    carriedTitle = titleFrom(rawTitle)
    pageIslandText = scan.island.text
    baseScan = scan
    baseRaw = raw
  }
}
if(island !== null && (typeof island !== 'object' || Array.isArray(island))) fail('the board data block is not an object')
// A scene that is present but malformed (not an object carrying an
// elements array) is refused rather than silently read as an empty board
// (KEEP-IN-SYNC: the CLI classifier's island schema refuses the same).
if(island !== null && island.scene !== undefined &&
   !(island.scene && typeof island.scene === 'object' && !Array.isArray(island.scene) && Array.isArray(island.scene.elements)))
  fail('the board data carries a scene this helper cannot represent - stop and tell the user')
const scene = island && island.scene ? island.scene : { v: 1, elements: [] }
// The box types whose additions may carry a riding <id>_t label (KEEP-IN-SYNC:
// SHAPES in template.html). The retire path's label sweep keys off the same
// set, so what mints a label and what sweeps one cannot drift apart.
const LABELED_BOX_TYPES = new Set(['rect', 'diamond', 'ellipse', 'cylinder', 'sticky'])
const LINEAR_TYPES = new Set(['line', 'arrow', 'pen'])
// The element types the page's sanitize() accepts (KEEP-IN-SYNC: TYPES in
// template.html and PAGE_ELEMENT_TYPES in the CLI's whiteboardState.ts).
const ELEMENT_TYPES = new Set([...LABELED_BOX_TYPES, ...LINEAR_TYPES, 'text', 'image'])
const isConnector = e => e.type === 'arrow' || e.type === 'line'
// a picture the page carries inline: '' (a placeholder) or bounded base64 image data (KEEP-IN-SYNC: IMG_SRC_RE / IMG_MAX_CHARS in template.html, whiteboardState.ts)
const IMG_SRC_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, IMG_MAX_CHARS = 1400000
const imageSrcOk = v => typeof v === 'string' && (v === '' || (v.length <= IMG_MAX_CHARS && IMG_SRC_RE.test(v)))
// Fail closed on any scene entry the page's sanitize() would rewrite or
// drop - a missing or duplicate id (the page mints a fresh one and renders
// the entry this helper would silently drop), an unknown type, blank or
// non-string text on a text element (sanitize()'s String() coercion would
// render something these bytes never spell), text on any other type
// (sanitize() attaches text only to text elements, so the field renders
// for no viewer - a carry channel, not a mark), a point-starved connector
// (invisible to every viewer yet carried here), points on a non-linear
// type (sanitize() keeps points only for line/arrow/pen, so viewers render
// the x/y/w/h box while a points-derived bbox would place the element
// somewhere else), any x/y/w/h or point coordinate that is not a finite
// number (exactly the set the page's num() coercion would rewrite, so the
// bbox math below never sees NaN), and an id over the 40 chars the
// helper's own additions are bounded to (the page keeps longer ids, but
// they are unechoable here and would ride a Claude write unbounded).
// Either way the two sides of the boundary would disagree on what is on
// the board, so the helper refuses instead of picking a side.
// (KEEP-IN-SYNC: sceneElementsRepresentable in the CLI's whiteboardState.ts.)
const finiteCoord = v => typeof v === 'number' && Number.isFinite(v)
{
  const seenIds = new Set()
  for(const e of scene.elements){
    const bad =
      !e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || e.id.length > 40 || seenIds.has(e.id) ||
      !ELEMENT_TYPES.has(e.type) ||
      !finiteCoord(e.x) || !finiteCoord(e.y) || !finiteCoord(e.w) || !finiteCoord(e.h) ||
      (Array.isArray(e.points) && e.points.some(p => !Array.isArray(p) || !finiteCoord(p[0]) || !finiteCoord(p[1]))) ||
      (e.type === 'text' ? typeof e.text !== 'string' || !e.text.trim() : e.text !== undefined) ||
      (e.type === 'image' ? !imageSrcOk(e.src) : e.src !== undefined) ||
      (LINEAR_TYPES.has(e.type)
        ? (Array.isArray(e.points) ? e.points.length : 0) < (e.type === 'pen' ? 1 : 2)
        : e.points !== undefined)
    if(bad) fail('the board data carries elements this helper cannot represent - stop and tell the user')
    seenIds.add(e.id)
  }
}
const elements = scene.elements
// A present seq outside the bounded lattice (see SEQ_MAX) is refused, not
// coerced: a forged 2^53 seq would make every later Math.max(...) + 1 a
// no-op and a fractional one diverges from what tabs adopt.
if(island && island.seq !== undefined && !saneSeq(+island.seq))
  fail('the board data carries a seq outside the range this helper can advance (a whole number below ' + SEQ_MAX + ') - stop and tell the user')
const prevSeq = island && Number.isFinite(+island.seq) ? +island.seq : 0
// A truncation refusal still surfaces the seq (and publisher) the island
// carries - the security-event restore needs it for --seq-floor, and on
// this branch no summary ever prints it.
const truncatedSeqHint = () => island === null ? '' : seqHintText('reads', prevSeq, island.publisherId)
// which publish rendered the snapshot: carried marks say so; a page the user
// published rendered its own. The claim rides the bounded seq lattice; an
// out-of-range claim reads as 0 (a stale claim), never the unbounded value.
const pngClaim = island === null ? NaN : +island.pngFromSeq
const pngFromSeq = !pngText ? null : Number.isFinite(pngClaim) ? seqOrZero(pngClaim) : prevSeq

// --- geometry, the way the page computes it ---
function textSize(text, px){
  const lines = String(text).split('\n')
  return { w: Math.max(2, Math.ceil(Math.max(...lines.map(l => l.length)) * px * CHAR_WIDTH)), h: Math.ceil(lines.length * px * LINE_HEIGHT) }
}
function bbox(e){
  if(Array.isArray(e.points) && e.points.length){
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for(const p of e.points){ const ax = e.x + p[0], ay = e.y + p[1]; x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, ax); y1 = Math.max(y1, ay) }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  return { x: Math.min(e.x, e.x + e.w), y: Math.min(e.y, e.y + e.h), w: Math.abs(e.w), h: Math.abs(e.h) }
}
function union(boxes){
  if(!boxes.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for(const b of boxes){ x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h) }
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
}
const boxes = new Map(elements.map(e => [e.id, bbox(e)]))

// The page serializer's style keys, each normalized to the value the
// page's own sanitize() would keep for it (KEEP-IN-SYNC: DEFAULT_STYLE,
// str()/one() and the clamps in template.html): enum members for the enum
// keys, clamped numbers for the numeric keys, bounded strings for the
// colors; undefined means the field is dropped. Shared by the element and
// appState carry filters below.
const colorString = v => typeof v === 'string' && v.length < 40 ? v : undefined
// The color echo gate: only a spelling this grammar knows - a CSS named
// color, transparent/none/empty, 3/4/6/8-digit hex, or a numeric-only
// rgb()/hsl() functional form (legacy comma or modern space separators,
// optional /-alpha; plain numbers and percentages only, no units) - is
// echoed or carried. That is the canvas's color grammar minus its
// unit-bearing corners (deg/turn angles, lab()/color() spaces), so a
// spelling outside it is free text riding a color field, not a mark a
// viewer relies on: the rows echo it as 'unparseable' and a carry drops
// it. What the grammar does know is re-emitted only in ONE canonical
// spelling - trimmed, lowercased, functional forms reassembled from
// their bare numeric tokens - never the writer's original bytes, so a
// carried or echoed color is byte-deterministic and cannot smuggle
// invisible padding (trim() alone would pass e.g. U+FEFF-prefixed
// spellings through verbatim inside the length budget).
// The full CSS spec named-color list (generated from mdn-data's
// named-color syntax), plus the page's own transparent/none/empty.
const COLOR_NAMES = new Set(['aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen', 'transparent', 'none', ''])
// Closed numeric-only functional form: digits, dots, percent, comma or
// space separators, an optional slash-alpha, and ASCII blanks only -
// never \s, which in JS matches U+FEFF and the Zs separators and would
// reopen the invisible-byte channel inside rgb(). Each component must be
// a real CSS <number> (one dot at most), matching what the canvas parser
// accepts: rgb(1.2.3,0,0), rgb(.,.,.), unitless s/l in legacy comma
// hsl(), %/number mixing in legacy comma rgb(), and a % hue are all
// browser-rejected no-ops a viewer never renders, so certifying or
// carrying them would report a color the element does not have.
const FUNCTIONAL_HEAD = /^(rgba?|hsla?)\(([\d.,%/ \t]*)\)$/
const CSS_NUM = /^(?:\d+(?:\.\d+)?|\.\d+)(%?)$/
const normalizedFunctional = s => {
  const m = FUNCTIONAL_HEAD.exec(s)
  if(!m) return undefined
  const fn = m[1], body = m[2], legacy = body.includes(',')
  let comps, alpha
  if(legacy){
    const parts = body.split(',').map(t => t.trim())
    if((parts.length !== 3 && parts.length !== 4) || parts.some(p => p.includes('/'))) return undefined
    comps = parts.slice(0, 3); alpha = parts[3]
  } else {
    const slash = body.split('/')
    if(slash.length > 2) return undefined
    comps = slash[0].trim().split(/[ \t]+/)
    if(comps.length !== 3) return undefined
    alpha = slash[1] === undefined ? undefined : slash[1].trim()
  }
  const tokens = alpha === undefined ? comps : comps.concat([alpha])
  const nums = tokens.map(t => CSS_NUM.exec(t))
  if(nums.some(t => t === null)) return undefined
  // The canonical spelling below is ALWAYS the legacy comma form, so the
  // legacy component-type rules gate every input regardless of its own
  // separator: a modern-syntax color whose comma re-spelling the legacy
  // grammar forbids (unitless s/l in hsl, %/number mixing in rgb) reads
  // as unparseable and drops, rather than being re-emitted as a spelling
  // browsers silently reject - which would recolor the mark for every
  // viewer while --inspect certified a color no one renders.
  if(fn[0] === 'h'){
    if(nums[0][1] === '%') return undefined // the hue is a plain number
    if(nums[1][1] !== '%' || nums[2][1] !== '%') return undefined // s/l need % in the emitted legacy form
  } else if(nums[1][1] !== nums[0][1] || nums[2][1] !== nums[0][1]) return undefined // no %/number mixing in the emitted legacy form
  return fn + '(' + tokens.join(',') + ')'
}
const normalizedColor = c => {
  if(typeof c !== 'string') return undefined
  const s = c.trim().toLowerCase()
  if(COLOR_NAMES.has(s) || /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}(?:[0-9a-f]{2})?)$/.test(s)) return s
  return normalizedFunctional(s)
}
const carriedColor = v => normalizedColor(colorString(v))
// Mirror of the page's num(): sanitize() coerces with +v and keeps any
// value whose coercion is finite - numeric strings included - so the carry
// must coerce identically or a field the browser renders (and --inspect
// reports) would drop from a Claude write and pop back to its default.
const coerceNum = v => Number.isFinite(+v) ? +v : undefined
const clampNum = (lo, hi) => v => { const n = coerceNum(v); return n === undefined ? undefined : Math.min(hi, Math.max(lo, n)) }
const keepEnum = list => v => list.includes(v) ? v : undefined
const STYLE_FIELDS = {
  stroke: carriedColor,
  fill: carriedColor,
  fillStyle: keepEnum(['hachure', 'cross', 'solid']),
  strokeWidth: clampNum(0.5, 40),
  strokeStyle: keepEnum(STROKE_STYLES),
  roughness: v => { const n = coerceNum(v); return n === undefined ? undefined : Math.min(2, Math.max(0, Math.round(n))) },
  roundness: keepEnum(['sharp', 'round']),
  opacity: clampNum(0, 100),
  fontSize: clampNum(4, 400),
}
// Carried elements ride into a publish under Claude's own publisherId, so
// each field survives only as the value the page's own sanitize() would
// render for it (the same rationale as the appState and snapshot filters
// below). Identity, geometry, point membership and text were already
// pinned by the scene validation on read; points survive as bare
// coordinate pairs, text only on text elements (the one place sanitize()
// attaches it), and anything else - fields or values sanitize() would
// rewrite or drop on load - never rides a Claude write.
const keep = v => v
const bindingId = v => typeof v === 'string' && v.length >= 1 && v.length <= 40 ? v : undefined
const ELEMENT_FIELDS = {
  id: keep, type: keep, x: keep, y: keep, w: keep, h: keep,
  points: v => v.map(p => [p[0], p[1]]),
  seed: v => { const n = coerceNum(v); return n === undefined ? undefined : n | 0 },
  text: v => typeof v === 'string' ? v : undefined,
  // an image's bytes were pinned by the scene validation on read; an arrow's
  // attachments are ids the page re-resolves (a stale one lets go there)
  src: v => imageSrcOk(v) ? v : undefined,
  startId: bindingId, endId: bindingId,
  ...STYLE_FIELDS,
}
// fields that exist on one element type only (the page's sanitize() attaches them nowhere else)
const TYPE_ONLY_FIELDS = { text: 'text', src: 'image', startId: 'arrow', endId: 'arrow' }
function carriedElement(e){
  const out = {}
  for(const [key, norm] of Object.entries(ELEMENT_FIELDS)){
    if(e[key] === undefined) continue
    if(TYPE_ONLY_FIELDS[key] !== undefined && e.type !== TYPE_ONLY_FIELDS[key]) continue
    const v = norm(e[key])
    if(v !== undefined) out[key] = v
  }
  return out
}
// appState is co-writer bytes that would otherwise ride verbatim into a
// publish under Claude's own publisherId (the same rationale as the
// snapshot drop below): only the page's own shape survives - theme from
// the page's enum, grid a boolean, style a flat object in the shared
// STYLE_FIELDS grammar - and anything else is dropped.
function carriedAppState(a){
  if(!a || typeof a !== 'object' || Array.isArray(a)) return undefined
  const out = {}
  if(['system', 'light', 'dark'].includes(a.theme)) out.theme = a.theme
  if(typeof a.grid === 'boolean') out.grid = a.grid
  if(a.style && typeof a.style === 'object' && !Array.isArray(a.style)){
    const style = {}
    for(const [key, norm] of Object.entries(STYLE_FIELDS)){
      const v = norm(a.style[key])
      if(v !== undefined) style[key] = v
    }
    out.style = style
  }
  return Object.keys(out).length ? out : undefined
}

// --- the shipped template, verified by content before anything trusts it ---
function loadTemplate(p){
  const tplText = stripCrlf(read(p, 'the --template'))
  // The page code comes ONLY from the skill's own template, verified by
  // content: anything whose bytes differ - a fetched page, a foreign or
  // edited file - is refused outright, so no crafted file can be laundered
  // into a publish or vouch for a read.
  if(createHash('sha256').update(tplText).digest('hex') !== TEMPLATE_SHA256)
    fail('that is not the skill template - pass template.html from the skill directory, unmodified')
  const tpl = tplText.split('\n')
  const lines = {
    mount: tpl.indexOf('<div id="sb-root"></div>'),
    island: tpl.indexOf(ISLAND_OPEN + 'null</script>'),
    png: tpl.indexOf(PNG_OPEN + '</script>'),
  }
  if(lines.mount === -1 || lines.island === -1 || lines.png === -1)
    fail('that is not the skill template - pass template.html from the skill directory, unmodified')
  return { tplText, tpl, lines }
}
// The exact bytes a write of (title, island, snapshot) onto the template
// produces - so hashing it on read reproduces the "page sha256" that write
// printed, binding the WHOLE page, not just the island values.
function reconstructPage(template, title, islandText, pngRaw){
  const tpl = template.tpl.slice()
  tpl[0] = '<title>' + escHtml(title) + '</title>'
  tpl[template.lines.island] = ISLAND_OPEN + islandText + '</script>'
  tpl[template.lines.png] = PNG_OPEN + pngRaw + '</script>'
  return tpl.join('\n')
}
// The scripts after the mount div, when that tail is nothing but the mount
// close, script elements (data-id at most), body/html closes and
// whitespace; null for anything else.
function tailScripts(html, from){
  const texts = []
  let i = from
  for(;;){
    const lt = html.indexOf('<', i)
    if(/[^ \t\n\f\r]/.test(html.slice(i, lt === -1 ? html.length : lt))) return null
    if(lt === -1) return texts
    const tag = parseTag(html, lt)
    if(!tag) return null
    if(tag.isEnd){
      if(tag.name !== 'div' && tag.name !== 'body' && tag.name !== 'html') return null
      i = tag.end
      continue
    }
    if(tag.name !== 'script' || tag.selfClosing || !attrsOnly(tag, [])) return null
    const rawEnd = scriptRawTextEnd(html, tag.end, false)
    if(rawEnd === null) return null
    texts.push(html.slice(tag.end, rawEnd.textEnd))
    i = rawEnd.end
  }
}
// Attribute values compare through the same entity decode the server's
// re-escape round-trips through, so a stored page's `&amp;` still equals
// the template's raw `&`; an entity the decoder does not know stays put
// and reads as inauthentic.
const attrsEqual = (a, b) => {
  const keys = [...a.keys()].filter(k => k !== 'data-id')
  return keys.length === [...b.keys()].filter(k => k !== 'data-id').length &&
    keys.every(k => b.has(k) && unescHtml(a.get(k)) === unescHtml(b.get(k)))
}
const tailScriptsEqual = (raw, scan, expectedText, expectedScan) => {
  const got = tailScripts(raw, scan.mountEnd)
  const want = tailScripts(expectedText, expectedScan.mountEnd)
  return got !== null && want !== null && got.length === want.length &&
    got.every((t, k) => t === want[k])
}
// The shipped template's own serialization: ahead of the mount div,
// exactly the template's elements in order (attribute-equal modulo the
// server's data-id annotation; the server's html/head/body materialization
// is ignored), and after it, exactly the template's app script with
// byte-identical raw text, compared UN-normalized.
const WRAPPER_KINDS = new Set(['doctype', 'html', 'head', 'body', 'endhead'])
const contentElements = els => els.filter(e => !WRAPPER_KINDS.has(e.kind))
// The one element-walk every authenticity comparison uses: same kinds in
// order, attribute-equal modulo the server's data-id annotation, wrapper
// kinds excluded by the callers via contentElements.
const elementListsEqual = (got, want) =>
  got.length === want.length && got.every((e, k) =>
    e.kind === want[k].kind &&
    (!(e.attrs || want[k].attrs) || attrsEqual(e.attrs || new Map(), want[k].attrs || new Map())))
function matchesTemplateShape(raw, scan, template){
  const templateScan = scanBoardHead(template.tplText)
  if(!elementListsEqual(contentElements(scan.elements), contentElements(templateScan.elements))) return false
  return tailScriptsEqual(raw, scan, template.tplText, templateScan)
}
// The page the verified template's own buildPage() emits - the shape every
// legitimate user Publish republishes. Reconstructed from the template's
// OWN bytes: its app script prefix (consts and function declarations, the
// mount call cut off) is evaluated to obtain buildPage exactly as the
// browser holds it - safe because loadTemplate already authenticated the
// bytes against TEMPLATE_SHA256, so this executes only the skill's shipped
// code, never fetched-page code.
function buildPageExpected(template){
  const templateScan = scanBoardHead(template.tplText)
  const scripts = tailScripts(template.tplText, templateScan.mountEnd)
  if(scripts === null || scripts.length !== 1) return null
  const src = scripts[0]
  const call = src.lastIndexOf('sketchboardApp();')
  if(call === -1) return null
  try{
    const buildPage = new Function(src.slice(0, call) + ';return buildPage;')()
    return buildPage(null, '', '')
  }catch(_){ return null }
}
// buildPage-shape match: the fetched page must carry buildPage's exact
// element sequence - wrapper kinds compared too, so the charset meta is
// accepted only in the exact spelling and position buildPage emits it -
// attribute-equal modulo the server's data-id annotation, with the app
// script's raw text byte-exact. The title and island raw texts are the
// page's data, judged elsewhere; everything around them is code.
function matchesBuildPageShape(raw, scan, template){
  const expected = buildPageExpected(template)
  if(expected === null) return false
  const expectedScan = scanBoardHead(expected)
  if(expectedScan.fail || expectedScan.mountEnd === -1) return false
  if(!elementListsEqual(scan.elements, expectedScan.elements)) return false
  return tailScriptsEqual(raw, scan, expected, expectedScan)
}
// True only when everything around the islands is one of exactly TWO
// known-good serializations: the shipped template's own (the helper's
// writes) or the buildPage() output the page's own Publish emits. Any
// third shape - a comment, an extra script, a swapped head element - is
// page code Claude did not write.
function pageMatchesTemplate(raw, scan, template){
  return matchesTemplateShape(raw, scan, template) || matchesBuildPageShape(raw, scan, template)
}
// A truncated read of a canonical page, told apart from a tamper by
// staying rail-anchored: the tail bytes read so far must still lie ON one
// of the two canonical serializations - the tail holds only the canonical
// structure (mount/wrapper closes, attribute-less scripts), every
// COMPLETED tail script byte-equals the canonical one at its position,
// and the script (or tag) cut off at EOF is a prefix of what the rail
// expects next. The app script is ~98% of the page's bytes, so an
// incomplete fetch cut almost anywhere after the mount div lands here -
// while a tampered tail diverges from both rails BEFORE any cut, so
// omitting the final </script> can never demote a forgery to a
// truncation (browsers still execute an unterminated script at EOF).
function truncatedTailRead(raw, scan, template){
  const rails = []
  const templateScan = scanBoardHead(template.tplText)
  if(!templateScan.fail && templateScan.mountEnd !== -1){
    const t = tailScripts(template.tplText, templateScan.mountEnd)
    if(t !== null) rails.push({ els: templateScan.elements, tail: t })
  }
  const expectedPage = buildPageExpected(template)
  if(expectedPage !== null){
    const expectedScan = scanBoardHead(expectedPage)
    if(!expectedScan.fail && expectedScan.mountEnd !== -1){
      const t = tailScripts(expectedPage, expectedScan.mountEnd)
      if(t !== null) rails.push({ els: expectedScan.elements, tail: t })
    }
  }
  // The pre-mount head must itself lie on a rail - the same element walk
  // the authenticity match performs (wrapper kinds excluded, attributes
  // compared, so an injected element or an attacker attribute VALUE fails
  // here) - or the "cut" rides tampered head markup and must classify as
  // tamper, never truncation. The cut this function tolerates is strictly
  // in the tail: a cut inside the pre-mount head already failed the scan.
  const got = contentElements(scan.elements)
  const headRails = rails
    .filter(({ els }) => elementListsEqual(got, contentElements(els)))
    .map(({ tail }) => tail)
  if(!headRails.length) return false
  // Walk the page's tail with tailScripts' own strictness, but tolerating
  // exactly one cut at EOF: a tag left open, or a script text with no
  // close tag before EOF (scriptRawTextEnd's fallback).
  const done = []
  let cutText = null, cutTag = null, i = scan.mountEnd
  for(;;){
    const lt = raw.indexOf('<', i)
    if(/[^ \t\n\f\r]/.test(raw.slice(i, lt === -1 ? raw.length : lt))) return false
    // EOF between tail constructs is NOT read as a cut: a page with no
    // (or fewer) tail scripts is judged by the authenticity match, the
    // same deliberate fail-toward-tamper asymmetry as the pre-mount
    // windows - only a construct visibly cut mid-bytes classifies.
    if(lt === -1) return false
    const tag = parseTag(raw, lt)
    if(!tag){
      if(raw.indexOf('>', lt) !== -1) return false // malformed, not cut
      cutTag = raw.slice(lt)
      break
    }
    if(tag.isEnd){
      if(tag.name !== 'div' && tag.name !== 'body' && tag.name !== 'html') return false
      i = tag.end
      continue
    }
    if(tag.name !== 'script' || tag.selfClosing || !attrsOnly(tag, [])) return false
    const rawEnd = scriptRawTextEnd(raw, tag.end, false)
    if(rawEnd === null) return false
    if(rawEnd.textEnd === raw.length){ cutText = raw.slice(tag.end); break }
    done.push(raw.slice(tag.end, rawEnd.textEnd))
    i = rawEnd.end
  }
  if(cutText === null && cutTag === null) return false
  // A tag cut at EOF is a truncation only when its bytes are visibly the
  // start of a construct the canonical tail can still expect - a wrapper
  // close or the next script's open tag - AND a canonical script is still
  // outstanding on the rail: a complete page with trailing junk (or with
  // nothing canonical left to cut) is tamper, not a cut.
  if(cutTag !== null && !['</div>', '</body>', '</html>', '<script>'].some(t => t.startsWith(cutTag))) return false
  return headRails.some(rail =>
    done.length < rail.length && done.every((t, k) => t === rail[k]) &&
    (cutTag !== null || rail[done.length].startsWith(cutText)))
}

// --- inspect row helpers. Board content is trusted input - anyone with
// publish access to the artifact is trusted the same as the user (the
// skill documents that) - so every element is reported uniformly. What
// stays byte-level is output hygiene: bounded, stripped echoes of
// co-writer bytes, never a raw side channel into context (colors ride
// only through normalizedColor above). ---

// --- inspect: say what is on the board and stop (one line per element keeps big boards readable) ---
if(hasArg('inspect')){
  const pngOut = arg('png-out'), sceneOut = arg('scene-out'), imagesOut = arg('images-out'), tplArg = arg('template')
  // A fetched page carries page code; without the shipped template there is
  // nothing to verify that code against, so the read fails closed (the
  // mirror of the write path's hard template requirement) instead of
  // returning a silently unverified pageCodeAuthentic: null.
  if(baseScan && tplArg === undefined)
    fail('--inspect on a fetched page needs --template <template.html> so the page code can be verified - pass the skill template and run again')
  // The page re-encodes an oversized snapshot as image/jpeg (DATA_URL admits
  // both mimes), so the saved file is named by the data URL's ACTUAL mime -
  // a requested .png/.jpg suffix is swapped to match instead of writing
  // bytes under a lying name - and the summary's snapshot object reports
  // the real file and format.
  const pngIsJpeg = pngText.startsWith('data:image/jpeg')
  const pngFile = pngOut && /\.(?:png|jpe?g)$/i.test(pngOut) ? pngOut.replace(/\.(?:png|jpe?g)$/i, pngIsJpeg ? '.jpg' : '.png') : pngOut
  if(pngFile && pngText) writeFileSync(pngFile, Buffer.from(pngText.slice(pngText.indexOf(',') + 1), 'base64'))
  let pageSha256 = null, pageCodeAuthentic = null
  if(tplArg !== undefined && baseScan){
    const template = loadTemplate(tplArg)
    // A rail-anchored cut (truncatedTailRead) is an incomplete READ of a
    // canonical page, not a tamper: fail with the re-read guidance
    // instead of reporting pageCodeAuthentic: false and sending the
    // session down the security-event flow over a partial fetch.
    if(truncatedTailRead(baseRaw, baseScan, template))
      fail('the page read from ' + basePath + ' looks truncated - the page code is cut off before its closing tag; re-read the full saved HTML by path and run again' + truncatedSeqHint())
    pageSha256 = createHash('sha256').update(reconstructPage(template, rawTitle, pageIslandText, pagePngText)).digest('hex')
    pageCodeAuthentic = pageMatchesTemplate(baseRaw, baseScan, template)
  }
  // pngFromSeq is a publisher-writable claim: a snapshot not claiming THIS
  // publish is flagged stale so it is never read as a picture of this scene
  const snapshotStale = pngText !== '' && pngFromSeq !== prevSeq
  // Free text is echoed stripped and capped (by code point) with an
  // explicit truncation marker, so no single field can flood the summary:
  // element text at ROW_TEXT_CAP, the note at the page's own 500-char
  // publish bound.
  const ROW_TEXT_CAP = 2000
  const boundedText = (t, cap) => {
    const stripped = String(t || '').replace(ROW_DENIED, ' ')
    if(stripped.length <= cap) return stripped // code units >= code points
    const points = Array.from(stripped)
    return points.length > cap
      ? points.slice(0, cap).join('') + ' [text truncated at ' + cap + ' of ' + points.length + ' characters]'
      : stripped
  }
  const summary = {
    title: carriedTitle || null,
    published: island !== null,
    seq: prevSeq,
    // hash of the scene as carried; matches the "scene sha256" a write prints
    sceneSha256: sceneHash(scene),
    // hash of the data block, raw title and snapshot bytes; matches the
    // "content sha256" a write prints (a swapped note, title, snapshot or
    // quick-answer field changes it even when the scene is replayed
    // byte-for-byte)
    contentSha256: island === null ? null : contentHash(island, rawTitle, pngText),
    // hash of the full written page the extracted values reconstruct over
    // the verified template (pass --template); matches the "page sha256" a
    // write prints, and is what the skill's echo check compares
    pageSha256,
    // whether every byte around the islands is one of the two known-good
    // serializations (the shipped template's, or the page's own buildPage
    // publish) - false means someone wrapped the board data in page code
    // Claude did not write, so no echo check may trust this page
    pageCodeAuthentic,
    publisherId: island ? claimString(island.publisherId, CLAIM_ID) : null,
    publishedAt: island ? claimString(island.publishedAt, CLAIM_TIME) : null,
    note: island && typeof island.note === 'string' ? boundedText(island.note, 500) : '',
    elementCount: elements.length,
    bounds: union([...boxes.values()]),
    snapshot: !pngText ? 'none'
      : pngOut ? Object.assign({ file: pngFile, format: pngIsJpeg ? 'jpeg' : 'png', renderedAtSeq: pngFromSeq }, snapshotStale ? { stale: true } : {})
      : snapshotStale ? 'present, stale (claims seq ' + pngFromSeq + ', not this publish) - pass --png-out to save it'
      : 'present (pass --png-out to save it)',
  }
  // Ids are co-writer bytes too: only a sane bounded charset is echoed;
  // anything else is replaced with an opaque positional marker, never the
  // raw bytes.
  const rowId = (e, idx) => SANE_ID.test(e.id) ? e.id : 'element ' + (idx + 1) + ' (id withheld: unrepresentable)'
  // Every element gets one uniform row: id, type, geometry, opacity,
  // stroke (echoed only in the one canonical spelling normalizedColor
  // re-emits), text and
  // fontSize for text, points count for pen strokes, endpoints for
  // arrows and lines (the bbox min/maxes them away, and direction is
  // scene content) - opacity and fontSize clamped the way the page's
  // sanitize() clamps them.
  const rows = elements.map((e, idx) => {
    const b = boxes.get(e.id)
    // an overlong or non-string stroke renders as the default ink (colorString is the mirror of the page's str())
    const stroke = colorString(e.stroke) ?? INK
    const row = { id: rowId(e, idx), type: e.type, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), mine: e.id.startsWith('cl_'), opacity: STYLE_FIELDS.opacity(e.opacity) ?? 100, stroke: normalizedColor(stroke) ?? 'unparseable' }
    if(e.type === 'text'){ row.text = boundedText(e.text, ROW_TEXT_CAP); row.fontSize = STYLE_FIELDS.fontSize(e.fontSize) ?? 24 }
    if(e.type === 'pen') row.points = Array.isArray(e.points) ? e.points.length : 0
    if(e.type === 'image'){
      // a picture: its byte size, and where it was written when --images-out names a directory
      row.image = e.src ? (e.src.slice(11, e.src.indexOf(';')) + ', ' + e.src.length + ' chars') : 'placeholder (bytes arrive with a later publish)'
      if(imagesOut && e.src && SANE_ID.test(e.id)){
        const ext = e.src.slice(11, e.src.indexOf(';')).replace('jpeg', 'jpg')
        const file = imagesOut.replace(/[\/]$/, '') + '/' + e.id + '.' + ext
        mkdirSync(imagesOut, { recursive: true })
        writeFileSync(file, Buffer.from(e.src.slice(e.src.indexOf(',') + 1), 'base64'))
        row.file = file
      }
    }
    if(isConnector(e)){
      // the representability gate above guarantees at least two points
      const first = e.points[0], last = e.points[e.points.length - 1]
      row.x1 = Math.round(e.x + first[0]); row.y1 = Math.round(e.y + first[1])
      row.x2 = Math.round(e.x + last[0]); row.y2 = Math.round(e.y + last[1])
    }
    return JSON.stringify(row)
  })
  // --scene-out is an echo surface like the rows, not a raw byte channel:
  // elements ride out through the same page-schema carry filter a write
  // uses, every string ROW_DENIED-stripped and code-point-capped, ids only
  // in the charset the rows echo.
  if(sceneOut){
    const stripStrings = v => {
      if(typeof v === 'string') return boundedText(v, ROW_TEXT_CAP)
      if(Array.isArray(v)) return v.map(stripStrings)
      if(v && typeof v === 'object'){ const o = {}; for(const [k, inner] of Object.entries(v)) o[k] = stripStrings(inner); return o }
      return v
    }
    writeFileSync(sceneOut, JSON.stringify(stripStrings({
      v: 1,
      elements: elements.map((e, idx) => {
        const el = Object.assign(carriedElement(e), { id: rowId(e, idx) })
        // mirror the rows' color gate: a present-but-unknown spelling reads as 'unparseable', never verbatim
        for(const k of ['stroke', 'fill']) if(colorString(e[k]) !== undefined && el[k] === undefined) el[k] = 'unparseable'
        return el
      }),
      appState: carriedAppState(scene.appState),
    })))
  }
  const out = JSON.stringify(summary, null, 1).slice(0, -2) + ',\n "elements": [' + (rows.length ? '\n  ' + rows.join(',\n  ') + '\n ]' : ']')
  process.stdout.write(out + '\n}\n')
  process.exit(0)
}

// --- write mode ---
const tplPath = arg('template'), outPath = arg('out'), addPath = arg('add')
if(!tplPath || !outPath) fail('need --template and --out (or --inspect)')
// document.title is the FIRST title element; a page carrying more than one
// has an ambiguous name a write would launder into a Claude-attributed
// rename, so refuse to write over it.
if(baseScan && baseScan.titles.length > 1)
  fail('the page in ' + basePath + ' carries more than one title - the board\'s name is ambiguous; stop and tell the user')
const retire = new Set((arg('retire') || '').split(',').map(s => s.trim()).filter(Boolean))
for(const id of retire) if(!id.startsWith('cl_')) fail('refusing to retire ' + id + ': only your own cl_ elements can be retired')
// A labeled box's label rides as <id>_t (minted below with the box):
// retiring the box sweeps its label along, or the label would orphan
// forever - the skill tells later sessions to leave unfamiliar ids alone.
// Only the exact <retired id>_t is swept, and only when the retired
// element is on the board, is a box type that can mint a riding label
// (LABELED_BOX_TYPES - a text or connector never carries one), and the
// _t element is a text label - a standalone element that merely spells
// <id>_t stays, and a retire id with no element behind it sweeps nothing.
let sweptLabels = 0
const elById = new Map(elements.map(e => [e.id, e]))
for(const id of [...retire]){
  const base = elById.get(id)
  const label = elById.get(id + '_t')
  if(base && LABELED_BOX_TYPES.has(base.type) && label && label.type === 'text' && !retire.has(id + '_t')){ retire.add(id + '_t'); sweptLabels += 1 }
}
let additions = []
if(addPath !== undefined){
  try{ additions = JSON.parse(read(addPath, 'the --add additions file')) }
  catch(e){ fail('additions file is not valid JSON (' + safeErr(e) + ')') }
  if(!Array.isArray(additions)) fail('additions must be a JSON array of elements')
}

const kept = elements.filter(e => !retire.has(e.id)).map(carriedElement)
const ids = new Set(kept.map(e => e.id))
const finite = (...ns) => ns.every(Number.isFinite)
// The one spelling of connector geometry - the builder and the nudge-follow
// rewrite both mint it here so the shape cannot fork.
const connectorGeom = (x1, y1, x2, y2) => ({ x: x1, y: y1, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), points: [[0, 0], [x2 - x1, y2 - y1]] })
let seed = 305419896
// a complete element in the page's own schema, so its sanitize() keeps every field as written
function element(a, id, type, geometry){
  seed = (seed * 1103515245 + 12345) % 2147483647
  return Object.assign({ id, type }, geometry, { seed }, STYLE, {
    stroke: carriedColor(a.stroke) ?? CLAUDE_STROKE,
    fill: carriedColor(a.fill) ?? STYLE.fill,
    strokeWidth: finite(a.strokeWidth) ? Math.max(0.5, Math.min(40, a.strokeWidth)) : STYLE.strokeWidth,
    strokeStyle: STROKE_STYLES.includes(a.strokeStyle) ? a.strokeStyle : STYLE.strokeStyle,
    fontSize: finite(a.fontSize) ? Math.max(4, Math.min(400, a.fontSize)) : STYLE.fontSize,
  })
}
const built = [] // {el, follows?: the box a label rides in}
for(const a of additions){
  if(!a || typeof a !== 'object') fail('every addition must be an object')
  // A refused id is by definition outside the sane charset, so its echo is
  // stripped and capped like every other untrusted byte.
  if(typeof a.id !== 'string' || !a.id.startsWith('cl_') || !SANE_ID.test(a.id)) fail('every addition needs an id starting with cl_, at most 40 characters, letters/digits/_/- only (got ' + safeErr(JSON.stringify(a.id)) + ')')
  if(ids.has(a.id)) fail('id ' + a.id + ' already exists on the board or earlier in this batch')
  ids.add(a.id)
  if(LABELED_BOX_TYPES.has(a.type)){
    if(!finite(a.x, a.y, a.w, a.h) || a.w <= 0 || a.h <= 0) fail(a.id + ': boxes need finite x, y and positive w, h')
    const box = element(a, a.id, a.type, { x: a.x, y: a.y, w: a.w, h: a.h })
    // sticky notes read as paper: solid pad unless the addition names a fill
    if(a.type === 'sticky' && box.fill === 'transparent'){ box.fill = '#ffec99'; box.fillStyle = 'solid' }
    built.push({ el: box })
    if(typeof a.label === 'string' && a.label.trim()){
      // the label rides as <id>_t and label ids obey the same 40-char id bound
      const labelId = a.id + '_t'
      if(labelId.length > 40) fail('id ' + a.id + ' is too long to carry a label - keep it to 38 characters so the _t label id fits')
      if(ids.has(labelId)) fail('label id ' + labelId + ' already exists - pick another id for ' + a.id)
      ids.add(labelId)
      const m = textSize(a.label, box.fontSize)
      // a cylinder's label centres in the body below its top rim, as the page draws it (KEEP-IN-SYNC: template labelBounds)
      const labelDrop = a.type === 'cylinder' ? 2 * Math.min(16, a.h * 0.18) : 0
      // offsets for now; moved to wherever its box lands after placement
      built.push({ el: element(a, labelId, 'text', { x: (a.w - m.w) / 2, y: labelDrop + (a.h - labelDrop - m.h) / 2, w: m.w, h: m.h, text: a.label }), follows: box })
    }
    continue
  }
  switch(a.type){
    case 'text': {
      if(!finite(a.x, a.y)) fail(a.id + ': text needs finite x and y')
      if(typeof a.text !== 'string' || !a.text.trim()) fail(a.id + ': text needs a non-empty text')
      const el = element(a, a.id, 'text', { x: a.x, y: a.y, w: 0, h: 0, text: a.text })
      Object.assign(el, textSize(a.text, el.fontSize))
      built.push({ el })
      break
    }
    case 'arrow': case 'line': {
      if(!finite(a.x1, a.y1, a.x2, a.y2)) fail(a.id + ': connectors need finite x1, y1, x2, y2')
      built.push({ el: element(a, a.id, a.type, connectorGeom(a.x1, a.y1, a.x2, a.y2)) })
      break
    }
    default: fail('additions must be ' + [...LABELED_BOX_TYPES].join(', ') + ', text, arrow or line (got ' + JSON.stringify(a.type) + ')')
  }
}

// --- place boxes and free text clear of everything already on the board and of each other;
// connectors keep their endpoints, labels ride with their box ---
// Only endpoint-anchored connectors stay out of the occupancy map: a pen
// stroke is a drawing, and its bbox must repel placed additions.
const intersects = (a, b) => a.x < b.x + b.w + MARGIN && a.x + a.w + MARGIN > b.x && a.y < b.y + b.h + MARGIN && a.y + a.h + MARGIN > b.y
const occupied = kept.filter(e => !isConnector(e)).map(e => boxes.get(e.id))
for(const entry of built){
  const { el, follows } = entry
  if(follows){ el.x += follows.x; el.y += follows.y; continue }
  if(isConnector(el)) continue
  let placed = null
  outer: for(let ring = 0; ring < 40; ring++){
    for(let dx = 0; dx <= ring; dx++){
      const cand = { x: el.x + dx * STEP, y: el.y + (ring - dx) * STEP, w: el.w, h: el.h }
      if(!occupied.some(o => intersects(cand, o))){ placed = cand; break outer }
    }
  }
  if(!placed) fail('no clear spot near (' + el.x + ',' + el.y + ') for ' + el.id + ' - aim at open space and run again')
  // nudgedFrom is the REQUESTED bbox; the landed position lives on el, so
  // the follow pass and the summary derive the delta instead of storing it
  if(placed.x !== el.x || placed.y !== el.y) entry.nudgedFrom = { x: el.x, y: el.y, w: el.w, h: el.h }
  el.x = placed.x; el.y = placed.y
  occupied.push(placed)
}
// Same-batch connector endpoints were computed against the spots the
// session ASKED for: an endpoint aimed within (or on) a nudged box's
// requested bbox rides with that box to where it landed, so arrows keep
// pointing at the boxes they label; endpoints anchored anywhere else -
// pre-existing elements, open space - stay put. An endpoint resting on a
// box that did NOT move is anchored there and never follows: a nudged
// box's requested footprint is exactly its overlap with whatever pushed
// it away, so an endpoint inside that footprint is usually aimed at the
// stationary side of the overlap. Pen strokes stay out of the anchor set
// - their bbox is a loose hull the placement pass deliberately nudges
// boxes OFF of, so an endpoint there was aimed at the box that moved,
// not at the drawing.
{
  const nudged = built.filter(b => b.nudgedFrom)
  if(nudged.length){
    const onBox = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
    const anchors = kept.filter(e => !LINEAR_TYPES.has(e.type)).map(e => boxes.get(e.id))
      .concat(built.filter(b => !b.nudgedFrom && !b.follows && !isConnector(b.el)).map(b => b.el))
    for(const entry of built){
      const el = entry.el
      if(!isConnector(el)) continue
      const ends = [{ x: el.x, y: el.y }, { x: el.x + el.points[1][0], y: el.y + el.points[1][1] }]
      let followed = false
      for(const p of ends){
        if(anchors.some(b => onBox(p, b))) continue
        const n = nudged.find(b => onBox(p, b.nudgedFrom))
        if(n){ p.x += n.el.x - n.nudgedFrom.x; p.y += n.el.y - n.nudgedFrom.y; followed = true }
      }
      if(!followed) continue
      entry.endpointsFollowed = true
      Object.assign(el, connectorGeom(ends[0].x, ends[0].y, ends[1].x, ends[1].y))
    }
  }
}
const merged = kept.concat(built.map(b => b.el))

// --- the new island: one publish past the base, marked as Claude's; the snapshot metadata rides along ---
// Every tab's adoption gate is strictly monotone on seq, so a restore
// rebuilt from the last clean page must outbid the version it replaces
// or no open tab ever pulls it: --seq-floor (the inauthentic page's seq,
// read from --inspect, which reports seq even when pageCodeAuthentic is
// false) lifts this write's seq above it.
const floorArg = arg('seq-floor')
// The flag present but valueless or empty (or eating the next flag) must
// refuse, not silently floor at 0: a restore that quietly fails to outbid
// the forged seq is never adopted by any tab - the exact failure the flag
// exists to prevent. A fractional floor (a seq an older page may have
// carried) is ceiled so the write still outbids it; anything past SEQ_MAX
// cannot be outbid at all and refuses.
const seqFloor = !hasArg('seq-floor') ? 0
  : floorArg.trim() !== '' ? Math.ceil(+floorArg) : NaN
if(!saneSeq(seqFloor)) fail('--seq-floor needs a non-negative whole number below ' + SEQ_MAX + ' (the seq --inspect reported for the version this write must supersede)')
// The minted seq must itself stay saneSeq or every reader (the template's
// boot parse, tab adoption, this helper's own next read) rejects the
// written island while the write reports success.
const outbid = Math.max(prevSeq, seqFloor)
if(outbid + 1 >= SEQ_MAX) fail('the board\'s version number has reached the ceiling this helper can advance (' + SEQ_MAX + ') - stop and tell the user')
const seq = outbid + 1
// Belt-and-braces on the outbid invariant the bounded reads above establish.
if(!(seq > prevSeq && seq > seqFloor)) fail('cannot mint a seq that supersedes the base (seq ' + prevSeq + ') and --seq-floor (' + seqFloor + ') - stop and tell the user')
const next = {
  v: 1, kind: 'sketchboard-publish', seq,
  snapshotId: 's' + String(seq).padStart(6, '0') + '-claude',
  publishedAt: new Date().toISOString(),
  note: Array.from(String(arg('note') || '')).slice(0, 500).join(''),
  publisherId: 'claude',
  elementCount: merged.length,
  bounds: union(merged.map(bbox)),
  // The snapshot is publisher-claimed advisory bytes nothing binds to the
  // scene: it is never carried into a publish under Claude's own id - the
  // page renders a fresh one on the user's next publish.
  png: null,
  pngFromSeq: null,
  // the newest publish made from the page itself (the user's side), carried
  // so the session's telemetry can tell user turns from its own writes -
  // bounded to the same seq lattice as seq (the page stamps userSeq = seq,
  // which is saneSeq-bounded): an out-of-range or fractional co-writer
  // claim drops to 0 instead of riding a Claude-authenticated publish and
  // wedging the telemetry baseline.
  userSeq: island ? seqOrZero(island.userSeq) : 0,
  // an acknowledgement write: tells open tabs the session has the board and is
  // still drawing; the answer that follows (written without --ack) ends it
  ack: hasArg('ack') ? true : undefined,
  sceneStorage: 'inline',
  scene: { v: 1, elements: merged, appState: carriedAppState(scene.appState) },
}

// --- write the page: the skill template with its title and its two empty island lines filled in ---
const template = loadTemplate(tplPath)
// A fetched page carries page code; a write over one whose code is not a
// known-good serialization would launder the forgery into a fresh Claude
// publish, so it fails closed (the mirror of --inspect's hard template
// requirement). A bare island JSON --base carries no page code and is
// unaffected.
if(baseScan && !pageMatchesTemplate(baseRaw, baseScan, template)){
  if(truncatedTailRead(baseRaw, baseScan, template))
    fail('the page read from ' + basePath + ' looks truncated - the page code is cut off before its closing tag; re-read the full saved HTML by path and run again' + truncatedSeqHint())
  fail('the page in ' + basePath + ' carries page code Claude did not write - run --inspect with --template on it (it will report pageCodeAuthentic: false) and follow the skill\'s security-event instructions instead of writing over it')
}
const explicit = arg('title')
if(explicit !== undefined && (/^\s*--/.test(explicit) || /<topic>/i.test(explicit) || !titleFrom(explicit)))
  fail('--title needs the board\'s name (e.g. "Ingest pipeline whiteboard"), got ' + JSON.stringify(explicit))
const esc = s => JSON.stringify(s).replace(/</g, '\\u003c')
const writtenTitle = titleFrom(explicit) || carriedTitle || DEFAULT_TITLE
const pageOut = reconstructPage(template, writtenTitle, esc(next), '')
writeFileSync(outPath, pageOut)
// Where each addition actually LANDED - placement may have nudged it off
// the requested spot, and the session must see the real layout instead of
// trusting its own coordinates. One terse line per added element: ids are
// the batch's own validated cl_ ids, coordinates schema-validated finite
// numbers (rounded for display).
const rd = n => Math.round(n)
const landed = built.map(({ el, follows, nudgedFrom, endpointsFollowed }) => {
  if(isConnector(el))
    return '  ' + el.id + ' (' + el.type + ') from (' + rd(el.x) + ',' + rd(el.y) + ') to (' + rd(el.x + el.points[1][0]) + ',' + rd(el.y + el.points[1][1]) + ')' + (endpointsFollowed ? ' - endpoint moved with its nudged box' : '')
  return '  ' + el.id + ' (' + el.type + ') at (' + rd(el.x) + ',' + rd(el.y) + ')'
    + (follows ? ' - label on ' + follows.id
      : nudgedFrom ? ' - nudged from (' + rd(nudgedFrom.x) + ',' + rd(nudgedFrom.y) + ')' : '')
})
process.stdout.write('wrote ' + outPath + ' - v' + seq + ': ' + built.length + ' added, ' + (elements.length - kept.length) + ' retired' + (sweptLabels ? ' (' + sweptLabels + ' riding label' + (sweptLabels > 1 ? 's' : '') + ' swept along)' : '') + ', ' + merged.length + ' elements; snapshot ' + (pngText ? 'dropped (publisher-claimed; the page renders its own on the next user publish)' : 'none') + '; scene sha256 ' + sceneHash(next.scene) + '; content sha256 ' + contentHash(next, writtenTitle, '') + '; page sha256 ' + createHash('sha256').update(pageOut).digest('hex') + '\n'
  + (landed.length ? 'landed:\n' + landed.join('\n') + '\n' : ''))
