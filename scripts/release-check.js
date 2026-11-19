#!/usr/bin/env node
'use strict';
// Local pre-release check (maintainers). Releases are made by release-please in CI; this runs the checks that
// need your machine, and never bumps, tags, pushes or publishes. In order, each refusing with exit 2:
//   the whole tracked tree free of your private terms -> claude plugin validate --strict
//   -> headless smoke test (claude --plugin-dir . names every skill).
// usage: node scripts/release-check.js [--terms <file>] [--skip-smoke] [--skip-validate]
// Without a runnable `claude` it refuses unless --skip-validate is given. Binaries come from EVEJS_CONTRIB_GIT /
// _CLAUDE (a path ending in .js is run with node); all via execFile semantics, no shell.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { slugFromRepository, scanTexts, identityTerms } = require('../skills/upstream-report/scripts/leak-scan.js');
const { loadUserTerms } = require('../skills/upstream-report/scripts/lib/terms.js');
const { decodeText } = require('../skills/upstream-report/scripts/lib/text.js');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = 'evejs-contrib';

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

// Windows installs npm packages as `<name>.cmd`, which spawn cannot run without a shell: find the real file
// on PATH and mark a .cmd as a shim to be run through cmd.exe with explicit quoting.
function findOnWindowsPath(name, env) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  // like Windows: directory by directory, each tried with the PATHEXT extensions in order
  for (const d of dirs) {
    for (const ext of ['.exe', '.cmd']) {
      const f = path.join(d, name + ext);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

const bin = (name, fallback, env, platform = process.platform) => {
  const v = env[name];
  if (v) return v.toLowerCase().endsWith('.js') ? { cmd: process.execPath, pre: [v] } : { cmd: v, pre: [] };
  if (platform === 'win32' && fallback === 'claude') {
    const f = findOnWindowsPath(fallback, env);
    if (f) return { cmd: f, pre: [], shim: f.toLowerCase().endsWith('.cmd') };
  }
  return { cmd: fallback, pre: [] };
};

// cmd.exe has no way to escape a double quote or %, and ^ & | < > ! are live outside quotes, so a .cmd shim
// only gets arguments free of all of them (refused, never mangled). Everything else is wrapped in quotes.
const CMD_UNSAFE = /["%^&|<>!\r\n]/;
function winCmdLine(parts) {
  const bad = parts.find((a) => CMD_UNSAFE.test(String(a)));
  if (bad !== undefined) refuse(`cannot pass ${JSON.stringify(String(bad))} through cmd.exe (it contains one of " % ^ & | < > ! or a newline)`);
  return `"${parts.map((a) => `"${a}"`).join(' ')}"`;
}

function makeRunner(env) {
  return (b, args, opts = {}) => {
    const spawnOpts = { encoding: 'utf8', cwd: ROOT, env, timeout: opts.timeout, ...opts.spawn };
    const r = b.shim
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', winCmdLine([b.cmd, ...b.pre, ...args])], { ...spawnOpts, windowsVerbatimArguments: true })
      : spawnSync(b.cmd, [...b.pre, ...args], spawnOpts);
    return { status: r.error ? 127 : r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
  };
}

function parseArgs(argv) {
  const o = { terms: null, skipSmoke: false, skipValidate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-smoke') o.skipSmoke = true;
    else if (a === '--skip-validate') o.skipValidate = true;
    else if (a === '--terms') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o.terms = argv[++i];
    } else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function scanTracked(git, run, slug, opts) {
  let user;
  try { user = loadUserTerms({ files: opts.terms ? [path.resolve(opts.terms)] : [] }); } catch (e) { refuse(`cannot use terms file: ${e.message}`); }
  const files = run(git, ['ls-files', '-z']);
  if (files.status !== 0) refuse(`git ls-files failed:\n${files.out.trim()}`);
  const texts = [];
  for (const rel of files.stdout.split('\0').filter(Boolean)) {
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, rel)); } catch (e) { continue; }
    const d = decodeText(buf);
    if (d) texts.push({ name: `${PLUGIN}/${rel}`, text: d.text.replace(/^\uFEFF/, '') });
  }
  const hits = scanTexts(texts, { terms: user.terms, names: user.names, identity: [...identityTerms(), ...user.identity], selfRefs: slug ? [slug] : [], generic: false });
  if (hits.length) {
    refuse(`private terms in tracked files (the whole repository is published, not only the zip):\n${hits.slice(0, 20).map((h) => `${h.name.split('/').slice(1).join('/')}:${h.line}: ${h.term}`).join('\n')}`);
  }
}

function check(opts, env = process.env, say = console.log) {
  const git = bin('EVEJS_CONTRIB_GIT', 'git', env);
  const claude = bin('EVEJS_CONTRIB_CLAUDE', 'claude', env);
  const run = makeRunner(env);
  const must = (b, args, what, o) => {
    const r = run(b, args, o);
    if (r.status !== 0) refuse(`${what} failed:\n${r.out.trim()}`);
    return r;
  };

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const slug = slugFromRepository(pkg.repository);

  // The whole repository is published, not only the zip: scan every tracked file for the user's private terms.
  say('leak scan of the tracked tree');
  scanTracked(git, run, slug, opts);

  const haveClaude = run(claude, ['--version']).status === 0;
  if (!haveClaude && !opts.skipValidate) {
    refuse('claude cannot be found or run, so the plugin cannot be validated; install it, or pass --skip-validate');
  }
  if (opts.skipValidate) {
    say('validation and smoke test skipped (--skip-validate)');
    return { validated: false };
  }
  say('claude plugin validate --strict');
  must(claude, ['plugin', 'validate', '--strict', '.'], 'claude plugin validate --strict');
  if (opts.skipSmoke) {
    say('smoke test skipped (--skip-smoke)');
    return { validated: true, smoke: false };
  }
  const skills = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  let smokeDir = null;
  try {
    say('smoke test: headless session with --plugin-dir .');
    const prompt = `List the names of the skills that the ${PLUGIN} plugin provides, one per line. Do not run any tools.`;
    // a file, not inline JSON: its quotes could not pass through cmd.exe
    smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evejs-contrib-smoke-'));
    const mcpConfig = path.join(smokeDir, 'mcp.json');
    fs.writeFileSync(mcpConfig, '{"mcpServers":{}}\n');
    const r = must(claude, ['--plugin-dir', '.', '-p', prompt, '--strict-mcp-config', '--mcp-config', mcpConfig, '--tools', 'Skill', '--allowedTools', 'Skill'], 'smoke test', { timeout: 300000 });
    const missing = skills.filter((s) => !new RegExp(`(?<![\\w-])${s}(?![\\w-])`).test(r.out));
    if (missing.length) refuse(`smoke test: the session did not list ${missing.join(', ')}:\n${r.out.trim()}`);
  } finally {
    if (smokeDir) fs.rmSync(smokeDir, { recursive: true, force: true });
  }
  say('all checks passed');
  return { validated: true, smoke: true };
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    console.error(e.message);
    console.error('usage: node scripts/release-check.js [--terms <file>] [--skip-smoke] [--skip-validate]');
    process.exit(64);
  }
  try { check(opts); } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(`refusing: ${e.message}`);
    process.exit(2);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { check, parseArgs, bin, winCmdLine };
