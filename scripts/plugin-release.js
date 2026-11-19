#!/usr/bin/env node
'use strict';
// Release evejs-contrib (maintainers). In order, each step refusing with exit 2 and a reason:
//   clean tree on main, only noreply author/committer emails in the history, the whole tracked tree
//   free of your private terms -> claude plugin validate --strict -> headless smoke test -> tests
//   -> bump plugin.json, commit "release: v<x>", tag v<x> -> build the zip from a clone of the tag
//   -> push branch and tag, gh release create with the zip -> update the local install.
// usage: node scripts/plugin-release.js [--patch|--minor|--major] [--owner <owner>] [--remote <name>]
//        [--terms <file>] [--skip-smoke] [--skip-validate] [--dry-run]
// Without a runnable `claude` it refuses (exit 2) unless --skip-validate is given, dry-run included.
// --dry-run runs the read-only checks (tree, validate, smoke, tests) and prints, without running, every
// command that would change anything. Binaries come from EVEJS_CONTRIB_GIT / _GH / _CLAUDE (a path ending
// in .js is run with node), the test command from EVEJS_CONTRIB_TEST; all via execFile semantics, no shell.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { slugFromRepository, scanTexts, identityTerms } = require('../skills/upstream-report/scripts/leak-scan.js');
const { loadUserTerms } = require('../skills/upstream-report/scripts/lib/terms.js');
const { decodeText } = require('../skills/upstream-report/scripts/lib/text.js');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, '.claude-plugin', 'plugin.json');
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
  if (platform === 'win32' && ['claude', 'npm'].includes(fallback)) {
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
    return { status: r.error ? 127 : r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', missing: Boolean(r.error && r.error.code === 'ENOENT') };
  };
}

const show = (b, args) => [b.cmd, ...b.pre, ...args].join(' ').replace(process.execPath, 'node');

function parseArgs(argv) {
  const o = { bump: 'patch', remote: 'origin', owner: null, terms: null, skipSmoke: false, skipValidate: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--patch' || a === '--minor' || a === '--major') o.bump = a.slice(2);
    else if (a === '--skip-smoke') o.skipSmoke = true;
    else if (a === '--skip-validate') o.skipValidate = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (['--owner', '--remote', '--terms'].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function bumped(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!m) refuse(`plugin.json version is not MAJOR.MINOR.PATCH: ${version}`);
  const [ma, mi, pa] = m.slice(1).map(Number);
  return kind === 'major' ? `${ma + 1}.0.0` : kind === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
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

function release(opts, env = process.env, say = console.log) {
  const git = bin('EVEJS_CONTRIB_GIT', 'git', env);
  const gh = bin('EVEJS_CONTRIB_GH', 'gh', env);
  const claude = bin('EVEJS_CONTRIB_CLAUDE', 'claude', env);
  const run = makeRunner(env);
  const must = (b, args, what, o) => {
    const r = run(b, args, o);
    if (r.status !== 0) refuse(`${what} failed:\n${r.out.trim()}`);
    return r;
  };

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const slug = slugFromRepository(pkg.repository);
  const repoName = slug ? slug.split('/')[1] : PLUGIN;
  const owner = opts.owner || (slug ? slug.split('/')[0] : '');
  if (!owner) refuse('no GitHub owner: pass --owner or set "repository" in package.json');
  const repoSlug = `${owner}/${repoName}`;

  // 1. clean tree, main only
  const branch = must(git, ['branch', '--show-current'], 'git branch').stdout.trim();
  if (branch !== 'main') refuse(`release from main only (on ${branch || 'a detached HEAD'})`);
  const dirty = must(git, ['status', '--porcelain'], 'git status').stdout.trim();
  if (dirty) refuse(`working tree is dirty; commit or remove first:\n${dirty}`);
  const remoteUrl = run(git, ['remote', 'get-url', opts.remote]);
  if (remoteUrl.status !== 0) refuse(`no git remote named ${opts.remote}`);

  // The tag is pushed to --remote but the release is created on <owner>/<repo>: they must be the same repository.
  // (Only the tests skip this: their remote is a local bare repository.)
  if (!env.EVEJS_CONTRIB_TEST_NO_REMOTE_CHECK) {
    const remoteSlug = slugFromRepository(remoteUrl.stdout.trim());
    if (remoteSlug.toLowerCase() !== repoSlug.toLowerCase()) {
      refuse(`remote ${opts.remote} (${remoteSlug || remoteUrl.stdout.trim()}) is not ${repoSlug}: the release would be created on a different repository than the one the tag is pushed to`);
    }
  }

  // Everything reachable from this release is published, so no commit may carry a private address.
  const noreply = (e) => /@users\.noreply\.github\.com$/i.test(e);
  const emails = must(git, ['log', '--format=%H %ae %ce', 'HEAD'], 'git log').stdout.trim().split('\n').filter(Boolean)
    .flatMap((l) => { const [h, a, c] = l.split(' '); return [[h, a], [h, c]]; })
    .filter(([, e]) => !noreply(e));
  const bad = [...new Set(emails.map(([h, e]) => `${h.slice(0, 10)} ${e.replace(/^[^@]*/, '***')}`))];
  if (bad.length) {
    refuse(`commits reachable from HEAD have an author or committer email that is not a @users.noreply.github.com address (${bad.length}):\n${bad.slice(0, 10).join('\n')}\nRe-author them before releasing`);
  }
  // The release commit is made with this checkout's own identity.
  for (const v of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const ident = must(git, ['var', v], `git var ${v}`).stdout.trim();
    const email = (/<([^>]*)>/.exec(ident) || [])[1] || '';
    if (!noreply(email)) refuse(`git ${v} is not a @users.noreply.github.com address: set user.name and user.email in this checkout first`);
  }
  // The zip scan covers the zip only, but the push publishes every tracked file: scan all of them for the
  // user's private terms and identity (the generic checks stay off: the tests plant example paths on purpose).
  scanTracked(git, run, slug, opts);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const version = bumped(manifest.version, opts.bump);
  const tag = `v${version}`;
  if (run(git, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0) refuse(`tag ${tag} already exists`);

  // the remote must not already have the tag, nor commits we lack (checked now, before anything is committed)
  const remoteTag = must(git, ['ls-remote', '--tags', opts.remote, `refs/tags/${tag}`], `git ls-remote ${opts.remote}`).stdout.trim();
  if (remoteTag) refuse(`${opts.remote} already has tag ${tag}; pull or pick another bump`);
  // ls-remote only (no fetch, so a dry run touches nothing): the remote's main must be an ancestor of HEAD,
  // and a commit we do not have locally is not one
  const remoteMain = must(git, ['ls-remote', '--heads', opts.remote, 'refs/heads/main'], `git ls-remote ${opts.remote}`).stdout.trim().split(/\s+/)[0];
  if (remoteMain && run(git, ['merge-base', '--is-ancestor', remoteMain, 'HEAD']).status !== 0) {
    refuse(`${opts.remote}/main has commits this checkout lacks (or has diverged); pull or rebase first`);
  }

  // 2. validate and smoke test. Fail closed: no runnable claude means no release unless --skip-validate.
  const haveClaude = run(claude, ['--version']).status === 0;
  if (!haveClaude && !opts.skipValidate) {
    refuse('claude cannot be found or run, so the plugin cannot be validated; install it, or pass --skip-validate to release without validation');
  }
  if (opts.skipValidate) say('validation and smoke test skipped (--skip-validate)');
  if (!haveClaude) say('claude is not available: skipping the local install update too');
  if (haveClaude && !opts.skipValidate) {
    say('claude plugin validate --strict');
    must(claude, ['plugin', 'validate', '--strict', '.'], 'claude plugin validate --strict');
    if (opts.skipSmoke) say('smoke test skipped (--skip-smoke)');
    else {
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
    }
  }

  // 3. tests
  say('tests');
  if (env.EVEJS_CONTRIB_TEST) must(bin('EVEJS_CONTRIB_TEST', '', env), [], 'tests');
  else {
    if (!(pkg.scripts && pkg.scripts.test)) refuse('package.json has no "test" script');
    must(bin('EVEJS_CONTRIB_NPM', 'npm', env), ['test'], 'npm test');
  }

  const zipDir = path.join(ROOT, 'dist');
  const zipName = `${PLUGIN}-${version}.zip`;
  const pushArgs = ['push', '--atomic', opts.remote, 'main', tag];
  const ghArgs = (zip) => ['release', 'create', tag, zip, '--repo', repoSlug, '--title', `${PLUGIN} ${tag}`, '--generate-notes'];
  const updates = [['plugin', 'marketplace', 'update', PLUGIN], ['plugin', 'update', `${PLUGIN}@${PLUGIN}`]];

  if (opts.dryRun) {
    say(`[dry-run] would bump ${manifest.version} -> ${version} in .claude-plugin/plugin.json, commit "release: ${tag}" and tag ${tag}`);
    say(`[dry-run] ${show(git, ['clone', '--branch', tag, ROOT, '<temp>'])} && node <temp>/scripts/build-zip.js --out ${zipDir}`);
    say(`[dry-run] ${show(git, pushArgs)}`);
    say(`[dry-run] ${show(gh, ghArgs(path.join(zipDir, zipName)))}`);
    if (haveClaude) updates.forEach((u) => say(`[dry-run] ${show(claude, u)}`));
    say(`dry run complete, nothing changed (would have released ${tag}).`);
    return { version, tag, dryRun: true };
  }

  // 4. bump, commit, tag. A failure from here until the push undoes the commit and tag.
  const before = must(git, ['rev-parse', 'HEAD'], 'git rev-parse').stdout.trim();
  const undo = () => {
    run(git, ['tag', '-d', tag]);
    run(git, ['reset', '--hard', before]);
  };
  let tmp = null;
  let zip = null;
  try {
    manifest.version = version;
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    must(git, ['add', '.claude-plugin/plugin.json'], 'git add');
    must(git, ['commit', '-q', '-m', `release: ${tag}`, '--', '.claude-plugin/plugin.json'], 'git commit');
    must(git, ['tag', tag], 'git tag');
    say(`bumped to ${version}, committed and tagged ${tag}`);

    // 5. zip from a clone of the tag, so uncommitted files cannot get in
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evejs-contrib-release-'));
    const clone = path.join(tmp, 'src');
    must(git, ['clone', '-q', '--branch', tag, ROOT, clone], 'git clone of the tag');
    const buildArgs = [path.join(clone, 'scripts', 'build-zip.js'), '--out', zipDir, ...(opts.terms ? ['--terms', path.resolve(opts.terms)] : [])];
    const built = must({ cmd: process.execPath, pre: [] }, buildArgs, 'build-zip', { spawn: { cwd: clone } });
    zip = built.stdout.trim().split('\n').pop();
    if (path.basename(zip) !== zipName) refuse(`build-zip wrote ${zip}, expected ${zipName}`);
  } catch (e) {
    undo();
    say(`undid the release commit and tag ${tag}`);
    throw e;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 6. publish: past this point nothing is undone
  say(`${show(git, pushArgs)}`);
  const pushed = run(git, pushArgs);
  if (pushed.status !== 0) {
    refuse(`git push failed; nothing was published, but the release commit and tag ${tag} are still local.\n${pushed.out.trim()}\n` +
      `Retry: ${show(git, pushArgs)}\n` +
      `Undo:  git tag -d ${tag} && git reset --hard ${before}`);
  }
  say(show(gh, ghArgs(zip)));
  const rel = run(gh, ghArgs(zip));
  if (rel.status !== 0) refuse(`pushed ${tag} but gh release create failed; rerun: ${show(gh, ghArgs(zip))}\n${rel.out.trim()}`);

  // 7. local install
  let updateFailed = false;
  if (haveClaude) {
    for (const u of updates) {
      say(show(claude, u));
      const r = run(claude, u);
      if (r.status !== 0) { updateFailed = true; say(`failed: ${r.out.trim()}`); break; }
    }
  }
  say(`released ${tag}. Running sessions keep their plugin version until restart or /reload-plugins.`);
  if (updateFailed) refuse(`released ${tag}, but the local install update failed (see above)`);
  return { version, tag, zip };
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    console.error(e.message);
    console.error('usage: node scripts/plugin-release.js [--patch|--minor|--major] [--owner <owner>] [--remote <name>] [--terms <file>] [--skip-smoke] [--skip-validate] [--dry-run]');
    process.exit(64);
  }
  try { release(opts); } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(`refusing: ${e.message}`);
    process.exit(2);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { release, parseArgs, bumped, bin, winCmdLine };
