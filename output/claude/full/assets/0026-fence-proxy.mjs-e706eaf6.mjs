









import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns';

const HEADER_CAP = 16 * 1024;
const IDLE_MS = 60_000;
const CONNECT_MS = 5_000;




const NON_PUBLIC = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) NON_PUBLIC.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 96], ['::1', 128], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) NON_PUBLIC.addSubnet(a, p, 'ipv6');
let ownList = null; let ownAt = 0;

function ownAddresses() {
  if (ownList && Date.now() - ownAt < 10000) return ownList;
  const b = new net.BlockList();
  try { for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) { const a = String(i.address || '').replace(/%.*$/, ''); if (net.isIPv4(a)) b.addAddress(a, 'ipv4'); else if (net.isIPv6(a)) b.addAddress(a, 'ipv6'); } } catch {                                                       }
  ownList = b; ownAt = Date.now(); return b;
}

export function plainAddress(ip) {
  let fam = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null; if (!fam) return null;
  let a; try { a = new net.SocketAddress({ address: String(ip).replace(/%.*$/, ''), family: fam }).address; } catch { return null; }
  if (fam === 'ipv6') { const m4 = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); if (m4) { a = m4[1]; fam = 'ipv4'; } }
  return { address: a, family: fam === 'ipv4' ? 4 : 6 };
}



export function isNonPublicAddress(ip) {
  let fam = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null; if (!fam) return true;
  let a; try { a = new net.SocketAddress({ address: ip, family: fam }).address; } catch { return true; }
  if (fam === 'ipv6') { const m4 = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); if (m4) { a = m4[1]; fam = 'ipv4'; } }
  return NON_PUBLIC.check(a, fam) || ownAddresses().check(a, fam);
}

function parseTarget(line) {

  const m = line.match(/^([A-Z]{3,10}) (\S{1,4096}) HTTP\/1\.[01]$/); if (!m) return null;
  const [, method, target] = m;
  if (method === 'CONNECT') {
    const t = target.match(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/); if (!t) return null;
    return { method, host: t[1].replace(/^\[|\]$/g, '').toLowerCase(), port: Number(t[2]), path: null };
  }
  let u; try { u = new URL(target); } catch { return null; }
  if (u.protocol !== 'http:' || u.username || u.password) return null;
  return { method, host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: Number(u.port || 80), path: (u.pathname || '/') + (u.search || '') };
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];




export function upstreamProxySetting(env) {
  const name = PROXY_VARS.find((k) => env[k]); if (!name) return { proxy: null };
  const raw = String(env[name]);
  let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw); } catch { return { proxy: null, problem: name + ' is not a readable proxy address' }; }
  if (u.protocol !== 'http:') return { proxy: null, problem: name + ' names a ' + u.protocol.replace(/:$/, '') + ' proxy, and this fence speaks only to a plain http proxy (CONNECT)' };
  if (!u.hostname) return { proxy: null, problem: name + ' has no host' };
  let auth = null;
  if (u.username) return { proxy: null, problem: name + ' carries a user and a password; the fence does not pass credentials on (its listener cannot tell the test browser from another program on this machine), so it connects to allowed hosts directly instead' };
  if (u.username) { try { auth = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64'); } catch { return { proxy: null, problem: name + ' has a user or password that is not valid percent-encoding (write a literal % as %25)' }; } }
  return { proxy: { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 80), auth } };
}


export function noProxyMatcher(env) {
  const raw = String(env.NO_PROXY || env.no_proxy || ''); const rules = [];
  for (const part of raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 200)) {
    if (part === '*') { rules.push({ all: true }); continue; }
    if (part.includes('/')) continue;
    const m = part.match(/^\*?\.?([a-z0-9.-]{1,253}?)(?::(\d{1,5}))?$/); if (!m || !m[1]) continue;
    rules.push({ name: m[1].replace(/\.$/, ''), port: m[2] ? Number(m[2]) : null });
  }
  return (host, port) => { const h = String(host || '').toLowerCase().replace(/\.$/, ''); return rules.some((r) => r.all || ((h === r.name || h.endsWith('.' + r.name)) && (r.port === null || r.port === port))); };
}

export function upstreamProxyFrom(env) { return upstreamProxySetting(env).proxy; }







export async function startFenceProxy({ allow, onRefused = () => {}, onAllowed = () => {}, onFailed = () => {}, direct = () => false, upstream = null, lookup = dns.promises.lookup, connect = net.connect, refuseText = 'Claude Test: this address is outside what the test browser may reach for this run.' }) {
  const refuse = (sock, host, port, why) => { try { if (host) onRefused(host, port, why); sock.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n' + refuseText + '\r\n'); } catch {            } };
  const server = net.createServer((sock) => {
    sock.on('error', () => {}); sock.setTimeout(IDLE_MS, () => sock.destroy());
    let buf = Buffer.alloc(0);
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > HEADER_CAP) { sock.removeListener('data', onData); refuse(sock, null, 0, 'header too large'); } return; }
      sock.removeListener('data', onData); sock.pause();
      const head = buf.subarray(0, end).toString('latin1'); const rest = buf.subarray(end + 4);
      if (/\r(?!\n)|(?<!\r)\n|\0/.test(head)) { try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {            } return; }
      const lines = head.split('\r\n'); const t = parseTarget(lines[0]);
      if (!t || !t.port || t.port > 65535) return refuse(sock, null, 0, 'unreadable request');
      let ok = false; try { ok = !!allow(t.host, t.port); } catch { ok = false; }
      if (!ok || net.isIP(t.host)) return refuse(sock, t.host, t.port, 'not allowed');
      let bodyLength = 0;
      if (t.method !== 'CONNECT') {
        if (lines.slice(1).some((l) => /^transfer-encoding:/i.test(l))) { try { sock.end('HTTP/1.1 411 Length Required\r\nConnection: close\r\n\r\n'); } catch {            } return; }
        const cls = lines.slice(1).filter((l) => /^content-length:/i.test(l)); const cl = cls.length ? cls[0].match(/^content-length:\s*(\d{1,15})\s*$/i) : null;
        if (cls.length > 1 || (cls.length && !cl)) { try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {            } return; }
        bodyLength = cl ? Number(cl[1]) : 0;
      }

      let targets; let viaUpstream = false;
      if (upstream && !direct(t.host, t.port)) {
        targets = [{ host: upstream.host, port: upstream.port }]; viaUpstream = true;
        let addrs = null; try { addrs = await lookup(t.host, { all: true, verbatim: true }); } catch { addrs = null; }
        if (addrs && addrs.length && addrs.some((a) => !a || !a.address || isNonPublicAddress(a.address))) return refuse(sock, t.host, t.port, 'resolves to a local or private address');
      } else {
        let addrs; try { addrs = await lookup(t.host, { all: true, verbatim: true }); } catch { return refuse(sock, t.host, t.port, 'name did not resolve'); }
        const pub = (addrs || []).filter((a) => a && a.address && !isNonPublicAddress(a.address));
        if (!pub.length) return refuse(sock, t.host, t.port, 'resolves to a local or private address');



        const v4 = pub.filter((a) => a.family === 4 || net.isIPv4(a.address)); const v6 = pub.filter((a) => !(a.family === 4 || net.isIPv4(a.address))); const order = [];
        for (let i = 0; i < Math.max(v4.length, v6.length) && order.length < 6; i++) { if (v4[i]) order.push(v4[i]); if (v6[i] && order.length < 6) order.push(v6[i]); }
        targets = order.map((a) => ({ host: a.address, port: t.port }));
      }
      let failed = false; const fail = () => { if (failed) return; failed = true; try { sock.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch {            } };
      const dial = (i) => {
        const up = connect({ host: targets[i].host, port: targets[i].port }); let settled = false;
        const giveUp = (why) => { if (settled) return; settled = true; clearTimeout(timer); try { up.destroy(); } catch {            } if (sock.destroyed) return; if (i + 1 < targets.length) return dial(i + 1); try { onFailed(t.host, t.port, why); } catch {                                        } fail(); };
        const timer = setTimeout(() => giveUp('no answer in ' + CONNECT_MS / 1000 + ' s'), CONNECT_MS); if (timer.unref) timer.unref();
        up.once('error', (e) => giveUp(String((e && e.code) || 'could not connect')));
        up.once('connect', () => { if (settled) { try { up.destroy(); } catch {            } return; } settled = true; clearTimeout(timer); up.on('error', () => {}); up.setTimeout(IDLE_MS, () => up.destroy()); connected(up); });
      };
      const connected = (up) => {
        onAllowed(t.host, t.port);
        const pipeBoth = (seed) => { if (seed && seed.length) up.write(seed); sock.pipe(up); up.pipe(sock); sock.resume(); sock.on('close', () => up.destroy()); up.on('close', () => sock.destroy()); };



        const pipeOneRequest = (seed, bodyBytes) => { let left = bodyBytes; const give = (b) => { if (left <= 0 || !b.length) return; const part = b.length > left ? b.subarray(0, left) : b; left -= part.length; up.write(part); };
          give(seed); up.pipe(sock); sock.on('data', give); sock.resume(); sock.on('close', () => up.destroy()); up.on('close', () => sock.destroy()); };
        if (t.method === 'CONNECT') {
          if (!viaUpstream) { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); return pipeBoth(rest); }

          up.write('CONNECT ' + t.host + ':' + t.port + ' HTTP/1.1\r\nHost: ' + t.host + ':' + t.port + '\r\n' + (upstream.auth ? 'Proxy-Authorization: ' + upstream.auth + '\r\n' : '') + '\r\n');
          let ub = Buffer.alloc(0);
          const early = () => fail(); up.once('close', early);
          const onUp = (c) => { ub = Buffer.concat([ub, c]); const e = ub.indexOf('\r\n\r\n'); if (e < 0) { if (ub.length > HEADER_CAP) { up.destroy(); fail(); } return; } up.removeListener('data', onUp);
            if (!/^HTTP\/1\.[01] 2\d\d/.test(ub.subarray(0, e).toString('latin1'))) { up.destroy(); return fail(); }
            up.removeListener('close', early); sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); const extra = ub.subarray(e + 4); if (extra.length) sock.write(extra); pipeBoth(rest); };
          up.on('data', onUp); return;
        }

        const headers = lines.slice(1).filter((l) => !/^(proxy-connection|connection|keep-alive|proxy-authorization):/i.test(l));
        const first = t.method + ' ' + (viaUpstream ? 'http://' + t.host + (t.port === 80 ? '' : ':' + t.port) + t.path : t.path) + ' HTTP/1.1';
        up.write([first, ...headers, 'Connection: close', ...(viaUpstream && upstream.auth ? ['Proxy-Authorization: ' + upstream.auth] : []), '', ''].join('\r\n'));
        pipeOneRequest(rest, bodyLength);
      };
      dial(0);
    };
    sock.on('data', onData);
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  server.unref();
  return { port: server.address().port, close: () => { try { server.close(); } catch {              } } };
}
