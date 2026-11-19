#!/usr/bin/env node
'use strict';
// Creates a small git repo: server/src/fleet.js (CRLF), tag upstream/000000.1, then a commit
// "fleet: fix x" changing two CRLF lines. Prints the base tag. Usage: node make-mini-repo.js <dir>
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanEnv } = require('./tmp.js');

function makeMiniRepo(dir) {
  fs.mkdirSync(path.join(dir, 'server', 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test Author');
  git('config', 'user.email', 'author@example.com');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  const file = path.join(dir, 'server', 'src', 'fleet.js');
  const lines = ['"use strict";', 'function fleetSize(n) {', '  return n + 1;', '}', 'function fleetName(n) {', '  return "fleet" + n;', '}', 'module.exports = { fleetSize, fleetName };'];
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('tag', 'upstream/000000.1');
  lines[2] = '  return n + 2;';
  lines[5] = '  return "fleet-" + n;';
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
  git('commit', '-q', '-am', 'fleet: fix x');
  return 'upstream/000000.1';
}

if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node make-mini-repo.js <dir>'); process.exit(64); }
  console.log(makeMiniRepo(process.argv[2]));
}

module.exports = { makeMiniRepo };
