'use strict';
// Temp dirs for tests. Every dir made here is removed when the test process exits (node --test runs
// each file in its own process), so `npm test` leaves nothing in the temp folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = [];
process.on('exit', () => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
});

const mk = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};

// A process environment for child processes: no GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE from a
// surrounding git hook, so a test's git commands can never act on the real repository.
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[k];
  return env;
};

// Requiring this module also drops those variables from this process, so every child a test spawns
// (git included) inherits a clean environment.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete process.env[k];

module.exports = { mk, cleanEnv };
