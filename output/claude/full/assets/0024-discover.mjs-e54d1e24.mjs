



import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RC_FILE } from './config.mjs';

export function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }


export const COMMON_PORTS = [3000, 5173, 8080, 8000, 4200, 4321, 5000, 3001];





export function packageManagerSignals(dir, pkg) {
  const signals = [];

  const fromField = (p, where) => { const m = typeof p?.packageManager === 'string' && p.packageManager.match(/^(npm|yarn|pnpm|bun)@[0-9A-Za-z.+-]{1,40}/); if (m) signals.push({ pm: m[1], from: where + ' packageManager "' + m[0] + '"' }); };
  fromField(pkg, 'package.json');
  const LOCKS = [['pnpm-lock.yaml', 'pnpm'], ['pnpm-workspace.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['.yarnrc.yml', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']];
  const home = os.homedir();
  let d = dir;
  for (let depth = 0; depth < 8; depth++) {
    const rel = (f) => path.relative(dir, path.join(d, f)) || f;



    if (depth > 0 && d === home) break;
    const isRepoRoot = fs.existsSync(path.join(d, '.git'));
    const ancestorPkg = depth > 0 ? readJson(path.join(d, 'package.json')) : null;
    const isWorkspaceRoot = !!ancestorPkg && (ancestorPkg.workspaces != null || fs.existsSync(path.join(d, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(d, '.yarnrc.yml')));
    if (depth === 0 || (ancestorPkg && (isWorkspaceRoot || isRepoRoot))) {
      for (const [f, pm] of LOCKS) if (fs.existsSync(path.join(d, f))) signals.push({ pm, from: rel(f) });
      if (ancestorPkg) fromField(ancestorPkg, rel('package.json'));
    }
    if (isRepoRoot || (depth > 0 && isWorkspaceRoot)) break;
    const parent = path.dirname(d); if (parent === d) break; d = parent;
  }
  const pms = [...new Set(signals.map((s) => s.pm))];
  return { signals, pms, pm: pms.length === 1 ? pms[0] : null, conflict: pms.length > 1 };
}


export function discoverDevServer(cfg, { inSandbox = false } = {}) {
  const found = { startCommand: cfg.startCommandSource === RC_FILE ? cfg.startCommand : null, startCommandSource: cfg.startCommandSource === RC_FILE ? RC_FILE : null, startCommandCwd: null, startCommandNote: null, startCommandCandidates: [], conflicts: [], portHints: [], portHintsSource: null, portHintFrom: {}, recipes: [] };
  const hint = (p, from) => { p = Number(p); if (!Number.isInteger(p) || p < 1024 || p > 65535) return; if (!found.portHints.includes(p)) found.portHints.push(p); if (!found.portHintFrom[p]) found.portHintFrom[p] = from; };
  const explicitScriptPorts = [];
  const dir = cfg.projectDir;

  for (const rel of ['.claude/skills/verify/SKILL.md']) if (fs.existsSync(path.join(dir, rel))) found.recipes.push(rel);
  const skillsDir = path.join(dir, '.claude', 'skills');

  try { for (const d of fs.readdirSync(skillsDir)) if (/^(run|verifier)-/.test(d)) found.recipes.push(path.join('.claude/skills', d, 'SKILL.md')); } catch (e) { if (e.code !== 'ENOENT') found.unreadable = (found.unreadable || []).concat('.claude/skills (' + e.code + (inSandbox ? ', masked by the sandbox' : '') + ')'); }







  const candidates = [];
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
    const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,40}$/;
    const BASES = ['dev', 'start', 'serve', 'preview'];
    const name = BASES.find((s) => pkg.scripts[s]);


    const variantKeys = Object.keys(pkg.scripts).filter((s) => SAFE_KEY.test(s) && !/:(down|stop|clean|kill|reset)$/.test(s) && (name ? s.startsWith(name + ':') : BASES.some((b) => s.startsWith(b + ':')))).slice(0, 4);
    const scriptNames = name ? [name] : variantKeys;
    if (scriptNames.length) {
      const pms = packageManagerSignals(dir, pkg);
      const run = (pm, script) => pm + ' run ' + script;
      const pmList = pms.conflict ? pms.pms : [pms.pm || 'npm'];
      const pmFrom = (pm) => pms.conflict ? ' + ' + pms.signals.filter((s) => s.pm === pm).map((s) => s.from).join(', ') : pms.pm ? ' + ' + pms.signals[0].from : ' (no lockfile or packageManager field found; assuming npm)';
      for (const script of scriptNames) for (const pm of pmList) candidates.push({ command: run(pm, script), from: 'package.json scripts.' + script + pmFrom(pm) });
      if (pms.conflict) found.conflicts.push('package managers disagree: ' + pms.signals.map((s) => s.pm + ' (' + s.from + ')').join(' vs '));
      if (!name && variantKeys.length > 1) found.conflicts.push('package.json has no plain dev/start script, only variants (' + variantKeys.join(', ') + ') and only the user knows which one this machine uses');
      if (name && variantKeys.length && !pms.conflict) {
        for (const v of variantKeys) candidates.push({ command: run(pmList[0], v), from: 'package.json scripts.' + v });
        found.conflicts.push('package.json has several ways to start the app (' + [name, ...variantKeys].join(', ') + '). Ask the user which one they use on this machine — often it is "' + run(pmList[0], name) + '"');
      }
      found.portHintsSource = 'package.json scripts.' + scriptNames[0];
      const text = String(pkg.scripts[scriptNames[0]]);
      const m = text.match(/(?:--port[ =]|PORT=|-p )(\d{2,5})/);
      if (m) { hint(Number(m[1]), 'package.json scripts.' + scriptNames[0]); if (found.portHints.includes(Number(m[1]))) explicitScriptPorts.push(Number(m[1])); }
      if (/vite|svelte-kit|sveltekit|astro dev/.test(text)) hint(/astro/.test(text) ? 4321 : 5173, 'package.json scripts.' + scriptNames[0] + ' (' + (/astro/.test(text) ? 'astro' : 'vite') + ' default port)');
      if (/next|react-scripts|remix|node |nodemon|express/.test(text)) hint(3000, 'package.json scripts.' + scriptNames[0] + ' (framework default port)');
      if (/ng serve/.test(text)) hint(4200, 'package.json scripts.' + scriptNames[0] + ' (ng default port)');
    }
  }
  for (const [file, tool] of [['Makefile', 'make'], ['makefile', 'make'], ['GNUmakefile', 'make'], ['justfile', 'just'], ['Justfile', 'just']]) {
    let t; try { t = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 65536); } catch { continue; }
    const target = ['dev', 'serve', 'start', 'server', 'run', 'up'].find((n) => new RegExp('^' + n + '\\s*:(?!=)', 'm').test(t));
    if (target) candidates.push({ command: tool + ' ' + target, from: file + ' target "' + target + '"' });
  }
  if (fs.existsSync(path.join(dir, 'manage.py'))) { candidates.push({ command: 'python manage.py runserver', from: 'manage.py' }); hint(8000, 'manage.py (Django default port)'); }
  if (fs.existsSync(path.join(dir, 'bin', 'rails'))) { candidates.push({ command: 'bin/rails server', from: 'bin/rails' }); hint(3000, 'bin/rails (Rails default port)'); }



  const launchPort = cfg.launch && Number.isInteger(Number(cfg.launch.port)) && Number(cfg.launch.port) >= 1024 && Number(cfg.launch.port) <= 65535 ? Number(cfg.launch.port) : null;
  if (launchPort) { found.portHints = [launchPort, ...found.portHints.filter((p) => p !== launchPort)]; found.portHintsSource = '.claude/launch.json'; found.portHintFrom[launchPort] = '.claude/launch.json'; }
  if (cfg.launch && cfg.launch.command) {
    const lc = cfg.launch.command.trim().replace(/^(yarn|pnpm|bun)\s+(?!run\b)([A-Za-z0-9:_.-]+)$/, '$1 run $2');
    const lcPm = (lc.match(/^(npm|yarn|pnpm|bun)\b/) || [])[1] || null;
    const repoPms = pkg ? packageManagerSignals(dir, pkg) : { pm: null, signals: [], conflict: false };
    const cwdRel = cfg.launch.cwd && typeof cfg.launch.cwd === 'string' ? (path.relative(dir, path.resolve(dir, cfg.launch.cwd)) || '.') : null;
    const cwdOk = !cwdRel || (!cwdRel.startsWith('..') && !path.isAbsolute(cwdRel) && fs.existsSync(path.join(dir, cwdRel)));
    let lcUse = lc; let lcFrom = '.claude/launch.json';
    if (lcPm && repoPms.pm && lcPm !== repoPms.pm && !repoPms.conflict) { lcUse = lc.replace(/^(npm|yarn|pnpm|bun)\b/, repoPms.pm).replace(/^(yarn|pnpm|bun)\s+(?!run\b)([A-Za-z0-9:_.-]+)$/, '$1 run $2'); lcFrom = '.claude/launch.json (says ' + lcPm + '; the repo uses ' + repoPms.pm + ' per ' + repoPms.signals[0].from + ', so translated)'; found.launchIgnored = '.claude/launch.json runs "' + lcPm + '" but the repo uses ' + repoPms.pm + ' (' + repoPms.signals[0].from + ') — its command is listed translated to ' + repoPms.pm + ', not trusted as written'; }
    if (!cwdOk) found.launchIgnored = '.claude/launch.json names a working directory outside or missing from the project (' + String(cfg.launch.cwd).replace(/[^\x20-\x7e]/g, ' ').slice(0, 60) + ') and is ignored';
    else if (/^[A-Za-z0-9][A-Za-z0-9 :_./=-]{0,80}$/.test(lcUse)) {
      candidates.push({ command: lcUse, from: lcFrom + (cwdRel && cwdRel !== '.' ? ' (cwd: ' + cwdRel + ')' : ''), cwd: cwdRel && cwdRel !== '.' ? cwdRel : null });


      if (cwdRel && cwdRel !== '.') {
        const sub = readJson(path.join(dir, cwdRel, 'package.json'));
        if (sub && sub.scripts && typeof sub.scripts === 'object') {
          const pm = repoPms.pm || lcPm || 'npm';
          const keys = Object.keys(sub.scripts).filter((s) => /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,40}$/.test(s) && /^(dev|start|serve|preview)(:|$)/.test(s)).slice(0, 5);
          for (const k of keys) { const cmd = pm + ' run ' + k; if (cmd !== lcUse) candidates.push({ command: cmd, from: cwdRel + '/package.json scripts.' + k, cwd: cwdRel }); }
          if (keys.length > 1) found.conflicts.push(cwdRel + '/package.json has several ways to start the app (' + keys.join(', ') + '); .claude/launch.json picks "' + lcUse + '" — ask the user which one they use');
        }
      }
    }
  }
  if (!found.startCommand) {
    const distinct = [...new Map(candidates.map((c) => [c.command + '\u0000' + (c.cwd || ''), c])).values()];
    if (distinct.length === 1 && !found.conflicts.length) { found.startCommand = distinct[0].command; found.startCommandSource = candidates.filter((c) => c.command === distinct[0].command).map((c) => c.from).join(' = '); found.startCommandCwd = distinct[0].cwd || null; }
    else if (candidates.length) {
      if (candidates.length > 1 && !found.conflicts.length) found.conflicts.push('more than one way to start the app: ' + candidates.map((c) => c.from).join(', '));
      found.startCommandNote = 'unknown — ask: ' + found.conflicts.join('; ') + '. Do not guess or pick a candidate; the user names the command, and "startCommand: <command>" in ' + RC_FILE + ' settles it for later runs.';
      found.startCommandCandidates = candidates;
    }
  }


  const filePorts = []; let filePortsSource = null;
  const scanDirs = ['']; if (found.startCommandCwd) scanDirs.push(found.startCommandCwd); else if (cfg.launch && typeof cfg.launch.cwd === 'string' && !cfg.launch.cwd.includes('..') && !path.isAbsolute(cfg.launch.cwd)) scanDirs.push(cfg.launch.cwd);
  for (const sub of scanDirs) for (const rel0 of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'next.config.js', 'next.config.mjs', 'astro.config.mjs', 'svelte.config.js', 'angular.json', 'server.js', 'server.ts', 'server.mjs', 'app.js', 'index.js', 'src/server.ts', 'src/server.js', 'src/index.ts', 'src/index.js', '.env', '.env.development', 'Procfile', 'docker-compose.yml']) {
    const rel = path.join(sub, rel0);
    let t; try { t = fs.readFileSync(path.join(dir, rel), 'utf8').slice(0, 65536); } catch { continue; }
    for (const m of t.matchAll(/(?:\bport\b["']?\s*[:=]\s*|\bPORT\b[^\n\w]{0,8}|listen\(\s*)(\d{4,5})\b/g)) { const p = Number(m[1]); if (p >= 1024 && p <= 65535 && !filePorts.includes(p)) { filePorts.push(p); if (!filePortsSource) filePortsSource = rel; if (!found.portHintFrom[p] || / default port\)$/.test(found.portHintFrom[p])) found.portHintFrom[p] = rel; } }
  }
  { const launchFirst = launchPort ? [launchPort] : []; const lead = [...launchFirst, ...explicitScriptPorts.filter((p) => !launchFirst.includes(p))]; found.portHints = [...lead, ...filePorts.filter((p) => !lead.includes(p)), ...found.portHints.filter((p) => !filePorts.includes(p) && !lead.includes(p))]; if (!launchFirst.length && !explicitScriptPorts.length && filePorts.length) found.portHintsSource = filePortsSource || found.portHintsSource; }
  return found;
}







export function candidateList(cfg, dev) {
  if (cfg.baseUrl) return [{ url: cfg.baseUrl, from: RC_FILE, own: true }];
  const ports = [...new Set([...dev.portHints, ...COMMON_PORTS])];
  return ports.map((p) => ({ url: 'http://localhost:' + p + '/', port: p, from: dev.portHintFrom[p] || 'common default port', own: !!dev.portHintFrom[p] }))
    .filter((x, i, arr) => x.own || arr.slice(0, i).filter((y) => !y.own).length < 4)
    .slice(0, 8);
}
