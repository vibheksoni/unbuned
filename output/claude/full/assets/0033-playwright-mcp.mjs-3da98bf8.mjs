#!/usr/bin/env node















import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { makeAllowTool, ALLOW_TOOL, UP_TOOL, SHOW_TOOL } from './lib/allow-tool.mjs';
import { loadConfig, shown, browserServerEnv, parseDotenv, isLocalHost, ensureRunsDir, assertRunsDirInsideProject, resolveProjectDir, sessionRoot, reallyInsideDir, runsPathProblem, envPathOutsideProject, originAllowed, projectsBelow, isMarked, rootConfiguresItself, sanitizeBrowserEnv, launcherConfig } from './lib/config.mjs';
import { makeVet } from './lib/vet.mjs';
import { runFolders, placeStagedFile } from './lib/runs.mjs';
import { keepLivePage } from './lib/live-page.mjs';
import { startFenceProxy, upstreamProxySetting, noProxyMatcher, isNonPublicAddress, plainAddress } from './lib/fence-proxy.mjs';
import { makeReachableMatcher } from './lib/hosts.mjs';
import { parseSnapLine, yamlScalar, makeHoldsValueOf, judgeProbe, bypassOf, UDP_FENCE_ARGS, resolverPins, guardScript, secretVariants, makeRedactor, toolTextOf, pageUrlFromToolText } from './lib/guard.mjs';
import { mcpCliPath, findChrome, toolsDir, makeLaunchDir, installTools, writeStandInPackages, browserSelection, browserProblem, toolsProblem, toolsInstallInfo, browsersDir, expectedChromiumDirs } from './lib/tools.mjs';
import { ensureAuthFile, tidySkillCreds } from './lib/signin.mjs';

const log = (m) => process.stderr.write('[claude-test] ' + shown(m, 2000) + '\n');
if (process.env.CLAUDE_TEST_DISABLE_MCP === '1') { log('disabled by CLAUDE_TEST_DISABLE_MCP=1'); process.exit(0); }



const allowTool = makeAllowTool({ send: (obj) => process.stdout.write(JSON.stringify(obj) + '\n') });






if (process.env.CLAUDE_TEST_EAGER === '1') await boot(null); else lazyServer();

function lazyServer() {
  let buf = ''; let initializeParams = null; let booted = false;
  const ct = fileURLToPath(new URL('./ct.mjs', import.meta.url));
  const snapshotTools = () => { try { const j = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./tools-snapshot.json', import.meta.url)), 'utf8')); return Array.isArray(j.tools) ? j.tools : []; } catch { return []; } };
  const noArgs = { type: 'object', properties: {}, additionalProperties: false };
  const setupTools = [
    { name: 'browser_setup_needed', description: 'Call this when a browser_* tool of this server answered that the Claude Test browser tooling is not usable on this machine: it says what is missing and the one fix.', inputSchema: noArgs },
    { name: 'claude_test_install', description: 'Install the Claude Test browser tooling now (the same as running  node ' + ct + ' install  in a terminal, minus the browser download): an npm ci of the pinned Playwright packages into the plugin\'s data folder, using your npm configuration. Takes up to a minute.', inputSchema: noArgs },
  ];
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const onEnd = () => process.exit(0);

  const nothingAllowedYet = () => { try { const { cfg } = launcherConfig(); return cfg.allowedOrigins && cfg.allowedOrigins.length ? null : 'Claude Test: the person has not allowed any address for this project yet' + (cfg.pendingOrigins && cfg.pendingOrigins.length ? ' (waiting: ' + shown(cfg.pendingOrigins.join(' '), 600) + ')' : '') + ', so the test browser stays closed. Run "ct.mjs status" and follow needsConsent: the tool ' + ALLOW_TOOL + ' of this server puts the question to the person. A background run reports BLOCKED with needsConsent.line and ends.'; } catch { return null; } };
  const take = () => { process.stdin.removeListener('data', onData); process.stdin.removeListener('end', onEnd); const rest = buf; buf = ''; return rest; };
  const onData = (chunk) => {
    buf += chunk; let nl;
    while (!booted && (nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      let msg = null; try { msg = JSON.parse(line); } catch {                         }
      if (allowTool.take(msg)) { buf = buf.slice(nl + 1); continue; }
      const mine = !msg || msg.id === undefined || typeof msg.method !== 'string' || msg.method === 'initialize' || msg.method === 'tools/list' || msg.method === 'ping';
      const waits = !mine && msg.method === 'tools/call' ? nothingAllowedYet() : null;
      if (waits) { buf = buf.slice(nl + 1); send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: waits }], isError: true } }); continue; }
      if (!mine) { booted = true; boot({ initializeParams, take }).catch((e) => { log('start-up failed on first use: ' + (e && e.message ? e.message : e)); process.exit(1); }); return; }
      buf = buf.slice(nl + 1);
      if (!msg || msg.id === undefined || typeof msg.method !== 'string') continue;
      const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'initialize') { initializeParams = msg.params && typeof msg.params === 'object' ? msg.params : null; reply({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'claude-test-browser', version: 'lazy' } }); }
      else if (msg.method === 'tools/list') reply({ tools: [...snapshotTools(), ...setupTools, ...allowTool.tools] });
      else reply({});
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.on('end', onEnd);
}



async function boot(lazy) {
allowTool.fenceBuilt();
const SESSION_ROOT = sessionRoot();
const { cfg, note: adoptionNote, served } = launcherConfig();
if (adoptionNote) log(adoptionNote);



const LANDING_ROOTS = process.platform === 'win32' ? null : [SESSION_ROOT, cfg.projectDir].flatMap((p) => { try { const st = fs.statSync(fs.realpathSync(p), { bigint: true }); return [{ dev: st.dev, ino: st.ino }]; } catch { return []; } });


{ const v = (process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim(); if (v && path.resolve(v) !== browsersDir()) log('PLAYWRIGHT_BROWSERS_PATH is set (' + shown(v, 120) + ') and is ignored by the browser server\'s launcher: a downloaded browser is looked for only in ' + browsersDir() + ', where  node ' + fileURLToPath(new URL('./ct.mjs', import.meta.url)) + ' install chromium  puts it'); }

{ const v = (process.env.CLAUDE_TEST_BROWSER_EXECUTABLE || '').trim(); if (v) log('CLAUDE_TEST_BROWSER_EXECUTABLE is set (' + shown(v, 120) + ') and is ignored by the browser server\'s launcher: it starts an installed Google Chrome, or the browser that  node ' + fileURLToPath(new URL('./ct.mjs', import.meta.url)) + ' install chromium  downloads into ' + browsersDir()); }
delete process.env.CLAUDE_TEST_BROWSER_EXECUTABLE;
delete process.env.PLAYWRIGHT_BROWSERS_PATH;
sanitizeBrowserEnv();
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir();
for (const w of cfg.warnings) log(w);
{ const v = (process.env.CLAUDE_TEST_TOOLS_DIR || '').trim(); if (v) log('CLAUDE_TEST_TOOLS_DIR is set (' + shown(v, 120) + ') and is ignored: the browser tooling is run only from ' + toolsDir() + '; a session variable cannot choose it'); }
try { process.chdir(cfg.projectDir); } catch {                }
if (LANDING_ROOTS) { let here = null; try { const st = fs.statSync('.', { bigint: true }); here = LANDING_ROOTS.some((w) => w.dev === st.dev && w.ino === st.ino); } catch { here = false; } if (!here) { log('refusing to start: the folder this helper works from is not the one it looked at a moment ago (it was moved or replaced). Reconnect the helper with /mcp'); process.exit(1); } }






try { assertRunsDirInsideProject(cfg); } catch (e) { log(e.message + ' — not starting the browser server'); process.exit(1); }
const usesClaudeTest = (cfg.rcFound && (cfg.projectDir !== SESSION_ROOT || rootConfiguresItself(cfg.projectDir))) || isMarked(cfg.projectDir) && !(cfg.projectDir === SESSION_ROOT && cfg.rcFound && !rootConfiguresItself(cfg.projectDir));
if (usesClaudeTest) { try { ensureRunsDir(cfg); } catch (e) { log('could not create ' + cfg.runsDir + ': ' + e.message); } }





let launchDir; try { launchDir = makeLaunchDir(); } catch (e) { log('refusing to start: could not make a folder for this session under the plugin\'s data folder (' + e.message + '). The browser server is only handed files from there: check that the folder named in that error is yours and writable, then reconnect this server (/mcp)'); process.exit(1); }
const outputDir = path.join(launchDir, 'out');
if (!cfg.allowedOrigins || !cfg.allowedOrigins.length) { log('refusing to start: the person has not allowed any address for this project yet' + (cfg.pendingOrigins && cfg.pendingOrigins.length ? ' (waiting: ' + cfg.pendingOrigins.join(' ') + ')' : '') + ' — type /claude-test in Claude Code and answer the dialog it opens'); process.exit(1); }



const serverArgs = ['--isolated', '--block-service-workers', '--output-dir', outputDir, '--snapshot-mode', 'none', '--viewport-size', '1280x800'];
if (process.env.CLAUDE_TEST_HEADED !== '1') serverArgs.push('--headless');








let networkFence;
let pinArgs = []; let pinnedNames = [];
let udpArgs = [];
let guardSockets = true;
let notePageLeftApp = () => {};
{
  { const why = browserProblem(cfg); if (why) { log('refusing to start: ' + why); process.exit(1); } }












  const proxySetting = upstreamProxySetting(process.env); const upstream = proxySetting.proxy;
  const lookup2s = (host) => Promise.race([dns.promises.lookup(host, { all: true, verbatim: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2000).unref())]);
  const bypass = ['<-loopback>']; const viaProxy = []; const appHostPorts = new Set(); const pins = [];
  for (const o of cfg.allowedOrigins) {
    let host; try { host = new URL(/^https?:\/\//.test(o) ? o : 'http://' + o).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { continue; }
    const pairs = bypassOf(o);
    for (const hp of pairs) appHostPorts.add(host + ':' + hp.slice(hp.lastIndexOf(':') + 1));
    const literal = isLocalHost(host) || net.isIP(host) !== 0;
    const localName = !literal && (!host.includes('.') || /\.(localhost|local|internal|test|lan|home|corp|private|intranet|localdomain|home\.arpa)$/.test(host));
    let own = literal || localName;
    if (!literal) {


      let addrs = null; let looked = false; try { addrs = await lookup2s(host); looked = true; } catch { addrs = null; }
      if (!looked && !localName) { own = false; log('NOTE could not look up ' + shown(host, 120) + ' within 2 s: it stays behind the fence\'s proxy, which resolves it afresh for every request and refuses a local or private address (an app on a private name that this machine cannot resolve will not load: use its address)'); }
      else if (looked) {
        const priv = (addrs || []).filter((x) => x && x.address && isNonPublicAddress(x.address)); const pub = (addrs || []).filter((x) => x && x.address && !isNonPublicAddress(x.address));
        if (!localName) own = pub.length === 0;
        if (own && priv.length) {
          const plain = priv.map((x) => plainAddress(x.address)).filter(Boolean); const pick = plain.find((x) => x.family === 4) || plain[0];
          if (pick && resolverPins([{ name: host, address: pick.address }])) pins.push({ name: host, address: pick.address });
          else if (!localName) { own = false; log('NOTE ' + shown(host, 120) + ' resolves to private space but cannot be held to one address (an unusual name or address form): it stays behind the fence\'s proxy'); }
        }
      }
    }
    (own ? bypass : viaProxy).push(...pairs);
  }
  let reach = { runId: undefined, entries: cfg.reachableHosts || [], match: makeReachableMatcher(cfg.reachableHosts || []) };
  let tally = new Map(); let leftFor = new Map(); let tallyDirty = false; let lastLook = 0; let ranId = null;


  const flushTally = () => {
    if (!tallyDirty) return; tallyDirty = false; if (!reach.runId) return;
    const dir = path.join(cfg.runsDir, reach.runId);
    try {
      assertRunsDirInsideProject(cfg);
      const realDir = fs.realpathSync(dir);
      if (!fs.lstatSync(dir).isDirectory() || realDir !== path.join(fs.realpathSync(cfg.runsDir), reach.runId)) return;


      const staged = path.join(launchDir, 'refused-hosts.' + crypto.randomBytes(6).toString('hex') + '.json');
      fs.writeFileSync(staged, JSON.stringify({ run: reach.runId, reachableHosts: reach.entries, refused: Object.fromEntries([...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200)), ...(leftFor.size ? { pageLeftAppFor: Object.fromEntries(leftFor) } : {}) }, null, 1) + '\n', { mode: 0o600, flag: 'wx' });
      placeStagedFile(staged, path.join(realDir, 'refused-hosts.json'), { within: LANDING_ROOTS && { root: fs.realpathSync(cfg.projectDir), anchors: LANDING_ROOTS }, mode: 0o600 });
    } catch {                                                             }
  };



  const rcFiles = [...new Set([cfg.rcPath, path.join(cfg.projectDir, '.claude-testrc')].filter(Boolean))];
  const rcStamp = () => rcFiles.map((f) => { try { const st = fs.statSync(f); return st.mtimeMs + ':' + st.size; } catch { return '-'; } }).join('|');
  let lastState = null; let lastRc = rcStamp();
  const lookForNewRun = () => {
    const now = Date.now(); if (now - lastLook < 2000) return; lastLook = now;
    const id = runFolders(cfg).pop() || null; let running = false;
    if (id) { try { const d = path.join(cfg.runsDir, id); running = fs.existsSync(path.join(d, 'progress.ndjson')) && !fs.existsSync(path.join(d, 'results.json')); } catch { running = false; } }
    const state = (id || '') + (running ? '|running' : '|idle');
    if (id !== reach.runId) { flushTally(); tally = new Map(); leftFor = new Map(); reach.runId = id; ranId = null; }
    if (running && ranId !== id) { ranId = id; if (tally.size || leftFor.size) { tally = new Map(); leftFor = new Map(); tallyDirty = true; } }
    if (running && state === lastState) return;
    const rc = rcStamp(); if (state === lastState && rc === lastRc) return;
    lastState = state; lastRc = rc;
    let entries = reach.entries; try { entries = loadConfig(cfg.projectDir).reachableHosts || []; } catch {                                              }
    if (JSON.stringify(entries) !== JSON.stringify(reach.entries)) { reach = { runId: reach.runId, entries, match: makeReachableMatcher(entries) }; log('reachableHosts now: ' + (entries.length ? entries.join(' ') : '(none)') + (running ? ' (run ' + id + ' begins with these)' : '')); }
  };
  const allow = (host, port) => { lookForNewRun(); return appHostPorts.has(host + ':' + port) || reach.match(host, port); };
  const onRefused = (host, port) => { if (!/^[a-z0-9.-]{1,253}$/.test(host) || appHostPorts.has(host + ':' + port)) return; const k = host + ':' + port; if (tally.size >= 400 && !tally.has(k)) return; tally.set(k, (tally.get(k) || 0) + 1); tallyDirty = true; };
  notePageLeftApp = (host) => { lookForNewRun(); if (!reach.runId || !/^[a-z0-9.:[\]-]{1,260}$/i.test(host)) return; if (leftFor.size >= 50 && !leftFor.has(host)) return; leftFor.set(host, (leftFor.get(host) || 0) + 1); tallyDirty = true; };
  if (proxySetting.problem) log('NOTE ' + proxySetting.problem + '; the test browser\'s fence connects to allowed hosts directly instead, and only to their public addresses. To tunnel through your proxy, set HTTPS_PROXY to an http:// proxy address');
  const unreachable = new Set();
  const onFailed = (host, port, why) => { const k = host + ':' + port; if (unreachable.has(k) || unreachable.size >= 50) return; unreachable.add(k); log('NOTE ' + shown(host, 120) + ':' + port + ' is allowed but could not be reached (' + shown(String(why), 60) + '), tried at each of its public addresses' + (upstream ? ' or through ' + upstream.host : '') + ': what the app loads from it will be missing in this run'); };
  const proxy = await startFenceProxy({ allow, onRefused, onFailed, direct: upstream ? noProxyMatcher(process.env) : () => false, upstream, refuseText: 'Claude Test: this address is outside what the test browser may reach for this run (the app under test, plus the hosts .claude-testrc lists under reachableHosts).' });
  const flushTimer = setInterval(flushTally, 1500); flushTimer.unref(); process.prependListener('exit', flushTally);
  serverArgs.push('--proxy-server', 'http://127.0.0.1:' + proxy.port, '--proxy-bypass', bypass.join(','));
  udpArgs = UDP_FENCE_ARGS;
  const pinRule = resolverPins(pins); if (pinRule) { pinArgs = ['--host-resolver-rules=' + pinRule]; pinnedNames = pins.map((p) => p.name); log('fence: held to the address they have now, for this session — ' + pins.map((p) => shown(p.name, 80) + ' → ' + p.address).join(', ')); }
  log('fence: reached directly, as the app\'s own — ' + (bypass.length > 1 ? bypass.slice(1).join(' ') : '(nothing)') + (viaProxy.length ? '; through the proxy as trusted origins — ' + viaProxy.join(' ') : '') + '; through the proxy for loading only — ' + (reach.entries.length ? reach.entries.join(' ') : '(nothing yet: reachableHosts is empty)') + '; everything else is refused and counted' + (upstream ? '; tunnels go via this machine\'s proxy ' + upstream.host + ':' + upstream.port : ''));
  guardSockets = false;
  networkFence = 'navigation only to ' + cfg.allowedOrigins.join(' ') + '; pages may also load from ' + (reach.entries.length ? reach.entries.join(' ') : 'no other host') + ' (reachableHosts, read again at each new run); a filtering proxy refuses and counts everything else, WebSockets included' + (upstream ? ', tunnelling through this machine\'s proxy ' + upstream.host + ':' + upstream.port : '') + '; WebRTC off in pages';
}
{
  const guard = guardScript(cfg, { sockets: guardSockets });



  const writeNew = (name, text) => { const p = path.join(launchDir, name); const fd = fs.openSync(p, 'wx', 0o600); try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); } return p; };
  try {
    serverArgs.push('--init-script', writeNew('ws-guard.js', guard));

    if (udpArgs.length || pinArgs.length) serverArgs.push('--config', writeNew('launch-options.json', JSON.stringify({ browser: { launchOptions: { args: [...udpArgs, ...pinArgs] } } }) + '\n'));
  } catch (e) { log('refusing to start: could not write the page guard script and the browser\'s launch options into ' + launchDir + ' (' + e.message + '); without them WebRTC and QUIC' + (pinArgs.length ? ' and the address pins for ' + pinnedNames.map((n) => shown(n, 60)).join(', ') : '') + ' would not be fenced. Check that this folder is writable, then reconnect this server (/mcp)'); process.exit(1); }
}
const { exe, chromePath, browser } = browserSelection(cfg);



if (chromePath) serverArgs.push('--executable-path', chromePath);
if (browser) serverArgs.push('--browser', browser);







if (cfg.signInApplies && cfg.storageState.refused) log('saved-session file not used: ' + cfg.storageState.refused);
else if (cfg.signInApplies) {
  const authPath = cfg.storageState.inUse ? cfg.storageState.path : cfg.storageState.defaultPath;
  try { const r = ensureAuthFile(authPath, { privateFolder: true, baseUrl: cfg.baseUrl || null, projectDir: cfg.projectDir }); if (r.usable) { serverArgs.push('--storage-state', authPath); if (r.repaired) log('saved-session file: ' + r.repaired); } else log('saved-session file not used: ' + r.reason); } catch (e) { log('saved-session file not usable (' + e.message + '); starting without it'); }
  try { fs.rmSync(path.join(path.dirname(cfg.storageState.defaultPath), 'auth.loaded.json'), { force: true }); } catch {                                          }
}
if (cfg.secretsFile.refused && cfg.signInApplies) log('secrets file not used: ' + cfg.secretsFile.refused);
else if (cfg.secretsFile.inUse && cfg.signInApplies) { try { const n = tidySkillCreds(cfg.secretsFile.path, { privateFolder: true }); if (n) log('secrets file: dropped ' + n + ' stale skill-written line(s) shadowed by your own'); } catch {                   } serverArgs.push('--secrets', cfg.secretsFile.path); }
if ((cfg.storageState.inUse || cfg.secretsFile.inUse) && !cfg.signInApplies) log('sign-in material not passed: ' + cfg.signInNote);
if (typeof process.getuid === 'function' && process.getuid() === 0) serverArgs.push('--no-sandbox');







const browserAvailable = () => {
  if (exe || chromePath || browser !== 'chromium') return true;
  const want = (expectedChromiumDirs() || []).filter((n) => /^chromium-\d/.test(n));
  const has = (dir) => { try { return want.length ? want.some((n) => fs.existsSync(path.join(dir, n, 'INSTALLATION_COMPLETE'))) : fs.readdirSync(dir).some((d) => /^chromium-\d/.test(d) && fs.existsSync(path.join(dir, d, 'INSTALLATION_COMPLETE'))); } catch { return false; } };
  return has(browsersDir());
};
{ const why = toolsProblem(); const localCli = why ? null : mcpCliPath({ report: true });
  if (localCli) { try { writeStandInPackages(path.join(toolsDir(), 'node_modules')); } catch {                                                                      } }
  const noBrowser = !!localCli && !browserAvailable();
  const stubWhy = why ? { text: 'the browser tooling folder cannot be used (' + why.split(' — ')[0] + ')', notPrivate: true } : noBrowser ? { text: 'there is no test browser to drive on this machine yet' } : { text: 'the browser tooling is not installed on this machine' };
  if (!localCli || noBrowser) setupNeededServer(stubWhy, lazy);
  else if (!lazy) startRealServer(localCli, null);
  else {
    const fallBack = (err) => setupNeededServer({ text: 'the browser server could not start (' + (err && err.message ? err.message : err) + ')' }, lazy);
    try { startRealServer(localCli, { initializeParams: lazy.initializeParams, takeStdin: lazy.take, done: (err) => { if (err) { log('could not start the browser server on first use (' + err.message + '); serving the setup stub'); fallBack(err); } } }); }
    catch (e) { fallBack(e); }
  } }




function startRealServer(localCli, handoff) {
const base = [process.execPath, localCli];
log('project ' + cfg.projectDir + '; base URL ' + (cfg.baseUrl || '(none yet)') + '; browser ' + (exe || chromePath || browser) + '; origins ' + cfg.allowedOrigins.join(' ') + '; network: ' + networkFence);












const childEnv = browserServerEnv();
childEnv.WS_NO_BUFFER_UTIL = '1'; childEnv.WS_NO_UTF_8_VALIDATE = '1';
const childCwd = fs.existsSync(os.homedir()) ? os.homedir() : os.tmpdir();
const child = spawn(base[0], [...base.slice(1), ...serverArgs], { cwd: childCwd, stdio: ['pipe', 'pipe', 'inherit'], env: childEnv, detached: process.platform !== 'win32' });
let handedOver = !handoff;
let giveUp = null;
const failedStart = (err) => { if (handedOver !== false) return; handedOver = null; clearTimeout(giveUp); disarm(); handoff.done(err); };
child.on('error', (e) => { log('could not start ' + base.join(' ') + ': ' + e.message); if (!handedOver) { failedStart(e); return; } process.exit(1); });
child.on('close', (code, signal) => { if (!handedOver) { failedStart(new Error('the browser server exited while starting (exit ' + (code ?? signal) + ')')); return; } process.exit(code ?? (signal ? 1 : 0)); });


const reap = () => { setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {            } } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {            } process.exit(0); }, 2000).unref(); }, 3000).unref(); };
const onSignal = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, () => { child.kill(sig); reap(); }]));
for (const [sig, fn] of Object.entries(onSignal)) process.on(sig, fn);
process.stdin.on('end', reap);
const disarm = () => { for (const [sig, fn] of Object.entries(onSignal)) process.removeListener(sig, fn); process.stdin.removeListener('end', reap); };



















const secrets = [];
let secretsUnreadable = false;
if (cfg.signInApplies && cfg.secretsFile.inUse && !cfg.secretsFile.refused && serverArgs.includes('--secrets')) {
  try {
    for (const [k, v] of Object.entries(parseDotenv(fs.readFileSync(cfg.secretsFile.path, 'utf8')))) {
      if (!v) continue;
      const variants = secretVariants(v);
      secrets.push([k, variants, v]);
    }
    secrets.sort((a, b) => String(b[2]).length - String(a[2]).length);
    const short = secrets.filter(([, vs]) => !vs.length).map(([k]) => k);
    if (short.length) log('secrets: ' + short.join(', ') + ' ' + (short.length > 1 ? 'have values' : 'has a value') + ' shorter than 6 characters — typed when a spec names the KEY, but too short to scrub reliably from what the agent reads back; use real-length test secrets');
    { const byVal = new Map(); for (const [k, , raw] of secrets) byVal.set(raw, [...(byVal.get(raw) || []), k]); const dup = [...byVal.values()].filter((ks) => ks.length > 1); const nested = secrets.filter(([k, , raw]) => secrets.some(([k2, , r2]) => k2 !== k && r2 !== raw && r2.includes(raw))).map(([k]) => k); if (dup.length) log('secrets: ' + dup.map((ks) => ks.join(' = ')).join('; ') + ' share one value — results will name whichever the redaction meets first'); if (nested.length) log('secrets: the value of ' + nested.join(', ') + ' is contained in another secret\'s value — prefer distinct test values'); }
    if (secrets.length) log('secrets: ' + secrets.length + ' KEY(s); typed only while the page is on ' + cfg.secretOrigins.join(' ') + '; browser_evaluate is off after one is typed until browser_close; values scrubbed from results');
  } catch (e) { secretsUnreadable = true; log('secrets file unreadable for the guard (' + (e.code || e.message) + ') though the server was given it — refusing every browser_type / browser_fill_form this session; fix the file and reconnect'); }
}
const secretKeySet = new Set(secrets.map(([k]) => k));
const redactor = makeRedactor(secrets);
const redactSecrets = (line) => redactor.redact(line, { splits: secretTyped });
const holdsValueOf = makeHoldsValueOf(secrets);
const secretOriginSet = new Set(cfg.secretOrigins);
let secretTyped = false;
let secretEver = false;
let scripted = false;
const secretRefs = new Map();
const closeCalls = new Set();
const inFlight = new Set();
const decidedLate = new Map();
const filesByCall = new Map();
const lateFiles = new Map();
let hold = null;
const queuedLines = [];

let probeSeq = 0;
const PROBE_ID = 'claude-test-guard-';
const refusal = (id, text) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Refused by the claude-test launcher: ' + text + '.' }], isError: true } }) + '\n';


function answerId(line, force = false) {
  if (line.length <= 200000 || force) { try { const m = JSON.parse(line); return m && typeof m === 'object' && !Array.isArray(m) ? m.id : undefined; } catch { return undefined; } }
  const m = line.slice(0, 200).match(/^\{"jsonrpc":"2\.0","id":(\d+|"[^"\\]{1,80}")/) || line.slice(-200).match(/,"jsonrpc":"2\.0","id":(\d+|"[^"\\]{1,80}")\}$/);
  return m ? (m[1].startsWith('"') ? m[1].slice(1, -1) : Number(m[1])) : undefined;
}
function startProbe() { hold.phase = 'probe'; hold.probeId = PROBE_ID + (++probeSeq); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: hold.probeId, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) + '\n'); }
function endHold() { if (!hold) return; clearTimeout(hold.timer); hold = null; while (queuedLines.length && !hold) { const out = fromClient(queuedLines.shift()); if (out !== null) child.stdin.write(out + '\n'); } }
function holdTimedOut() {
  if (!hold) return;
  if (hold.phase === 'sent') { log('the forwarded ' + hold.msg.params.name + ' was not answered within 60 s; checking where the value went before releasing the queue'); inFlight.delete(hold.msg.id); hold.answerLine = null; hold.phase = 'verify'; hold.probeId = PROBE_ID + (++probeSeq); hold.timer = setTimeout(holdTimedOut, 15000); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: hold.probeId, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) + '\n'); return; }
  if (hold.phase === 'verify') { releaseVerified('unconfirmed', 'the after-check was not answered within 15 s'); return; }
  log('refused ' + hold.msg.params.name + ': the page-origin check was not settled within 15 s'); process.stdout.write(refusal(hold.msg.id, 'the browser server did not settle the page-origin check for this secret within 15 s')); endHold();
}

function settleProbe(line) {
  let origin = null; let why = 'the page\'s address could not be confirmed';
  try {
    const msg = JSON.parse(line);
    const text = msg && msg.result && Array.isArray(msg.result.content) ? msg.result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
    if (msg && msg.result && !msg.result.isError) {



      const j = judgeProbe(text, { secretOrigins: secretOriginSet, targets: hold.targets, pairs: hold.pairs, holdsValueOf });
      origin = j.allowed ? j.origin : (j.origin && !secretOriginSet.has(j.origin) ? j.origin : null); why = j.why; hold.alreadyHolds = j.alreadyHolds; hold.valueAtProbe = j.valueAtProbe;
    }
  } catch {                                            }
  if (origin && secretOriginSet.has(origin) && hold.alreadyHolds && hold.alreadyHolds.length) {
    secretTyped = true; secretEver = true; for (const [t, k] of hold.alreadyHolds) { secretRefs.set(t, k); log('not re-typed: ' + k + ' is already in ' + t); }
    const a = hold.msg.params.arguments; const held = new Set(hold.alreadyHolds.map(([t]) => t));
    const rest = Array.isArray(a.fields) ? a.fields.filter((f) => !(isSecretField(f) && held.has(typeof f.target === 'string' ? f.target : f.ref))) : [];
    if (!rest.length) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: hold.msg.id, result: { content: [{ type: 'text', text: 'Already filled: ' + hold.alreadyHolds.map(([t, k]) => t + ' holds ' + k).join(', ') + ' (the snapshot shows the value); nothing was typed again. Continue with the next step.' }] } }) + '\n'); endHold(); return; }
    a.fields = rest; hold.msg.__rewritten = true; hold.pairs = hold.pairs.filter(([t]) => !held.has(t)); hold.targets = hold.targets.filter((t) => !held.has(t));
    if (!hold.pairs.length) { inFlight.add(hold.msg.id); delete hold.msg.__rewritten; child.stdin.write(JSON.stringify(hold.msg) + '\n'); endHold(); return; }
  }
  if (origin && secretOriginSet.has(origin)) {
    hold.prevSecretTyped = secretTyped; hold.prevSecretEver = secretEver; hold.prevRefs = new Set(secretRefs.keys()); secretTyped = true; secretEver = true; for (const [t, k] of hold.pairs) secretRefs.set(t, k); hold.phase = 'sent'; inFlight.add(hold.msg.id); clearTimeout(hold.timer); hold.timer = setTimeout(holdTimedOut, 60000);
    child.stdin.write((hold.msg.__rewritten ? (delete hold.msg.__rewritten, JSON.stringify(hold.msg)) : hold.line) + '\n');
  } else {
    const text = 'the secret ' + hold.key + ' was not typed: ' + (origin ? 'the page is on ' + origin + ', and secrets go only into a page on ' + cfg.secretOrigins[0] + ' (the dev server under test) — a sign-in form anywhere else is never given this project\'s test credentials' : why);
    log('refused ' + hold.msg.params.name + ': ' + text);
    process.stdout.write(refusal(hold.msg.id, text));
    endHold();
  }
}



const FIELDISH = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
function scrubSnapshotFields(text) {
  if (!secretTyped || !secrets.length || !text.includes('[ref=')) return text;
  let sawSecretField = false;
  const lines = text.split('\n'); let field = null;
  for (let i = 0; i < lines.length; i++) {
    const r = parseSnapLine(lines[i]);
    if (r) {
      if (field && r.indent <= field.indent) field = null;
      if (FIELDISH.has(r.role) && r.ref) {
        if (!secretRefs.has(r.ref)) { const around = (r.value || '') + ' ' + (lines[i + 1] || '') + ' ' + (lines[i + 2] || ''); const mk = around.match(/<secret>([\w.-]+)<\/secret>/); if (mk) secretRefs.set(r.ref, mk[1]); else { const squeezed = yamlScalar(r.value || ((lines[i + 1] || '').match(/^ *- text: (.*)$/) || (lines[i + 2] || '').match(/^ *- text: (.*)$/) || [null, ''])[1]).replace(/\s+/g, ''); if (squeezed.length >= 6) { const hit = secrets.find(([, , raw]) => raw && String(raw).replace(/\s+/g, '') === squeezed); if (hit) secretRefs.set(r.ref, hit[0]); } } }
        const mask = secretRefs.has(r.ref) ? '<secret>' + secretRefs.get(r.ref) + '</secret>' : null;
        if (mask) sawSecretField = true;
        field = { indent: r.indent, ref: r.ref };
        if (r.value && mask) { const cut = lines[i].lastIndexOf(': ' + r.value); if (cut >= 0) lines[i] = lines[i].slice(0, cut) + ': ' + mask; }
        continue;
      }
      if (r.role === 'text' && field && r.indent === field.indent + 2) { const m = lines[i].match(/^( *- text: )(.*)$/); if (m) { const v = yamlScalar(m[2]); if (!secretRefs.has(field.ref)) { const mk = v.match(/<secret>([\w.-]+)<\/secret>/); if (mk) secretRefs.set(field.ref, mk[1]); } const mask = secretRefs.has(field.ref) ? '<secret>' + secretRefs.get(field.ref) + '</secret>' : null; if (mask && v !== mask) lines[i] = m[1] + mask; } }
    } else if (field && lines[i].trim() !== '' && ((lines[i].match(/^ */) || [''])[0].length) <= field.indent) field = null;
  }
  return lines.join('\n');
}

function scrubLineFields(line) {
  if (!secretTyped || !secrets.length || !line.includes('[ref=')) return line;
  try { const m = JSON.parse(line); if (!m || !m.result || !Array.isArray(m.result.content)) return line; let changed = false; for (const c of m.result.content) if (c && c.type === 'text' && typeof c.text === 'string') { const t = scrubSnapshotFields(c.text); if (t !== c.text) { c.text = t; changed = true; } } return changed ? JSON.stringify(m) : line; } catch { return line; }
}




function scrubbedBytes(tool, bytes, name) {
  if (!secrets.length || /^(browser_take_screenshot|browser_pdf_save)$/.test(tool || '')) return bytes;
  if (bytes.length > 16 * 1024 * 1024) { log('withheld ' + name + ' (' + bytes.length + ' bytes): too large to scrub'); return Buffer.from('[claude-test: this file was larger than 16 MiB while secrets were attached to the session, so it was withheld rather than scrubbed. Ask for a smaller dump.]\n'); }
  const before = bytes.toString('utf8'); const after = scrubSnapshotFields(redactSecrets(before));
  return after === before ? bytes : Buffer.from(after, 'utf8');
}
function isErrorAnswer(line) { try { const m = JSON.parse(line); return !!(m && (m.error || (m.result && m.result.isError === true))); } catch { return false; } }
function dropStaged(files) { for (const f of files) { try { fs.unlinkSync(f.staged); } catch {                     } } }

function giveUpOnFiles(id, files, reason) {
  lateFiles.set(id, { files, reason }); if (lateFiles.size > 512) lateFiles.delete(lateFiles.keys().next().value);
  const t = setTimeout(() => dropStaged(files), 20000); if (t.unref) t.unref();
}

function shownName(dest) {
  let root = SESSION_ROOT; try { root = fs.realpathSync(SESSION_ROOT); } catch {                  }
  const under = (base, p) => { const rel = path.relative(base, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null; };
  let real = dest; try { real = path.join(fs.realpathSync(path.dirname(dest)), path.basename(dest)); } catch {                  }
  return under(SESSION_ROOT, dest) || under(root, real) || dest;
}

function namesPutBack(entry, line) {
  if (!entry.files.some((f) => line.includes(path.basename(f.staged)))) return line;
  try {
    const m = JSON.parse(line); if (!m) return line;
    let root = SESSION_ROOT; try { root = fs.realpathSync(SESSION_ROOT); } catch {                  }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fix = (text) => { for (const f of entry.files) { const to = shownName(f.dest); text = text.split(f.staged).join(to).split(path.relative(root, f.staged)).join(to).replace(new RegExp('[^\\s()\\[\\]<>\'"`]*' + esc(path.basename(f.staged)), 'g'), () => to); } return text; };
    if (m.result && Array.isArray(m.result.content)) for (const c of m.result.content) if (c && c.type === 'text' && typeof c.text === 'string') c.text = fix(c.text);
    if (m.error && typeof m.error.message === 'string') m.error.message = fix(m.error.message);
    return JSON.stringify(m);
  } catch { return line; }
}




function placeFiles(entry, id, line) {
  if ((line.includes('"isError":true') || line.includes('"error"')) && isErrorAnswer(line)) { dropStaged(entry.files); return namesPutBack(entry, line); }
  let failed = null;
  for (const f of entry.files) {
    const why = placeStagedFile(f.staged, path.join(f.realDir, path.basename(f.dest)), { within: LANDING_ROOTS && { root: f.realRoot, anchors: LANDING_ROOTS }, check: () => { try { if (fs.realpathSync(path.dirname(f.dest)) !== f.realDir) return 'its folder is not where it was when the call was checked'; } catch { return 'its folder is gone'; } const p = runsPathProblem(f.owner, f.dest); return p ? 'its name ' + p : null; }, change: (b) => scrubbedBytes(entry.tool, b, f.dest) });
    if (why && !failed) failed = 'the file ' + shownName(f.dest) + ' was not saved: ' + why;
  }
  if (failed) { log(failed); return refusal(id, failed).trimEnd(); }
  return namesPutBack(entry, line);
}

function observeAnswer(line) {
  if (line.includes(PROBE_ID)) { const pid = answerId(line, true); if (typeof pid === 'string' && pid.startsWith(PROBE_ID)) { if (pid.startsWith(FRAME_ID)) { if (pid === framePending) frameAnswered(); } else if (pid === INIT_ID) onChildInitialized(line); else if (hold && hold.phase === 'probe' && pid === hold.probeId) settleProbe(redactSecrets(line)); else if (hold && hold.phase === 'verify' && pid === hold.probeId) settleVerify(redactSecrets(line)); return true; } }
  if (line.length < 200000 && line.includes('"method"')) { try { const m = JSON.parse(line); if (m && typeof m.method === 'string') return false; } catch {                    } }
  const id = answerId(line); if (id === undefined) return false;
  inFlight.delete(id); let placed = null;
  if (decidedLate.has(id)) { const d = decidedLate.get(id); decidedLate.delete(id); for (const [k, v] of decidedLate) if (Date.now() - v.at > 120000) decidedLate.delete(k); if (d.line !== null) { log('late answer to an already-decided secret call dropped (the client has the warning)'); return true; } }
  if (filesByCall.has(id)) { const e = filesByCall.get(id); filesByCall.delete(id); placed = placeFiles(e, id, line); }
  else if (lateFiles.has(id)) { const e = lateFiles.get(id); lateFiles.delete(id); dropStaged(e.files); if (e.reason === null) return true; placed = refusal(id, e.reason).trimEnd(); }
  if (closeCalls.has(id)) { closeCalls.delete(id); try { const msg = JSON.parse(line); if (msg && msg.result && !msg.result.isError) { secretTyped = false; scripted = false; secretRefs.clear(); pageOffApp = null; frameContextReset(); } } catch {                           } }
  if (hold && hold.phase === 'verify' && id === hold.msg.id && hold.answerLine === null) { hold.answerLine = line; return true; }
  if (hold && hold.phase === 'sent' && id === hold.msg.id) {
    let untouched = false; try { const m = JSON.parse(line); const whole = m && m.result && m.result.isError && Array.isArray(m.result.content) ? m.result.content.map((c) => c && c.text || '').join('\n') : '';
      const t = whole.replace(/^### Error\s*\n/, '').split('\n')[0].replace(/^(Error: )?((TimeoutError|Error): )?browserBackend\.callTool: /, '').trim();
      const badRef = (t.match(/^(Error: )?Ref ((?:f\d+)?e\d+) not found in the current page snapshot/) || [null, null, null])[2];
      const a = hold.msg.params.arguments || {}; const firstSecret = Array.isArray(a.fields) ? a.fields.findIndex(isSecretField) : 0; const badAt = Array.isArray(a.fields) ? a.fields.findIndex((f) => f && (f.target === badRef || f.ref === badRef)) : (badRef ? 0 : -1);
      untouched = !!(m && m.error) || /^(Error: )?Invalid arguments for tool "browser_/.test(t) ||
         (badRef !== null && badAt >= 0 && badAt <= firstSecret);
    } catch {       }
    if (untouched) { secretTyped = hold.prevSecretTyped === true; secretEver = hold.prevSecretEver === true; for (const [t] of hold.pairs) if (!hold.prevRefs || !hold.prevRefs.has(t)) secretRefs.delete(t); endHold(); return false; }
    hold.answerLine = line; hold.phase = 'verify'; hold.probeId = PROBE_ID + (++probeSeq); clearTimeout(hold.timer); hold.timer = setTimeout(holdTimedOut, 15000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: hold.probeId, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) + '\n');
    return true;
  }
  else if (hold && hold.phase === 'drain' && inFlight.size === 0) startProbe();
  return placed === null || placed === line ? false : placed;
}





function settleVerify(probeLine) {
  let verdict = 'unconfirmed'; let detail = 'the after-check could not read the page';
  try {
    const msg = JSON.parse(probeLine);
    const text = msg && msg.result && !msg.result.isError && Array.isArray(msg.result.content) ? msg.result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
    if (msg && msg.result && msg.result.isError) detail = 'the after-check was answered with an error (an open dialog does this)';
    const sections = ('\n' + text).split(/\n### /).slice(1); const titles = sections.map((s) => s.split('\n')[0]);
    const head = titles.slice(0, titles.indexOf('Snapshot') >= 0 ? titles.indexOf('Snapshot') + 1 : titles.length);
    const page = sections.find((s) => s.startsWith('Page\n')); const tabs = sections.find((s) => s.startsWith('Open tabs\n'));
    const u = page ? ((page.split('\n')[1] || '').match(/^- Page URL: (\S+)$/) || [null, ''])[1] : '';
    let originNow = null; try { originNow = /^https?:\/\//.test(u) ? new URL(u).origin : null; } catch { originNow = null; }
    const snap = sections.find((s) => /^Snapshot\n```yaml\n/.test(s));
    if (head.some((t, i) => head.indexOf(t) !== i || !['Open tabs', 'Page', 'Snapshot', 'Ran Playwright code'].includes(t))) detail = 'the page\'s state could not be read cleanly after typing (an open dialog shows up this way)';
    else if (tabs && tabs.split('\n').filter((l) => /^- \d+: /.test(l)).length > 1) detail = 'a second tab opened while the secret was typed';
    else if (!originNow || !secretOriginSet.has(originNow)) detail = 'the page moved to ' + (originNow || 'an unreadable address') + ' while the secret was typed';
    else if (snap) {
      const lines = snap.split('\n'); const rows = lines.map(parseSnapLine);
      const top = rows.find((r) => r && r.indent === 0 && r.ref); const mainPrefix = top ? (top.ref.match(/^f\d+/) || [''])[0] : null;


      const valueOf = (t) => { const i = rows.findIndex((r) => r && r.ref === t); if (i < 0) return null; const r = rows[i]; let v = yamlScalar(r.value); for (let j = i + 1; j < lines.length; j++) { const ind = (lines[j].match(/^ */) || [''])[0].length; if (lines[j].trim() === '' ) continue; if (ind <= r.indent) break; const c = lines[j].match(/^ *- text: (.*)$/); if (c && ind === r.indent + 2) v += (v ? ' ' : '') + yamlScalar(c[1]); } return v; };
      const absent = hold.pairs.filter(([t]) => valueOf(t) === null);
      const appended = !!(hold.msg.params.arguments && hold.msg.params.arguments.slowly === true);
      const missing = hold.pairs.filter(([t, k]) => { const v = valueOf(t); if (v === null) return false; if (appended && hold.valueAtProbe && v === hold.valueAtProbe[t]) return true;                                                                            return !holdsValueOf(v, k, { appended }); }).map(([t, k]) => k + ' → ' + t);
      if (!missing.length && !absent.length) verdict = 'ok';
      else if (missing.length) { verdict = 'astray'; const empties = hold.pairs.filter(([t]) => { const v = valueOf(t); return v !== null && v.trim() === ''; }).length === missing.length; detail = empties ? 'the field is empty after typing (' + missing.join(', ') + ')' : 'the field holds something other than the value after typing (' + missing.join(', ') + ') — e.g. truncated or re-formatted by the field'; }
      else { verdict = 'absent'; detail = 'the page replaced or left the field before the check (' + absent.map(([t, k]) => k + ' → ' + t).join(', ') + ')'; }
    } else if (!msg.result.isError) detail = 'the page snapshot is missing from the after-check';
  } catch {                        }
  releaseVerified(verdict, detail);
}



function releaseVerified(verdict, detail) {
  let out = hold.answerLine;
  if (verdict !== 'ok') {
    let serverSaid = ''; try { const a = JSON.parse(hold.answerLine); if (a && a.result && a.result.isError) { const t = (a.result.content || []).map((c) => c && c.text || '').join('\n').replace(/^### Error\s*\n/, ''); serverSaid = ' The browser itself reported: ' + shown(t.split('\n').find((l) => l.trim()) || '', 200); } } catch {       }
    const warn = 'a secret was sent to the page but the launcher could not confirm it landed in its field: ' + detail + '.' + serverSaid + ' Report this spec FAIL "secret did not land in its field (' + shown(detail, 120) + ')"';
    log('WARNING ' + warn);
    let id = null; try { id = JSON.parse(hold.answerLine).id; } catch { id = hold.msg.id; }
    const warnLine = JSON.stringify({ jsonrpc: '2.0', id: id === null ? hold.msg.id : id, result: { content: [{ type: 'text', text: 'Note from the claude-test launcher: ' + warn + '.' }], isError: true } });
    if (hold.answerLine === null) { decidedLate.set(hold.msg.id, { line: warnLine, at: Date.now() }); out = hold.cancelled ? null : warnLine; }
    else out = warnLine;
  } else if (hold.answerLine === null) decidedLate.set(hold.msg.id, { line: null, at: Date.now() });
  if (out !== null) process.stdout.write(redactSecrets(out) + '\n');
  endHold();
}

















const FRAME_ID = PROBE_ID + 'frame-';
const FRAME_AFTER = new Set(['browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_drag', 'browser_handle_dialog', 'browser_file_upload', 'browser_wait_for']);
const framesOff = process.env.CLAUDE_TEST_FRAMES === '0' || (cfg.rc && cfg.rc.frames === false);
const actionCalls = new Map();







const ACTS_ON_PAGE = new Set(['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_drag', 'browser_file_upload', 'browser_evaluate']);
let pageOffApp = null;
function watchPageUrl(line) {
  if (!line.includes('- Page URL: ')) return;
  const p = pageUrlFromToolText(toolTextOf(line)); if (!p) return;
  const off = p.urls.find((u) => !originAllowed(cfg, u));
  if (off === undefined) { if (p.clean) pageOffApp = null; return; }
  p.url = off;
  const web = /^https?:\/\//i.test(p.url); let host; try { host = web ? new URL(p.url).host : p.url.split(/[/?#]/)[0].slice(0, 40); } catch { host = 'an unreadable address'; }
  host = redactSecrets(String(host));
  if (web && (!pageOffApp || pageOffApp.host !== host)) { log('the page left the app for ' + shown(host, 120) + '; actions there are refused until the runner navigates back');                                                                                                try { notePageLeftApp(host); } catch {                               } }
  pageOffApp = { url: p.url, host, web };
}
let frameSeq = 0; let framePending = null; let frameTimer = null; let frameStalled = false; let frameFile = null;
const frameRun = { id: null, dir: null, count: 0, checkedAt: 0 };
function runForFrames() {
  const now = Date.now(); if (now - frameRun.checkedAt < 3000) return frameRun.dir ? frameRun : null; frameRun.checkedAt = now;
  let id = null; try { assertRunsDirInsideProject(cfg); const dirs = runFolders(cfg); id = dirs[dirs.length - 1] || null; } catch { id = null; }
  if (!id) { frameRun.dir = null; return null; }
  const dir = path.join(cfg.runsDir, id); let running = false;
  try { running = fs.lstatSync(path.join(dir, 'progress.ndjson')).isFile() && !fs.existsSync(path.join(dir, 'results.json')); } catch { running = false; }
  if (!running) { frameRun.id = id; frameRun.dir = null; return null; }
  if (frameRun.id !== id || !frameRun.dir) { frameRun.id = id; frameRun.count = 0; try { frameRun.count = fs.readdirSync(path.join(dir, 'frames')).filter((f) => /^f-\d{4}\.jpeg$/.test(f)).length; } catch {                } }
  frameRun.dir = dir; return frameRun;
}

function framesDirOk(dir) { try { assertRunsDirInsideProject(cfg); return fs.lstatSync(dir).isDirectory() && fs.realpathSync(dir) === path.join(fs.realpathSync(cfg.projectDir), path.relative(cfg.projectDir, dir)); } catch { return false; } }
function frameAnswered() {
  if (framePending) inFlight.delete(framePending); framePending = null; clearTimeout(frameTimer);
  if (frameFile) { const f = frameFile; frameFile = null; placeStagedFile(f.staged, path.join(f.realDir, path.basename(f.dest)), { within: LANDING_ROOTS && { root: f.realRoot, anchors: LANDING_ROOTS }, check: () => { if (!framesDirOk(f.dir)) return 'the frames folder is not a plain folder inside the project'; try { fs.lstatSync(f.dest); return 'something is already at that name'; } catch { return null; } } }); }
  if (hold && hold.phase === 'drain' && inFlight.size === 0) startProbe();
}
function frameContextReset() { frameStalled = false; }
function maybeFrame(toolName) {
  if (framesOff || !FRAME_AFTER.has(toolName) || framePending || frameStalled || hold || secretTyped) return;
  const run = runForFrames(); if (!run || run.count >= 240) return;
  const dir = path.join(run.dir, 'frames');
  try { assertRunsDirInsideProject(cfg); fs.mkdirSync(dir, { recursive: false }); } catch (e) { if (!e || e.code !== 'EEXIST') return; }
  if (!framesDirOk(dir)) return;
  const file = path.join(dir, 'f-' + String(++run.count).padStart(4, '0') + '.jpeg');
  try { fs.lstatSync(file); return; } catch {                             }


  let realDir, realRoot; try { realDir = fs.realpathSync(dir); realRoot = fs.realpathSync(cfg.projectDir); } catch { return; }
  frameFile = { staged: path.join(outputDir, crypto.randomBytes(8).toString('hex') + '.jpeg'), dest: file, dir, realDir, realRoot };
  framePending = FRAME_ID + (++frameSeq); inFlight.add(framePending);
  frameTimer = setTimeout(() => { frameStalled = true; log('a step picture did not come back within 5 s: no more pictures in this browser context'); }, 5000); if (frameTimer.unref) frameTimer.unref();
  try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: framePending, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: { type: 'jpeg', filename: frameFile.staged } } }) + '\n'); } catch { frameAnswered(); }
}



const { vet: vetFileArgs, isSecretField, namesSecret, elementTargets, REFUSED_TOOLS } = makeVet({ cfg, sessionRoot: SESSION_ROOT, stagingDir: outputDir, state: { get secretKeySet() { return secretKeySet; }, get secretsUnreadable() { return secretsUnreadable; }, get scripted() { return scripted; }, get secretTyped() { return secretTyped; }, get secretEver() { return secretEver; } } });
function pump(from, to, rewrite, seed = '') {
  let parts = [];
  from.setEncoding('utf8');
  const pass = (line) => { const out = rewrite ? rewrite(line) : line; if (out !== null) to.write(out + '\n'); };
  from.on('data', (chunk) => {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf('\n', start)) >= 0) {
      parts.push(chunk.slice(start, nl));
      const line = parts.length === 1 ? parts[0] : parts.join('');
      parts = []; start = nl + 1;
      pass(line);
    }
    if (start < chunk.length) parts.push(start ? chunk.slice(start) : chunk);
  });
  from.on('end', () => { if (parts.length) pass(parts.join('')); if (to !== process.stdout) to.end(); });
  if (seed) from.emit('data', seed);
}
pump(child.stdout, process.stdout, (line) => {
  const seen = observeAnswer(line); if (seen === true || handedOver !== true) return null;
  let pictureAfter = null; if (actionCalls.size) { const aid = answerId(line); if (aid !== undefined && actionCalls.has(aid)) { const tool = actionCalls.get(aid); actionCalls.delete(aid); if (!line.includes('"isError":true')) pictureAfter = tool; } }
  if (typeof seen === 'string') line = seen;
  try { watchPageUrl(line); } catch {                         }
  line = scrubLineFields(redactSecrets(line));
  if (!secretTyped && secrets.length && line.includes('<secret>') && /<secret>[\w.-]+<\/secret>/.test(line)) { secretTyped = true; secretEver = true; log('a secret value is visible in this browser context (the redaction fired) — treating the context as holding a secret'); }
  if (pictureAfter) { try { maybeFrame(pictureAfter); } catch {                                      } }
  if (!line.includes('"tools"')) return line;
  let msg; try { msg = JSON.parse(line); } catch { return line; }
  if (msg && msg.result && Array.isArray(msg.result.tools)) { msg.result.tools = msg.result.tools.filter((t) => !(t && (REFUSED_TOOLS.has(t.name) || t.name === ALLOW_TOOL || t.name === UP_TOOL || t.name === SHOW_TOOL))); msg.result.tools.push(...allowTool.tools); return JSON.stringify(msg); }
  return line;
});

keepLivePage(served);
const fromClient = (line) => {
  if (allowTool.takeLine(line)) return null;
  if (line.includes('"tools/call"')) keepLivePage([]);
  if (hold) {
    let peek; try { peek = JSON.parse(line); } catch { peek = null; }
    const isRequest = peek && typeof peek === 'object' && !Array.isArray(peek) && typeof peek.method === 'string' && peek.id !== undefined;
    if (isRequest) { if (queuedLines.length >= 256) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: peek.id, error: { code: -32000, message: 'claude-test launcher: too many calls queued behind a pending secret entry; retry' } }) + '\n'); return null; } queuedLines.push(line); return null; }
    if (peek === null || Array.isArray(peek)) { queuedLines.push(line); return null; }
  }
  let msg; try { msg = JSON.parse(line); } catch { return line; }
  if (msg && typeof msg === 'object') for (const k of Object.keys(msg)) if (k.startsWith('__')) { delete msg[k]; msg.__rewritten = true; }
  if (msg && typeof msg.id === 'string' && msg.id.startsWith(PROBE_ID)) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'claude-test launcher: request ids starting with ' + PROBE_ID + ' are reserved' } }) + '\n'); return null; }
  if (msg && msg.method === 'notifications/cancelled' && msg.params && msg.params.requestId !== undefined) {
    const rid = msg.params.requestId; inFlight.delete(rid); closeCalls.delete(rid);
    if (filesByCall.has(rid)) { const e = filesByCall.get(rid); filesByCall.delete(rid); giveUpOnFiles(rid, e.files, null); }
    for (let i = queuedLines.length - 1; i >= 0; i--) { try { const q = JSON.parse(queuedLines[i]); if (q && q.id === rid) queuedLines.splice(i, 1); } catch {            } }
    if (hold && hold.msg.id === rid) { if (hold.phase === 'sent') { hold.cancelled = true; clearTimeout(hold.timer); hold.timer = setTimeout(() => { if (!hold || hold.phase !== 'sent') return; hold.answerLine = null; hold.phase = 'verify'; hold.probeId = PROBE_ID + (++probeSeq); hold.timer = setTimeout(holdTimedOut, 15000); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: hold.probeId, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) + '\n'); }, 5000);                                                                                                                                                     } else if (hold.phase === 'verify') {                                                                                                  } else { log('dropped ' + hold.msg.params.name + ': cancelled by the client before it was forwarded'); clearTimeout(hold.timer); hold = null; while (queuedLines.length && !hold) { const out = fromClient(queuedLines.shift()); if (out !== null) child.stdin.write(out + '\n'); } return null; } }
    else if (hold && hold.phase === 'drain' && inFlight.size === 0) startProbe();
  }
  const actsOffApp = pageOffApp && msg && msg.method === 'tools/call' && msg.params && (ACTS_ON_PAGE.has(msg.params.name) || (msg.params.name === 'browser_handle_dialog' && msg.params.arguments && (msg.params.arguments.accept === true || (typeof msg.params.arguments.promptText === 'string' && msg.params.arguments.promptText !== ''))));
  const problem = vetFileArgs(msg) || (actsOffApp
    ? (pageOffApp.web ? 'the page is on ' + shown(pageOffApp.host, 120) + ', which is outside the app under test (' + cfg.allowedOrigins.join(' ') + '). Pages may load from that host, but the runner does not act there' : 'the page is not on the app (' + shown(pageOffApp.host, 60) + ')') + '. Go back to the app with browser_navigate or browser_navigate_back and carry on'
    : null);
  if (!problem) {
    if (msg && msg.method === 'tools/call' && msg.id !== undefined && !msg.__typesSecret) { inFlight.add(msg.id); if (inFlight.size > 256) { for (const old of inFlight) { if (!(typeof old === 'string' && old.startsWith(PROBE_ID))) { inFlight.delete(old); break; } } }                                                                                                                                                                        if (msg.params && FRAME_AFTER.has(msg.params.name)) { actionCalls.set(msg.id, msg.params.name); if (actionCalls.size > 256) actionCalls.delete(actionCalls.keys().next().value); } }
    if (msg && msg.__files) { filesByCall.set(msg.id, { files: msg.__files, tool: msg.params && msg.params.name }); delete msg.__files; if (filesByCall.size > 256) { const [oldId, old] = filesByCall.entries().next().value; filesByCall.delete(oldId); giveUpOnFiles(oldId, old.files, 'too many calls that save a file were waiting at once, so this file was not saved; ask for it again'); } }
    if (msg && msg.method === 'tools/call' && msg.params && msg.params.name === 'browser_close' && msg.id !== undefined) { closeCalls.add(msg.id); if (closeCalls.size > 64) closeCalls.delete(closeCalls.values().next().value); }
    if (msg && msg.__scripts) { scripted = true; delete msg.__scripts; msg.__rewritten = true; }
    if (msg && msg.__typesSecret) {
      const key = msg.__typesSecret; delete msg.__typesSecret; const targets = msg.__secretTargets || []; const pairs = msg.__secretPairs || []; delete msg.__secretTargets; delete msg.__secretPairs; msg.__rewritten = true;
      hold = { line, msg, key, targets, pairs, phase: 'drain', probeId: null, answerLine: null, timer: setTimeout(holdTimedOut, 15000) };
      if (inFlight.size === 0) startProbe();
      return null;
    }
    if (!(msg && msg.__rewritten)) return line; delete msg.__rewritten; return JSON.stringify(msg);
  }
  log('refused ' + (Array.isArray(msg) ? 'batch' : msg.params && msg.params.name) + ': ' + problem);
  if (Array.isArray(msg)) { for (const m of msg) if (m && m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'Refused by the claude-test launcher: ' + problem + '.' } }) + '\n'); return null; }
  if (msg.id !== undefined) process.stdout.write(refusal(msg.id, problem));
  return null;
};



const INIT_ID = PROBE_ID + 'init';
let onChildInitialized = () => {};
if (!handoff) pump(process.stdin, child.stdin, fromClient);
else {
  giveUp = setTimeout(() => { if (handedOver !== false) return; log('the browser server did not answer initialize within 30 s after the install; keeping the setup stub'); try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {            } } failedStart(new Error('the browser server did not answer within 30 s')); }, 30000);
  onChildInitialized = (line) => {
    if (handedOver !== false) return;
    let ok = false; try { const m = JSON.parse(line); ok = !!(m && m.result && m.result.capabilities); } catch { ok = false; }
    if (!ok) { clearTimeout(giveUp); log('the browser server refused initialize after the install; keeping the setup stub'); try { child.kill('SIGTERM'); } catch {       } failedStart(new Error('the browser server refused initialize')); return; }
    handedOver = true; clearTimeout(giveUp);
    pump(process.stdin, child.stdin, fromClient, handoff.takeStdin());
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
    log('browser tooling loaded into the running server; the client was told the tool list changed');
    handoff.done(null);
  };

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: INIT_ID, method: 'initialize', params: handoff.initializeParams || { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-test-launcher', version: '0' } } }) + '\n');
}
}




function setupNeededServer(why, lazy = null) {
  const ct = fileURLToPath(new URL('./ct.mjs', import.meta.url));
  const gesture = 'in Claude Code type /mcp, select this server (claude-test "browser") and choose Reconnect — "connected" there only means the old copy is still running, not that it reloaded; if Reconnect is not offered, choose Disable and then Enable, or restart Claude Code';
  const ending = ' This server loads the tooling by itself once it is in place, so the NEXT run has the browser tools; no reconnect is needed. Report BLOCKED with exactly this text and end this run — a run that has already started never gains tools. (Only if the next run still shows browser_setup_needed: ' + gesture + '.) Do not use another browser.';

  const whyNow = () => {
    const bad = toolsProblem(); if (bad) return 'the browser tooling folder cannot be used: ' + bad + '.';
    if (!mcpCliPath({ report: true }) || !toolsInstallInfo()) return 'the browser tooling is not installed on this machine. Fix: run  node ' + ct + ' install  in a terminal (it installs the pinned Playwright tooling into ' + toolsDir() + ' with your npm configuration' + (browserSelection(cfg).browser === 'chromium' ? ', and downloads a test browser because this machine has no Google Chrome' : '') + '), OR call the claude_test_install tool of this server, which does the same install from here.';
    if (!browserAvailable()) return 'the Playwright packages are installed but there is no test browser to drive (no Google Chrome in use and no downloaded Chromium). Fix: run  node ' + ct + ' install chromium  in a terminal (it downloads the test browser into ' + browsersDir() + ').';
    return null;
  };

  const remedy = () => {
    if (upgrading) return 'Claude Test browser tools were just installed and this server is loading them right now. Nothing to install: report BLOCKED "browser tooling was just installed — run /claude-test:run again" and end this run; the next run has the browser tools (no /mcp step). Do not use another browser.';
    const w = whyNow();
    if (!w && failures) return 'Claude Test browser tools are installed, but this server could not start them (' + (lastError || 'unknown error') + '). Fix: ' + gesture + '; if that does not help, run  node ' + ct + ' install  again in a terminal. Report BLOCKED with exactly this text and end this run. Do not use another browser.';
    return 'Claude Test browser tools are not usable here: ' + (w || why.text + '.') + ending;
  };
  log('browser tools not usable yet (' + why.text + ') — serving a setup stub (browser_setup_needed, claude_test_install and the allow tool); it loads the tooling by itself once "node ' + ct + ' install" has run (terminal or the install tool) and announces the new tool list');
  const tool = () => ({ name: 'browser_setup_needed', description: remedy(), inputSchema: { type: 'object', properties: {}, additionalProperties: false } });


  const installTool = { name: 'claude_test_install', description: 'Install the Claude Test browser tooling now (the same as running  node ' + ct + ' install  in a terminal, minus the browser download): an npm ci of the pinned Playwright packages (versions and checksums from the lockfile shipped with the plugin) into ' + toolsDir() + ' using your npm configuration; prints the registry it used. Takes up to a minute. On success this server loads the tooling at once: end the current run and run Claude Test again (no /mcp step). A machine without Google Chrome also needs the terminal command once, for the test browser.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  let buf = '';
  let initializeParams = null;
  let upgrading = null;
  let loaded = false; let failures = 0; let lastError = null;
  const onEnd = () => { clearInterval(watch); if (!upgrading) process.exit(0); };

  const upgrade = (cli) => {
    if (loaded) return Promise.resolve(null);
    if (upgrading) return upgrading;
    let settle; const attempt = upgrading = new Promise((resolve) => { settle = resolve; });
    const done = (err) => { if (upgrading === attempt) upgrading = null; if (err) { failures++; lastError = err.message; log('could not load the installed tooling into this server (' + err.message + '); still serving the setup stub' + (failures >= 3 ? ' — giving up here: ' + gesture : '')); } settle(err || null); };
    try { startRealServer(cli, { initializeParams, takeStdin: () => { process.stdin.removeListener('data', onData); process.stdin.removeListener('end', onEnd); clearInterval(watch); loaded = true; const rest = buf; buf = ''; return rest; }, done }); }
    catch (e) { done(e instanceof Error ? e : new Error(String(e))); }
    return attempt;
  };

  const readyCli = () => { const cli = mcpCliPath({ report: true }); return cli && toolsInstallInfo() && !toolsProblem() && browserAvailable() ? cli : null; };
  const watch = setInterval(() => { if (loaded || upgrading || failures >= 3 || !initializeParams) return; const cli = readyCli(); if (!cli) return; log('browser tooling found in ' + toolsDir() + '; loading it into this running server'); upgrade(cli); }, 3000); watch.unref();
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const loadedText = (what) => what + ' The browser tools are now available to new work in this session with no /mcp step: a conversation can go straight on; a background run that started without them cannot gain them — it ends here ("browser tooling was just installed — run /claude-test:run again") and the next run has them.';
  const onData = (chunk) => {
    buf += chunk;
    let nl;
    while (!loaded && (nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (allowTool.take(msg)) continue;
      if (!msg || msg.id === undefined || typeof msg.method !== 'string') continue;
      const id = msg.id;
      const reply = (result) => send({ jsonrpc: '2.0', id, result });
      const text = (t, isError) => reply({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
      if (msg.method === 'initialize') { initializeParams = msg.params && typeof msg.params === 'object' ? msg.params : null; reply({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'claude-test-browser', version: '0-setup' } }); }
      else if (msg.method === 'tools/list') reply({ tools: [tool(), installTool, ...allowTool.tools] });
      else if (msg.method === 'tools/call' && msg.params && msg.params.name === 'claude_test_install') {
        if (upgrading) { upgrading.then((err) => text(err === null ? loadedText('The browser tooling is already installed and was just loaded into this running server.') : 'The browser tooling is installed but this server could not load it (' + err.message + '). Report BLOCKED: "' + gesture + ', then run /claude-test:run again".')); continue; }
        if (mcpCliPath({ report: true }) && toolsInstallInfo() && !toolsProblem() && !browserAvailable()) { text('Nothing for this tool to install — ' + whyNow() + ' This server loads everything by itself a few seconds after that download; then run /claude-test:run again (no /mcp step). END THIS RUN NOW: report BLOCKED with exactly that instruction.'); continue; }
        let r; try { r = installTools(); } catch (e) { r = { ok: false, log: String(e.message || e), registry: null, remedy: 'see the error' }; }
        const tail = String(r.log || '').trim().split('\n').slice(-12).join('\n');
        if (!r.ok) { text('Install failed (registry ' + (r.registry || 'unknown') + '): ' + r.remedy + (r.fallbackAvailable ? ' — from a terminal:  node ' + ct + ' install --allow-fallback' : '') + '\n' + tail, true); continue; }
        const installed = 'Installed the browser tooling into ' + toolsDir() + ' (registry ' + (r.registry || 'unknown') + ', playwright-core ' + (r.playwright || 'pinned') + (r.pinned ? ', checksums verified' : ', NOT checksum-pinned: ' + r.mode) + ')';
        const cli = readyCli();
        if (!cli) { const w = whyNow(); text(installed + (toolsProblem() || !mcpCliPath({ report: true }) ? ', but it cannot be used yet: ' + w : '. One thing is still missing — ' + w + ' This server loads everything by itself a few seconds after that download; then run /claude-test:run again (no /mcp step).') + ' END THIS RUN NOW: report BLOCKED with exactly that instruction.'); continue; }
        upgrade(cli).then((err) => text(err === null ? loadedText(installed + ' and loaded it into this running server.') : installed + ', but this server could not load it here (' + err.message + '). Report BLOCKED: "browser tooling installed; ' + gesture + ', then run /claude-test:run again".'));
      }
      else if (msg.method === 'tools/call') text(remedy(), true);
      else if (msg.method === 'ping') reply({});
      else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    }
  };
  process.stdin.setEncoding('utf8');
  const pending = lazy ? lazy.take() : '';
  if (lazy) initializeParams = lazy.initializeParams;
  process.stdin.on('data', onData);
  process.stdin.on('end', onEnd);
  if (lazy) { send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); if (pending) onData(pending); }
}
}
