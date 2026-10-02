


import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { launcherConfig, readConsent, writeConsent, consentKey, isLocalHost, shown, trustedHome } from './config.mjs';
import { keepLivePage, plainWay, notOwnWay } from './live-page.mjs';
import { livePageFile, openLivePage, openByHand, runOpener } from './open-page.mjs';
import { RUN_ID } from './runs.mjs';

export const ALLOW_TOOL = 'claude_test_allow';
export const UP_TOOL = 'claude_test_app_up';
export const SHOW_TOOL = 'claude_test_show_run';


const WAIT_ARG = '--allow-wait-ms=';
const WAIT_MS = Math.min(Math.max(Number((process.argv.find((a) => a.startsWith(WAIT_ARG)) || '').slice(WAIT_ARG.length)) || Infinity, 50), 10 * 60 * 1000);


const LINE_COLUMNS = 72;
const WHO = 'Claude Test: ';

const MOST_QUESTIONS = 8;

const MOST_ASKED = 32;

const TOOL = {
  name: ALLOW_TOOL,
  description: 'Ask the person whether the Claude Test browser may open ONE address this project is waiting for ("ct.mjs status" lists them under needsConsent, with the exact arguments for this tool). Claude Code shows the person a dialog that opens with that address, goes on to the project folder and ends in a box to tick; only Accept with the box ticked records it, for that project on this machine. Call it from the person\'s own conversation with needsConsent.tool.arguments as status printed them; status names the next address waiting after each yes. After a no it does not ask about that address again in this session, and after eight questions that ended without a yes it asks no more in this session. A background run never calls it.',
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'One entry of needsConsent (its addresses or loadOnlyHosts), spelled as status printed it.' },
      project: { type: 'string', description: 'The project folder, exactly as needsConsent.tool.arguments.project gives it.' },
    },
    required: ['address', 'project'],
    additionalProperties: false,
  },
};

const hostOf = (origin) => origin.replace(/^https?:\/\//, '').replace(/:\d+$/, '');

const columns = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x7e ? 2 : 1), 0);

function folderShown(projectDir) {
  const home = trustedHome(); const short = home && (projectDir === home || projectDir.startsWith(home + path.sep)) ? '~' + projectDir.slice(home.length) : projectDir;
  return shown(short, 4096) === short ? short : null;
}

function question(folder, address, isOrigin) {
  return [
    WHO + address,
    isOrigin ? 'May its test browser open this address?' + (isLocalHost(hostOf(address)) ? '' : ' It is not on this machine.') : 'May pages in its test browser load files from this host?',
    'Project: ' + folder,
    'Tick the box and Accept to record it for this project on this machine.',
  ].join('\n');
}

const tickBox = (address, isOrigin) => ({ type: 'object', properties: { allow: { type: 'boolean', title: isOrigin ? 'Allow this address' : 'Allow this host', description: address } }, required: ['allow'] });

const UP = {
  name: UP_TOOL,
  description: 'Say whether the app under test is listening on this machine right now. The browser helper runs outside Claude Code\'s command sandbox, so it can see localhost when "ct.mjs status" could not (devServer.sandboxed). It tries only the ports of this machine that Claude Test would try for this project (its base URL\'s, or those its files name and a few usual ones), by address: it only connects, and sends no data at all; "up" is about the base URL\'s address when one is set, else about the ports the project\'s own files name. Call it from the person\'s conversation with devServer.check.arguments as status printed them, before a run is started.',
  inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'The project folder, exactly as devServer.check.arguments.project gives it.' } }, required: ['project'], additionalProperties: false },
};
const SHOW = {
  name: SHOW_TOOL,
  description: 'Open the live page of the run that is about to start in the person\'s default browser, so they can watch it. Call it from the person\'s conversation only, right before the runner is started, with livePageShow.arguments exactly as your own "ct.mjs new-run" printed them, nothing else. The page is a local file this browser helper wrote under the plugin\'s data folder. To open it the helper starts ONE program outside Claude Code\'s command sandbox (open, xdg-open or explorer.exe, from a fixed location) with that file\'s path and nothing else from the call (on a Mac, after the first time, -g before it, so it opens behind their work), at most once a run and eight times a session, and notes in the person\'s prefs.json, the first time, that a page has been opened. It opens nothing in CI, over SSH, with no display, with CLAUDE_TEST_NO_OPEN set, or when the person chose "link" ("ct.mjs prefs live-page link"). The answer says what became of it. A background run never calls this tool.',
  inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'livePageShow.arguments.project, as your own "ct.mjs new-run" printed it.' }, run: { type: 'string', description: 'livePageShow.arguments.run: the runId your own "ct.mjs new-run" printed for the run that is about to start.' } }, required: ['project', 'run'], additionalProperties: false },
};

const MOST_PAGES_OPENED = 8;

const listening = (ip, port) => new Promise((resolve) => { const s = net.connect({ host: ip, port }); const done = (yes) => { s.destroy(); resolve(yes); }; s.setTimeout(1000, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false)); });

const MOST_PORTS = 12;


const MOST_PLACES_EVER = 72;

const ipsFor = (host) => (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? [host] : host === '::1' ? ['::1'] : ['127.0.0.1', '::1']);



function ownPorts(cfg) {
  const ports = new Map(); const left = new Set();
  const portOf = (o) => { try { const u = new URL(/^https?:\/\//.test(String(o)) ? String(o) : 'http://' + o); return isLocalHost(u.hostname.replace(/^\[|\]$/g, '')) ? Number(u.port) || (u.protocol === 'https:' ? 443 : 80) : null; } catch { return null; } };
  const usualOnly = new Set((cfg.candidates || []).filter((c) => !c.own).map((c) => c.port));
  const rcNamed = new Set([].concat(cfg.rc && cfg.rc.allowedOrigins ? cfg.rc.allowedOrigins : []).map(portOf));
  for (const o of cfg.wantedOrigins || []) {
    let u; try { u = new URL(/^https?:\/\//.test(o) ? o : 'http://' + o); } catch { continue; }
    const host = u.hostname.replace(/^\[|\]$/g, ''); if (!isLocalHost(host)) continue;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); const named = !usualOnly.has(port) || rcNamed.has(port);
    if (ports.has(port)) { const p = ports.get(port); for (const ip of ipsFor(host)) p.ips.add(ip); p.named = p.named || named; continue; }
    if (ports.size >= MOST_PORTS) { left.add(port); continue; }
    ports.set(port, { address: u.protocol + '//' + (/^127\./.test(host) && host !== '127.0.0.1' ? host : 'localhost') + (u.port ? ':' + u.port : ''), ips: new Set(ipsFor(host)), named });
  }
  return { ports, more: left.size };
}






export function makeAllowTool({ send, settings = launcherConfig, opening = {} }) {


  const idPrefix = ALLOW_TOOL + ':' + crypto.randomBytes(8).toString('hex') + ':';
  let seq = 0;
  let clientAsks = false;
  let built = false;
  let open = null;
  let asked = 0;
  let withoutYes = 0;
  const tried = new Set();
  const declined = new Set();

  const answer = (id, text, isError = false) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } });


  function close(why, answerCall) {
    const o = open; open = null; clearTimeout(o.timer); withoutYes++;
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: o.askId, reason: why } });
    if (answerCall) answer(o.callId, 'Nothing was recorded: ' + why + '. Start no run. The person can type /claude-test again when they want to answer.', true);
  }


  function pick(served, project) {
    const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
    return served.find((c) => project === c.projectDir || project === real(c.projectDir)) || null;
  }


  async function up(msg) {
    const id = msg.id; const args = msg.params.arguments;
    if (!args || typeof args !== 'object' || typeof args.project !== 'string' || !args.project || args.project.length > 4096) return answer(id, 'Pass { project: "<folder>" } exactly as "ct.mjs status" prints it under devServer.check.arguments.', true);
    let served; try { served = settings().served; } catch (e) { return answer(id, 'Could not read the Claude Test settings here: ' + shown(e && e.message ? e.message : e, 300), true); }
    const cfg = pick(served, args.project);
    if (!cfg) return answer(id, 'Nothing was checked: this browser helper does not serve ' + shown(args.project, 300) + '. It serves ' + served.map((c) => shown(c.projectDir, 300)).join(', ') + '.', true);
    keepLivePage([cfg], { unpaced: true });

    let base = null; try { base = cfg.baseOrigin ? new URL(/^https?:\/\//.test(cfg.baseOrigin) ? cfg.baseOrigin : 'http://' + cfg.baseOrigin) : null; } catch {                            }
    if (base && !isLocalHost(base.hostname.replace(/^\[|\]$/g, ''))) return answer(id, JSON.stringify({ up: null, elsewhere: true, note: 'the app\'s base URL, ' + shown(cfg.baseOrigin, 120) + ', is not one of this machine\'s own addresses, so it was not checked: no name is looked up from here' }));
    const basePort = base ? Number(base.port) || (base.protocol === 'https:' ? 443 : 80) : null;

    const { ports, more } = ownPorts(cfg);
    if (!ports.size) return answer(id, JSON.stringify({ up: null, elsewhere: true, note: 'this project names no address on this machine, so there is nothing to check from here' }));
    const fresh = [...ports].flatMap(([port, p]) => [...p.ips].map((ip) => ip + ' ' + port)).filter((place) => !tried.has(place));
    if (tried.size + fresh.length > MOST_PLACES_EVER) return answer(id, 'Nothing was checked: this helper has tried ' + tried.size + ' different addresses and ports of this machine in this session and tries ' + MOST_PLACES_EVER + ' at most. A new Claude Code session looks afresh; ask the person whether their dev server is running.', true);
    for (const place of fresh) tried.add(place);
    const checked = [];
    for (const [port, p] of ports) checked.push({ address: p.address, port, named: p.named, listening: (await Promise.all([...p.ips].map((ip) => listening(ip, port)))).some(Boolean) });
    const mine = checked.filter((c) => (basePort === null ? c.named : c.port === basePort));
    const answering = mine.filter((c) => c.listening).map((c) => c.address);
    const others = checked.filter((c) => c.listening && !mine.includes(c));
    const alsoListening = others.map((c) => c.address);
    const rest = { checked: checked.map((c) => ({ address: c.address, listening: c.listening })), ...(more ? { notChecked: more + ' more ports the project names: one call tries ' + MOST_PORTS } : {}) };
    if (basePort === null && !answering.length && alsoListening.length) return answer(id, JSON.stringify({ up: null, onUsualPorts: alsoListening, ...rest, note: 'something is listening at ' + alsoListening.join(', ') + ', a usual port that this project\'s files do not name: it may be this app or any other program on this machine. Ask the person; "baseUrl: http://localhost:<port>" in .claude-testrc settles it' }));
    answer(id, JSON.stringify({ up: answering.length > 0, answering, ...(alsoListening.length ? { alsoListening } : {}), ...rest, note: answering.length ? 'something is listening there; the runner\'s first page load still decides that it is this app' : 'nothing is listening at ' + (mine.length ? mine : checked).map((c) => c.address).join(', ') + ' on this machine, so the dev server is not running there.' + (alsoListening.length ? ' Also listening, but not ' + (basePort === null ? 'an address the project names' : 'the app\'s address') + ': ' + alsoListening.join(', ') + '.' : '') + ' If the app runs on another port, the baseUrl line in .claude-testrc must name it.' }));
  }




  const startedFor = new Set(); let openerStarts = 0; const showing = new Set(); const cancelled = new Set();
  async function show(msg) {
    const id = msg.id; const args = msg.params.arguments;
    if (!args || typeof args !== 'object' || typeof args.project !== 'string' || !args.project || args.project.length > 4096 || typeof args.run !== 'string' || args.run.length > 32 || !RUN_ID.test(args.run)) return answer(id, 'Nothing was opened: pass livePageShow.arguments exactly as your own "ct.mjs new-run" printed them, { project: "<folder>", run: "<runId>" }.', true);
    let served; try { served = settings().served; } catch (e) { return answer(id, 'Nothing was opened: could not read the Claude Test settings here: ' + shown(e && e.message ? e.message : e, 300), true); }
    const cfg = pick(served, args.project);
    if (!cfg) return answer(id, 'Nothing was opened: this browser helper does not serve ' + shown(args.project, 300) + '. It serves ' + served.map((c) => shown(c.projectDir, 300)).join(', ') + '.', true);
    const key = cfg.projectDir + '\n' + args.run; const file = livePageFile(cfg, args.run); const byHand = openByHand(file, opening.platform);
    const say = (o) => answer(id, JSON.stringify({ ...o, ...(o.opened !== true && !o.linkOnly && !o.noPage && byHand ? { byHand } : {}) }));
    keepLivePage([cfg], { unpaced: true });
    const noPage = (why) => { const notOwn = notOwnWay(path.dirname(file)); return say({ opened: false, noPage: true, why: notOwn ? 'Claude Test opens no page while a folder it keeps its pages in is not yours alone or cannot be read: ' + shown(notOwn, 300) + '. Move or remove that folder and run again; Claude Test makes its folders for you alone' : why }); };
    const uid = 'uid' in opening ? opening.uid : typeof process.getuid === 'function' ? process.getuid() : null;
    const notMine = (f, d) => { const what = uid === null ? null : d.uid !== uid ? ['wrote', 'is owned by another user (uid ' + d.uid + ')'] : (d.mode & 0o022) !== 0 ? ['can change', 'is writable by group or other users (mode ' + (d.mode & 0o777).toString(8) + ')'] : null; return what && 'Claude Test opens no page that another account ' + what[0] + ': ' + shown(f, 300) + ' ' + what[1] + '. Move or remove the folder it is in and run again; Claude Test makes its folders for you alone'; };
    try {
      const d = fs.lstatSync(file); if (!plainWay(path.dirname(file)) || !d.isFile() || d.nlink > 1) return noPage('the page is not an ordinary file, or a folder on the way to it is a link');
      const pageNotMine = notMine(file, d); if (pageNotMine) return noPage(pageNotMine);
      const dataFile = path.join(path.dirname(file), 'live-data.js'); let dd = null; try { dd = fs.lstatSync(dataFile); } catch (e) { if (!e || e.code !== 'ENOENT') return noPage('Claude Test opens no page whose data file could not be read: ' + shown(dataFile, 300) + ' (' + shown(e && e.code ? e.code : 'no code', 40) + '). Move or remove the folder it is in and run again; Claude Test makes its folders for you alone');                                                                         }
      if (dd && (!dd.isFile() || dd.nlink > 1)) return noPage('Claude Test opens no page whose data file is a link or has a second name: ' + shown(dataFile, 300) + '. Move or remove the folder it is in and run again; Claude Test makes its folders for you alone');
      const dataNotMine = dd && notMine(dataFile, dd); if (dataNotMine) return noPage(dataNotMine);
    } catch { return noPage('the browser helper has not written a page for this run (is the run folder there?)'); }
    if (startedFor.has(key)) return say({ opened: false, why: 'this helper has already been asked for this run\'s page' });
    if (openerStarts >= MOST_PAGES_OPENED) return say({ opened: false, tooMany: true, why: 'this helper has opened ' + MOST_PAGES_OPENED + ' pages in this session and opens no more' });
    startedFor.add(key); openerStarts++; showing.add(id);
    let started = false; let r;
    await new Promise((turn) => setImmediate(turn));
    try { r = await openLivePage(cfg, args.run, { ...opening, file, start: (how, o) => { if (cancelled.has(id)) return Promise.resolve({ opened: false, why: 'it could not be started (the call was cancelled first)' }); started = true; return (opening.start || runOpener)(how, o); } }); }
    catch (e) { if (!started) { startedFor.delete(key); openerStarts--; } throw e; }
    finally { showing.delete(id); cancelled.delete(id); }
    if (started && r.opened === false && /could not be started/.test(r.why || '')) started = false;
    if (!started) { startedFor.delete(key); openerStarts--; }
    say({ opened: r.opened, ...(r.firstOpen && r.opened !== false ? { firstOpen: true } : {}), ...(r.meant === false ? { linkOnly: true } : {}), ...(r.opened === null ? { notKnown: true } : {}), ...(r.why ? { why: shown(r.why, 200) } : {}) });
  }

  function begin(msg) {
    const id = msg.id; const args = msg.params.arguments;
    const fail = (text) => answer(id, text, true);
    if (!clientAsks) return fail('Nothing was recorded: this client did not say it can show the person a question (MCP elicitation), and only their answer in such a dialog allows an address. Use Claude Test from a Claude Code terminal session.');
    if (open) return fail('A question about an address is already on the person\'s screen. Wait for their answer; do not ask again.');
    if (!args || typeof args !== 'object' || typeof args.address !== 'string' || !args.address.trim() || args.address.length > 300 || typeof args.project !== 'string' || !args.project || args.project.length > 4096) return fail('Pass { address: "<one address>", project: "<folder>" } exactly as "ct.mjs status" prints them under needsConsent.tool.arguments.');
    let served; try { served = settings().served; } catch (e) { return fail('Could not read the Claude Test settings here: ' + shown(e && e.message ? e.message : e, 300)); }
    const cfg = pick(served, args.project);
    if (!cfg) return fail('Nothing was asked: this browser helper does not serve ' + shown(args.project, 300) + '. It serves ' + served.map((c) => shown(c.projectDir, 300)).join(', ') + '. Pass needsConsent.tool.arguments as "ct.mjs status" printed them there.');
    const rec = readConsent(cfg.projectDir);
    if (rec.refused) return fail('Nothing was asked: ' + shown(rec.refused, 600));
    const k = consentKey(args.address); const h = args.address.trim().toLowerCase();
    const isOrigin = cfg.pendingOrigins.includes(k);
    if (!isOrigin && !cfg.pendingHosts.some((p) => p.toLowerCase() === h)) {
      if (rec.origins.has(k) || rec.hosts.has(h)) return answer(id, JSON.stringify({ ok: true, alreadyAllowed: [shown(args.address, 120)], file: rec.file, note: 'nothing to ask: already allowed for this project on this machine' }));
      return fail('Nothing was asked and nothing was changed: this project is not waiting for ' + shown(args.address, 120) + ' ("ct.mjs status" lists what it is waiting for, under needsConsent).');
    }
    const address = isOrigin ? k : h; const folder = folderShown(cfg.projectDir);

    if (shown(address, 4096) !== address || columns(WHO + address) > LINE_COLUMNS) return fail('Nothing was asked: ' + shown(address, 120) + ' cannot be shown whole in the question (it takes more than ' + (LINE_COLUMNS - WHO.length) + ' columns), so it cannot be allowed. Tell the person.');
    if (folder === null || columns('Project: ' + folder) > LINE_COLUMNS) return fail('Nothing was asked: the project folder\'s path cannot be shown whole in the question (it takes more than ' + (LINE_COLUMNS - 9) + ' columns, or holds a character that cannot be shown or a run of spaces), so nothing can be allowed for it. Tell the person; the project would have to sit at a shorter or plainer path.');
    if (declined.has(cfg.projectDir + '\n' + address)) return fail('Nothing was asked: the person already said no to ' + address + ' in this session, and that no stands. Do not ask again. If they change their mind, a new Claude Code session asks afresh.');
    if (withoutYes >= MOST_QUESTIONS) return fail('Nothing was asked: ' + withoutYes + ' questions in this session ended without a yes, so this helper asks no more in this session. What still waits can be asked about in a new Claude Code session.');
    if (asked >= MOST_ASKED) return fail('Nothing was asked: the person has been asked ' + asked + ' questions in this session, the most this helper asks. What still waits can be asked about in a new Claude Code session.');
    asked++;
    const askId = idPrefix + (++seq);
    const timer = setTimeout(() => { if (open && open.askId === askId) close('the person did not answer in time', true); }, WAIT_MS); timer.unref();
    send({ jsonrpc: '2.0', id: askId, method: 'elicitation/create', params: { message: question(folder, address, isOrigin), requestedSchema: tickBox(address, isOrigin) } });
    open = { askId, callId: id, projectDir: cfg.projectDir, address, isOrigin, file: rec.file, timer };
  }


  function settle(msg) {
    const o = open; open = null; clearTimeout(o.timer);
    const said = !('error' in msg) && msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result) ? msg.result.action : undefined;
    if (said === 'decline') declined.add(o.projectDir + '\n' + o.address);
    if (said !== 'accept') { withoutYes++; return answer(o.callId, 'Nothing was recorded: ' + (said === 'decline' ? 'the person declined. That is their no' : said === 'cancel' ? 'the question was closed without an answer' : 'the question could not be put to the person') + '. Start no run, and record nothing any other way.', true); }
    const filled = msg.result.content;
    if (!filled || typeof filled !== 'object' || Array.isArray(filled) || filled.allow !== true) { withoutYes++; return answer(o.callId, 'Nothing was recorded: the answer came back without the box ticked, and only a ticked box is a yes. Start no run, and record nothing any other way.', true); }
    let why; try { why = writeConsent(o.projectDir, o.isOrigin ? { origins: [o.address] } : { hosts: [o.address] }); } catch (e) { why = String(e && e.message ? e.message : e); }
    if (why) { withoutYes++; return answer(o.callId, 'The person accepted, but the record could not be written: ' + shown(why, 600), true); }
    const when = !o.isOrigin ? 'a load-only host applies from the next run' : built ? 'this session\'s test browser started before this yes: restart Claude Code once for it to open ' + o.address : 'the test browser starts with it at its next use in this session';
    answer(o.callId, JSON.stringify({ ok: true, allowed: [o.address], file: o.file, note: 'for this project on this machine only; ' + when + '. Run "ct.mjs status" again: it names the next address waiting, if any' }));
  }

  function take(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (msg.method === 'initialize') { const caps = msg.params && typeof msg.params === 'object' ? msg.params.capabilities : null; clientAsks = !!(caps && typeof caps === 'object' && caps.elicitation && typeof caps.elicitation === 'object'); return false; }
    if (msg.method === 'tools/call' && msg.id !== undefined && msg.params && typeof msg.params === 'object' && msg.params.name === ALLOW_TOOL) { try { begin(msg); } catch (e) { answer(msg.id, 'Nothing was recorded: ' + shown(e && e.message ? e.message : e, 300), true); } return true; }
    if (msg.method === 'tools/call' && msg.id !== undefined && msg.params && typeof msg.params === 'object' && msg.params.name === UP_TOOL) { up(msg).catch((e) => answer(msg.id, 'Nothing was checked: ' + shown(e && e.message ? e.message : e, 300), true)); return true; }
    if (msg.method === 'tools/call' && msg.id !== undefined && msg.params && typeof msg.params === 'object' && msg.params.name === SHOW_TOOL) { show(msg).catch((e) => answer(msg.id, 'Nothing was opened: ' + shown(e && e.message ? e.message : e, 300), true)); return true; }
    if (msg.method === 'notifications/cancelled' && msg.params && showing.has(msg.params.requestId)) { cancelled.add(msg.params.requestId); return true; }
    if (msg.method === 'notifications/cancelled' && open && msg.params && msg.params.requestId === open.callId) { close('the call was cancelled', false); return true; }
    if (typeof msg.method !== 'string' && typeof msg.id === 'string' && msg.id.startsWith(idPrefix)) { if (open && msg.id === open.askId) settle(msg); return true; }
    return false;
  }
  function takeLine(line) {
    if (!open && !showing.size && !line.includes(ALLOW_TOOL) && !line.includes(UP_TOOL) && !line.includes(SHOW_TOOL) && !line.includes('"initialize"')) return false;
    let msg; try { msg = JSON.parse(line); } catch { return false; }
    return take(msg);
  }
  return { tools: [TOOL, UP, SHOW], take, takeLine, fenceBuilt() { built = true; } };
}
