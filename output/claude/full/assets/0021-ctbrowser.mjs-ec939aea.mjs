#!/usr/bin/env node




















import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, originAllowed, ensureRunsDir, resolveProjectDir, projectSlug, runsPathProblem, envPathOutsideProject, sanitizeBrowserEnv, shownText } from './lib/config.mjs';
import { importPlaywright, findChrome, toolsDir, cacheDir, useOwnBrowsersIfPresent, toolsProblem } from './lib/tools.mjs';
import { stateHasContent, ensureAuthFile } from './lib/signin.mjs';
import { UDP_FENCE_ARGS } from './lib/guard.mjs';

process.stderr.write('ctbrowser.mjs is not available: specs run only through the Claude Test browser tools, which are held to the allowed addresses. Nothing was started.\n');
process.exit(2);

const argv = process.argv.slice(2);


const selfPath = fileURLToPath(import.meta.url);
const ctPath = path.join(path.dirname(selfPath), 'ct.mjs');
const cfg = loadConfig(resolveProjectDir());
sanitizeBrowserEnv();





const stateDir = path.join(cacheDir(), 'run', projectSlug(cfg.projectDir));
useOwnBrowsersIfPresent();
const stateFile = path.join(stateDir, 'ctbrowser.json');
const IDLE_MS = 15 * 60 * 1000;

function usage() {
  process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   node')).map((l) => l.slice(5)).join('\n') + '\n');
}


async function daemon() {
  const found = await importPlaywright();
  if (!found) { fs.writeFileSync(stateFile + '.err', 'playwright-core not found. Run: node ' + ctPath + ' install\n'); process.exit(1); }
  const { chromium } = found.pw;
  const exe = envPathOutsideProject('CLAUDE_TEST_BROWSER_EXECUTABLE');
  const launchOpts = { headless: process.env.CLAUDE_TEST_HEADED !== '1', args: [...((typeof process.getuid === 'function' && process.getuid() === 0) ? ['--no-sandbox'] : []), ...UDP_FENCE_ARGS] };
  const chromePath = exe || process.env.CLAUDE_TEST_BROWSER || cfg.browser ? null : findChrome();
  if (exe) launchOpts.executablePath = exe; else if (chromePath) launchOpts.executablePath = chromePath; else if ((process.env.CLAUDE_TEST_BROWSER || cfg.browser) === 'chrome') launchOpts.channel = 'chrome'; else if ((process.env.CLAUDE_TEST_BROWSER || cfg.browser) === 'msedge') launchOpts.channel = 'msedge';
  let browser;
  try { browser = await chromium.launch(launchOpts); }
  catch (e) { fs.writeFileSync(stateFile + '.err', 'could not launch a browser: ' + e.message.split('\n')[0] + '\nRun: node ' + ctPath + ' install chromium\n'); process.exit(1); }




  const ctxOpts = { viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' };
  let context; let sessionAttached = false;
  if (cfg.storageState.inUse && cfg.signInApplies) {
    try {
      const r = ensureAuthFile(cfg.storageState.path, { privateFolder: true, baseUrl: cfg.baseUrl || null, projectDir: cfg.projectDir });
      if (!r.usable) process.stderr.write('[claude-test] saved session not used: ' + r.reason + '\n');
      else { context = await browser.newContext({ ...ctxOpts, storageState: cfg.storageState.path }); sessionAttached = stateHasContent(cfg.storageState.path); }
    } catch (e) { process.stderr.write('[claude-test] saved session not loaded (' + String(e.message).split('\n')[0] + ')\n'); }
  }
  if (!context) context = await browser.newContext(ctxOpts);
  await context.route('**', (route) => originAllowed(cfg, route.request().url()) ? route.continue() : route.abort('blockedbyclient'));

  if (typeof context.routeWebSocket === 'function') await context.routeWebSocket(/.*/, (ws) => { const u = ws.url().replace(/^ws(s?):/, 'http$1:'); if (originAllowed(cfg, u)) ws.connectToServer(); else ws.close({ code: 1008, reason: 'origin not allowed' }); });
  const page = await context.newPage();
  const consoleLog = [];
  page.on('console', (m) => { consoleLog.push({ type: m.type(), text: m.text().slice(0, 500) }); if (consoleLog.length > 200) consoleLog.shift(); });
  page.on('pageerror', (e) => consoleLog.push({ type: 'pageerror', text: String(e.message).slice(0, 500) }));
  const token = crypto.randomBytes(24).toString('hex');
  let idleTimer;
  const shutdown = async () => { try { fs.unlinkSync(stateFile); } catch {} try { await browser.close(); } catch {} process.exit(0); };
  const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(shutdown, IDLE_MS); };

  const resolveUrl = (target) => {
    if (!cfg.baseUrl && !/^https?:\/\//.test(target || '')) throw new Error('no baseUrl in .claude-testrc; pass a full allowed URL or configure baseUrl');
    const u = new URL(target || '', cfg.baseUrl || undefined);
    if (!originAllowed(cfg, u.href)) throw new Error('refusing to open ' + u.origin + ': not in the allowed origins (' + cfg.allowedOrigins.join(' ') + ')');
    return u.href;
  };
  const within = (file) => {
    const abs = path.resolve(cfg.projectDir, file);
    const problem = runsPathProblem(cfg, abs) || (fs.mkdirSync(path.dirname(abs), { recursive: true }), runsPathProblem(cfg, abs));
    if (problem) throw new Error('screenshot ' + file + ' ' + problem);
    return abs;
  };


  const checkLanded = async () => {
    const u = page.url();
    if (/^(about:blank|chrome-error:)/.test(u) || originAllowed(cfg, u)) return;
    await page.goto('about:blank').catch(() => {});
    throw new Error('landed on ' + u + ' which is outside the allowed origins (a redirect?) — went back to a blank page');
  };


  const onAllowedPage = async () => { const u = page.url(); if (/^(about:blank|chrome-error:)/.test(u) || originAllowed(cfg, u)) return; await page.goto('about:blank').catch(() => {}); throw new Error('the page was on ' + u + ', outside the allowed origins — went back to a blank page; open an allowed page first'); };
  const need = (a, n, usage) => { if (a.length < n || a.slice(0, n).some((x) => !x)) throw new Error('usage: ' + usage); };
  const commands = {
    async open(a) { await page.goto(resolveUrl(a[0] || ''), { waitUntil: 'domcontentloaded' }); await checkLanded(); return page.url() + ' — ' + (await page.title()); },
    async goto(a) { need(a, 1, 'goto <path>'); return commands.open(a); },
    async snapshot(a) { await onAllowedPage(); return await page.locator(a[0] || 'body').first().ariaSnapshot(); },
    async click(a) { need(a, 1, 'click <selector>'); await page.locator(a[0]).first().click({ timeout: 8000 }); await page.waitForTimeout(300); await checkLanded(); return 'clicked ' + a[0] + ' → ' + page.url(); },
    async fill(a) { need(a, 1, 'fill <selector> <text>'); await onAllowedPage(); await page.locator(a[0]).first().fill(a.slice(1).join(' '), { timeout: 8000 }); return 'filled ' + a[0]; },
    async press(a) { need(a, 1, 'press <key> [selector]'); if (a[1]) await page.locator(a[1]).first().press(a[0], { timeout: 8000 }); else await page.keyboard.press(a[0]); await page.waitForTimeout(300); await checkLanded(); return 'pressed ' + a[0]; },
    async select(a) { need(a, 2, 'select <selector> <value>'); await onAllowedPage(); await page.locator(a[0]).first().selectOption(a.slice(1).join(' '), { timeout: 8000 }); await page.waitForTimeout(300); await checkLanded(); return 'selected'; },
    async 'wait-text'(a) { need(a, 1, 'wait-text <text> [seconds]'); await onAllowedPage(); const s = Math.min(Number(a[1]) || 10, 120); await page.getByText(a[0]).first().waitFor({ state: 'visible', timeout: s * 1000 }); return 'visible: ' + a[0]; },
    async 'wait-gone'(a) { need(a, 1, 'wait-gone <text> [seconds]'); await onAllowedPage(); const s = Math.min(Number(a[1]) || 10, 120); await page.getByText(a[0]).first().waitFor({ state: 'hidden', timeout: s * 1000 }); return 'gone: ' + a[0]; },
    async text(a) { need(a, 1, 'text <selector>'); await onAllowedPage(); return await page.locator(a[0]).first().innerText({ timeout: 8000 }); },
    async eval(a) { need(a, 1, 'eval <js expression>'); if (sessionAttached) throw new Error('eval is off while a saved sign-in session is attached to this browser (page script could read the session back); check text with snapshot/find instead'); await onAllowedPage(); const r = await page.evaluate('(' + a.join(' ') + ')'); return JSON.stringify(r, null, 2) ?? 'undefined'; },
    async url() { return page.url(); },
    async title() { return await page.title(); },
    async console(a) { const rows = a.includes('--errors') ? consoleLog.filter((m) => m.type === 'error' || m.type === 'pageerror') : consoleLog; return rows.length ? rows.map((m) => m.type + ': ' + m.text).join('\n') : '(none)'; },
    async screenshot(a) { const file = a.find((x) => !x.startsWith('--')); if (!file) throw new Error('screenshot <file>'); await onAllowedPage(); const abs = within(file); const buf = await page.screenshot({ fullPage: a.includes('--full') }); const tmp = abs + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, buf, { flag: 'wx' }); fs.renameSync(tmp, abs); return 'saved ' + path.relative(cfg.projectDir, abs); },
    async close() { setTimeout(shutdown, 50); return 'closed'; },
  };

  const server = http.createServer((req, res) => {



    if (req.method !== 'POST' || req.headers.origin !== undefined || !/^application\/json\b/i.test(req.headers['content-type'] || '')) { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }


      const nonce = String(msg.nonce ?? ''); if (!/^[0-9a-f]{32}$/.test(nonce)) { res.writeHead(403).end(); return; }
      const given = Buffer.from(String(msg.mac ?? ''));
      const want = Buffer.from(crypto.createHmac('sha256', token).update('request:' + nonce + '\n' + String(msg.cmd) + '\n' + JSON.stringify(msg.args || [])).digest('hex'));
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { res.writeHead(403).end(); return; }
      const proof = crypto.createHmac('sha256', token).update('reply:' + nonce).digest('hex');
      bump();
      const fn = commands[msg.cmd];
      if (!fn) { res.end(JSON.stringify({ ok: false, proof, out: 'unknown command ' + msg.cmd + '. Try: help' })); return; }
      try { res.end(JSON.stringify({ ok: true, proof, out: await fn(msg.args || []) })); }
      catch (e) { res.end(JSON.stringify({ ok: false, proof, out: String(e.message).split('\n').slice(0, 6).join('\n') })); }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    try { ensureRunsDir(cfg); } catch (e) { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.err', e.message + '\n'); process.exit(1); }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify({ port: server.address().port, token, pid: process.pid, playwright: found.from }), { mode: 0o600 });
    bump();
  });
}


function readState() { try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); process.kill(s.pid, 0); return s; } catch { return null; } }

async function ensureDaemon() {
  let s = readState();
  if (s) return s;
  try { ensureRunsDir(cfg); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  { const why = toolsProblem(); if (why) { process.stderr.write('browser daemon not started: the tools folder is not private — ' + why + '\n'); process.exit(2); } }
  const lock = stateFile + '.lock';
  let mine = false;
  try { fs.closeSync(fs.openSync(lock, 'wx')); mine = true; } catch { try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { fs.unlinkSync(lock); fs.closeSync(fs.openSync(lock, 'wx')); mine = true; } } catch {                                   } }
  if (mine) {
    try { fs.unlinkSync(stateFile + '.err'); } catch {}
    const child = spawn(process.execPath, [selfPath, '--daemon'], { cwd: cfg.projectDir, detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_TEST_PROJECT_DIR: cfg.projectDir } });
    child.unref();
  }
  const cleanup = () => { if (mine) { try { fs.unlinkSync(lock); } catch {} } };
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if ((s = readState())) { cleanup(); return s; }
    if (fs.existsSync(stateFile + '.err')) { const msg = fs.readFileSync(stateFile + '.err', 'utf8'); cleanup(); try { fs.unlinkSync(stateFile + '.err'); } catch {} process.stderr.write(msg); process.exit(1); }
  }
  cleanup();
  process.stderr.write('browser daemon did not start within 30 s\n'); process.exit(1);
}

function send(s, cmd, args) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(16).toString('hex'); const hm = (label, rest = '') => crypto.createHmac('sha256', String(s.token)).update(label + nonce + rest).digest('hex');
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', timeout: 130000, headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode)); let r; try { r = JSON.parse(b); } catch { return reject(new Error('bad reply')); } const got = Buffer.from(String(r && r.proof || '')); const exp = Buffer.from(hm('reply:')); if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return reject(new Error('the program on that port is not this project\'s browser daemon')); resolve(r); }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.end(JSON.stringify({ nonce, mac: hm('request:', '\n' + String(cmd) + '\n' + JSON.stringify(args || [])), cmd, args }));
  });
}

if (argv[0] === '--daemon') { daemon(); }
else {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help') { usage(); process.exit(0); }
  if (cmd === 'close' && !readState()) { console.log('not running'); process.exit(0); }
  let s = await ensureDaemon();
  let r;
  try { r = await send(s, cmd, argv.slice(1)); }
  catch (e) {

    process.stderr.write('browser daemon unreachable (' + e.message + '); starting a new one — the page starts blank again\n');
    try { fs.unlinkSync(stateFile); } catch {}
    s = await ensureDaemon();
    try { r = await send(s, cmd, argv.slice(1)); }
    catch (e2) { process.stderr.write('browser daemon unreachable: ' + e2.message + '\n'); process.exit(1); }
  }
  process.stdout.write(shownText(String(r.out)) + '\n');
  process.exit(r.ok ? 0 : 1);
}
