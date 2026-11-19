#!/usr/bin/env node
'use strict';
// Manages your private leak-terms file (default: <config dir>/leak-terms, see lib/config.js).
//   init [--logs <dir|report.zip>] [--add <term>]... [--remove <term>]... [--character <name>]... [--file <file>] [--yes]
//   edit [--add ...] [--remove ...] [--character ...] [--file <file>]   (no flags: opens your editor)
//   show [--logs <dir|report.zip>] [--file <file>]
//   --help (or <command> --help) prints the usage.
// Terms you pass with --add that are your own identity (git name/email, login, host) are written under
// [identity]: the scan treats them like the auto-detected identity (a "Signed: <name>" line is exempt).
// Exit 0 ok, 64 usage.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defaultTermsPath } = require('./lib/config.js');
const { identityTerms } = require('./lib/identity.js');
const { candidates, scanLogs } = require('./lib/candidates.js');
const { readTermsFile, editTermsText } = require('./lib/terms.js');

// The older flag name still parses (silently; never printed or documented).
const OLD_CHARACTER_FLAG = '--' + 'play' + 'er';

const USAGE = `usage: node leak-terms.js init|edit|show [--logs <dir|report.zip>] [--add <term>]... [--remove <term>]... [--character <name>]... [--file <file>] [--yes]
  init   proposes candidates; writes only with --yes and the confirmed --add/--character list
  edit   --add/--remove/--character change the file; with none of them it opens your editor
  show   one-line summary; with --logs, also new character names
  --file <file>  manage that file instead of the default one`;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(64);
}

function parse(argv) {
  const o = { add: [], remove: [], character: [], logs: null, file: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--yes') o.yes = true;
    else if (['--add', '--remove', '--character', OLD_CHARACTER_FLAG, '--logs', '--file', '--terms'].includes(a)) {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      const v = argv[++i];
      if (a === '--logs') o.logs = v;
      else if (a === '--file' || a === '--terms') o.file = v; // --terms is the older name of --file
      else o[a === OLD_CHARACTER_FLAG ? 'character' : a.slice(2)].push(v);
    } else usage(`unknown option: ${a}`);
  }
  if (o.logs && !(fs.existsSync(o.logs) && (fs.statSync(o.logs).isDirectory() || /\.zip$/i.test(o.logs)))) {
    usage(`no such logs folder or report zip: ${o.logs}`);
  }
  return o;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const load = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const summaryLine = (file) => {
  const { terms, names, identity } = fs.existsSync(file) ? readTermsFile(file) : { terms: [], names: [], identity: [] };
  return `scanning for ${terms.length + names.length + identity.length} private terms (${names.length} character names); leak-terms edit to change`;
};

function newNames(file, logs) {
  const have = new Set();
  if (fs.existsSync(file)) {
    const { terms, names, identity } = readTermsFile(file);
    for (const t of [...terms, ...names, ...identity]) if (typeof t === 'string') have.add(t.toLowerCase());
  }
  return scanLogs(logs).names.filter((n) => !have.has(n.toLowerCase()));
}

// --add terms that are the user's own identity go under [identity].
function splitIdentity(o, identity = identityTerms()) {
  const mine = new Set(identity.map((t) => t.toLowerCase()));
  return { ...o, add: o.add.filter((t) => !mine.has(t.trim().toLowerCase())), identity: o.add.filter((t) => mine.has(t.trim().toLowerCase())) };
}

function init(o, file) {
  const list = candidates({ identity: identityTerms(), logsDir: o.logs });
  const exists = fs.existsSync(file);
  console.log(`terms file: ${file}${exists ? ' (exists)' : ''}`);
  console.log('candidates (nothing is added until you confirm them):');
  list.forEach((c, i) => console.log(`${i + 1}. ${c.term}  [${c.kind === 'character' ? 'character name' : 'term'}; ${c.source}]`));
  if (!list.length) console.log('(none found)');
  console.log('Ask: anything else you would rather not share?');
  if (!o.yes) {
    console.log('proposal only; nothing written — re-run with --yes and the confirmed list (--add for terms, --character for character names)');
    return;
  }
  write(file, editTermsText(load(file), splitIdentity(o)));
  console.log(summaryLine(file));
}

// Splits an editor command ("code --wait", '"C:\\Program Files\\x\\ed.exe" -w') without a shell.
function splitCommand(str) {
  return [...str.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
}

// Builds the spawn call. Windows can only launch .cmd/.bat editors through a shell, so only those
// get one, with every part quoted; everything else is spawned directly (no shell, spaces safe).
function editorSpawn(parts, file, platform = process.platform) {
  const [cmd, ...args] = parts;
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    return { cmd: [cmd, ...args, file].map((p) => `"${p}"`).join(' '), args: [], options: { shell: true } };
  }
  return { cmd, args: [...args, file], options: {} };
}

// Spawns the editor. On Windows a bare name like "code" resolves to code.cmd, which a no-shell spawn
// cannot start: on ENOENT retry once through a quoted shell command.
function runEditor(parts, file, { platform = process.platform, spawn = spawnSync } = {}) {
  const sp = editorSpawn(parts, file, platform);
  const r = spawn(sp.cmd, sp.args, { stdio: 'inherit', ...sp.options });
  if (platform === 'win32' && r.error && r.error.code === 'ENOENT' && !sp.options.shell) {
    return spawn([...parts, file].map((p) => `"${p}"`).join(' '), [], { stdio: 'inherit', shell: true });
  }
  return r;
}

function edit(o, file) {
  if (!o.add.length && !o.remove.length && !o.character.length) {
    if (!fs.existsSync(file)) write(file, editTermsText('', {}));
    const [cmd, ...args] = splitCommand(process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi'));
    const r = runEditor([cmd, ...args], file);
    if (r.error) {
      console.error(`could not run editor "${cmd}": ${r.error.message}`);
      process.exit(1);
    }
    process.exit(r.status === null ? 1 : r.status);
  }
  write(file, editTermsText(load(file), splitIdentity(o)));
  console.log(summaryLine(file));
}

function show(o, file) {
  console.log(summaryLine(file));
  if (o.logs) {
    const fresh = newNames(file, o.logs);
    if (fresh.length) console.log(`new character names: ${fresh.join(', ')}`);
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (!['init', 'edit', 'show'].includes(cmd)) usage();
  const o = parse(rest);
  const file = o.file || defaultTermsPath();
  try {
    ({ init, edit, show })[cmd](o, file);
  } catch (e) {
    usage(e.message);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, editorSpawn, runEditor };
