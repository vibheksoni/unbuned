




import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_PIN, envPathOutsideProject, insideProjectReally, reallyInsideDir, trustedHome, homeTampered, dirNotPrivateProblem, playwrightRegistryDir, launcherConfig, browserServerEnv, dataRoot } from './config.mjs';



export function cacheDir() {
  let cache = process.env.XDG_CACHE_HOME || (process.platform === 'win32' && process.env.LOCALAPPDATA) || path.join(os.homedir(), '.cache');
  if (insideProjectReally(path.resolve(cache))) cache = path.join(trustedHome(), '.cache');
  const dir = path.join(cache, 'claude-test');
  if (homeTampered() && insideProjectReally(path.resolve(dir))) { process.stderr.write('[claude-test] refusing to run: HOME points into the project, and this plugin runs sign-in scripts from its cache there\n'); process.exit(2); }
  return dir;
}



export function toolsDir() { return path.join(dataRoot(), 'tools'); }




export function makeLaunchDir() {
  const root = path.join(dataRoot(), 'launch');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });


  let old = []; try { old = fs.readdirSync(root); } catch {                        }
  for (const e of old) {
    const m = e.match(/^(\d+)-[0-9a-f]{16}$/); if (!m) continue;
    let idleMs = 0; try { idleMs = Date.now() - fs.lstatSync(path.join(root, e)).mtimeMs; } catch { continue; }
    if (idleMs < 15 * 60 * 1000) continue;
    let alive = true; try { process.kill(Number(m[1]), 0); } catch (err) { alive = !!err && err.code === 'EPERM'; }
    if (!alive || idleMs > 7 * 24 * 3600 * 1000) { try { fs.rmSync(path.join(root, e), { recursive: true, force: true }); } catch {                          } }
  }
  const dir = path.join(root, process.pid + '-' + crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'out'), { mode: 0o700 });
  const touch = setInterval(() => { try { const now = new Date(); fs.utimesSync(dir, now, now); } catch {                             } }, 5 * 60 * 1000); touch.unref();
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {                                  } });
  return dir;
}





export function browsersDir() { return path.join(toolsDir(), 'browsers'); }
export function useOwnBrowsersIfPresent() {
  try { if (fs.readdirSync(browsersDir()).some((d) => /^(chromium|chromium_headless_shell|firefox|webkit|ffmpeg|msedge|chrome)[-_]/.test(d))) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir(); } catch {                               }
}






export function tightenToolsDir(root = toolsDir()) {
  let n = 0;
  try { root = fs.realpathSync(root); } catch { return 0; }


  try { if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name !== 'claude-test-tools') return 0; } catch { return 0; }
  const walk = (p) => { let st; try { st = fs.lstatSync(p); } catch { return; } if (st.isSymbolicLink()) return; if (st.mode & 0o022) { try { fs.chmodSync(p, st.mode & 0o7755 & ~0o022); n++; } catch {                } } if (st.isDirectory()) { let ents = []; try { ents = fs.readdirSync(p); } catch { return; } for (const e of ents) walk(path.join(p, e)); } };
  try { const st = fs.lstatSync(root); if (st.mode & 0o022) { fs.chmodSync(root, st.mode & 0o7755 & ~0o022); n++; } } catch {       }
  for (const sub of ['node_modules', 'browsers', 'package.json', 'package-lock.json']) walk(path.join(root, sub));
  return n;
}








export function browserSelection(cfg) {
  const exe = envPathOutsideProject('CLAUDE_TEST_BROWSER_EXECUTABLE');
  const named = process.env.CLAUDE_TEST_BROWSER || (cfg && cfg.browser) || null;
  const chromePath = exe ? null : named ? null : findChrome();
  const browser = named || (exe || chromePath ? null : 'chromium');
  const usesRegistry = !exe && !!browser && !/^(chrome|msedge)(-|$)/.test(browser);
  return { exe, chromePath, browser, usesRegistry };
}



export function browserProblem(cfg) {
  const { browser } = browserSelection(cfg);
  if (!browser || /^(chromium|chrome|msedge)(-|$)/.test(browser)) return null;
  const asked = browser === 'firefox' || browser === 'webkit' ? '"' + browser + '"' : 'a value Claude Test does not support';
  return 'the test browser can only be chrome, msedge or chromium: no other browser can be held to the allowed addresses. CLAUDE_TEST_BROWSER asks for ' + asked + ': unset it (in the shell, or under "env" in a Claude Code settings file), then restart Claude Code once';
}
const useOwn = () => { const v = process.env.PLAYWRIGHT_BROWSERS_PATH; return !!v && path.resolve(v) === path.join(toolsDir(), 'browsers'); };


export function sharedPlaceProblem(p) { if (process.platform === 'win32') return null; try { const st = fs.statSync(p); if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) return p + ' is owned by another user (uid ' + st.uid + ')'; if (st.mode & 0o002) return p + ' is writable by every user (mode ' + (st.mode & 0o777).toString(8) + ')'; return null; } catch { return null; } }
const sharedPlaces = new Set();
function executedPlaces() {
  const dir = toolsDir(); const b = path.join(dir, 'browsers');
  const places = [dir, path.join(dir, 'node_modules'), path.join(dir, 'node_modules', '@playwright', 'mcp'), path.join(dir, 'node_modules', '@playwright', 'mcp', 'cli.js'), path.join(dir, 'node_modules', 'playwright-core'), path.join(dir, 'node_modules', 'playwright-core', 'lib'), path.join(dir, 'node_modules', 'playwright'), path.join(dir, 'node_modules', 'playwright', 'lib'), path.join(dir, 'package.json'), path.join(dir, 'package-lock.json'), b, ...ABSENT_OPTIONAL_PACKAGES.map((n) => path.join(dir, 'node_modules', n))];
  try { for (const e of fs.readdirSync(b)) places.push(path.join(b, e)); } catch {                       }
  const reg = playwrightRegistryDir();


  let usesRegistry = true; try { usesRegistry = browserSelection(launcherConfig().cfg).usesRegistry; } catch {                                                  }
  if (reg && reg.dir && reg.dir !== b && !useOwn() && usesRegistry) { for (const p of [reg.dir, ...(() => { try { return fs.readdirSync(reg.dir).filter((e) => /^(chromium|chrome|ffmpeg|firefox|webkit|msedge|winldd)/.test(e)).map((e) => path.join(reg.dir, e)); } catch { return []; } })()]) { places.push(p); sharedPlaces.add(p); } }
  return places.filter((p) => fs.existsSync(p));
}
function placeProblem(p) { if (sharedPlaces.has(p)) return sharedPlaceProblem(p); try { const st = fs.statSync(p);                                                                                                                                   if (st.isDirectory()) return dirNotPrivateProblem(p); if (st.mode & 0o022) return p + ' is writable by group or other users (mode ' + (st.mode & 0o777).toString(8) + ')'; if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) return p + ' is owned by another user (uid ' + st.uid + ')'; return null; } catch { return null; } }
function assertToolsDirPrivate() {
  for (const d of executedPlaces()) { const why = placeProblem(d); if (why) { process.stderr.write('[claude-test] refusing to run a browser/tooling from a place others can write: ' + why + (sharedPlaces.has(d) ? ' (the shared Playwright registry: fix its owner/mode, point PLAYWRIGHT_BROWSERS_PATH at a private folder, or run "ct.mjs install chromium" for an own copy)' : ' (chmod go-w it, or re-run "ct.mjs install")') + '\n'); process.exit(2); } }
}


export function toolsProblem() { for (const d of executedPlaces()) { const why = placeProblem(d); if (why) return why + (sharedPlaces.has(d) ? ' — that is the shared Playwright browser registry: fix its owner/mode, point PLAYWRIGHT_BROWSERS_PATH at a private folder, or run "ct.mjs install chromium" to give Claude Test its own copy' : ' — chmod go-w it, or re-run "ct.mjs install"'); } return null; }

export function mcpCliPath({ forInstall = false, report = false } = {}) {
  const p = path.join(toolsDir(), 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!fs.existsSync(p)) return null;
  if (report) return p;
  if (!forInstall) assertToolsDirPrivate();
  return p;
}







function toolsDirIsOursOrEmpty(dir) {
  let ents; try { ents = fs.readdirSync(dir); } catch (e) { return e.code === 'ENOENT'; }
  if (ents.length === 0) return true;
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'claude-test-tools'; } catch { return false; }
}


export function toolsLockPath() { return path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools-lock.json'); }



export const ABSENT_OPTIONAL_PACKAGES = ['fsevents', 'bufferutil', 'utf-8-validate', 'kerberos'];



export function writeStandInPackages(nodeModules) {
  for (const name of ABSENT_OPTIONAL_PACKAGES) {
    const dir = path.join(nodeModules, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', private: true, main: 'index.js', description: 'Stand-in written by the claude-test plugin: this optional package is not installed here.' }, null, 2) + '\n', { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'index.js'), "throw Object.assign(new Error(\"Cannot find module '" + name + "' (not installed: a stand-in written by the claude-test plugin)\"), { code: 'MODULE_NOT_FOUND' });\n", { mode: 0o644 });
  }
}

export function installTools({ noLock = false, allowFallback = false } = {}) {
  const dir = toolsDir();
  if (!toolsDirIsOursOrEmpty(dir)) return { ok: false, log: '', dir, registry: null, remedy: dir + ' already holds something that is not a Claude Test tools folder (no claude-test-tools package.json) — move it away, then run the install again' };


  for (const f of ['package-lock.json', 'npm-shrinkwrap.json']) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {       } }


  const nm = path.join(dir, 'node_modules');
  if (fs.existsSync(nm) && executedPlaces().filter((p) => p === nm || p.startsWith(nm + path.sep)).some((p) => placeProblem(p))) { try { fs.rmSync(nm, { recursive: true, force: true }); } catch {                                     } }
  const cannotWrite = (e) => ({ ok: false, log: String((e && e.message) || e), dir, registry: null, remedy: 'the install cannot write ' + dir + ' (' + ((e && e.code) || 'error') + '), where the browser tooling lives. Check that this folder and the ones above it are yours and writable (owner, mode, a read-only home), then install again.' + ((e && e.code === 'EROFS') || process.env.SANDBOX_RUNTIME === '1' ? ' If Claude Code ran this command, its sandbox may be what refused: run it in your own terminal' : '') });
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); } catch (e) { return cannotWrite(e); }
  try { fs.chmodSync(dir, 0o755); } catch {       }
  const manifest = { name: 'claude-test-tools', private: true, description: 'Browser tooling for the claude-test plugin. Safe to delete.', dependencies: { '@playwright/mcp': PLAYWRIGHT_MCP_VERSION }, overrides: { playwright: PLAYWRIGHT_PIN, 'playwright-core': PLAYWRIGHT_PIN } };
  const writeManifest = (extra) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...manifest, ...(extra ? { claudeTest: extra } : {}) }, null, 2) + '\n');
  try { writeManifest(null); } catch (e) { return cannotWrite(e); }
  if (process.platform === 'win32' && /[&|<>^%!"`\r\n]/.test(dir)) return { ok: false, log: 'refusing to install into ' + dir + ': the path contains characters cmd.exe would interpret', dir };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const opts = { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' };
  const reg = spawnSync(npm, ['config', 'get', 'registry'], opts);
  const registry = reg.status === 0 ? String(reg.stdout || '').trim() : null;
  let r; let log = ''; let pin = PLAYWRIGHT_PIN; let mode;
  const run = (args) => { r = spawnSync(npm, args, opts); log += (log ? '\n--- npm ' + args[0] + ' ---\n' : '') + (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error.message) : ''); return r.status === 0; };
  if (noLock) {
    mode = 'unpinned (--no-lock)';
    process.stderr.write('[claude-test] --no-lock: installing from the version pins WITHOUT the shipped checksums — what your registry serves is what runs\n');
    run(['install', '--no-audit', '--no-fund', '--ignore-scripts']);
  } else {
    mode = 'pinned';
    try { fs.copyFileSync(toolsLockPath(), path.join(dir, 'package-lock.json')); } catch (e) { return { ok: false, log: 'the plugin\'s tools-lock.json is missing or unreadable (' + e.message + ')', dir, registry, remedy: 'reinstall the plugin; or run the install with --no-lock to proceed without checksums' }; }
    run(['ci', '--no-audit', '--no-fund', '--ignore-scripts']);



    if (r.status !== 0 && /(ETARGET|notarget|No matching version)[\s\S]{0,200}\bplaywright(-core)?@(?!0\.0\.)/i.test(log)) {
      const v = spawnSync(npm, ['view', 'playwright-core', 'versions', '--json'], opts);
      const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
      let newest = null;
      try { const all = JSON.parse(String(v.stdout || '[]')); const major = PLAYWRIGHT_PIN.split('.')[0]; const ok = (Array.isArray(all) ? all : [all]).filter((x) => /^\d+\.\d+\.\d+$/.test(x) && x.split('.')[0] === major && cmp(x, PLAYWRIGHT_PIN) >= 0).sort(cmp); newest = ok[ok.length - 1] || null; } catch { newest = null; }
      if (!newest) log += '\n[claude-test] this registry carries neither playwright-core ' + PLAYWRIGHT_PIN + ' nor any newer stable ' + PLAYWRIGHT_PIN.split('.')[0] + '.x — nothing to fall back to';
      if (newest && newest !== PLAYWRIGHT_PIN && !allowFallback) {
        log += '\n[claude-test] ' + (registry || 'your registry') + ' does not carry playwright ' + PLAYWRIGHT_PIN + '. It does have ' + newest + ' (newest stable ' + PLAYWRIGHT_PIN.split('.')[0] + '.x): run the install again with --allow-fallback to use that version WITHOUT the shipped checksums, or point npm at a registry that carries ' + PLAYWRIGHT_PIN + '.';
        return { ok: false, log, dir, registry, playwright: PLAYWRIGHT_PIN, pinned: false, mode: 'not installed', remedy: 'your registry lacks playwright ' + PLAYWRIGHT_PIN + '; "install --allow-fallback" accepts its newest ' + PLAYWRIGHT_PIN.split('.')[0] + '.x (' + newest + ') without checksums, or use a registry that has the pinned version', fallbackAvailable: newest };
      }
      if (newest && newest !== PLAYWRIGHT_PIN) {
        process.stderr.write('[claude-test] --allow-fallback: ' + (registry || 'your registry') + ' does not carry playwright ' + PLAYWRIGHT_PIN + '; installing the newest stable ' + PLAYWRIGHT_PIN.split('.')[0] + '.x it has: ' + newest + ' — version-pinned, NOT checksum-pinned (no shipped lockfile covers it)\n');
        manifest.overrides = { playwright: newest, 'playwright-core': newest };
        writeManifest(null);
        try { fs.rmSync(path.join(dir, 'package-lock.json'), { force: true }); } catch {       }
        mode = 'fallback: playwright ' + newest + ' from the registry, no checksums';
        run(['install', '--no-audit', '--no-fund', '--ignore-scripts']);
        pin = newest;
      }
    }
  }
  if (r.status === 0) { try { writeStandInPackages(path.join(dir, 'node_modules')); } catch (e) { log += '\n[claude-test] could not write the stand-in packages (' + ((e && e.message) || e) + ')'; r = { status: 1 }; } }
  try { fs.chmodSync(path.join(dir, 'node_modules'), 0o755); } catch {       }
  tightenToolsDir(dir);
  const ok = r.status === 0 && !!mcpCliPath({ forInstall: true });
  if (ok) { try { writeManifest({ mode, pinned: mode === 'pinned', playwright: pin, mcp: PLAYWRIGHT_MCP_VERSION }); } catch {       } }
  return { ok, log, dir, registry, playwright: pin, pinned: mode === 'pinned', mode, remedy: ok ? null : installRemedy(log, registry) };
}


let browserDirsMemo = null; let dryRunFailures = 0; let dryRunRetryAt = 0;
export function expectedChromiumDirs() {
  const info = toolsInstallInfo(); const key = info ? String(info.playwright) : '';
  if (browserDirsMemo && browserDirsMemo.key === key) return browserDirsMemo.names;
  if (dryRunFailures >= 5 || Date.now() < dryRunRetryAt) return null;
  const cli = path.join(toolsDir(), 'node_modules', 'playwright-core', 'cli.js');
  let names = null;
  try { const r = spawnSync(process.execPath, [cli, 'install', '--dry-run', 'chromium'], { cwd: toolsDir(), encoding: 'utf8', timeout: 5000, env: { ...browserServerEnv(), WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1', PLAYWRIGHT_BROWSERS_PATH: browsersDir() } });                                                                           const found = [...String(r.stdout || '').matchAll(/Install location:\s+(.+)$/gm)].map((m) => path.basename(m[1].trim())).filter((n) => /^chromium/.test(n)); if (r.status === 0 && found.length) names = found; } catch { names = null; }
  if (names) { browserDirsMemo = { key, names }; dryRunFailures = 0; } else { dryRunFailures++; dryRunRetryAt = Date.now() + 60000; if (dryRunFailures === 5) process.stderr.write('[claude-test] could not list the expected browser folders five times; judging by folder names from now on\n'); }
  return names;
}


export function toolsInstallInfo() { try { const j = JSON.parse(fs.readFileSync(path.join(toolsDir(), 'package.json'), 'utf8')); return j && j.name === 'claude-test-tools' && j.claudeTest ? j.claudeTest : null; } catch { return null; } }


function installRemedy(log, registry) {
  const reg = registry || '(npm config get registry)';
  if (/EINTEGRITY|Integrity checksum failed|integrity verification failed/i.test(log)) return reg + ' served a package whose checksum differs from the published one (EINTEGRITY) — nothing from it is used. If your registry re-packs packages on purpose, run the same install command with --no-lock to accept what it serves (version-pinned, not checksum-pinned); otherwise ask whoever runs the registry';
  if (/EUSAGE[\s\S]{0,300}(lock file|package-lock)/i.test(log)) return 'npm refused the shipped lockfile (your npm may be too old for lockfile version 3 — Node 18+ brings a new enough npm); update npm, or run the install with --no-lock';
  if (/ETARGET|notarget|No matching version|E404|404 Not Found/i.test(log)) return 'your npm registry ' + reg + ' does not carry the pinned packages (@playwright/mcp ' + PLAYWRIGHT_MCP_VERSION + ' with playwright-core ' + PLAYWRIGHT_PIN + ', or any stable playwright-core to fall back to); ask the registry\'s owners to mirror them, then run install again';
  if (/\b(EACCES|EPERM|EROFS)\b/.test(log) && log.includes(toolsDir())) return 'npm could not write into ' + toolsDir() + ' (a permission error). Check that this folder and what is in it are yours and writable, or delete it, then install again.' + (/\bEROFS\b/.test(log) || process.env.SANDBOX_RUNTIME === '1' ? ' If Claude Code ran this command, its sandbox may be what refused: run it in your own terminal' : '');


  const sandboxed = process.env.SANDBOX_RUNTIME === '1' || /^(https?:\/\/)?(srt[^/@]*@)?(localhost|127\.0\.0\.1):\d+/i.test(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|tunneling socket could not be established|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED/i.test(log) || (sandboxed && /E403|403 Forbidden/i.test(log))) return 'npm could not reach ' + reg + ' from here — the network is blocked or filtered (Claude Code\'s sandbox, a proxy, or a certificate in between)' + (sandboxed ? '; this shell looks sandboxed: run the same install command in your own terminal' : '; fix the network path and run install again');
  if (/E401|ENEEDAUTH|Unable to authenticate|authentication token/i.test(log)) return 'your npm registry ' + reg + ' rejected the credentials npm has for it (401) — npm login / your token setup, then run install again';
  if (/E403|403 Forbidden/i.test(log)) return reg + ' answered 403: either the registry refuses this package/your account, or something between you and it (a sandbox or proxy) blocks the request — if you are inside Claude Code, run the same install command in your own terminal first; otherwise check your registry access';
  if (/spawnSync npm(\.cmd)? ENOENT|ENOENT.*npm|npm: (command )?not found/i.test(log)) return 'npm itself was not found on PATH; install Node.js (which brings npm) and run install again';
  return 'see the npm output above; registry used: ' + reg;
}




export async function importPlaywright() {
  assertToolsDirPrivate();
  try {
    const req = createRequire(path.join(toolsDir(), 'package.json'));
    for (const name of ['playwright-core', 'playwright']) {


      try { const resolved = req.resolve(name); if (!reallyInsideDir(resolved, toolsDir())) continue; const mod = await import(pathToFileURL(resolved).href); return { pw: mod.default || mod, from: resolved }; } catch {            }
    }
  } catch {                     }
  return null;
}

export function findChrome() {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const name of ['google-chrome', 'google-chrome-stable']) if (dir && path.isAbsolute(dir)) candidates.push(path.join(dir, name));
    candidates.push('/opt/google/chrome/chrome');
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile() && !insideProjectReally(c); } catch { return false; } }) || null;
}
