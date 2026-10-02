


import { isLocalHost } from './config.mjs';


export function yamlScalar(s) { const t = String(s).trim(); if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } } return t; }





export function parseSnapLine(line) {
  const m = line.match(/^( *)- (.*)$/); if (!m) return null;
  let key; let value = ''; const body = m[2];
  if (body.startsWith("'")) { let i = 1, out = ''; for (;;) { const j = body.indexOf("'", i); if (j < 0) return null; if (body[j + 1] === "'") { out += body.slice(i, j) + "'"; i = j + 2; continue; } out += body.slice(i, j); const rest = body.slice(j + 1); if (rest !== '' && rest !== ':' && !rest.startsWith(': ')) return null; key = out; value = rest.startsWith(': ') ? rest.slice(2) : ''; break; } }
  else { const c = body.search(/: |:$/); key = c >= 0 ? body.slice(0, c) : body; value = c >= 0 && body.startsWith(': ', c) ? body.slice(c + 2) : ''; }
  const k = key.match(/^([a-z][a-zA-Z]*)(?: "(?:[^"\\]|\\.)*")?((?: \[[a-zA-Z][\w-]*(?:=[^\]\s\[]*)?\])*)$/); if (!k) return null;
  const ref = (k[2].match(/ \[ref=((?:f\d+)?e\d+)\]/) || [null, null])[1];
  const active = / \[active\]/.test(k[2]);
  return { indent: m[1].length, role: k[1].toLowerCase(), ref, value, active };
}


export function makeHoldsValueOf(secrets) {
  return function holdsValueOf(fieldValue, key, { appended = false } = {}) { const raw = (secrets.find(([k]) => k === key) || [null, null, null])[2]; if (raw == null) return false; const norm = (s) => String(s).trim().replace(/\s+/g, ' '); const plain = norm(String(fieldValue).replace(/<secret>([\w.-]+)<\/secret>/g, (m, k) => { const s = secrets.find(([kk]) => kk === k); return s ? s[2] : m; })); const want = norm(raw); return want !== '' && (plain === want || (appended && plain.endsWith(want))); }
}





export function judgeProbe(text, { secretOrigins, targets, pairs, holdsValueOf }) {
  let origin = null; let why = 'the page\'s address could not be confirmed'; let alreadyHolds = []; let valueAtProbe = {};
  try {
    const sections = ('\n' + text).split(/\n### /).slice(1);
    const titles = sections.map((s) => s.split('\n')[0]);
    const tabs = sections.find((s) => s.startsWith('Open tabs\n'));
    const page = sections.find((s) => s.startsWith('Page\n'));
    const snap = sections.find((s) => s.startsWith('Snapshot\n'));
    const urlLine = page ? page.split('\n')[1] || '' : '';
    const u = (urlLine.match(/^- Page URL: (\S+)$/) || [null, ''])[1];
    const head = titles.slice(0, titles.indexOf('Snapshot') >= 0 ? titles.indexOf('Snapshot') + 1 : titles.length);
    const odd = head.find((t, i) => head.indexOf(t) !== i || !['Open tabs', 'Page', 'Snapshot', 'Ran Playwright code'].includes(t));
    if (odd !== undefined) why = 'the page\'s state could not be read cleanly (a "' + odd.slice(0, 40) + '" section before the snapshot — an open dialog shows up this way: handle it with browser_handle_dialog, then try again)';
    else if (tabs && tabs.split('\n').filter((l) => /^- \d+: /.test(l)).length > 1) why = 'more than one tab is open — a secret is typed only with a single tab (another tab could hold a handle to this page); close the others with browser_tabs first';
    else if (!page) why = 'no page is open yet — navigate to the app first';
    else if (!snap || !/^Snapshot\n```yaml\n/.test(snap)) why = 'the page snapshot is missing from the browser\'s answer — take a browser_snapshot, then try again';
    else {
      try { origin = /^https?:\/\//.test(u) ? new URL(u).origin : null; } catch { origin = null; }
      if (!origin) why = /^(about:|chrome-error:|$)/.test(u) ? 'no page is open yet — navigate to the app first' : 'the page\'s address could not be confirmed — refused to be safe';
      else if (secretOrigins.has(origin)) {



        const rows = snap.replace(/^Snapshot\n```yaml\n/, '').split('\n').map(parseSnapLine);
        const top = rows.find((r) => r && r.indent === 0 && r.ref);
        const mainPrefix = top ? (top.ref.match(/^f\d+/) || [''])[0] : null;
        const rowOf = (ref) => rows.find((r) => r && r.ref === ref) || null;
        const snapLines = snap.replace(/^Snapshot\n```yaml\n/, '').split('\n');
        const valueAt = (t) => { const i = rows.findIndex((r) => r && r.ref === t); if (i < 0) return null; let v = yamlScalar(rows[i].value); for (let j = i + 1; j < snapLines.length; j++) { const ind = (snapLines[j].match(/^ */) || [''])[0].length; if (snapLines[j].trim() === '') continue; if (ind <= rows[i].indent) break; const c = snapLines[j].match(/^ *- text: (.*)$/); if (c && ind === rows[i].indent + 2) v += (v ? ' ' : '') + yamlScalar(c[1]); } return v; };
        valueAtProbe = Object.fromEntries(pairs.map(([t]) => [t, valueAt(t)]));
        alreadyHolds = pairs.filter(([t, k]) => { const v = valueAt(t); return v !== null && holdsValueOf(v, k); });
        const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
        const stale = targets.find((t) => !rowOf(t));
        const wrong = targets.find((t) => (t.match(/^f\d+/) || [''])[0] !== mainPrefix);
        const notField = targets.find((t) => rowOf(t) && !FIELD_ROLES.has(rowOf(t).role));
        if (mainPrefix === null) { origin = null; why = 'the page has no element to type into yet'; }
        else if (stale !== undefined) { origin = null; why = 'the element ' + stale + ' is not in the current page snapshot (a ref from an earlier page, or a line the launcher cannot read) — take a new browser_snapshot and use the field\'s ref from it'; }
        else if (wrong !== undefined) { origin = null; why = 'the element ' + wrong + ' is inside a frame, not in the page on ' + u.replace(/[?#].*$/, '') + ' itself — a secret goes only into the page\'s own fields'; }
        else if (notField !== undefined) { origin = null; why = 'the element ' + notField + ' is a ' + rowOf(notField).role + ', not a text field — a secret goes only into a textbox / searchbox / combobox, by its current ref'; }
      }
    }
  } catch { origin = null; }
  return { origin, why, allowed: !!(origin && secretOrigins.has(origin)), alreadyHolds, valueAtProbe };
}



export const isLoopbackOriginEntry = (o) => { const m = String(o).match(/^(?:https?:\/\/)?(\[[^\]]+\]|[^/:]+)(:\d+|:\*)?$/i); return !!m && isLocalHost(m[1]); };

export const bypassOf = (o) => { const m = String(o).match(/^(?:(https?):\/\/)?(\[[^\]]+\]|[^/:]+)(?::(\d+|\*))?$/i); if (!m) return []; const host = m[2]; if (m[3] === '*') return [host]; if (m[3]) return [host + ':' + m[3]]; return m[1] === 'https' ? [host + ':443'] : m[1] === 'http' ? [host + ':80'] : [host + ':80', host + ':443']; };








export function resolverPins(list) {
  const rules = new Map();
  for (const e of list || []) {
    const name = e && typeof e.name === 'string' ? e.name.toLowerCase() : ''; const address = e && typeof e.address === 'string' ? e.address : '';
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name) || name.includes('..') || rules.has(name)) continue;
    const v4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every((n) => Number(n) <= 255); const v6 = !v4 && /^[0-9a-f:]{2,39}$/i.test(address) && address.includes(':');
    if (!v4 && !v6) continue;
    rules.set(name, 'MAP ' + name + ' ' + (v6 ? '[' + address + ']' : address)); if (rules.size >= 50) break;
  }
  return [...rules.values()].join(',');
}
export const UDP_FENCE_ARGS = ['--webrtc-ip-handling-policy=disable_non_proxied_udp', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'];
export function fencePlan(allowedOrigins, chromiumFamily) {
  const deadProxy = !!chromiumFamily && allowedOrigins.every(isLoopbackOriginEntry);
  return { deadProxy, bypass: deadProxy ? ['<-loopback>', ...new Set(allowedOrigins.flatMap(bypassOf))] : [], remote: allowedOrigins.filter((o) => !isLoopbackOriginEntry(o)), chromiumArgs: deadProxy ? UDP_FENCE_ARGS : [] };
}

export function toolTextOf(line) { try { const m = JSON.parse(line); return m && m.result && Array.isArray(m.result.content) ? m.result.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : ''; } catch { return ''; } }





export function pageUrlFromToolText(text) {
  const sections = ('\n' + String(text)).split(/\n### /).slice(1); const i = sections.findIndex((s) => s.startsWith('Page\n')); if (i < 0) return null;
  const urlOf = (s) => { const m = s.split('\n').slice(1).map((l) => l.match(/^- Page URL: (\S+)$/)).find(Boolean); return m ? m[1] : null; };
  const clean = sections.slice(0, i).every((s) => /^(Ran Playwright code|Open tabs)\n/.test(s) || s === 'Ran Playwright code' || s === 'Open tabs');
  const urls = [...new Set(sections.filter((s) => s.startsWith('Page\n')).map(urlOf).filter(Boolean))]; if (!urls.length) return null;
  return { url: urls[0], clean, urls };
}

export function guardScript(cfg, { sockets = true } = {}) {


  if (!sockets) return '(() => { try {\n' + RTC_OFF + '} catch (e) {} })();\n';
  return '(() => { try {\n' +
    'const allowed = ' + JSON.stringify(cfg.allowedOrigins) + ';\n' +
    'const originOk = (u) => { let x; try { x = new URL(u, location.href); } catch { return false; } const proto = x.protocol === "wss:" ? "https:" : x.protocol === "ws:" ? "http:" : x.protocol; if (proto !== "http:" && proto !== "https:") return false; const host = x.hostname.toLowerCase(); const port = x.port; const origin = proto + "//" + x.host.toLowerCase();\n' +
    '  for (const o of allowed) { if (/^https?:\\/\\//.test(o)) { if (origin === o.toLowerCase() || origin === new URL(o).origin.toLowerCase()) return true; continue; } const mm = o.match(/^(\\[[^\\]]+\\]|[^:]+)(?::(\\d+))?$/); if (mm && host === mm[1].toLowerCase() && (mm[2] ? port === mm[2] : port === "")) return true; }\n' +
    '  return false; };\n' +
    'const refuse = (what, u) => { throw new DOMException("Claude Test: " + what + " to " + String(u).slice(0, 200) + " is outside the allowed origins", "SecurityError"); };\n' +
    'const wrap = (name) => { const C = globalThis[name]; if (typeof C !== "function") return; const P = new Proxy(C, { construct(t, args, nt) { if (!originOk(args[0])) refuse(name, args[0]); return Reflect.construct(t, args, nt); } }); try { Object.defineProperty(C.prototype, "constructor", { value: P, writable: true, configurable: true }); } catch (e) {} try { Object.defineProperty(globalThis, name, { value: P, writable: true, configurable: true }); } catch (e) { globalThis[name] = P; } };\n' +
    'wrap("WebSocket"); wrap("WebSocketStream"); wrap("WebTransport");\n' +
    RTC_OFF +
    '} catch (e) {} })();\n';
}

const RTC_OFF = 'for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) { try { delete globalThis[name]; } catch (e) {} if (name in globalThis) { try { Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true }); } catch (e) {} } }\n';



export function secretVariants(v) {
  const esc1 = JSON.stringify(v).slice(1, -1), esc2 = JSON.stringify(esc1).slice(1, -1), norm = v.trim().replace(/\s+/g, ' ');
  return [...new Set([v, esc1, esc2, norm, JSON.stringify(norm).slice(1, -1), JSON.stringify(JSON.stringify(norm).slice(1, -1)).slice(1, -1), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, '+'), new URLSearchParams([['v', v]]).toString().slice(2)])].filter((x) => x.length >= 6).sort((a, b) => b.length - a.length);
}



export function makeRedactor(secrets) {
  let nestedFixups = null;
  function buildNestedFixups() { nestedFixups = []; const encs = [(s) => s, (s) => JSON.stringify(s).slice(1, -1), (s) => JSON.stringify(JSON.stringify(s).slice(1, -1)).slice(1, -1), (s) => encodeURIComponent(s), (s) => new URLSearchParams([['v', s]]).toString().slice(2)]; for (const [ky, , ry] of secrets) for (const [kx, , rx] of secrets) { if (kx === ky || !rx || !ry || rx === ry || !String(ry).includes(rx)) continue; for (const e of encs) { const parts = String(ry).split(rx).map(e); nestedFixups.push([parts.join('<secret>' + kx + '</secret>'), '<secret>' + ky + '</secret>']); } } nestedFixups = [...new Map(nestedFixups).entries()].filter(([p, r]) => p !== r).sort((a, b) => b[0].length - a[0].length); }
  let splitVariants = null;
  function buildSplitVariants() { splitVariants = []; const esc = (s) => JSON.stringify(s).slice(1, -1), enc = (s) => encodeURIComponent(s), form = (s) => new URLSearchParams([['v', s]]).toString().slice(2); for (const [k, , raw] of secrets) { const v = String(raw || ''); if (v.length < 6) continue; const nested = secrets.some(([k2, , r2]) => k2 !== k && r2 && String(r2) !== v && v.includes(String(r2)));                                                                                                                            for (let i = 1; i < v.length; i++) { const a = v.slice(0, i), b = v.slice(i); for (const p of new Set([a + ' ' + b, esc(a) + ' ' + esc(b), esc(a) + '\\n' + esc(b), esc(a) + '\\r\\n' + esc(b), enc(a) + '%0A' + enc(b), enc(a) + '%0D%0A' + enc(b), form(a) + '%0A' + form(b), form(a) + '%0D%0A' + form(b), enc(a) + '%20' + enc(b), form(a) + '+' + form(b)])) splitVariants.push([p, k, nested]); } } splitVariants.sort((x, y) => y[0].length - x[0].length); }
  function redact(line, { splits = false } = {}) {
    const doSplits = splits && line.length < 2000000; if (doSplits && splitVariants === null) buildSplitVariants();
    if (doSplits) for (const [p, k, nested] of splitVariants) if (nested && line.includes(p)) line = line.split(p).join('<secret>' + k + '</secret>');
    for (const [k, variants] of secrets) for (const v of variants) if (line.includes(v)) line = line.split(v).join('<secret>' + k + '</secret>');
    if (doSplits) for (const [p, k, nested] of splitVariants) if (!nested && line.includes(p)) line = line.split(p).join('<secret>' + k + '</secret>');
    if (nestedFixups === null) buildNestedFixups();
    for (const [p, r] of nestedFixups) if (line.includes(p)) line = line.split(p).join(r);
    return line;
  }
  return { redact };
}
