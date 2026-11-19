'use strict';
// One definition of "looks like a LAN host name", shared by the leak scan and `leak-terms init`.
// First labels that make a name ending in one of the suffixes below a property access, not a host name.
const NOT_HOSTS = new Set(['this', 'self', 'that', 'module', 'exports', 'process', 'config', 'cfg', 'settings',
  'options', 'opts', 'window', 'global', 'state', 'props', 'ctx', 'obj', 'req', 'res', 'data', 'env', 'conf']);
const LAN_SRC = '(?:(?<=:\\/\\/)|(?<=\\\\\\\\)|(?<=(?<![:\\w])\\/\\/)|(?<![\\w./\\\\-]))(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-]+\\.(?:lan|local|internal|home\\.arpa)(?![\\w-])(?!\\.\\w)(?!\\()';

// A camelCase middle label in a 3+-label match means a code property chain
// (a camelCase name in the middle), not a host. A two-label name is always a host.
const isCodeLike = (host) => {
  const labels = host.split('.');
  return labels.length >= 3 && labels.slice(0, -1).some((l) => /[a-z][A-Z]/.test(l));
};

function findHosts(line) {
  const out = [];
  for (const m of line.matchAll(new RegExp(LAN_SRC, 'gi'))) {
    const h = m[0];
    if (NOT_HOSTS.has(h.split('.')[0].toLowerCase()) || isCodeLike(h)) continue;
    out.push(h);
  }
  return out;
}

module.exports = { findHosts };
