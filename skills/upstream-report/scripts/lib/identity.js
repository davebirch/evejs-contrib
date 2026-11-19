'use strict';
// The user's own identity, auto-detected: git user.name and user.email, the email's local part,
// login name and hostname. Sources are injectable so tests never depend on the real machine.
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const safe = (fn) => { try { return fn() || ''; } catch (e) { return ''; } };
const gitConfig = (key) =>
  safe(() => execFileSync('git', ['config', '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

// Common words that would flood the scan if a machine happened to use them.
const COMMON = new Set(['root', 'node', 'localhost', 'user', 'admin', 'administrator', 'ubuntu', 'debian', 'docker', 'default', 'guest', 'test', 'runner']);

function identityTerms({
  get = gitConfig,
  username = safe(() => os.userInfo().username),
  hostname = safe(() => os.hostname()),
} = {}) {
  const name = get('user.name') || '';
  const email = get('user.email') || '';
  // a fully qualified host name also yields its first label
  const firstLabel = hostname.includes('.') ? hostname.split('.')[0] : '';
  const terms = [name, email, email.includes('@') ? email.split('@')[0] : '', username, hostname, firstLabel]
    .map((s) => (s || '').trim())
    .filter((s) => s.length >= 3 && !COMMON.has(s.toLowerCase()));
  return [...new Set(terms)];
}

module.exports = { identityTerms };
