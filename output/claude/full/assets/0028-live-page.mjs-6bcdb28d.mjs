

















import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runFolders, runIdOrder, runStart, writeInRunFolder, RUN_ID } from './runs.mjs';
import { assertRunsDirInsideProject, dataRoot, dirNotPrivateProblem, liveDir, originAllowed, shown, stemOk } from './config.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => c === '\u2028' ? '\\u2028' : '\\u2029');


export function liveData(state) {
  const done = new Map(state.lines.map((l) => [l.spec, l]));
  const planned = state.planned.length ? state.planned : state.lines.map((l) => ({ stem: l.spec, name: l.spec }));
  const extra = state.lines.filter((l) => !planned.some((p) => p.stem === l.spec)).map((l) => ({ stem: l.spec, name: l.spec }));
  const rows = [...planned, ...extra].map((r) => ({ stem: r.stem, name: r.name, verdict: done.has(r.stem) ? done.get(r.stem).verdict : null, ...(done.has(r.stem) && Array.isArray(done.get(r.stem).frames) && done.get(r.stem).frames.length ? { frames: done.get(r.stem).frames } : {}) }));
  const last = state.lines[state.lines.length - 1] || null;
  const running = state.finished || !state.startedAt ? null : (rows.find((r) => !r.verdict) || { stem: null }).stem;
  return { runId: state.runId, address: state.address || '', pictures: state.pictures || './', rows, running, since: last ? last.at : state.startedAt, started: !!state.startedAt, finished: !!state.finished, ...(state.finished && ['blocked', 'needs-input'].includes(state.outcome) ? { outcome: state.outcome } : {}),
    secondsPerSpec: last && typeof last.s === 'number' && state.lines.length ? Math.max(1, Math.round(last.s / state.lines.length)) : null, writtenAt: state.writtenAt };
}

const PAGE_SCRIPT = `
(function(){
  var state = JSON.parse(document.getElementById('state').textContent), heard = Date.now(), everPolled = false, timer = null;
  function f(s){ return s < 90 ? s + ' s' : Math.round(s / 60) + ' min'; }
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function count(v){ return state.rows.filter(function(r){ return r.verdict === v; }).length; }
  function head(){
    var n = state.rows.length, d = state.rows.filter(function(r){ return r.verdict; }).length, left = n - d, b = count('BLOCKED');
    var tail = count('PASS') + ' passed · ' + count('FAIL') + ' failed' + (b ? ' · ' + b + ' blocked' : '');
    if (state.finished && !d && state.outcome) return state.outcome === 'needs-input' ? 'Stopped before any spec ran: it needs an answer from you first. The question is in the conversation.' : 'Blocked before any spec ran. What stopped it, and the fix, are in the conversation.';
    if (state.finished) return 'Finished · ' + n + ' spec' + (n === 1 ? '' : 's') + ' · ' + tail;
    if (!state.started) return 'Getting ready: saving the specs and opening the browser';
    return d + ' of ' + n + ' done · ' + tail + (state.secondsPerSpec && left ? ' · about ' + f(state.secondsPerSpec) + ' a spec, roughly ' + f(state.secondsPerSpec * left) + ' left' : '');
  }
  var userOpen = Object.create(null); // what the person opened or closed by hand wins over the default (a finished run opens its FAIL and BLOCKED rows, nothing else)
  function isOpen(r){ if (!r.verdict) return false; if (r.stem in userOpen) return userOpen[r.stem]; return state.finished && r.verdict !== 'PASS'; }
  function toggle(stem){ var r = state.rows.filter(function(x){ return x.stem === stem; })[0]; if (!r || !r.verdict) return; userOpen[stem] = !isOpen(r); draw(); }
  function setAll(open){ state.rows.forEach(function(r){ if (r.verdict) userOpen[r.stem] = open; }); draw(); }
  // An open row: the picture in large, and under it the pictures the launcher took after each step the runner made, ending with the verdict's own screen.
  function viewer(li, r, png){
    var shots = (r.frames || []).map(function(f){ return state.pictures + 'frames/' + encodeURIComponent(f); }).concat([png]), at = shots.length - 1, timer = null;
    var v = el('div', 'viewer'), big = el('div', 'big'), im = el('img'); im.alt = 'A screen from this spec'; big.appendChild(im); v.appendChild(big);
    var strip = el('div', 'strip'), ctl = el('div', 'ctl'), play = el('button', 'all', '\u25B6 play'), pos = el('span', 'pos'); play.type = 'button';
    function show(i){ at = Math.max(0, Math.min(shots.length - 1, i)); im.src = shots[at]; pos.textContent = (at === shots.length - 1 ? 'the screen the verdict was given on' : 'step ' + (at + 1)) + ' · ' + (at + 1) + ' of ' + shots.length; Array.prototype.forEach.call(strip.children, function(b, k){ b.className = 'fr' + (k === at ? ' sel' : ''); if (k === at && b.scrollIntoView && shots.length > 6) b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }); }
    function stop(){ if (timer) { clearInterval(timer); timer = null; play.textContent = '\u25B6 play'; } }
    shots.forEach(function(src, i){ var b = el('button', 'fr'); b.type = 'button'; b.title = i === shots.length - 1 ? 'The screen the verdict was given on' : 'Step ' + (i + 1); var t = el('img'); t.alt = ''; t.loading = 'lazy'; t.src = src; t.onerror = function(){ b.style.display = 'none'; }; b.appendChild(t); b.addEventListener('click', function(){ stop(); show(i); }); strip.appendChild(b); });
    play.addEventListener('click', function(){ if (timer) { stop(); return; } if (at >= shots.length - 1) show(0); play.textContent = '\u275A\u275A pause'; timer = setInterval(function(){ if (at >= shots.length - 1) { stop(); return; } show(at + 1); }, 900); });
    if (shots.length > 1) { ctl.appendChild(play); ctl.appendChild(pos); v.appendChild(strip); v.appendChild(ctl); }
    li._step = function(d){ stop(); show(at + d); };
    li.appendChild(v); show(at);
  }
  function draw(){
    document.getElementById('head').textContent = head();
    var ul = document.getElementById('rows'), keep = Object.create(null);
    Array.prototype.forEach.call(ul.children, function(li){ keep[li.getAttribute('data-stem')] = li; });
    var judged = 0, opened = 0;
    state.rows.forEach(function(r, i){
      var li = keep[r.stem];
      if (!li) {
        li = el('li'); li.setAttribute('data-stem', r.stem); li.appendChild(el('span', 'chip')); li.appendChild(el('span', 'name')); li.appendChild(el('span', 'stem'));
        li.addEventListener('click', function(ev){ if (ev.target && ev.target.closest && ev.target.closest('.viewer')) return; toggle(r.stem); });
        li.addEventListener('keydown', function(ev){ if (ev.target !== li) return; if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(r.stem); } else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && li._step) { ev.preventDefault(); li._step(ev.key === 'ArrowRight' ? 1 : -1); } });
      }
      if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
      var now = !r.verdict && state.running === r.stem, open = isOpen(r);
      if (r.verdict) { judged++; if (open) opened++; }
      li.className = (r.verdict ? 'done' : now ? 'now' : 'todo') + (open ? ' open' : '');
      if (r.verdict) { li.setAttribute('tabindex', '0'); li.setAttribute('role', 'button'); li.setAttribute('aria-expanded', open ? 'true' : 'false'); li.title = open ? 'Click to close' : 'Click to see the screen'; }
      var chip = li.children[0]; chip.className = 'chip ' + (r.verdict ? r.verdict.toLowerCase() : now ? 'running' : 'waiting'); chip.setAttribute('data-now', now ? '1' : '');
      if (!now) chip.textContent = r.verdict || 'waiting';
      li.children[1].textContent = r.name; li.children[2].textContent = r.stem;
      var png = state.pictures + encodeURIComponent(r.stem) + '.png';
      var th = li.querySelector('img.thumb');
      if (r.verdict && !th && !li.getAttribute('data-noshot')) { th = el('img', 'thumb'); th.alt = ''; th.onerror = function(){ li.setAttribute('data-noshot', '1'); if (this.parentNode) this.parentNode.removeChild(this); }; th.src = png; li.appendChild(th); }
      if (open && !li.querySelector('.viewer') && !li.getAttribute('data-noshot')) viewer(li, r, png);
    });
    while (ul.children.length > state.rows.length) ul.removeChild(ul.lastChild);
    var all = document.getElementById('all'); all.hidden = !judged; all.textContent = opened === judged && judged ? 'hide all screenshots' : 'show all screenshots'; all.onclick = function(){ setAll(!(opened === judged && judged)); };
    document.getElementById('foot').textContent = (judged ? 'Click a spec to see how the runner got to its verdict: the screens after each step, then the one it judged. ' : '') + (state.finished ? 'The reason for each verdict is in the conversation and in log.md in the folder of this run, .claude-test/runs/' + state.runId + '/ in your project.' : 'This page keeps itself up to date while the run goes on; the reason for each verdict arrives in the conversation with the results.');
    tick();
  }
  function tick(){
    var c = document.querySelector('.chip[data-now="1"]'); if (c) { var d = Date.parse(state.since); c.textContent = 'running' + (d ? ' · ' + f(Math.max(0, Math.round((Date.now() - d) / 1000))) : ''); }
    var live = document.getElementById('live'); if (state.finished) { live.textContent = ''; return; }
    var quiet = Math.round((Date.now() - heard) / 1000), old = Math.round((Date.now() - Date.parse(state.writtenAt)) / 60000);
    live.className = 'live' + (quiet > 12 ? ' warn' : '');
    live.textContent = quiet > 12 ? (everPolled ? 'The page could not read its data file for ' + f(quiet) + '.' : 'This browser is not letting the page read the file beside it.') + ' Refresh the page to see where the run stands.' : (state.started && old >= 8) ? 'The run has written nothing for ' + old + ' minutes: it may have stopped. Ask for status in the conversation.' : 'live · checked ' + (quiet <= 2 ? 'just now' : quiet + ' s ago');
  }
  window.__claudeTestLive = function(d){ if (!d || d.runId !== state.runId || !Array.isArray(d.rows)) return; heard = Date.now(); everPolled = true; if (d.writtenAt !== state.writtenAt) { state = d; draw(); } if (state.finished && timer) { clearInterval(timer); timer = null; } };
  function poll(){ var s = document.createElement('script'); s.src = 'live-data.js?t=' + Date.now(); s.onload = s.onerror = function(){ if (s.parentNode) s.parentNode.removeChild(s); }; document.head.appendChild(s); }
  draw(); setInterval(tick, 1000);
  if (!state.finished) { timer = setInterval(poll, 2000); poll(); }
})();
`;



const PAGE_SCRIPT_HASH = createHash('sha256').update(PAGE_SCRIPT).digest('base64');
export function renderLivePage(data) {
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' file:; script-src \'sha256-' + PAGE_SCRIPT_HASH + '\' \'strict-dynamic\' file:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>Claude Test · ' + esc(data.runId) + '</title>\n<style>\n' +
    ':root{--bg:#fbfaf7;--fg:#1d1c1a;--mut:#6b675f;--line:#e4e0d6;--pass:#1f7a4d;--fail:#b3261e;--blk:#8a6100;--run:#2457a6;--card:#fff}\n' +
    '@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--mut:#a09c92;--line:#2e2d29;--pass:#5fc28f;--fail:#f2837b;--blk:#e0b155;--run:#8ab0f0;--card:#1e1e1b}}\n' +
    'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:860px;margin:0 auto;padding:28px 20px 60px}\n' +
    'h1{font-size:18px;margin:0 0 2px;font-weight:650}.sub{color:var(--mut);font-size:13px;margin:0 0 18px;word-break:break-all}.head{font-size:16px;margin:0 0 4px;font-variant-numeric:tabular-nums}\n' +
    '.live{color:var(--mut);font-size:12px;margin:0 0 16px;min-height:17px;font-variant-numeric:tabular-nums}.live.warn{color:var(--blk)}\n' +
    'ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:grid;grid-template-columns:132px 1fr auto;gap:4px 12px;align-items:center}\n' +
    'li.now{border-color:var(--run)}li.todo{opacity:.62}.name{font-weight:550}.stem{grid-column:2;color:var(--mut);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}\n' +
    '.chip{grid-row:1 / span 2;white-space:nowrap;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.03em;padding:3px 8px;border-radius:999px;border:1px solid currentColor;justify-self:start;font-variant-numeric:tabular-nums}\n' +
    '.pass{color:var(--pass)}.fail{color:var(--fail)}.blocked{color:var(--blk)}.running{color:var(--run)}.waiting{color:var(--mut);border-style:dashed}\n' +
    'li.done{cursor:pointer}li.done:hover{border-color:var(--mut)}li:focus-visible{outline:2px solid var(--run);outline-offset:2px}\n' +
    '.thumb{grid-column:3;grid-row:1 / span 2;display:block;height:54px;width:auto;max-width:150px;border:1px solid var(--line);border-radius:4px;object-fit:cover;object-position:top}li.open .thumb{visibility:hidden}\n' +
    '.viewer{display:none;grid-column:1 / -1;grid-row:3;margin-top:8px;cursor:default}li.open .viewer{display:block}.big{display:block}.big img{display:block;width:100%;height:auto;max-height:70vh;object-fit:contain;object-position:top left;border:1px solid var(--line);border-radius:6px;background:var(--bg)}\n' +
    '.strip{display:flex;gap:6px;overflow-x:auto;padding:8px 0 4px}.fr{flex:0 0 auto;padding:0;border:2px solid transparent;border-radius:6px;background:none;cursor:pointer}.fr.sel{border-color:var(--run)}.fr img{display:block;height:52px;width:auto;max-width:120px;border:1px solid var(--line);border-radius:4px;object-fit:cover;object-position:top}\n' +
    '.ctl{display:flex;gap:12px;align-items:baseline;color:var(--mut);font-size:12px}.ctl .all{margin:0}\n' +
    '.all{background:none;border:0;padding:0;margin:0 0 12px;color:var(--run);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline}\n' +
    'footer{color:var(--mut);font-size:12px;margin-top:22px}\n' +
    '</style></head><body><main>\n<h1>Claude Test · ' + esc(data.runId) + '</h1>\n<p class="sub">' + esc(data.address) + '</p>\n<p class="head" id="head"></p>\n<p class="live" id="live"></p>\n<button class="all" id="all" type="button" hidden></button>\n<ul id="rows"></ul>\n<footer id="foot"></footer>\n' +
    '<noscript><p>This page needs JavaScript to draw the run. The same information is in progress.ndjson in the folder of this run, .claude-test/runs/' + esc(data.runId) + '/ in your project; or ask for status in the conversation.</p></noscript>\n' +
    '<script type="application/json" id="state">' + json(data) + '</script>\n<script>' + PAGE_SCRIPT + '</script>\n</main></body></html>\n';
}



export function writeLivePage(dir, state) {
  try {
    const data = liveData({ ...state, writtenAt: new Date().toISOString() });
    const a = writeInRunFolder(dir, 'live-data.js', 'window.__claudeTestLive && window.__claudeTestLive(' + json(data) + ');\n');
    const b = writeInRunFolder(dir, 'live.html', renderLivePage(data));
    return a && b;
  } catch { return false; }
}

const MAX_BYTES = 2 * 1024 * 1024; const MOST_LINES = 2000; const MOST_ROWS = 500; const MOST_RUNS = 4;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const KEEP_RUNS = 8; const QUIET_MS = 45 * 60 * 1000; const RECENT_MS = 12 * 3600 * 1000;



function readPlain(file) {
  let fd = null;
  try {
    if (process.platform === 'win32' && !fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(st.size); let got = 0;
    while (got < st.size) { const n = fs.readSync(fd, bytes, got, st.size - got, got); if (!n) break; got += n; }
    return bytes.toString('utf8', 0, got);
  } catch (e) { return e && e.code === 'ENOENT' ? undefined : null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {              } } }
}

function parsed(text) {
  if (typeof text !== 'string' || text.length > 262144) return null;
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}




export function runStateOf({ runId, address, pictures, progress, names, decisions, results }) {
  const lines = String(progress || '').split('\n', MOST_LINES).map(parsed).filter(Boolean);
  const st = lines.find((l) => l.event === 'start') || null;
  const n = parsed(names); const nameOf = new Map(n && n.names && typeof n.names === 'object' && !Array.isArray(n.names) ? Object.entries(n.names).slice(0, MOST_ROWS) : []);
  const d = parsed(decisions); const drop = new Set(d && Array.isArray(d.drop) ? d.drop.slice(0, MOST_ROWS).filter(stemOk) : []);
  const finished = results !== undefined; const res = finished ? parsed(results) : null;
  const judged = new Map();
  for (const l of lines) if (stemOk(l.spec) && ['PASS', 'FAIL', 'BLOCKED'].includes(l.verdict)) { judged.delete(l.spec); judged.set(l.spec, { spec: l.spec, verdict: l.verdict, at: typeof l.at === 'string' && ISO_TIME.test(l.at) ? l.at : null, s: Number.isFinite(l.s) && l.s >= 0 && l.s <= 1e7 ? Math.round(l.s) : null, frames: Array.isArray(l.frames) ? l.frames.slice(0, 400).filter((f) => typeof f === 'string' && /^f-\d{4}\.jpeg$/.test(f)).slice(0, 40) : [] }); }

  const planned = []; const listed = new Set();
  for (const stem of st && Array.isArray(st.specs) ? st.specs.slice(0, MOST_ROWS) : []) {
    if (!stemOk(stem) || listed.has(stem) || drop.has(stem) || (finished && !judged.has(stem))) continue;
    const name = nameOf.get(stem);
    listed.add(stem); planned.push({ stem, name: (typeof name === 'string' && shown(name.trim(), 140)) || stem });
  }
  const verdicts = [];
  for (const v of judged.values()) { if (!listed.has(v.spec)) { if (listed.size >= MOST_ROWS) continue; listed.add(v.spec); } verdicts.push(v); }
  return { runId, address: shown(String(address || ''), 300), pictures, planned, lines: verdicts, startedAt: st && typeof st.at === 'string' && ISO_TIME.test(st.at) ? st.at : null, finished, outcome: res && ['passed', 'failed', 'blocked', 'needs-input'].includes(res.outcome) ? res.outcome : null };
}



export function readRunState(runDir, { runId, address }) {
  const progress = readPlain(path.join(runDir, 'progress.ndjson')); if (progress === null) return null;
  const results = readPlain(path.join(runDir, 'results.json'));
  return runStateOf({ runId, address, pictures: pathToFileURL(runDir).href + '/', progress, names: readPlain(path.join(runDir, 'names.json')) || undefined, decisions: readPlain(path.join(runDir, 'decisions.json')) || undefined, results: results === null ? '' : results });
}


function ownFolder(dir) {
  try {
    let at = dataRoot();
    for (const name of path.relative(at, dir).split(path.sep)) {
      at = path.join(at, name);
      try { fs.mkdirSync(at, { mode: 0o700 }); } catch (e) { if (!e || e.code !== 'EEXIST') return false; }
      if (!fs.lstatSync(at).isDirectory()) return false;
    }
    return !dirNotPrivateProblem(path.join(dataRoot(), 'live'));
  } catch { return false; }
}



export function notOwnWay(dir) {
  try {
    let at = dataRoot(); const below = path.relative(at, dir);
    if (!below || below.startsWith('..') || path.isAbsolute(below)) return dir + ' is not below Claude Test\'s data folder';
    for (const name of below.split(path.sep)) {
      at = path.join(at, name);
      let st; try { st = fs.statSync(at); } catch (e) { if (e && e.code === 'ENOENT') return null; return at + ' could not be read (' + ((e && e.code) || 'error') + ')'; }
      const problem = dirNotPrivateProblem(at, st); if (problem) return problem;
    }
    return null;
  } catch { return dir + ' could not be read'; }
}

export function plainWay(dir) {
  try {
    let at = dataRoot(); const below = path.relative(at, dir);
    if (!below || below.startsWith('..') || path.isAbsolute(below)) return false;
    for (const name of below.split(path.sep)) { at = path.join(at, name); if (!fs.lstatSync(at).isDirectory()) return false; }
    return !notOwnWay(dir);
  } catch { return false; }
}


function prune(projectLive, keep) {
  try {
    if (!fs.lstatSync(projectLive).isDirectory()) return;
    const ids = fs.readdirSync(projectLive).filter((d) => RUN_ID.test(d)).sort(runIdOrder);
    for (const d of ids.slice(0, Math.max(0, ids.length - keep))) { const p = path.join(projectLive, d); if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); }
  } catch {                          }
}





export function makeLivePageKeeper({ cfg, everyMs = 2000 }) {
  const runs = new Map(); let lastLook = 0; let timer = null; let listed = { at: 0, stamp: null };
  const settings = (next) => { if (next && next.projectDir === cfg.projectDir) cfg = next; };
  const soon = new Set();
  const rest = () => { if (timer) { clearInterval(timer); timer = null; } };
  const stop = () => { rest(); for (const t of soon) clearTimeout(t); soon.clear(); };
  const stampOf = (dir) => ['progress.ndjson', 'names.json', 'decisions.json', 'results.json'].map((n) => { try { const s = fs.lstatSync(path.join(dir, n)); return s.size + ':' + s.mtimeMs; } catch { return '-'; } }).join('|');

  const realRunDir = (dir) => { try { assertRunsDirInsideProject(cfg); return fs.lstatSync(dir).isDirectory() && fs.realpathSync(dir) === path.join(fs.realpathSync(cfg.projectDir), path.relative(cfg.projectDir, dir)); } catch { return false; } };
  const write = (id, run) => {
    if (!realRunDir(run.dir)) return false;
    const state = readRunState(run.dir, { runId: id, address: cfg.baseUrl && originAllowed(cfg, cfg.baseUrl) ? cfg.baseUrl : '' });
    if (!state || !realRunDir(run.dir) || !ownFolder(run.live)) return false;
    if (!run.pruned) { run.pruned = true; prune(path.dirname(run.live), KEEP_RUNS); }
    if (!writeLivePage(run.live, state)) return false;
    run.finished = state.finished; return true;
  };
  const tick = () => {
    try {
      const now = Date.now();
      for (const [id, run] of runs) {
        const stamp = stampOf(run.dir);
        if (stamp !== run.seen) { run.seen = stamp; run.changedAt = now; }
        if (stamp !== run.stamp && write(id, run)) run.stamp = stamp;
        if (run.finished || now - run.changedAt > QUIET_MS) runs.delete(id);
      }
      if (!runs.size) rest();
    } catch {                                                          }
  };
  const look = (unpaced = false, again = unpaced) => {
    try {
      const now = Date.now(); if (!unpaced && now - lastLook < everyMs) return; lastLook = now;
      assertRunsDirInsideProject(cfg);

      let stamp = '-'; try { stamp = String(fs.lstatSync(cfg.runsDir).mtimeMs); } catch {                          }
      if (!unpaced && stamp === listed.stamp && now - listed.at < 30000) { tick(); return; }
      listed = { at: now, stamp };
      const changedLately = (p) => { try { return now - fs.lstatSync(p).mtimeMs < RECENT_MS; } catch { return false; } };
      for (const id of runFolders(cfg).slice(-MOST_RUNS)) {
        if (runs.has(id)) continue;
        const dir = path.join(cfg.runsDir, id); const began = runStart(id); let results = null; try { results = fs.lstatSync(path.join(dir, 'results.json')); } catch {                    }

        if (results) { try { if (fs.lstatSync(path.join(liveDir(cfg.projectDir, id), 'live.html')).mtimeMs >= results.mtimeMs) continue; } catch { continue; } }

        else if (!(began && now - began.getTime() < RECENT_MS) && ![dir, ...['progress.ndjson', 'names.json', 'decisions.json'].map((n) => path.join(dir, n))].some(changedLately)) continue;
        if (runs.size >= MOST_RUNS) {
          if ([...runs.keys()].some((other) => runIdOrder(other, id) > 0)) continue;
          runs.delete([...runs].sort((a, b) => a[1].changedAt - b[1].changedAt)[0][0]);
        }
        runs.set(id, { dir, live: liveDir(cfg.projectDir, id), stamp: null, changedAt: now, seen: null, finished: false, pruned: false });
      }
      if (runs.size && !timer) { timer = setInterval(tick, everyMs); if (timer.unref) timer.unref(); }
      tick();

      if (again) for (const ms of [1000, 3000]) { const t = setTimeout(() => { soon.delete(t); look(true, false); }, ms); soon.add(t); if (t.unref) t.unref(); }
    } catch {                                                          }
  };
  return { look, stop, settings };
}

const keepers = new Map();
let lastAll = 0;

export function keepLivePage(cfgs, { unpaced = false } = {}) {
  try {
    const now = Date.now(); if (!unpaced && !cfgs.length && now - lastAll < 2000) return; lastAll = now;
    for (const cfg of cfgs) { if (keepers.has(cfg.projectDir)) keepers.get(cfg.projectDir).settings(cfg); else keepers.set(cfg.projectDir, makeLivePageKeeper({ cfg })); }
    for (const keeper of keepers.values()) keeper.look(unpaced);
  } catch {                                                          }
}
