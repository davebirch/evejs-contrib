'use strict';
// One definition of "an IP address in text", shared by the leak scan (detect) and redact.js (replace).
// IPv4 and IPv6. Loopback, the unspecified address and documentation ranges are never a leak.
const net = require('node:net');

const V4 = '(?<![\\w.])(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?![\\w]|\\.\\d)';
// A candidate IPv6 token: hex digits, colons, and an optional dotted tail (::ffff:a.b.c.d).
const V6_CAND = '(?<![\\w:.])(?=[0-9A-Fa-f:]*:)[0-9A-Fa-f:]{2,}(?:\\.[0-9.]+)?(?![\\w:.])';

const v4Parts = (s) => s.split('.').map(Number);

// 'ok' (never a leak) | 'private' | 'public'
function classify4(s) {
  const [a, b, c] = v4Parts(s);
  if (a === 127 || s === '0.0.0.0') return 'ok';
  if (a >= 240) return 'ok'; // reserved: netmasks (255.255.255.0) and broadcast, never a host
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'ok';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)) return 'private';
  return 'public';
}

function expand6(s) {
  // -> array of 8 numbers (an IPv4 tail counts as two groups), or null
  let tail = [];
  const dot = s.lastIndexOf('.');
  let head = s;
  if (dot >= 0) {
    const colon = s.lastIndexOf(':');
    const p = v4Parts(s.slice(colon + 1));
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    head = s.slice(0, colon + 1) + '0:0';
  }
  const [l, r] = head.split('::');
  const left = l ? l.split(':') : [];
  const right = r === undefined ? [] : r ? r.split(':') : [];
  const nums = (a) => a.map((g) => parseInt(g, 16));
  let out;
  if (head.includes('::')) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    out = [...nums(left), ...Array(fill).fill(0), ...nums(right)];
  } else out = nums(left);
  if (out.length !== 8) return null;
  if (tail.length) out.splice(6, 2, ...tail);
  return out;
}

function classify6(s) {
  const g = expand6(s);
  if (!g) return 'public';
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return 'ok';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'ok';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classify4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return 'private';
  return 'public';
}

// [{ index, text, kind: 'private'|'public' }] for every address in the line that is not exempt.
function findIps(line) {
  const out = [];
  const taken = [];
  for (const m of line.matchAll(new RegExp(V6_CAND, 'g'))) {
    let tok = m[0];
    if (!/\d/.test(tok)) continue; // "a::b" is far more likely code or a word than an address
    if (!net.isIPv6(tok)) {
      // "addr:port" without brackets: try without a trailing :digits
      const cut = tok.replace(/:\d{1,5}$/, '');
      if (cut === tok || !net.isIPv6(cut)) continue;
      tok = cut;
    }
    taken.push([m.index, m.index + tok.length]);
    const kind = classify6(tok);
    if (kind !== 'ok') out.push({ index: m.index, text: tok, kind });
  }
  for (const m of line.matchAll(new RegExp(V4, 'g'))) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const kind = classify4(m[0]);
    if (kind !== 'ok') out.push({ index: m.index, text: m[0], kind });
  }
  return out.sort((a, b) => a.index - b.index);
}

module.exports = { findIps };
