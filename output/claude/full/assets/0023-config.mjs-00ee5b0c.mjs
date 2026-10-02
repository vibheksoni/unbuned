





import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { discoverDevServer, candidateList } from './discover.mjs';

export const RC_FILE = '.claude-testrc';
export const SPECS_DIR = path.join('.claude-test', 'specs');
export const RUNS_DIR = path.join('.claude-test', 'runs');
export const DEFAULT_BASE_URL = 'http://localhost:3000';


export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.79';
export const PLAYWRIGHT_MCP_VERSION = '0.0.79';



export const PLAYWRIGHT_PIN = '1.62.1';

export const MAX_OWN_STATE_BYTES = 16 * 1024 * 1024;

function stripComment(line) {

  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const dict = () => Object.create(null);

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === 'no' || v === 'off') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((s) => parseScalar(s));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const obj = dict();
    const inner = v.slice(1, -1).trim();
    if (inner) for (const part of inner.split(',')) {
      const k = part.indexOf(':');
      const key = k > 0 ? part.slice(0, k).trim() : '';
      if (key && !BAD_KEYS.has(key)) obj[key] = parseScalar(part.slice(k + 1));
    }
    return obj;
  }
  return v;
}


export function parseRc(text) {
  const data = dict();
  const warnings = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let currentKey = null;
  for (let n = 0; n < lines.length; n++) {
    const rawLine = stripComment(lines[n]);
    if (rawLine.trim() === '' || rawLine.trim() === '---') continue;
    if (/^\t/.test(rawLine)) { warnings.push('line ' + (n + 1) + ': starts with a tab (YAML indents with spaces), ignored'); continue; }
    const indent = rawLine.match(/^ */)[0].length;
    const line = rawLine.trim();
    if (indent === 0) {
      const m = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
      if (!m) { warnings.push('line ' + (n + 1) + ': not understood, ignored'); currentKey = null; continue; }
      const [, key, rest] = m;
      if (BAD_KEYS.has(key)) { warnings.push('line ' + (n + 1) + ': key "' + key + '" refused'); currentKey = null; continue; }
      if (rest === '' ) { data[key] = undefined; currentKey = key; }
      else { data[key] = parseScalar(rest); currentKey = null; }
    } else if (currentKey) {
      if (line.startsWith('- ')) {
        if (!Array.isArray(data[currentKey])) data[currentKey] = [];
        data[currentKey].push(parseScalar(line.slice(2)));
      } else {
        const m = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
        if (!m) { warnings.push('line ' + (n + 1) + ': not understood, ignored'); continue; }
        if (BAD_KEYS.has(m[1])) { warnings.push('line ' + (n + 1) + ': key "' + m[1] + '" refused'); continue; }
        if (data[currentKey] === undefined) data[currentKey] = dict();
        if (typeof data[currentKey] === 'object' && data[currentKey] !== null && !Array.isArray(data[currentKey])) data[currentKey][m[1]] = parseScalar(m[2]);
        else warnings.push('line ' + (n + 1) + ': mapping entry under a non-mapping key, ignored');
      }
    } else {
      warnings.push('line ' + (n + 1) + ': unexpected indentation, ignored');
    }
  }
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  return { data, warnings };
}







const HOST = /^(?=.{1,253}$)(?!\d+$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const V6 = /^\[[0-9a-f:]+\]$/;
const hostOk = (h) => HOST.test(h) || V6.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];


import { reachableEntryProblem } from './hosts.mjs';

export function isLocalHost(h) {
  let x = String(h).trim().toLowerCase(); if (!x) return false;
  if (!x.startsWith('[') && x.includes(':')) x = '[' + x + ']';
  let canon; try { canon = new URL('http://' + x + '/').hostname; } catch { return false; }
  if (/^localhost\.?$/.test(canon) || /\.localhost\.?$/.test(canon)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(canon)) return /^127\./.test(canon) || canon === '0.0.0.0';
  if (canon.startsWith('[')) { const v6 = canon.slice(1, -1); if (v6 === '::1' || v6 === '::') return true; const m4 = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); if (m4) { const a = parseInt(m4[1], 16) >> 8; return a === 127 || (parseInt(m4[1], 16) === 0 && parseInt(m4[2], 16) === 0); } const d4 = v6.match(/^::ffff:(\d+)\.\d+\.\d+\.\d+$/); if (d4) return d4[1] === '127' || /^::ffff:0\.0\.0\.0$/.test(v6); }
  return false;
}

export function normaliseOrigin(entry) {
  if (typeof entry !== 'string') return null;
  const s = entry.trim().toLowerCase();
  if (s === '' || /[\s/?#]/.test(s.replace(/^https?:\/\//, ''))) return null;
  const wildcardPort = s.match(/^(https?:\/\/)([^/:]+|\[[0-9a-f:]+\]):\*$/);
  if (wildcardPort) return null;
  if (/^https?:\/\//.test(s)) {
    try { const u = new URL(s); if (u.origin !== 'null' && hostOk(u.hostname) && (u.pathname === '/' || u.pathname === '')) return u.origin; } catch {                    }
    return null;
  }

  const m = s.match(/^([^:\[\]]+|\[[0-9a-f:]+\])(:\d{1,5})?$/);
  if (m && hostOk(m[1])) { if (m[2] && (Number(m[2].slice(1)) < 1 || Number(m[2].slice(1)) > 65535)) return null; try { const u = new URL('http://' + s); return u.hostname + (u.port ? ':' + u.port : (m[2] ? ':' + Number(m[2].slice(1)) : '')); } catch { return null; } }
  return null;
}

export function parseBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!hostOk(u.hostname.toLowerCase())) return null;
    u.hash = '';
    return u;
  } catch { return null; }
}





export function projectIdentityPath(projectDir) { return path.resolve(projectDir); }



export function projectSlug(projectDir) { const identity = projectIdentityPath(projectDir); return path.basename(identity).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) + '-' + crypto.createHash('sha256').update(identity).digest('hex'); }


export function wrongProject(parsed, projectDir) {
  const got = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.project : undefined;
  if (got === projectIdentityPath(projectDir)) return null;
  return typeof got === 'string' && got !== '' ? 'was saved for another project folder (' + shown(got, 200) + ')' : 'does not say which project folder it was saved for';
}


export function privateDir(projectDir) {
  const fallback = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config');
  const fromEnv = [process.env.XDG_CONFIG_HOME, process.platform === 'win32' ? process.env.APPDATA : null].find((v) => v && path.isAbsolute(v));
  let base = path.resolve(fromEnv || fallback);
  if (insideDir(base, projectDir) || reallyInsideDir(base, projectDir) || insideProjectReally(base)) base = process.platform === 'darwin' ? path.join(trustedHome(), 'Library', 'Application Support') : path.join(trustedHome(), '.config');
  if (homeTampered() && (reallyInsideDir(base, projectDir) || insideProjectReally(base))) { process.stderr.write('[claude-test] refusing to run: HOME points into the project\n'); process.exit(2); }
  return path.join(base, 'claude-test', projectSlug(projectDir));
}



let pinNote = null; let openedNote = null;



export function pinnedProjectDir() {
  const v = process.env.CLAUDE_TEST_PROJECT_DIR; if (!v || /^\$\{.*\}$/.test(v)) return null;
  const pinned = path.resolve(v); const cwd = path.resolve(process.cwd());
  const opened = openedProjectDir();
  const same = reallyInsideDir(pinned, cwd) && reallyInsideDir(cwd, pinned);
  let why = null;
  if (!reallyInsideDir(pinned, cwd) && !reallyInsideDir(cwd, pinned)) why = 'it names a folder this session is not in';
  else if (opened && !(pinned === opened || reallyInsideDir(pinned, opened))) { const raw = path.resolve(process.env.CLAUDE_PROJECT_DIR); why = raw === opened ? 'it lies outside the folder Claude Code opened (' + opened + ')' : 'it lies outside this checkout\'s top folder (' + opened + '), which is as far up as the folder Claude Code opened (' + raw + ') counts here'; }
  else if (!same && reallyInsideDir(cwd, pinned) && !ancestorMayAnchor(pinned, cwd, opened)) why = checkoutRootOf(cwd) ? 'it names a folder above this checkout (' + checkoutRootOf(cwd) + ')' : 'it names a folder above the current directory, and no .git folder marks a checkout that would make it part of this project';
  if (why) { pinNote = 'CLAUDE_TEST_PROJECT_DIR=' + pinned + ' is ignored: ' + why + ' — a session setting must not move the project, and with it the private sign-in folder, somewhere else'; return null; }
  return pinned;
}



function ancestorMayAnchor(dir, cwd, opened) { if (opened && reallyInsideDir(dir, opened) && reallyInsideDir(opened, dir)) return true; const top = checkoutRootOf(cwd); return !!top && reallyInsideDir(dir, top); }



export function openedProjectDir() {
  const v = process.env.CLAUDE_PROJECT_DIR; if (!v || /^\$\{.*\}$/.test(v)) return null;
  const opened = path.resolve(v); const cwd = path.resolve(process.cwd());
  if (!(opened === cwd || reallyInsideDir(cwd, opened) || reallyInsideDir(opened, cwd))) { openedNote = 'CLAUDE_PROJECT_DIR=' + opened + ' is ignored: this process is not running inside it'; return null; }


  const top = reallyInsideDir(cwd, opened) && !reallyInsideDir(opened, cwd) ? checkoutRootOf(cwd) : null;
  return top && !reallyInsideDir(opened, top) ? top : opened;
}
export function sessionRoot() {
  return path.resolve(openedProjectDir() || pinnedProjectDir() || process.cwd());
}
const PROJECT_MARKERS = ['.claude-testrc', '.claude-test'];


export function isMarked(d) {
  try { fs.lstatSync(path.join(d, '.claude-testrc')); return true; } catch {       }
  try { return fs.readdirSync(path.join(d, '.claude-test')).some((e) => e !== 'runs' && e !== '.gitignore'); } catch { return false; }
}












export function launcherConfig() {
  let cfg = loadConfig(resolveProjectDir());
  const root = sessionRoot();
  let note = null; let served = null;
  const runsOwnApp = (() => { try { const pkg = JSON.parse(fs.readFileSync(path.join(cfg.projectDir, 'package.json'), 'utf8')); return !!(pkg && pkg.scripts && ['dev', 'start'].some((s) => pkg.scripts[s] || Object.keys(pkg.scripts).some((k) => k.startsWith(s + ':')))); } catch { return false; } })();
  if (cfg.projectDir === root && !rootConfiguresItself(cfg.projectDir) && !runsOwnApp) {
    const below = projectsBelow(cfg.projectDir);
    const cwd = process.cwd(); const onlyApp = below.length === 1 ? path.join(cfg.projectDir, below[0]) : null;
    const here = onlyApp && ((reallyInsideDir(cwd, root) && reallyInsideDir(root, cwd)) || reallyInsideDir(cwd, onlyApp));
    if (onlyApp && here) { note = 'no .claude-testrc at ' + cfg.projectDir + '; using the app folder ' + below[0]; cfg = loadConfig(onlyApp); }
    else if (onlyApp) { note = 'no .claude-testrc at ' + cfg.projectDir + ' and this process runs in ' + cwd + ', not in the app folder ' + below[0] + ' — that app\'s settings and sign-in files are not applied from here; start Claude Code in ' + onlyApp + ' or put a .claude-testrc at the root'; }
    else if (below.length > 1) { const apps = below.map((b) => { try { return loadConfig(path.join(cfg.projectDir, b)); } catch { return null; } }).filter(Boolean); if (apps.length) { cfg.allowedOrigins = [...new Set(apps.flatMap((a) => a.allowedOrigins))]; served = apps; } note = 'several app folders with Claude Test files (' + below.join(', ') + '): the browser fence is the union of their allowed origins (a configured app gives its base URL; an unconfigured one its candidate ports); sign-in material is per app and is not applied from the root — put a .claude-testrc at ' + cfg.projectDir + ' to choose one'; }
  }
  return { cfg, note, served: served || [cfg] };
}
export function appPointer(root) { const r = appPointerInfo(root); return r && r.dir ? r.dir : null; }


export function appPointerInfo(root) {
  let txt; try { const p = path.join(root, RC_FILE); if (!fs.lstatSync(p).isFile()) return null; txt = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const m = txt.match(/^\s*app\s*:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m);
  if (!m) return null;
  const rel = m[1].trim();
  const bad = (problem) => ({ dir: null, value: rel, problem: 'the "app: ' + rel.replace(/[^\x20-\x7e]/g, '?').slice(0, 80) + '" line in ' + path.join(root, RC_FILE) + ' ' + problem });
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return bad('must be a plain relative path inside the repo');
  const abs = path.resolve(root, rel);
  try { if (!fs.statSync(abs).isDirectory()) return bad('is not a directory'); } catch { return bad('names a folder that does not exist'); }
  return reallyInsideDir(abs, root) ? { dir: abs, value: rel } : bad('resolves outside the repo');
}


export function rootConfiguresItself(root) {
  try { const txt = fs.readFileSync(path.join(root, RC_FILE), 'utf8'); return txt.split(/\r?\n/).some((l) => /^\s*[A-Za-z][\w-]*\s*:/.test(l) && !/^\s*app\s*:/.test(l)); } catch { return false; }
}
export function resolveProjectDir() {



  { const pinned = pinnedProjectDir(); if (pinned) return appPointer(pinned) || pinned; }
  const root = sessionRoot();
  const cwd = path.resolve(process.cwd());
  const pointed = appPointer(root);
  if (!insideDir(cwd, root)) return pointed || root;
  for (let d = cwd; ; d = path.dirname(d)) {
    if (d === root) break;
    if (isMarked(d)) return d;
    if (path.dirname(d) === d) break;
  }
  if (cwd !== root && fs.existsSync(path.join(cwd, 'package.json'))) return cwd;
  if (pointed) return pointed;
  if (rootConfiguresItself(root)) return root;
  return root;
}

export function projectDirReason(dir) {
  if (pinnedProjectDir() === dir) return 'CLAUDE_TEST_PROJECT_DIR';
  if (appPointer(sessionRoot()) === dir) return 'the "app:" line in the session root\'s ' + RC_FILE;
  const marked = PROJECT_MARKERS.filter((m) => { try { fs.lstatSync(path.join(dir, m)); return true; } catch { return false; } });
  if (marked.length && isMarked(dir)) return 'nearest folder with ' + marked.join(' + ') + (dir === sessionRoot() ? ' (the session root)' : ' (walking up from the current directory, inside the session root ' + sessionRoot() + ')');
  if (dir !== sessionRoot()) return 'the current directory (it has a package.json; nothing above it up to the session root is marked with .claude-testrc / .claude-test)';
  return 'the session root (no .claude-testrc or .claude-test found from the current directory up)';
}


export function projectsBelow(dir, depth = 3) {
  const found = [];
  const walk = (d, left) => {
    if (found.length >= 8) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (d !== dir && isMarked(d)) { found.push(path.relative(dir, d)); return; }
    if (left === 0) return;
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'build') walk(path.join(d, e.name), left - 1);
  };
  walk(dir, depth);
  return found;
}


export function insideDir(p, dir) { return p === dir || p.startsWith(dir + path.sep); }




function realish(p) {
  let head = path.resolve(p); const tail = [];
  while (!fs.existsSync(head)) { const up = path.dirname(head); if (up === head) break; tail.unshift(path.basename(head)); head = up; }
  try { head = fs.realpathSync(head); } catch {                        }
  const full = path.join(head, ...tail);
  return process.platform === 'darwin' || process.platform === 'win32' ? full.toLowerCase() : full;
}
export function reallyInsideDir(p, dir) { return insideDir(realish(p), realish(dir)); }




const checkoutRootMemo = new Map();




function checkoutRootOf(dir) { if (checkoutRootMemo.has(dir)) return checkoutRootMemo.get(dir); const r = checkoutRootWalk(dir); checkoutRootMemo.set(dir, r); return r; }
function checkoutRootWalk(dir) { let d; try { d = fs.realpathSync(dir); } catch { d = path.resolve(dir); } const home = path.resolve(trustedHome()); let top = null; for (;;) { if (d === home || reallyInsideDir(home, d)) break;                                     let has = false; try { fs.lstatSync(path.join(d, '.git')); has = true; } catch {                 } if (has) top = d; const up = path.dirname(d); if (up === d) break; d = up; } return top; }
let checkoutRootsMemo = null;
function checkoutRoots() { if (checkoutRootsMemo) return checkoutRootsMemo; const roots = new Set(); for (const d of [process.cwd(), resolveProjectDir(), sessionRoot()]) { const r = checkoutRootOf(d); if (r) roots.add(r); } checkoutRootsMemo = [...roots]; return checkoutRootsMemo; }


export function insideProjectReally(p) { return reallyInsideDir(p, resolveProjectDir()) || reallyInsideDir(p, process.cwd()) || reallyInsideDir(p, sessionRoot()) || checkoutRoots().some((r) => reallyInsideDir(p, r)); }




export function envPathOutsideProject(name) {
  const v = process.env[name];
  if (!v || !v.trim()) return null;
  const p = path.resolve(v.trim());
  if (!insideProjectReally(p)) return p;
  process.stderr.write('[claude-test] ' + name + ' points inside the project and is ignored\n');
  return null;
}




export function dirNotPrivateProblem(dir, had = null) {
  if (process.platform === 'win32') return null;
  let st = had; if (!st) { try { st = fs.statSync(dir); } catch { return null; } }
  if (!st.isDirectory()) return dir + ' is not a directory';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid && st.uid !== 0) return dir + ' is owned by another user (uid ' + st.uid + ')';
  if ((st.mode & 0o022) !== 0) return dir + ' is writable by group or other users (mode ' + (st.mode & 0o777).toString(8) + ')';
  return null;
}



export function trustedHome() { try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); } }
export function homeTampered() { const envHome = process.platform === 'win32' ? (process.env.USERPROFILE || '') : (process.env.HOME || ''); return !!envHome && path.resolve(envHome) !== path.resolve(trustedHome()); }




const PW_NPM_SPELLINGS = ['npm_config_playwright_browsers_path', 'npm_package_config_playwright_browsers_path'];
function platformCacheBrowsers() {
  if (process.platform === 'linux') return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}
function trustedHomeBrowsers() {
  const h = trustedHome();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Local', 'ms-playwright');
  return path.join(h, '.cache', 'ms-playwright');
}







let browserEnvChecked = false;


function sharedRegistryProblem(dir) { if (process.platform === 'win32') return null; try { const st = fs.statSync(dir); if (!st.isDirectory()) return dir + ' is not a directory'; if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) return dir + ' is owned by another user (uid ' + st.uid + ')'; if (st.mode & 0o002) return dir + ' is writable by every user (mode ' + (st.mode & 0o777).toString(8) + ')'; return null; } catch { return null; } }





const SERVER_ENV_KEEP = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'LD_LIBRARY_PATH', 'CHROME_DEVEL_SANDBOX', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'PLAYWRIGHT_BROWSERS_PATH',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'HOMEDRIVE', 'HOMEPATH', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'SYSTEMDRIVE']);
const SERVER_ENV_KEEP_PREFIX = ['LC_', 'XDG_', 'CLAUDE_TEST_'];
export function browserServerEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) { const K = k.toUpperCase(); if (v !== undefined && (SERVER_ENV_KEEP.has(K) || SERVER_ENV_KEEP.has(k) || SERVER_ENV_KEEP_PREFIX.some((p) => K.startsWith(p)) || /^(http|https|no|all)_proxy$/.test(k))) out[k] = v; }
  return out;
}


function scrubPlaywrightEnv() {
  for (const k of Object.keys(process.env)) if ((/^(PLAYWRIGHT_|PWTEST_|PW_|PWDEBUG$)/i.test(k) && !/^PLAYWRIGHT_BROWSERS_PATH$/i.test(k)) || /^npm_(package_)?config_.*(playwright|pwdebug|pwtest)/i.test(k) && !/browsers_path$/i.test(k)) delete process.env[k];
}
export function sanitizeBrowserEnv() {
  if (browserEnvChecked) return; browserEnvChecked = true;
  scrubPlaywrightEnv();
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) { for (const k of PW_NPM_SPELLINGS) if (process.env[k] !== undefined) { process.env.PLAYWRIGHT_BROWSERS_PATH = process.env[k]; break; } }
  for (const k of PW_NPM_SPELLINGS) delete process.env[k];
  const v = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (v === '0') return;
  const given = v !== undefined && v !== '' ? path.resolve(process.env.INIT_CWD || process.cwd(), v) : null;
  const candidates = [given, platformCacheBrowsers(), trustedHomeBrowsers()].filter(Boolean);




  const why = (c) => insideProjectReally(c) ? 'is inside the project' : (fs.existsSync(c) && sharedRegistryProblem(c)) ? 'is not safe to run browsers from (' + sharedRegistryProblem(c) + ')' : null;
  let pick = [...new Set(candidates)].find((c) => !why(c));
  if (!pick) {
    pick = candidates[candidates.length - 1];
    process.stderr.write('[claude-test] no safe Playwright browsers path: ' + [...new Set(candidates)].map((c) => c + ' ' + why(c)).join('; ') + ' — an installed Chrome, or "ct.mjs install chromium" (own copy under the tools folder), avoids it\n');
  } else if (pick !== candidates[0]) process.stderr.write('[claude-test] the Playwright browsers path ' + candidates[0] + ' ' + why(candidates[0]) + ' and is ignored; using ' + pick + '\n');
  process.env.PLAYWRIGHT_BROWSERS_PATH = pick;
}
export function playwrightRegistryDir() {
  const v = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (v === '0') return { hermetic: true };
  return { dir: v && v !== '' ? path.resolve(process.env.INIT_CWD || process.cwd(), v) : platformCacheBrowsers() };
}



export const GIT_SAFE_ARGS = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null'];

function gitIgnored(projectDir, file) {
  try { execFileSync('git', [...GIT_SAFE_ARGS, 'check-ignore', '-q', file], { cwd: projectDir, stdio: 'ignore' }); return true; }
  catch (e) { return e && e.status === 1 ? false : null; }
}





function resolvePrivateFile(projectDir, rcValue, defaultName, warnings, key, envName, { carriesProject = false } = {}) {
  const defaultPath = path.join(privateDir(projectDir), defaultName);
  if (rcValue !== undefined) warnings.push(RC_FILE + ': "' + key + '" is ignored — sign-in material is per developer; put the file at ' + defaultPath);
  const envVal = process.env[envName];
  if (envVal && envVal.trim()) warnings.push(envName + ' is set (' + shown(envVal.trim(), 120) + ') and is ignored — sign-in material comes only from ' + defaultPath + '; a session variable cannot choose it');


  const refused = (why, note = key + ': ' + why) => { if (!warnings.includes(note)) warnings.push(note); return { path: null, inUse: false, source: null, defaultPath, refused: why }; };
  const dp = fs.existsSync(path.dirname(defaultPath)) ? dirNotPrivateProblem(path.dirname(defaultPath)) : null;
  if (dp) return refused(dp + ' — sign-in material is neither read from nor written to that folder until it is private again (chmod 700)');
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if (isLink(defaultPath)) return refused(defaultPath + ' is a symbolic link and is ignored — replace the link with a copy of the file (sign-in material comes only from a regular file in the private folder)');
  const linkedDir = [path.dirname(defaultPath), path.dirname(path.dirname(defaultPath))].find(isLink);
  if (linkedDir) { const why = linkedDir + ' is a symbolic link, so the sign-in files under it are ignored — make it a real folder and copy auth.json / secrets.env to ' + path.dirname(defaultPath); return refused(why, why); }
  let st = null; try { st = fs.lstatSync(defaultPath); } catch { st = null; }
  const exists = st !== null && st.isFile();
  if (exists && insideProjectReally(defaultPath)) return refused(defaultPath + ' resolves inside the repository, so it is ignored — sign-in material must live outside it; check where HOME / XDG_CONFIG_HOME (or a link under them) point');
  const found = { path: exists ? defaultPath : null, inUse: exists, source: exists ? 'private folder' : null, defaultPath };
  if (!exists || !carriesProject) return found;
  let parsed; if (st.size <= MAX_OWN_STATE_BYTES) { try { parsed = JSON.parse(fs.readFileSync(defaultPath, 'utf8')); } catch { parsed = undefined; } }
  const why = parsed === undefined ? null : wrongProject(parsed, projectDir);
  if (why) return refused(defaultPath + ' ' + why + ', so it is not used — delete it and sign in again' + (typeof (parsed && parsed.project) === 'string' && parsed.project !== '' ? '' : ' (a session file you saved yourself needs "project": ' + JSON.stringify(shown(projectIdentityPath(projectDir), 4096)) + ' beside its cookies and origins)'));
  return { ...found, hasContent: parsed !== undefined && ((Array.isArray(parsed.cookies) && parsed.cookies.length > 0) || (Array.isArray(parsed.origins) && parsed.origins.length > 0)) };
}




export const CONSENT_FILE = 'allowed-origins.json';



export function dataRoot() { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'); }


export function consentDir(projectDir) { return path.join(dataRoot(), 'consent', path.basename(privateDir(projectDir))); }

export function liveDir(projectDir, runId) { if (!RUN_ID.test(runId)) throw new Error('not a run id'); let real = projectDir; try { real = fs.realpathSync(projectDir); } catch {                      } return path.join(dataRoot(), 'live', projectSlug(real), runId); }

export function consentKey(o) { const s = String(o).trim().toLowerCase(); const m = s.match(/^(https?:\/\/)?(\[[0-9a-f:]+\]|[^:/\[\]]+)(:\d+)?$/); return m ? (m[1] || '') + (LOOPBACK_HOSTS.includes(m[2]) ? 'localhost' : m[2]) + (m[3] || '') : s; }
export function readConsent(projectDir, warnings = []) {
  const file = path.join(consentDir(projectDir), CONSENT_FILE); const dir = path.dirname(file);
  const none = (why) => { if (why && !warnings.includes(why)) warnings.push(why); return { file, origins: new Set(), hosts: new Set(), ...(why ? { refused: why } : {}) }; };
  if (!fs.existsSync(dir)) return none(null);
  const dp = dirNotPrivateProblem(dir); if (dp) return none(CONSENT_FILE + ': ' + dp + ' — allowed addresses are not read from that folder until it is private again (chmod 700)');
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if ([file, dir, path.dirname(dir)].some(isLink)) return none(file + ' (or its folder, or that folder\'s parent) is a symbolic link, so the record of allowed addresses is ignored — replace the link with a real folder or file');
  let st; try { st = fs.lstatSync(file); } catch { return none(null); }
  if (!st.isFile() || st.nlink > 1 || st.size > 65536) return none(file + ' is not a plain file of sane size (a hard link to another file counts) and is ignored — delete it and allow the address again');
  if (insideProjectReally(file)) return none(file + ' resolves inside the folder Claude Code opened, so it is ignored — allowed addresses are recorded outside the project (if Claude Code was opened in your home folder, open it in the project\'s folder instead)');
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return none(file + ' is not valid JSON and is ignored — delete it and allow the address again'); }
  const foreign = wrongProject(j, projectDir); if (foreign) return none(file + ' ' + foreign + ', so it is ignored — delete it and allow the address again');
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).filter((k) => k.length <= 300) : []);
  return { file, origins: new Set(keys(j.origins).map(consentKey)), hosts: new Set(keys(j.hosts).map((h) => h.trim().toLowerCase())) };
}

export function writeConsent(projectDir, { origins = [], hosts = [], remove = false }) {
  const cur = readConsent(projectDir); if (cur.refused) return cur.refused;
  try {
    fs.mkdirSync(path.dirname(cur.file), { recursive: true, mode: 0o700 });
    const j = { project: projectIdentityPath(projectDir), origins: {}, hosts: {} }; try { const old = JSON.parse(fs.readFileSync(cur.file, 'utf8')); for (const k of ['origins', 'hosts']) if (old && old[k] && typeof old[k] === 'object' && !Array.isArray(old[k])) Object.assign(j[k], old[k]); } catch {                     }
    const now = new Date().toISOString(); const existed = fs.existsSync(cur.file);
    for (const o of origins) { for (const k of Object.keys(j.origins)) if (consentKey(k) === consentKey(o)) delete j.origins[k]; if (!remove) j.origins[consentKey(o)] = now; }
    for (const h of hosts) { const k = String(h).trim().toLowerCase(); delete j.hosts[k]; if (!remove) j.hosts[k] = now; }
    const tmp = cur.file + '.' + process.pid + '.tmp'; try { fs.unlinkSync(tmp); } catch {            }
    fs.writeFileSync(tmp, JSON.stringify(j, null, 1) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, cur.file);
    const back = readConsent(projectDir);
    if (back.refused && !existed) { try { fs.unlinkSync(cur.file); } catch {            } }
    return back.refused ? back.refused + ' — nothing was allowed' : null;
  } catch (e) { return 'could not write ' + cur.file + ': ' + e.message + (['EPERM', 'EACCES', 'EROFS'].includes(e.code) ? ' — a sandboxed shell (Claude Code\'s, typically) may not write there' : ''); }
}







export function parseDotenv(src) {
  const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  const obj = {}; let m; const lines = String(src).replace(/\r\n?/mg, '\n');
  while ((m = LINE.exec(lines)) != null) { let v = (m[2] || '').trim(); const q = v[0]; v = v.replace(/^(['"`])([\s\S]*)\1$/mg, '$2'); if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r'); obj[m[1]] = v; }
  return obj;
}







const UNSAFE_ANY = String.raw`\u2028\u2029\uFE00-\uFE0D\u{E0100}-\u{E01EF}]|(?![\u200C\u200D])\p{Cf}|[\u115F\u1160\u3164\uFFA0\u2065\uFFF0-\uFFF8\u{E0000}\u{E0002}-\u{E001F}\u{E0080}-\u{E00FF}\u{E01F0}-\u{E0FFF}]`;
const RE_SHOWN = new RegExp('(?:[\\p{Cc}' + UNSAFE_ANY + ')+', 'gu');
const RE_SHOWN_TEXT = new RegExp('(?:[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' + UNSAFE_ANY + ')+', 'gu');
const RE_HAS_CONTROL = new RegExp('[\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F' + UNSAFE_ANY, 'u');
export function shown(s, max = 400) {
  let t = String(s).replace(RE_SHOWN, ' ').replace(/ {2,}/g, ' ');
  if (t !== String(s)) t = t.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function shownText(s) { const t = String(s).slice(0, 1 << 20); return t.replace(RE_SHOWN_TEXT, ' '); }

export function hasControl(s) { return RE_HAS_CONTROL.test(String(s)); }

export function shownDeep(v, max = 2000) {
  if (typeof v === 'string') return shown(v, max);
  if (Array.isArray(v)) return v.map((x) => shownDeep(x, max));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = shownDeep(x, max); return o; }
  return v;
}


function commandLineClean(s) { return !hasControl(s) && !/[\u200c\u200d]|\p{Default_Ignorable_Code_Point}/u.test(String(s)); }
function startCommandEarly(rc) { return typeof rc.startCommand === 'string' && rc.startCommand.trim() && rc.startCommand.trim().length <= 400 && commandLineClean(rc.startCommand) ? rc.startCommand.trim() : null; }
export function loadConfig(projectDir) {
  const dir = path.resolve(projectDir || process.cwd());
  const rcPath = path.join(dir, RC_FILE);
  let rc = {}; let warnings = []; let rcFound = false;
  pinnedProjectDir();


  const isRegularFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
  if (isRegularFile(rcPath)) {
    rcFound = true;
    try { ({ data: rc, warnings } = parseRc(fs.readFileSync(rcPath, 'utf8'))); }
    catch (e) { warnings.push('could not read ' + RC_FILE + ': ' + e.message); }
  } else if (fs.existsSync(rcPath)) warnings.push(RC_FILE + ' is not a regular file (a symlink?) and is ignored');
  let baseUrl = parseBaseUrl(rc.baseUrl);
  let baseUrlSource = baseUrl ? RC_FILE : null;
  if (rc.baseUrl !== undefined && !baseUrl) warnings.push(RC_FILE + ': baseUrl ignored — it must be an http(s) URL whose host is a plain name (letters, digits, hyphens, dots), an IPv4 address or [IPv6], with no credentials');


  let launch = null;
  const launchPath = path.join(dir, '.claude', 'launch.json');
  if (isRegularFile(launchPath)) {
    try {
      const txt = fs.readFileSync(launchPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const j = JSON.parse(txt);
      const c = Array.isArray(j.configurations) ? j.configurations[0] : null;
      if (c) {
        const cmd = c.program ? ['node', c.program, ...(c.args || [])] : c.runtimeExecutable ? [c.runtimeExecutable, ...(c.runtimeArgs || [])] : null;



        launch = { name: typeof c.name === 'string' ? c.name.slice(0, 60) : null, command: cmd ? cmd.join(' ') : null, port: Number(c.port) || null, url: typeof c.url === 'string' ? c.url : null, cwd: typeof c.cwd === 'string' ? c.cwd : null };
      }
    } catch { warnings.push('.claude/launch.json: not valid JSON, ignored'); }
  }

  const rejectedOrigins = [];
  const extra = [];
  const rawExtra = rc.allowedOrigins === undefined ? [] : Array.isArray(rc.allowedOrigins) ? rc.allowedOrigins : [rc.allowedOrigins];


  const printable = (e) => { const s = String(e); return /^[A-Za-z0-9.:/\[\]*@_-]{1,80}$/.test(s) ? s : '(an entry that is not a plain host or origin)'; };
  for (const e of rawExtra) { const n = typeof e === 'string' ? normaliseOrigin(e) : null; if (n) extra.push(n); else rejectedOrigins.push(typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean' ? printable(e) : '(non-text entry)'); }
  if (rejectedOrigins.length) warnings.push(RC_FILE + ': ignored allowedOrigins entries that are not plain origins or hosts ("host:*" wildcard ports are not accepted — name the port): ' + rejectedOrigins.join(', '));




  const reachableHosts = []; const rejectedReachable = [];
  const rawReach = rc.reachableHosts === undefined ? [] : Array.isArray(rc.reachableHosts) ? rc.reachableHosts : [rc.reachableHosts];
  for (const e of rawReach.slice(0, 64)) {
    if (typeof e !== 'string') { rejectedReachable.push({ entry: '(non-text entry)', why: 'not text' }); continue; }
    let why; try { why = reachableEntryProblem(e); } catch (err) { why = 'could not be checked (' + String(err && err.message || err).slice(0, 80) + ')'; }
    if (why === null) { const t = e.trim(); if (!reachableHosts.includes(t)) reachableHosts.push(t); } else rejectedReachable.push({ entry: printable(e.trim()), why });
  }
  if (rawReach.length > 64) warnings.push(RC_FILE + ': reachableHosts takes at most 64 entries; the rest were ignored');
  if (rejectedReachable.length) warnings.push(RC_FILE + ': ignored reachableHosts entries: ' + rejectedReachable.map((r) => r.entry + ' (' + r.why + ')').join('; '));





  const twins = [];
  if (baseUrl && LOOPBACK_HOSTS.includes(baseUrl.hostname)) {
    for (const h of baseUrl.hostname === 'localhost' ? LOOPBACK_HOSTS : ['localhost', baseUrl.hostname]) twins.push(baseUrl.protocol + '//' + h + (baseUrl.port ? ':' + baseUrl.port : ''));
  }




  let devDiscovery = null; let candidates = null;
  if (!baseUrl) {
    devDiscovery = discoverDevServer({ projectDir: dir, startCommand: startCommandEarly(rc), startCommandSource: startCommandEarly(rc) ? RC_FILE : null, launch });
    candidates = candidateList({ baseUrl: null }, devDiscovery);
  }
  const candidateOrigins = candidates ? candidates.flatMap((cand) => LOOPBACK_HOSTS.map((h) => 'http://' + h + ':' + cand.port)) : [];
  const wantedOrigins = [...new Set([...(baseUrl ? [baseUrl.origin, ...twins] : candidateOrigins), ...extra])];

  const consent = readConsent(dir, warnings);
  const allowedOrigins = wantedOrigins.filter((o) => consent.origins.has(consentKey(o)));
  const pendingOrigins = [...new Set(wantedOrigins.filter((o) => !consent.origins.has(consentKey(o))).map(consentKey))];
  const pendingHosts = reachableHosts.filter((h) => !consent.hosts.has(h.toLowerCase()));
  for (const h of pendingHosts) reachableHosts.splice(reachableHosts.indexOf(h), 1);
  const startCommand = startCommandEarly(rc);


  const setupCommand = typeof rc.setupCommand === 'string' && rc.setupCommand.trim() && rc.setupCommand.trim().length <= 400 && commandLineClean(rc.setupCommand) ? rc.setupCommand.trim() : null;
  if (rc.setupCommand !== undefined && !setupCommand) warnings.push(RC_FILE + ': setupCommand must be a one-line command string of printable characters, at most 400 long (ignored)');
  if (rc.startCommand !== undefined && !startCommandEarly(rc)) warnings.push(RC_FILE + ': startCommand must be a one-line command string of printable characters, at most 400 long (ignored)');
  const storageState = resolvePrivateFile(dir, rc.storageState, 'auth.json', warnings, 'storageState', 'CLAUDE_TEST_STORAGE_STATE', { carriesProject: true });
  const secretsFile = resolvePrivateFile(dir, rc.secretsFile, 'secrets.env', warnings, 'secretsFile', 'CLAUDE_TEST_SECRETS_FILE');



  const baseIsLoopback = !!baseUrl && LOOPBACK_HOSTS.includes(baseUrl.hostname);
  for (const n of [openedNote, pinNote]) if (n && !warnings.includes(n)) warnings.push(n);
  const signInApplies = baseIsLoopback;
  const signInNote = !baseUrl ? 'sign-in withheld: set baseUrl in ' + RC_FILE + ' (a saved session / secrets file is only given to the browser when a local base URL is configured, in ' + RC_FILE + ')'
    : baseIsLoopback ? 'base URL is on this machine, so a saved session / secrets file (if present) is given to the browser'
    : 'base URL is NOT on this machine: a saved session / secrets file is withheld from the browser — sign-in works for local dev servers only (by design, for now)';
  const isLoopbackOrigin = (o) => { const h = o.replace(/^https?:\/\//, '').replace(/:(\d+|\*)$/, ''); return LOOPBACK_HOSTS.includes(h); };
  const remoteOrigins = allowedOrigins.filter((o) => !isLoopbackOrigin(o));
  const sessionHasContent = storageState.inUse && storageState.hasContent;
  if (signInApplies && (sessionHasContent || secretsFile.inUse) && extra.length) warnings.push('sign-in material is attached and the browser may also load ' + extra.join(', ') + ' (allowedOrigins): the browser server types secret values only into the page\'s own fields on ' + baseUrl.origin + ' and checks afterwards that the value landed there, but a document from one of those hosts embedded IN such a page is inside the browser with it (it is reported, not prevented, if it grabs the keystrokes), and the saved session\'s cookies go wherever the browser sends them — list only hosts you trust as much as the app itself');



  const browser = typeof rc.browser === 'string' && /^(chrome|msedge|chromium)$/.test(rc.browser.trim()) ? rc.browser.trim() : null;
  if (rc.driver !== undefined && !(typeof rc.driver === 'string' && rc.driver.trim() === 'bundled')) warnings.push(RC_FILE + ': driver can only be "bundled", so delete the line: specs still run in the Claude Test browser, which is held to the allowed addresses (ignored)');
  if (rc.browser !== undefined && !browser) warnings.push(RC_FILE + ': browser must be one of chrome, msedge, chromium: only these can be held to the allowed addresses, so the default test browser is used (ignored)');

  return {
    projectDir: dir, rcPath, rcFound, rc, warnings,
    baseUrl: baseUrl ? baseUrl.href : null, baseUrlSource, baseOrigin: baseUrl ? baseUrl.origin : null, secretOrigins: baseUrl ? [baseUrl.origin] : [],
    allowedOrigins, wantedOrigins, pendingOrigins, pendingHosts, consentFile: consent.file, rejectedOrigins, reachableHosts, rejectedReachable, candidates, devDiscovery, startCommand, startCommandSource: startCommand ? RC_FILE : null,
    browser, launch, storageState, secretsFile, setupCommand, signInApplies, signInNote,
    specsDir: path.join(dir, SPECS_DIR), runsDir: path.join(dir, RUNS_DIR),
  };
}





export function assertRunsDirInsideProject(cfg) {
  const realProject = fs.realpathSync(cfg.projectDir);
  for (const p of [path.dirname(cfg.runsDir), cfg.runsDir]) {
    let st; try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const rel = path.relative(cfg.projectDir, p);
    if (st.isSymbolicLink()) throw new Error(rel + ' is a symlink — refusing to write run artifacts through it');
    if (!st.isDirectory()) throw new Error(rel + ' is not a directory');
    if (!insideDir(fs.realpathSync(p), realProject)) throw new Error(rel + ' resolves outside the project — refusing to write run artifacts there');
  }
}








export function trackedClaudeTestSymlinks(projectDir, root) {
  const dirs = [...new Set([projectDir, ...projectsBelow(root).map((b) => path.join(root, b))])];
  const out = [];
  for (const d of dirs) {
    let listing = '';
    try { listing = execFileSync('git', [...GIT_SAFE_ARGS, 'ls-files', '-s', '-z', '--', '.claude-test'], { cwd: d, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { continue; }
    for (const rec of listing.split('\0')) { if (!rec.startsWith('120000 ')) continue; const rel = rec.slice(rec.indexOf('\t') + 1); let target = '?'; try { target = fs.readlinkSync(path.join(d, rel)); } catch {            } out.push((path.relative(root, path.join(d, rel)) || rel).replace(/[^\x20-\x7e]/g, '?') + ' → ' + String(target).replace(/[^\x20-\x7e]/g, '?').slice(0, 120)); if (out.length >= 10) return out; }
  }

  const seen = new Set(out.map((s) => s.split(' → ')[0]));
  let budget = 400;
  const walk = (base, d, depth) => { if (budget <= 0 || depth > 3 || out.length >= 10) return; let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (--budget <= 0 || out.length >= 10) return; const p = path.join(d, e.name); if (e.isSymbolicLink()) { const rel = (path.relative(root, p) || p).replace(/[^\x20-\x7e]/g, '?'); if (!seen.has(rel)) { let t = '?'; try { t = fs.readlinkSync(p); } catch {       } out.push(rel + ' → ' + String(t).replace(/[^\x20-\x7e]/g, '?').slice(0, 120) + ' (untracked)'); seen.add(rel); } } else if (e.isDirectory()) walk(base, p, depth + 1); } };
  for (const d of dirs) { const ct = path.join(d, '.claude-test'); try { if (fs.lstatSync(ct).isSymbolicLink()) { const rel = (path.relative(root, ct) || ct).replace(/[^\x20-\x7e]/g, '?'); if (!seen.has(rel)) { let t = '?'; try { t = fs.readlinkSync(ct); } catch {       } out.push(rel + ' → ' + String(t).replace(/[^\x20-\x7e]/g, '?').slice(0, 120) + ' (the folder itself)'); seen.add(rel); } continue; } } catch { continue; } walk(d, ct, 0); }
  return out;
}
function assertNoTrackedSymlinkUnderRuns(cfg) {
  let listing = '';
  try { listing = execFileSync('git', [...GIT_SAFE_ARGS, 'ls-files', '-s', '--', path.relative(cfg.projectDir, cfg.runsDir)], { cwd: cfg.projectDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return;                             }
  const links = listing.split('\n').filter((l) => l.startsWith('120000 ')).map((l) => l.split('\t')[1]);
  if (links.length) throw new Error(path.relative(cfg.projectDir, cfg.runsDir) + ' contains symlinks committed to git (' + links.slice(0, 3).join(', ') + (links.length > 3 ? ', …' : '') + ') — remove them from the repository first');
}







const STEM_SHAPE = /^(?![.\s])[^/\\$`"':;&|<>*?\n\t]{1,120}$/u;




const JOINING_LETTER = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Mandaic}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Tibetan}\p{Script=Javanese}\p{Script=Balinese}]/u;
const EMOJI_CHAR = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|[\u{1F000}-\u{1FAFF}]/u;
function joinerNeighbourOk(cps, i, dir) { const c = cps[i + dir]; if (c === undefined) return false; if (EMOJI_CHAR.test(c)) return true; if (dir > 0 && /\p{Extended_Pictographic}/u.test(c) && cps[i + 2] === '\uFE0F') return true;                                                                                             if (c === '\uFE0F') { const base = cps[i + 2 * dir]; return dir < 0 && base !== undefined && (EMOJI_CHAR.test(base) || /\p{Extended_Pictographic}/u.test(base)); } if (JOINING_LETTER.test(c)) return true; if (/\p{M}/u.test(c)) { const base = cps[i + 2 * dir]; return base !== undefined && JOINING_LETTER.test(base); } return false; }
function joinersWellPlaced(s) { const cps = [...s]; return cps.every((c, i) => (c !== '\u200c' && c !== '\u200d') || (joinerNeighbourOk(cps, i, -1) && joinerNeighbourOk(cps, i, +1))); }
export function safeStem(s) { return typeof s === 'string' && STEM_SHAPE.test(s) && shownText(s) === s && !hasControl(s) && joinersWellPlaced(s); }

export function stemOk(s) { if (!safeStem(s) || s.startsWith('-')) return false; try { encodeURIComponent(s); return true; } catch { return false; } }
const ARTIFACT_NAME = /^(.+)\.(png|snapshot\.md)$/; const WIN_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/;
export function runsPathProblem(cfg, abs) {
  const rel = path.relative(cfg.projectDir, cfg.runsDir) + '/';
  if (!insideDir(abs, cfg.runsDir) || abs === cfg.runsDir) return 'must be a file under ' + rel;


  const parts = path.relative(cfg.runsDir, abs).split(path.sep);
  const am = parts.length === 2 ? parts[1].match(ARTIFACT_NAME) : null;
  if (!am || !safeStem(am[1]) || WIN_DEVICE.test(parts[1])) return 'must be <run folder>/<name>.png or <name>.snapshot.md, directly inside the run folder (no subfolders)';
  if (!RUN_ID.test(parts[0])) return 'must be inside a run folder that "ct.mjs new-run" made (its name is a date and time)';
  try { assertRunsDirInsideProject(cfg); } catch (e) { return 'cannot be written: ' + e.message; }
  if (!fs.existsSync(cfg.runsDir)) return 'cannot be written yet: ' + rel + ' does not exist (run "ct.mjs new-run" first)';
  let realRuns; try { realRuns = fs.realpathSync(cfg.runsDir); } catch { realRuns = cfg.runsDir; }
  let existing = abs; while (!fs.existsSync(existing)) existing = path.dirname(existing);
  let realExisting; try { realExisting = fs.realpathSync(existing); } catch { return 'cannot be resolved'; }
  if (!insideDir(realExisting, realRuns)) return 'must stay under ' + rel + ' (a symlink points elsewhere)';
  try { const realParent = fs.realpathSync(path.dirname(abs)); if (realParent !== path.join(realRuns, parts[0])) return 'must stay directly inside its run folder (a link points elsewhere)'; } catch { return 'cannot be written yet: the run folder does not exist'; }
  try { const st = fs.lstatSync(abs); if (st.isSymbolicLink()) return 'is a symlink'; if (st.nlink > 1) return 'is a hard link to another file — not writing through it'; } catch {                          }
  return null;
}

export function ensureRunsDir(cfg) {
  assertRunsDirInsideProject(cfg);
  assertNoTrackedSymlinkUnderRuns(cfg);
  fs.mkdirSync(cfg.runsDir, { recursive: true });




  const gi = path.join(path.dirname(cfg.runsDir), '.gitignore');
  try { if (fs.lstatSync(gi).isSymbolicLink()) throw new Error(path.relative(cfg.projectDir, gi) + ' is a symlink — refusing to write through it'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Claude Test run artifacts (logs, screenshots, driver state) are local evidence, not source.\nruns/\nfiled.*.tmp\n');
  else if (gitIgnored(cfg.projectDir, path.join(cfg.runsDir, 'canary-' + crypto.randomBytes(6).toString('hex'), 'log.md')) === false) fs.appendFileSync(gi, '\nruns/\n');
}


export function originAllowed(cfg, url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  for (const o of cfg.allowedOrigins) {
    if (/^https?:\/\//.test(o)) { if (u.origin === o) return true; continue; }


    const mm = o.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (mm && u.hostname === mm[1] && (mm[2] ? u.port === mm[2] : u.port === '')) return true;
  }
  return false;
}



export function mintSpecId() { const A = 'abcdefghijklmnopqrstuvwxyz234567'; const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += A[b[i] & 31]; return 'ct_' + s; }


export function withSpecId(text, id) {
  let body = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 3);
    if (end > 0) { const fm = body.slice(4, end).split('\n').filter((l) => !/^\s*id\s*:/.test(l)); return '---\n' + ['id: ' + id, ...fm].join('\n') + body.slice(end); }
  }
  return '---\nid: ' + id + '\n---\n' + body;
}






export function fromComment(text) {
  const all = [...String(text).matchAll(/<!--\s*from:\s*([\s\S]*?)\s*-->/g)];
  if (!all.length) return null;
  const files = [];
  for (const m of all) for (const tok of m[1].replace(/(^|\s)\([^)]*\)/g, ' ').replace(/"[^"]*"/g, ' ').split(/,\s*|\s+/)) { const clean = tok.replace(/[—–].*$/, '').replace(/:[\d,-]+$/, '').trim(); if (clean && /^[\w/.@()[\]$+-]+\.\w+$/.test(clean) && !files.includes(clean)) files.push(clean); }
  const lastM = all[all.length - 1];
  return { last: { text: lastM[1].trim(), start: lastM.index, end: lastM.index + lastM[0].length }, files, count: all.length };
}





export function joinWrappedCriteria(text) {
  const lines = String(text).split('\n'); const out = []; let inSection = false; let afterMust = false;
  const BLOCK = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|[-*_]{3,}\s*$|```|~~~|>|\||[[<]|(must not|must)\s*:)/i;
  for (const line of lines) {
    if (/^##\s+passes when\s*$/i.test(line)) { inSection = true; afterMust = false; out.push(line); continue; }
    if (/^##\s+/.test(line)) { inSection = false; afterMust = false; out.push(line); continue; }
    if (inSection && /^\s*[-*]\s*(must not|must)\s*:/i.test(line)) { afterMust = true; out.push(line); continue; }
    if (inSection && afterMust && /^[ \t]+\S/.test(line) && !BLOCK.test(line)) { out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '') + ' ' + line.trim(); continue; }
    afterMust = false; out.push(line);
  }
  return out.join('\n');
}
export function parseSpec(text, file) {
  const out = { file, name: null, frontMatter: {}, description: '', passesWhen: '', must: [], mustNot: [], warnings: [] };
  let body = joinWrappedCriteria(text.replace(/^\uFEFF/, ''));
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end < 0) out.warnings.push('front matter opened with --- but never closed; it is being read as body text');
    if (end > 0) {
      const { data, warnings } = parseRc(body.slice(3, end));
      out.frontMatter = data; out.warnings.push(...warnings.map((w) => 'front matter ' + w));
      body = body.slice(end + 4).replace(/^\r?\n/, '');
    }
  }
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) out.name = shown(h1[1].trim(), 160);
  else if (typeof out.frontMatter.name === 'string') out.name = shown(out.frontMatter.name, 160);
  else out.warnings.push('no "# name" heading');
  const pw = body.search(/^##\s+passes when\s*$/im);
  const afterH1 = h1 ? body.indexOf(h1[0]) + h1[0].length : 0;
  if (pw < 0) { out.warnings.push('no "## Passes when" section'); out.description = body.slice(afterH1).trim(); }
  else {
    out.description = body.slice(afterH1, pw).replace(/^##\s+steps\s*$/im, '').trim();
    const rest = body.slice(pw).replace(/^##.*$/m, '');
    const next = rest.search(/^##\s+/m);
    out.passesWhen = (next >= 0 ? rest.slice(0, next) : rest).trim();
    for (const line of out.passesWhen.split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s*(must not|must)\s*:\s*(.+)$/i);
      if (m) (m[1].toLowerCase() === 'must' ? out.must : out.mustNot).push(m[2].trim());
    }
    if (out.must.length + out.mustNot.length === 0) out.warnings.push('"## Passes when" has no "- Must:" / "- Must not:" lines');
    else if (out.must.length === 0) out.warnings.push('no "- Must:" line — a spec needs at least one positive criterion to pass');
  }
  if (!out.description) out.warnings.push('no steps text between the heading and "## Passes when"');
  return out;
}




export function specsDirProblem(cfg) {
  let st; try { st = fs.lstatSync(cfg.specsDir); } catch { return null; }
  const rel = path.relative(cfg.projectDir, cfg.specsDir);
  if (st.isSymbolicLink()) return rel + ' is a symlink — refusing to use it';
  if (!st.isDirectory()) return rel + ' is not a directory';
  if (!reallyInsideDir(cfg.specsDir, cfg.projectDir)) return rel + ' resolves outside the project';
  return null;
}

export function listSpecs(cfg) {
  if (!fs.existsSync(cfg.specsDir) || specsDirProblem(cfg)) return [];
  let names; try { names = fs.readdirSync(cfg.specsDir); } catch { return []; }
  return names
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase() !== 'readme.md')
    .sort()
    .map((f) => {
      const p = path.join(cfg.specsDir, f);


      try { if (!fs.lstatSync(p).isFile()) return { file: path.relative(cfg.projectDir, p), name: null, skipped: true, warnings: ['not a regular file (a symlink?) — skipped; copy the spec here instead'] }; } catch {                                      }
      try { const s = parseSpec(fs.readFileSync(p, 'utf8'), path.relative(cfg.projectDir, p)); return { file: s.file, id: typeof s.frontMatter.id === 'string' && /^ct_[a-z2-7]{8}$/.test(s.frontMatter.id) ? s.frontMatter.id : null, name: s.name, allow_navigation: s.frontMatter.allow_navigation, timeout_ms: s.frontMatter.timeout_ms, tags: Array.isArray(s.frontMatter.tags) ? s.frontMatter.tags : undefined, must: s.must.length, mustNot: s.mustNot.length, warnings: s.warnings }; }
      catch (e) { return { file: path.relative(cfg.projectDir, p), name: null, warnings: ['unreadable: ' + e.message] }; }
    });
}
