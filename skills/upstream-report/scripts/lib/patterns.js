'use strict';
// Shared by leak-scan.js (detect) and redact.js (replace): one definition of what a home path
// and a literal term look like.

// The unix forms are case-sensitive and the Windows forms spell their case-insensitivity out, so the
// source works without the i flag (redact.js compiles it with g only). A consumer that does add i,
// as leak-scan.js does, must filter its unix matches by case afterwards, or "/users/123" in a URL
// counts as a home path. Group 1 is the trailing
// separator, if any. A Windows user name may hold spaces (it runs to the next backslash, quote or
// line end), as may a macOS one when a "/" follows (up to four words). Separators may be repeated
// when the path has been JSON-escaped more than once, but a backslash run that ends at a quote is
// left alone: it is escaping that quote.
const HOME_PATH_SRC =
  '(?:/' + 'Users/[^/\\s"\'\\\\]+(?: [^/\\s"\'\\\\]+){1,3}(?=/)' +
  '|/(?:home|Users)/[^/\\s"\'\\\\]+' +
  '|(?<![\\w./-])/root(?=/)' +
  '|[A-Za-z]:/+[Dd][Oo][Cc][Uu][Mm][Ee][Nn][Tt][Ss] [Aa][Nn][Dd] [Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]/[^/\\s"\'\\\\]+' +
  '|[A-Za-z]:\\\\+[Dd][Oo][Cc][Uu][Mm][Ee][Nn][Tt][Ss] [Aa][Nn][Dd] [Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\\\\+[^\\\\"\'\\r\\n]+' +
  '|[A-Za-z]:/+[Uu][Ss][Ee][Rr][Ss]/[^/\\s"\'\\\\]+' +
  '|/[a-z]/[Uu][Ss][Ee][Rr][Ss]/[^/\\s"\'\\\\]+' +
  '|[A-Za-z]:\\\\+[Uu][Ss][Ee][Rr][Ss]\\\\+[^\\\\"\'\\r\\n]+)' +
  '(/|\\\\+(?![\\\\"\']))?';

// A session-line account login: user=<login>(<digits>) (upstream's session tag, "[Login] ...: closing
// user=..." and similar) or user=<login> client=<n> (the login-takeover lines). Group 1 is the login,
// group 2 the numeric id (absent in the client= form). An already-redacted <account-N>, "?",
// "unknown" and "undefined(undefined)" do not match.
const ACCOUNT_LOGIN_SRC = '(?<![\\w-])user=(?![<?]|unknown\\s)([^\\s()=<>"\']+)(?:\\((\\d+)\\)|(?= client=\\d))';

// The handshake's quoted login forms: user="<login>", Account "<login>", for "<login>", user "<login>"
// on a [HANDSHAKE] line. Group 1 is the text up to the opening quote, group 2 the login.
const HANDSHAKE_LOGIN_SRC = '(\\[HANDSHAKE\\][^\\n]*?\\b(?:user=|user |Account |for ))"(?![<])([^"\\s\\\\]+)"';

// Log lines that carry a character name in a fixed shape (upstream's own formats; example names are
// made up): "char=<name>(<id>)" in the session tag, "Created character "<name>" with ID", the
// CreateCharacterWithDoll line and "[CharState] Applied <name>(<id>) ship=". Named groups: pre, name, post.
const CHARACTER_SHAPES = [
  '(?<![\\w-])(?<pre>char=)(?<name>[^\\n()<>=\\]]+?)(?<post>\\(\\d+\\))',
  '(?<pre>\\[CharService\\] Created character ")(?<name>[^"\\n]+)(?<post>" with ID)',
  '(?<pre>CreateCharacterWithDoll: name=")(?<name>[^"\\n]+)(?<post>")',
  '(?<pre>\\[CharState\\] Applied )(?<name>[^\\n]+?)(?<post>\\(\\d+\\) ship=)',
];
const NOT_NAMES = new Set(['undefined', 'null', 'none', 'unknown', '?']);
// Is this captured text a real name (not a placeholder, a number, a template or code)?
const isRealName = (n) => {
  const t = n.trim();
  return t.length >= 3 && !/^\d+$/.test(t) && !NOT_NAMES.has(t.toLowerCase()) && !t.startsWith('<') && !/[${}\[\]\\^*+?|]|%s/.test(t);
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word-boundary rule (whole words): boundaries only on word-character ends.
function literalSource(s) {
  const t = s.trim();
  const pre = /^\w/.test(t) ? '(?<!\\w)' : '';
  const post = /\w$/.test(t) ? '(?!\\w)' : '';
  return pre + escapeRe(t) + post;
}

module.exports = { CHARACTER_SHAPES, isRealName, HOME_PATH_SRC, ACCOUNT_LOGIN_SRC, HANDSHAKE_LOGIN_SRC, escapeRe, literalSource };
