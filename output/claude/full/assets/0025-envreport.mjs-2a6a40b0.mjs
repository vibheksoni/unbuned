



import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, packageManagerSignals } from './discover.mjs';
import { parseDotenv } from './config.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.astro', '.output', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.netlify', '.cache', '.parcel-cache', 'tmp', 'temp', 'vendor', '__pycache__', '.venv', 'venv', 'site-packages', 'dist-packages', '.tox', '.claude-test', '.claude', 'public', 'static', 'storybook-static', '.storybook', 'cypress', 'playwright-report', 'test-results', '__tests__', '__mocks__', 'e2e', '.yarn', '.pnpm-store', 'target', 'obj', 'log', 'logs', 'scripts', 'script', 'tools', 'bin', 'deploy', 'infra', 'terraform']);
const SOURCE_EXT = /\.(m?[jt]sx?|c[jt]s|vue|svelte|astro|py|rb|erb|haml)$/;
const TEST_FILE = /(\.|-|_)(test|spec|stories|e2e)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.rb$/;
const NAME = '[A-Z][A-Z0-9_]{1,80}';
const Q = '[\'"\x60]';


const READS = [
  new RegExp('\\bprocess\\.env\\??\\.(' + NAME + ')\\b(?!\\s*=[^=])', 'g'),
  new RegExp('\\bprocess\\.env\\??\\.?\\[\\s*' + Q + '(' + NAME + ')' + Q + '\\s*\\]', 'g'),
  new RegExp('\\bimport\\.meta\\.env\\??\\.(' + NAME + ')\\b', 'g'),
  new RegExp('\\b(?:os\\.)?environ(?:\\.get)?\\s*[\\[(]\\s*' + Q + '(' + NAME + ')' + Q + '\\s*(?:[\\])](?!\\s*=[^=])|,)', 'g'),
  new RegExp('\\bos\\.getenv\\(\\s*' + Q + '(' + NAME + ')' + Q, 'g'),
  new RegExp('\\bENV(?:\\.fetch)?\\s*[\\[(]\\s*' + Q + '(' + NAME + ')' + Q, 'g'),
];
const DESTRUCTURE = /\{([^{}]{1,600})\}\s*=\s*process\.env\b/g;
const SCHEMA_FIELD = new RegExp('(?:^|[{,])\\s*(' + NAME + ')\\s*:\\s*z\\s*\\.', 'gm');
const NEXT_FIELD = new RegExp(',\\s*(' + NAME + '|[a-z]\\w*)\\s*:|\\n\\s*[})]');

const PROVIDED = /^(NODE_ENV|PORT|HOST|HOSTNAME|CI|TZ|PWD|HOME|PATH|SHELL|USER|LOGNAME|TMPDIR|TEMP|TMP|LANG|LC_ALL|TERM|DEBUG|FORCE_COLOR|NO_COLOR|EDITOR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|DISPLAY|XDG_\w+|APPDATA|LOCALAPPDATA|PROGRAMFILES|USERPROFILE|SYSTEMROOT|COMSPEC|VERCEL|VERCEL_\w+|NEXT_RUNTIME|NEXT_PHASE|NEXT_DEPLOYMENT_ID|__NEXT\w*|NETLIFY|RENDER|RAILWAY_\w+|HEROKU_\w+|FLY_\w+|AWS_LAMBDA_\w+|AWS_EXECUTION_ENV|K_SERVICE|FUNCTION_\w+|GITHUB_\w+|GITLAB_\w+|BUILDKITE\w*|JEST_WORKER_ID|VITEST\w*|PLAYWRIGHT_\w+|CYPRESS\w*|STORYBOOK|npm_\w+|INIT_CWD|NVM_\w+|ANALYZE|BUNDLE_ANALYZE|DJANGO_SETTINGS_MODULE|RAILS_ENV|RACK_ENV|FLASK_ENV|FLASK_DEBUG|PYTHONPATH|WERKZEUG_\w+)$/;
const VITE_BUILTIN = /^(MODE|DEV|PROD|SSR|BASE_URL)$/;

const CLIENT_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_|STORYBOOK_|NG_APP_)/;


const OUTSIDE_SERVICE = /(MAPS|MAPBOX|GOOGLE|GTM|GTAG|GA_|GA4|ANALYTICS|SEGMENT|SENTRY|DATADOG|POSTHOG|MIXPANEL|AMPLITUDE|HEAP_|HOTJAR|FULLSTORY|LOGROCKET|INTERCOM|CRISP|ZENDESK|HUBSPOT|DRIFT|RECAPTCHA|HCAPTCHA|TURNSTILE|STRIPE|PAYPAL|BRAINTREE|ADYEN|ALGOLIA|TYPESENSE|CLOUDINARY|IMGIX|YOUTUBE|VIMEO|TWITTER|FACEBOOK|PIXEL|TIKTOK|LINKEDIN|PUSHER|ABLY|ONESIGNAL|LAUNCHDARKLY|OPTIMIZELY|STATSIG|BUGSNAG|ROLLBAR|NEW_RELIC|NEWRELIC|APPCUES|PENDO|CALENDLY|TYPEFORM|DISQUS|GIPHY|_DSN$|TRACKING|TELEMETRY)/;


const REQUIRED_HINT = /\bthrow\b|\binvariant\(|\bassert\w*\(|process\.exit\(|console\.error\(|log(ger)?\.(error|fatal)\(|must be (set|defined|provided)|is (required|not set|missing|undefined)|not (defined|configured)/i;
const SOFT_WORDS = /\b(default\w*|fallback|fall(ing)? back|warn\w*)\b/i;
const OTHER_READ = /process\.env|import\.meta\.env|environ|getenv|\bENV[.\[]|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

const defaultHint = (name) => new RegExp('\\b' + name + '\\b' + Q + '?\\]?\\s*(\\?\\?|\\|\\|(?!\\s*!)|[!=]==?\\s*(undefined|null)\\s*\\?)|\\b' + name + '\\b[^,;\\n]{0,80}\\.(default|optional|nullish|catch)\\(|\\bget\\(\\s*' + Q + name + Q + '\\s*,|getenv\\(\\s*' + Q + name + Q + '\\s*,|fetch\\(\\s*' + Q + name + Q + '\\s*,|\\w\\(\\s*(process\\.env|import\\.meta\\.env)\\??\\.' + name + '\\b[^()\\n]{0,24}\\)\\s*(\\|\\||\\?\\?)|\\.' + name + '\\?\\.|\\.' + name + '\\s*&&(?!\\s*!)|[^!&]&&\\s*(process\\.env|import\\.meta\\.env)\\??\\.' + name + '\\b|environ\\.get\\(\\s*' + Q + name + Q + '\\s*\\)|getenv\\(\\s*' + Q + name + Q + '\\s*\\)|\\bENV\\[\\s*' + Q + name + Q + '\\s*\\]');

const requiredRead = (name) => new RegExp('environ\\[\\s*' + Q + name + Q + '\\s*\\]|\\bENV\\.fetch\\(\\s*' + Q + name + Q + '\\s*\\)');
const switchUse = (name) => new RegExp('\\b' + name + '\\b' + Q + '?\\]?\\)?\\s*(===?|!==?)\\s*' + Q + '|(===?|!==?)\\s*(process\\.env|import\\.meta\\.env)\\??\\.' + name + '\\b|(!!\\s*|Boolean\\(\\s*)(process\\.env|import\\.meta\\.env)\\??\\.' + name + '\\b|\\bif\\s*\\(\\s*(process\\.env|import\\.meta\\.env)\\??\\.' + name + '\\s*\\)|\\.' + name + '\\s*\\?\\s*[^?.\\s]');
const ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env.dev', '.env'];
const ENV_TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.local.example', '.env.development.example', 'example.env', 'sample.env', '.env.defaults'];
const MAX_VARS_LISTED = 80;
const MAX_UP = 12;



function parseEnvNames(text) { const names = new Map(); for (const [k, v] of Object.entries(parseDotenv(text))) if (/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(k)) names.set(k, v !== ''); return names; }


function readJsonFile(p) { try { const st = fs.lstatSync(p); return st.isFile() && st.size <= 1024 * 1024 ? readJson(p) : null; } catch { return null; } }
const isRegularFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };


function unsafeDir(d) { if (process.platform === 'win32') return false; try { const st = fs.statSync(d); const me = typeof process.getuid === 'function' ? process.getuid() : null; const mine = me !== null && me !== 0 && st.uid === me; return ((st.mode & 0o002) !== 0 && !mine) || (me !== null && me !== 0 && st.uid !== me && st.uid !== 0); } catch { return true; } }



function checkoutTop(dir) {
  const home = os.homedir(); let d = dir; let workspaceTop = null;
  for (let i = 0; i < MAX_UP; i++) {
    if (i > 0 && (d === home || unsafeDir(d))) break;
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const pkg = readJsonFile(path.join(d, 'package.json'));
    if ((pkg && pkg.workspaces != null) || ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json'].some((f) => fs.existsSync(path.join(d, f)))) workspaceTop = d;
    const p = path.dirname(d); if (p === d) break; d = p;
  }
  return workspaceTop || dir;
}

function upTo(dir, top) { const out = []; let d = dir; for (let i = 0; i < MAX_UP; i++) { out.push(d); if (d === top) break; const p = path.dirname(d); if (p === d) break; d = p; } return out; }



function findInstalled(name, dirs, top) {
  for (const d of dirs) {
    const p = path.join(d, 'node_modules', ...name.split('/'));
    const where = pathTextWithin(d, ['node_modules', ...name.split('/')], top); if (where === undefined) continue;
    if (where === 'outside') return 'outside';
    let real; try { real = fs.realpathSync(p); } catch { continue; } if (real !== top && !real.startsWith(top + path.sep)) return 'outside';
    if (isRegularFile(path.join(real, 'package.json'))) return real;
  }
  return null;
}

function linkTextTarget(p) { let st; try { st = fs.lstatSync(p); } catch { return undefined; } if (!st.isSymbolicLink()) return p; try { return path.resolve(path.dirname(p), fs.readlinkSync(p)); } catch { return undefined; } }



function pathTextWithin(base, segments, top, budget = { hops: 16 }) {
  const inTop = (p) => p === top || p.startsWith(top + path.sep);
  let cur = base;
  for (const s of segments) {
    cur = path.join(cur, s);
    const t = linkTextTarget(cur); if (t === undefined) return undefined;
    if (t === cur) continue;
    if (!inTop(t) || --budget.hops < 0) return 'outside';

    const w = pathTextWithin(top, path.relative(top, t).split(path.sep).filter(Boolean), top, budget);
    if (w === undefined || w === 'outside') return w; cur = w;
  }
  return cur;
}
function mtime(p) { try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? null : st.mtimeMs; } catch { return null; } }


const realDir = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };

export function dependencyReport(dir) {
  dir = realDir(dir);
  const pkg = readJsonFile(path.join(dir, 'package.json'));
  if (!pkg || typeof pkg !== 'object') return null;
  const top = checkoutTop(dir); const dirs = upTo(dir, top);
  const pms = packageManagerSignals(dir, pkg); const manager = pms.pm || pms.pms[0] || 'npm';
  const installCommand = manager + ' install';

  if (dirs.some((d) => fs.existsSync(path.join(d, '.pnp.cjs')) || fs.existsSync(path.join(d, '.pnp.js')))) return { manager, installCommand, checked: false, note: 'Yarn Plug\'n\'Play install (.pnp.cjs): dependency presence is not checked from the file system' };
  const declared = { ...(pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}), ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}) };
  const names = Object.keys(declared).filter((n) => /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(n)).slice(0, 400);
  if (!names.length) return { manager, installCommand, checked: true, installed: true, declared: 0, missing: [], missingCount: 0, problem: null };
  if (!dirs.some((d) => fs.existsSync(path.join(d, 'node_modules')))) return { manager, installCommand, checked: true, installed: false, declared: names.length, missing: names.slice(0, 12), missingCount: names.length, problem: 'dependencies are not installed (no node_modules folder in this app folder' + (dirs.length > 1 ? ' or the ' + (dirs.length - 1) + ' folder' + (dirs.length > 2 ? 's' : '') + ' above it' : '') + '; ' + names.length + ' package' + (names.length === 1 ? '' : 's') + ' declared in package.json) — run "' + installCommand + '"' };
  const missing = []; const outside = []; const workspaceDirs = [];
  const inTop = (p) => p === top || p.startsWith(top + path.sep);
  for (const n of names) {
    const spec = String(declared[n]);
    const where = findInstalled(n, dirs, top);
    if (where === 'outside') { outside.push(n); continue; }
    if (!where) {


      const local = spec.match(/^(?:workspace:|link:|file:|portal:)((?:\.{1,2}\/)?[^\s:/][^\s:]{0,199})$/);
      const abs = local && !local[1].includes('//') ? path.resolve(dir, local[1]) : null;
      const walked = abs && inTop(abs) ? pathTextWithin(dir, path.relative(dir, abs).split(path.sep).filter(Boolean), top) : null;
      const localDir = walked && walked !== 'outside' && inTop(walked) ? realDir(walked) : null;
      if (localDir && inTop(localDir) && isRegularFile(path.join(localDir, 'package.json'))) { workspaceDirs.push(localDir); continue; }
      missing.push(/^workspace:/.test(spec) ? n + ' (a workspace package: not linked)' : n); continue;
    }
    if (!where.split(path.sep).includes('node_modules') && inTop(where)) workspaceDirs.push(where);
  }


  let marker = null; let markerWhere = null;
  for (const m of ['node_modules/.modules.yaml', 'node_modules/.package-lock.json', 'node_modules/.yarn-integrity', 'node_modules/.yarn-state.yml', 'node_modules']) { for (const d of dirs) { const t = mtime(path.join(d, m)); if (t !== null) { marker = t; markerWhere = path.relative(dir, path.join(d, m)) || m; break; } } if (marker !== null) break; }
  const newer = [];
  if (marker !== null) { const m = mtime(path.join(dir, 'package.json')); if (m !== null && m > marker + 2000) newer.push('package.json'); for (const d of dirs) for (const lock of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json']) { const t = mtime(path.join(d, lock)); if (t !== null && t > marker + 2000) newer.push(path.relative(dir, path.join(d, lock)) || lock); } }
  const stale = newer.length ? [...new Set(newer)].join(', ') + ' ' + (new Set(newer).size === 1 ? 'is' : 'are') + ' newer than the last install here (' + markerWhere + ')' : null;
  const problem = missing.length ? missing.length + ' of ' + names.length + ' packages declared in package.json ' + (missing.length === 1 ? 'is' : 'are') + ' not installed: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' and ' + (missing.length - 8) + ' more' : '') + ' — they ARE declared, so this is the install on this machine lagging behind package.json; run "' + installCommand + '"' + (stale ? ' (' + stale + ')' : '') : null;
  const outsideNote = outside.length ? outside.length + ' package' + (outside.length === 1 ? ' is' : 's are') + ' linked from outside this checkout and not counted (' + outside.slice(0, 6).join(', ') + ')' : null;
  return { manager, installCommand, checked: true, installed: true, declared: names.length, missing: missing.slice(0, 12), missingCount: missing.length, ...(stale ? { stale } : {}), ...(outsideNote ? { outside: outsideNote } : {}), problem, ...(!problem && stale ? { note: stale + ' — if the app misbehaves, run "' + installCommand + '" first' } : {}), workspaceDirs: [...new Set(workspaceDirs)].slice(0, 12) };
}


export function envFileReport(dir) {
  const files = []; const present = new Map();
  for (const f of ENV_FILES) {
    let st; try { st = fs.lstatSync(path.join(dir, f)); } catch { continue; }
    if (st.isSymbolicLink()) { files.push({ file: f, state: 'a symlink — not read', keys: 0, unchecked: true }); continue; }
    if (!st.isFile()) { files.push({ file: f, state: 'not a regular file', keys: 0, unchecked: true }); continue; }
    if (st.size === 0) { files.push({ file: f, state: 'empty (0 bytes)', keys: 0, empty: true }); continue; }
    if (st.size > 256 * 1024) { files.push({ file: f, state: 'too large to check (' + Math.round(st.size / 1024) + ' KiB)', keys: 0, unchecked: true }); continue; }
    let names = new Map(); try { names = parseEnvNames(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { files.push({ file: f, state: 'unreadable', keys: 0, unchecked: true }); continue; }
    const blank = [...names].filter(([, has]) => !has).length;
    files.push({ file: f, state: names.size ? names.size + ' key' + (names.size === 1 ? '' : 's') + (blank ? ', ' + blank + ' with no value' : '') : 'sets no variable (comments or blank lines only)', keys: names.size, ...(blank ? { blank } : {}) });
    for (const [n, has] of names) if (!present.has(n)) present.set(n, has ? f : false);
  }
  const templates = [];
  for (const f of ENV_TEMPLATES) { let st; try { st = fs.lstatSync(path.join(dir, f)); } catch { continue; } if (!st.isFile() || st.size > 256 * 1024) continue; let names = new Map(); try { names = parseEnvNames(fs.readFileSync(path.join(dir, f), 'utf8')); } catch {       } templates.push({ file: f, keys: [...names.keys()].filter((n) => /^[A-Z][A-Z0-9_]{1,63}$/.test(n)).slice(0, 80) }); }
  return { files, templates, present };
}


export function scanEnvReads(dirs, { maxFiles = 2500, maxMs = 2500, root = dirs[0] } = {}) {
  const started = Date.now(); const vars = new Map(); const schema = new Map(); let files = 0; let capped = false;
  const entry = (name) => { let v = vars.get(name); if (!v) { v = { name, readAt: [], requiredAt: null, hasDefault: false, client: CLIENT_PREFIX.test(name) }; vars.set(name, v); } return v; };
  const note = (name, rel, lineNo, lines, viaImportMeta) => {
    if (viaImportMeta && VITE_BUILTIN.test(name)) return;
    const line = (lines[lineNo - 1] || '').replace(/\s\/\/.*$|\s#\s.*$/, '');
    if (/^\s*(\/\/|#|\*|\/\*)/.test(lines[lineNo - 1] || '')) return;
    const v = entry(name);
    if (v.readAt.length < 3 && !v.readAt.includes(rel + ':' + lineNo)) v.readAt.push(rel + ':' + lineNo);
    let required = (REQUIRED_HINT.test(line) && !SOFT_WORDS.test(line)) || requiredRead(name).test(line);
    const fallback = !required && defaultHint(name).test(line);
    const guarded = new RegExp('(if\\s*\\(|&&|\\|\\|)\\s*!\\s*(process\\.env|import\\.meta\\.env)\\??\\.' + name + '\\b').test(line);
    for (let k = 1; !required && !fallback && k <= 2; k++) {
      const next = (lines[lineNo - 1 + k] || '').replace(/\s\/\/.*$/, ''); if (/^\s*(\/\/|#|\*)/.test(next)) continue;
      const others = OTHER_READ.test(next.replace(new RegExp('\\b' + name + '\\b', 'g'), ''));
      if (REQUIRED_HINT.test(next) && !SOFT_WORDS.test(next) && (next.includes(name) || (guarded && !others))) required = true; else if (others) break;
    }
    if (required && !v.requiredAt) v.requiredAt = rel + ':' + lineNo;
    if (!required && !v.hasDefault && (fallback || switchUse(name).test(line))) v.hasDefault = true;
  };
  const visit = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.name === 'pyvenv.cfg')) return;
    for (const e of ents) {
      if (capped) return;
      if (files >= maxFiles || Date.now() - started > maxMs) { capped = true; return; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(path.join(dir, e.name)); continue; }
      if (!e.isFile() || !SOURCE_EXT.test(e.name) || TEST_FILE.test(e.name) || /\.min\.|\.d\.ts$/.test(e.name)) continue;
      const p = path.join(dir, e.name); let st; try { st = fs.statSync(p); } catch { continue; } if (st.size > 512 * 1024) continue;
      let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (!/process\.env|import\.meta\.env|environ|getenv|\bENV\b/.test(text)) continue;
      files++;
      const rel = path.relative(root, p); const lines = text.split('\n');
      const starts = []; { let at = 0; for (const l of lines) { starts.push(at); at += l.length + 1; } }
      const lineNoAt = (idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
      for (const re of READS) { re.lastIndex = 0; let m; while ((m = re.exec(text)) !== null) note(m[1], rel, lineNoAt(m.index), lines, /import\.meta/.test(m[0])); }
      DESTRUCTURE.lastIndex = 0; let d; while ((d = DESTRUCTURE.exec(text)) !== null) { const ln = lineNoAt(d.index); for (const part of d[1].split(',')) { const mm = part.trim().match(/^([A-Z][A-Z0-9_]{1,80})\b\s*(?::\s*\w+)?\s*(=)?/); if (!mm) continue; note(mm[1], rel, ln, lines, false); if (mm[2] && vars.get(mm[1])) vars.get(mm[1]).hasDefault = true; } }

      if (/\bz\s*\.\s*(object|string|enum|url|coerce|number|boolean)\b|createEnv\(/.test(text)) { SCHEMA_FIELD.lastIndex = 0; let s; while ((s = SCHEMA_FIELD.exec(text)) !== null) { const at = s.index + s[0].indexOf(s[1]); const rest = text.slice(at, at + 400); const end = rest.slice(s[1].length).search(NEXT_FIELD); const seg = end < 0 ? rest : rest.slice(0, s[1].length + end); schema.set(s[1], { optional: /\.(optional|default|nullish|catch)\(/.test(seg), at: rel + ':' + lineNoAt(at) }); } }
    }
  };
  for (const d of dirs) { if (capped) break; visit(d); }
  for (const [name, sdef] of schema) { const v = vars.get(name); if (!v) continue; if (sdef.optional) { v.hasDefault = true; v.requiredAt = null; } else { v.requiredAt = v.requiredAt || sdef.at; v.hasDefault = false; } }
  return { vars: [...vars.values()], files, capped, ms: Date.now() - started };
}



export function environmentReport(cfg, { tools } = {}) {
  const dir = realDir(cfg.projectDir);
  const problems = []; const notes = [];
  if (tools && tools.installed === false) problems.push('the browser tooling is not ' + (tools.problem ? 'usable' : 'installed') + ' on this machine — ' + (tools.problem || tools.remedy));
  let deps = null; try { deps = dependencyReport(dir); } catch (e) { deps = { checked: false, note: 'dependency check failed: ' + (e.code || e.message) }; }
  if (deps && deps.problem) problems.push(deps.problem);
  if (deps && deps.note) notes.push(deps.note);
  let envFiles; try { envFiles = envFileReport(dir); } catch { envFiles = { files: [], templates: [], present: new Map() }; }
  const scanDirs = [dir, ...((deps && deps.workspaceDirs) || []).filter((d) => d !== dir && !d.startsWith(dir + path.sep) && !dir.startsWith(d + path.sep))];
  let scan; try { scan = scanEnvReads(scanDirs, { root: dir }); } catch (e) { scan = { vars: [], files: 0, capped: false, error: e.code || e.message }; }
  const expected = new Set(envFiles.templates.flatMap((t) => t.keys));
  for (const n of expected) if (!scan.vars.find((v) => v.name === n)) scan.vars.push({ name: n, readAt: [], requiredAt: null, hasDefault: false, client: CLIENT_PREFIX.test(n), templateOnly: true });
  const vars = scan.vars.filter((v) => !PROVIDED.test(v.name)).map((v) => {
    const inFile = envFiles.present.get(v.name);
    const set = inFile ? inFile : null;
    const fenceMoot = !!v.client && !v.requiredAt && OUTSIDE_SERVICE.test(v.name);
    return { name: v.name, set, ...(inFile === false ? { blank: true } : {}), ...(v.client ? { client: true } : {}), ...(fenceMoot ? { fenceMoot: true } : {}), ...(v.requiredAt ? { requiredAt: v.requiredAt } : {}), ...(v.hasDefault ? { hasDefault: true } : {}), ...(expected.has(v.name) ? { inTemplate: true } : {}), ...(v.templateOnly ? { readAt: 'not found in source; listed in a template' } : { readAt: v.readAt }) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const unset = vars.filter((v) => !v.set);
  const likelyNeeded = unset.filter((v) => !v.fenceMoot && (v.requiredAt || (!v.hasDefault && (v.inTemplate || !v.client))));
  const withKeys = envFiles.files.filter((f) => f.keys > 0).map((f) => f.file);
  const unchecked = envFiles.files.filter((f) => f.unchecked);
  if (unchecked.length) problems.push(unchecked.map((f) => f.file + ' is ' + f.state).join('; ') + ' — what ' + (unchecked.length === 1 ? 'it sets' : 'they set') + ' is not counted below');

  const tmpl = envFiles.templates.find((t) => t.keys.length);
  const empties = envFiles.files.filter((f) => f.empty); const silent = envFiles.files.filter((f) => !f.empty && f.keys === 0 && /^sets no variable/.test(f.state));
  if (empties.length) problems.push(empties.map((f) => f.file).join(', ') + ' ' + (empties.length === 1 ? 'exists but is EMPTY (0 bytes) — the file was created and nothing was written into it' : 'exist but are EMPTY (0 bytes)') + (tmpl ? '; ' + tmpl.file + ' lists the ' + tmpl.keys.length + ' expected keys' : ''));
  if (silent.length) problems.push(silent.map((f) => f.file).join(', ') + ' ' + (silent.length === 1 ? 'exists but sets no variable' : 'exist but set no variable') + ' (every line is a comment or blank — values still to be filled in)' + (tmpl ? '; ' + tmpl.file + ' lists the ' + tmpl.keys.length + ' expected keys' : ''));
  if (tmpl && !envFiles.files.length) problems.push('there is no env file here (.env / .env.local are MISSING — absent, not empty) while ' + tmpl.file + ' lists ' + tmpl.keys.length + ' expected keys: copy it to the name this framework reads (usually .env.local) and fill in what the first pages need');
  if (likelyNeeded.length) {
    const listed = likelyNeeded.slice(0, 16).map((v) => v.name + (v.requiredAt ? ' (looks required at ' + v.requiredAt + ')' : v.blank ? ' (named in an env file with no value)' : ''));
    const fromTemplate = likelyNeeded.filter((v) => v.readAt === 'not found in source; listed in a template').length;
    const who = fromTemplate === likelyNeeded.length ? tmpl.file + ' lists' : fromTemplate ? 'the code reads or ' + tmpl.file + ' lists' : 'the code reads';
    problems.push(likelyNeeded.length + ' variable' + (likelyNeeded.length === 1 ? ' ' + who.replace(/reads$/, 'reads').replace(/lists$/, 'lists') + ' is' : 's ' + who + ' are') + (unchecked.length ? ' not found in the env files that could be read' : ' not set in ' + (withKeys.length ? withKeys.join(', ') : 'any env file here')) + ' (the shell is not checked): ' + listed.join(', ') + (likelyNeeded.length > 16 ? ' and ' + (likelyNeeded.length - 16) + ' more (status environment.env.vars)' : '') + ' — one the app needs at start-up fails every page the same way (the "looks required" ones first; the rest are read with no visible fallback); for a local run a placeholder in .env.local is usually enough');
  }
  const moot = vars.filter((v) => v.fenceMoot);
  if (moot.length) notes.push('moot under the network fence: ' + moot.slice(0, 10).map((v) => v.name).join(', ') + (moot.length > 10 ? ', ...' : '') + ' — browser-side key' + (moot.length === 1 ? '' : 's') + ' for an outside service the test browser cannot reach anyway (only the app\'s origin and allowedOrigins load), so any placeholder is enough');
  const clientUrls = vars.filter((v) => v.client && !v.fenceMoot && /(_URL|_URI|_HOST|_ORIGIN|_ENDPOINT|_DOMAIN|_API)$/.test(v.name));
  if (clientUrls.length) notes.push('browser-side addresses (' + clientUrls.slice(0, 8).map((v) => v.name).join(', ') + '): the host they name must be the app\'s own origin or be listed under allowedOrigins in .claude-testrc, or the test browser blocks those requests (expected, not a failure)');
  const optional = unset.filter((v) => !likelyNeeded.includes(v) && !v.fenceMoot);
  if (optional.length) notes.push(optional.length + ' unset variable' + (optional.length === 1 ? '' : 's') + ' read with a fallback value, as an on/off switch, or only in the browser bundle (fine unset unless a spec needs that feature): ' + optional.slice(0, 12).map((v) => v.name).join(', ') + (optional.length > 12 ? ', ...' : ''));
  if (scan.capped) notes.push('the source scan stopped at its limit (' + scan.files + ' files with env reads, ' + scan.ms + ' ms): the variable list may be incomplete');
  const node = nodeExpectation(dir);
  if (node && node.mismatch) notes.push(node.mismatch);
  const summary = problems.length ? problems.length + ' thing' + (problems.length === 1 ? '' : 's') + ' to fix before a run can get far — see problems' : 'nothing found that would stop a run (dependencies present, env files and variables look set)';
  const depsOut = deps ? (({ workspaceDirs, ...rest }) => ({ ...rest, ...(workspaceDirs && workspaceDirs.length ? { workspacePackagesScanned: workspaceDirs.map((d) => path.relative(dir, d) || '.') } : {}) }))(deps) : null;
  const listed = vars.length > MAX_VARS_LISTED ? [...vars].sort((a, b) => (a.set ? 1 : 0) - (b.set ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, MAX_VARS_LISTED) : vars;
  return { summary, problems, notes, dependencies: depsOut, env: { files: envFiles.files.map(({ empty, ...f }) => f), templates: envFiles.templates.map((t) => ({ file: t.file, keys: t.keys.length })), scannedFiles: scan.files, ...(scan.capped ? { capped: true } : {}), vars: listed, ...(vars.length > MAX_VARS_LISTED ? { varsNotListed: vars.length - MAX_VARS_LISTED } : {}) }, ...(node ? { node } : {}) };
}




const VERSION_SPEC = /^(v?\d+(\.(\d+|x|\*)){0,2}|lts\/[a-z*-]+|node|stable|latest|current|system|[<>=^~ 0-9.x*|-]{1,20})$/i;
export function nodeExpectation(dir) {
  const top = checkoutTop(dir); const running = process.versions.node; const major = Number(running.split('.')[0]);
  let want = null; let from = null;
  for (const d of [dir, top]) { const pkg = readJsonFile(path.join(d, 'package.json')); if (pkg && pkg.engines && typeof pkg.engines.node === 'string' && pkg.engines.node.length <= 60) { want = pkg.engines.node.trim(); from = (path.relative(dir, path.join(d, 'package.json')) || 'package.json') + ' engines.node'; break; } }
  if (!want) for (const d of [dir, top]) { for (const f of ['.nvmrc', '.node-version']) { try { const p = path.join(d, f); const st = fs.lstatSync(p); if (!st.isFile() || st.size > 256) continue; const t = fs.readFileSync(p, 'utf8').trim().split('\n')[0].slice(0, 40); if (/\d/.test(t)) { want = t; from = path.relative(dir, p) || f; break; } } catch {       } } if (want) break; }
  if (!want) return null;
  if (!VERSION_SPEC.test(want)) return { running, from, note: from + ' is present but not a plain version (not shown)' };
  let mismatch = null;
  const minOnly = want.match(/^>=?\s*v?(\d{1,3})(?:[.\dx*]*)$/);
  if (minOnly) { if (major < Number(minOnly[1])) mismatch = 'Node ' + running + ' is older than ' + from + ' requires (' + want + ')'; }
  else { const majors = [...want.matchAll(/(?:^|[\s^~=<>|v])(\d{1,3})(?=[.x*\s|]|$)/g)].map((m) => Number(m[1])).filter((n) => n >= 4 && n < 200); if (majors.length && !majors.includes(major) && !/[<>]/.test(want)) mismatch = 'Node ' + running + ' is running here while ' + from + ' asks for ' + want.replace(/\s+/g, ' ') + ' — if the dev server refuses to start or behaves oddly, switch Node versions first'; }
  return { running, wanted: want, from, ...(mismatch ? { mismatch } : {}) };
}
