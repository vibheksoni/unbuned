



import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appPointer, loadConfig, assertRunsDirInsideProject, reallyInsideDir, runsPathProblem, originAllowed, projectsBelow, isMarked } from './config.mjs';








export function makeVet({ cfg, sessionRoot: SESSION_ROOT, state, stagingDir }) {
  const S = state;
  const isSecretField = (f) => !!f && typeof f.value === 'string' && S.secretKeySet.has(f.value) && (f.type === 'textbox' || f.type === 'slider');

  function namesSecret(name, a) {
    if (!a || typeof a !== 'object') return null;
    if (S.secretsUnreadable && (name === 'browser_type' || name === 'browser_fill_form')) return '(unknown: the secrets file could not be read)';
    if (!S.secretKeySet.size) return null;
    if (name === 'browser_type' && typeof a.text === 'string' && S.secretKeySet.has(a.text)) return a.text;
    if (name === 'browser_fill_form' && Array.isArray(a.fields)) { const f = a.fields.find((x) => x && typeof x.value === 'string' && S.secretKeySet.has(x.value) && (x.type === 'textbox' || x.type === 'slider')); if (f) return f.value; }
    return null;
  }


  function elementTargets(name, a, secretOnly = false) {
    const out = [];
    const take = (obj) => { for (const [k, v] of Object.entries(obj || {})) if (/(target|ref)$/i.test(k) && v !== undefined) out.push(v); };
    if (!secretOnly || name === 'browser_type') take(a);
    if (Array.isArray(a && a.fields)) for (const f of a.fields) if (f && (!secretOnly || isSecretField(f))) take(f);
    return out;
  }
  
  const FILE_ARG_KEYS = ['filename', 'fileName'];
  const URL_ARG_KEYS = ['url'];




  const ownerCache = new Map();


  function projectForRunsPath(abs) {
    const marker = path.sep + path.join('.claude-test', 'runs') + path.sep;
    const i = abs.lastIndexOf(marker);
    if (i < 0) return null;
    const proj = abs.slice(0, i) || path.sep;
    if (proj === cfg.projectDir) {
      const runId = abs.slice(i + marker.length).split(path.sep)[0];
      return runId && fs.existsSync(path.join(cfg.runsDir, runId)) ? cfg : null;
    }
    if (!reallyInsideDir(proj, SESSION_ROOT)) return null;
    const runId = abs.slice(i + marker.length).split(path.sep)[0];


    let owner = ownerCache.get(proj) || null;
    if (!owner) { const marked = isMarked(proj); let c2 = null; try { if (marked || appPointer(SESSION_ROOT) === proj) { c2 = loadConfig(proj); assertRunsDirInsideProject(c2); if (!fs.existsSync(c2.runsDir)) c2 = null; } } catch { c2 = null; } if (!c2) return null; if (marked) ownerCache.set(proj, c2); owner = c2; }
    if (!runId || !fs.existsSync(path.join(owner.runsDir, runId))) return null;
    return owner;
  }



  const MOD_RE = /^((Shift|Control|Alt|Meta)(Left|Right)?|ControlOrMeta)$/;
  const KEY_RE = /^([\x20-\x7e]|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Escape|Backquote|Minus|Equal|Backslash|Backspace|Tab|BracketLeft|BracketRight|CapsLock|Semicolon|Quote|Enter|Comma|Period|Slash|Space|AltGraph|ContextMenu|PrintScreen|ScrollLock|Pause|PageUp|PageDown|Insert|Delete|Home|End|Arrow(Left|Up|Right|Down)|AudioVolume(Mute|Down|Up)|MediaTrack(Next|Previous)|MediaPlayPause|NumLock)$/;
  const splitKeys = (str) => { const keys = []; let b = ''; for (const ch of str) { if (ch === '+' && b) { keys.push(b); b = ''; } else b += ch; } keys.push(b); return keys; };
  const CLIP_ALIAS = { keyc: 'c', keyx: 'x', keyv: 'v', numpad0: 'insert', numpaddecimal: 'delete' };
  const pressKeyProblem = (key, afterSecret) => {
    if (typeof key !== 'string') return 'malformed';
    const toks = splitKeys(key); const last = toks[toks.length - 1];
    if (!toks.slice(0, -1).every((m) => MOD_RE.test(m)) || !(KEY_RE.test(last) || MOD_RE.test(last))) return 'malformed';
    if (!afterSecret) return null;
    const norm = toks.map((t) => { const b = t.toLowerCase().replace(/(left|right)$/, ''); return CLIP_ALIAS[b] || b; }); const has = (...names) => names.some((n) => norm.includes(n));
    return (has('control', 'meta', 'controlormeta') && has('c', 'x', 'v', 'insert')) || (has('shift') && has('insert', 'delete')) ? 'clipboard' : null;
  };
  const REFUSED_TOOLS = new Map([['browser_drop', 'dropping files or data onto a page is not something Claude Test does'], ['browser_file_upload', 'uploading local files to a page is not something Claude Test does (the private sign-in files live on this machine)'], ['browser_install', 'browser downloads go through "ct.mjs install", not the browser server'], ['browser_run_code_unsafe', 'arbitrary Node-side code with page access is never needed to test a page'], ['browser_route', 'request rewriting is not part of a test run'], ['browser_unroute', 'request rewriting is not part of a test run']]);
  function vetFileArgs(msg) {
    if (Array.isArray(msg)) return 'JSON-RPC batch requests are refused by this launcher (send one request per line)';
    if (msg && msg.method === 'tools/call' && msg.params && REFUSED_TOOLS.has(msg.params.name)) return msg.params.name + ' is refused by this launcher: ' + REFUSED_TOOLS.get(msg.params.name);
    if (!msg || msg.method !== 'tools/call' || !msg.params || typeof msg.params.arguments !== 'object' || msg.params.arguments === null) return null;
    const a = msg.params.arguments;
    const toolName = msg.params.name;
    const key = namesSecret(toolName, a);
    if (key && msg.id === undefined) return 'a call that types a secret must carry a request id';
    if (key && Array.isArray(a.fields) && a.fields.some((f) => isSecretField(f) && f.type === 'slider')) return 'a secret goes into a text field, not a slider';
    if (key && a.submit === true) return 'a secret is typed without submit:true — type it, then press Enter with browser_press_key or click the sign-in button, so the launcher can check the value landed in its field before the page moves on';
    if (key && S.secretsUnreadable) return 'the secrets file could not be read by the launcher, so no secret is typed this session (fix the file, then /mcp → reconnect)';
    if (key) { const targets = elementTargets(toolName, a, true); const anyBad = elementTargets(toolName, a, false).find((t) => typeof t !== 'string' || !/^(f\d+)?e\d+$/.test(t)); const bad = anyBad !== undefined ? anyBad : targets.find((t) => typeof t !== 'string' || !/^(f\d+)?e\d+$/.test(t)); if (bad !== undefined || !targets.length) return 'a secret is typed only into an element named by its snapshot ref (e12 / f1e12), never by a selector — a ref pins the element to the page the address check saw: ' + JSON.stringify(String(bad === undefined ? '' : bad).slice(0, 60)); msg.__secretTargets = targets; msg.__secretPairs = toolName === 'browser_type' ? [[typeof a.target === 'string' ? a.target : a.ref, key]] : a.fields.filter(isSecretField).map((f) => [typeof f.target === 'string' ? f.target : f.ref, f.value]); if (msg.__secretPairs.some(([t]) => typeof t !== 'string')) return 'every field that takes a secret must name its element as "target": "<snapshot ref>"'; }
    if (key && S.scripted) return 'browser_evaluate already ran in this browser context, so the secret ' + key + ' is not typed into it (script planted earlier could read it) — browser_close, open the page fresh, sign in first, and use browser_evaluate only afterwards if at all';
    if (key && FILE_ARG_KEYS.some((k) => a[k] !== undefined)) return 'a call that types a secret does not also save a file: take the picture or snapshot in a call of its own';
    if (key) msg.__typesSecret = key;
    if (S.secretTyped && toolName === 'browser_wait_for' && (a.text !== undefined || a.textGone !== undefined)) return 'a secret was typed in this browser context, so browser_wait_for with text is off until the next browser_close (whether a text appears is a yes/no question over the raw page, where the typed value sits) — wait a fixed time, or check with browser_snapshot';
    if (key && toolName === 'browser_type' && a.slowly === true) return 'a secret is filled, never typed key by key (slowly:true would show every prefix to the page)';
    if (S.secretTyped && toolName === 'browser_network_request') return 'a secret was typed in this browser context, so request details (browser_network_request) are off until the next browser_close — a sign-in request carries the credential in encodings no scrub can follow; the numbered list (browser_network_requests) stays available';
    if (S.secretTyped && toolName === 'browser_network_requests' && a.filter !== undefined) return 'a secret was typed in this browser context, so browser_network_requests is used without "filter" until the next browser_close (a filter is a yes/no question over raw request URLs, where the value may sit) — list them unfiltered';


    const moved = S.secretEver || S.secretTyped;
    if (toolName === 'browser_press_key') { const p = pressKeyProblem(a.key, moved); if (p === 'clipboard') return 'a secret was typed in this browser, so clipboard chords (copy, cut, paste) in browser_press_key are off for the rest of this session — a copied value could be pasted into a page on another allowed host; press single keys (Enter, Tab, arrows) instead'; if (p) return 'browser_press_key takes a key name exactly as the browser tool spells it ("Enter", "Tab", "a", "Control+A", "Shift+ArrowLeft"): ' + JSON.stringify(String(a.key).slice(0, 40)) + ' is not one (a chord with an unknown part would leave its modifier key held down for the next key)'; }
    if (moved && toolName === 'browser_click' && a.button !== undefined && a.button !== 'left') return 'a secret was typed in this browser, so only plain left-button clicks are made for the rest of this session (a middle click pastes the current selection on some systems)';
    if (moved && toolName === 'browser_drag') return 'a secret was typed in this browser, so browser_drag is off for the rest of this session (dragging a selected value into another document would hand it over)';
    if (S.secretTyped && toolName === 'browser_find') return 'a secret was typed in this browser context, so browser_find is off until the next browser_close (its matching runs over the raw page, where the typed value sits) — use browser_snapshot, whole or with a ref target';
    if (S.secretTyped) { const sel = elementTargets(toolName, a).find((t) => typeof t !== 'string' || !/^(f\d+)?e\d+$/.test(t)); if (sel !== undefined) return 'a secret was typed in this browser context, so elements are named by snapshot ref only (no selectors, which could test the typed value) until the next browser_close: ' + JSON.stringify(String(sel).slice(0, 60)); }
    if (toolName === 'browser_evaluate') msg.__scripts = true;
    if (toolName === 'browser_evaluate' && S.secretTyped) return 'a secret was typed in this browser context, so page script (browser_evaluate) is off until the next browser_close — a typed secret must not be readable back; check text with browser_snapshot (whole, or a ref as target) instead, or close the page and start the next spec';
    if (a.paths !== undefined) return 'paths: local file lists are refused by this launcher';
    let touched = false;
    for (const key of FILE_ARG_KEYS) {
      const v = a[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || v === '') return key + ' must be a file path under ' + path.relative(cfg.projectDir, cfg.runsDir) + '/';





      let abs = path.isAbsolute(v) ? path.resolve(v) : path.resolve(cfg.projectDir, v);
      if (!path.isAbsolute(v) && !projectForRunsPath(abs) && cfg.projectDir !== SESSION_ROOT) abs = path.resolve(SESSION_ROOT, v);
      if (!path.isAbsolute(v) && !projectForRunsPath(abs)) {
        const m = v.split(/[\\/]/); const k = m.indexOf('.claude-test');
        if (k >= 0 && m[k + 1] === 'runs' && m[k + 2]) { const hits = projectsBelow(SESSION_ROOT).map((b) => path.join(SESSION_ROOT, b)).filter((d) => fs.existsSync(path.join(d, '.claude-test', 'runs', m[k + 2]))); if (hits.length === 1) abs = path.resolve(hits[0], v.split(/[\\/]/).slice(k).join(path.sep)); }
      }



      const owner = projectForRunsPath(abs);
      if (!owner) return key + ' ' + JSON.stringify(v) + ' must be a file under <an app folder inside ' + SESSION_ROOT + '>/.claude-test/runs/<run>/';
      const problem = runsPathProblem(owner, abs);
      if (problem) return key + ' ' + JSON.stringify(v) + ' ' + problem;
      if (msg.id === undefined) return key + ': a call that saves a file must carry a request id';



      const dest = abs;
      const ext = dest.endsWith('.snapshot.md') ? '.snapshot.md' : /^\.[A-Za-z0-9]{1,8}$/.test(path.extname(dest)) ? path.extname(dest) : '';
      const staged = path.join(stagingDir, crypto.randomBytes(8).toString('hex') + ext);
      let realDir; try { realDir = fs.realpathSync(path.dirname(abs)); } catch { return key + ' ' + JSON.stringify(v) + ' cannot be written: its run folder is gone'; }
      let realRoot; try { realRoot = fs.realpathSync(owner.projectDir); } catch { return key + ' ' + JSON.stringify(v) + ' cannot be written: its project folder is gone'; }
      a[key] = staged; touched = true; (msg.__files = msg.__files || []).push({ staged, dest, owner, realDir, realRoot });
    }
    for (const key of URL_ARG_KEYS) {
      const v = a[key];
      if (v === undefined) continue;

      if (typeof v !== 'string') return key + ' must be a URL';
      if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(v)) return key + ' holds a control character (a tab, a line break): a URL parser drops those silently, and the address would be echoed into an answer this launcher reads the page\'s own address from';
      if (v === 'about:blank') continue;
      const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^(about|blob|data|file|javascript|view-source):/i.test(v);
      const withScheme = hasScheme ? v : (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(v) ? 'http://' : 'https://') + v;
      if (!originAllowed(cfg, withScheme)) return key + ' ' + JSON.stringify(v.slice(0, 200)) + ' is not an allowed origin (' + cfg.allowedOrigins.join(' ') + ')';
    }
    if (touched || '_meta' in a) { delete a._meta; msg.__rewritten = true; }
    return null;
  }
  
  return { vet: vetFileArgs, isSecretField, namesSecret, elementTargets, REFUSED_TOOLS };
}
