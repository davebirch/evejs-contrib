'use strict';
// Decides by content (not by file extension) whether a file is text, and decodes it. Text is UTF-8
// (with or without a BOM) or UTF-16 with a BOM (what Windows PowerShell 5.1 writes for ">").
// Anything else with a NUL byte in its first 8 KiB is binary.

const hasNul = (buf) => buf.subarray(0, 8192).includes(0);

function utf16beToLe(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}

// -> { text, enc: 'utf8'|'utf16le'|'utf16be'|'latin1', bom, lossy } or null when the file is binary.
// lossy: not valid UTF-8, read as latin1 (only when it holds no NUL).
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), enc: 'utf16le', bom: true, lossy: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: utf16beToLe(buf.subarray(2)).toString('utf16le'), enc: 'utf16be', bom: true, lossy: false };
  }
  if (hasNul(buf)) return null;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf), enc: 'utf8', bom: false, lossy: false };
  } catch (e) {
    return { text: buf.toString('latin1'), enc: 'latin1', bom: false, lossy: true };
  }
}

// Inverse of decodeText for text that was changed. The text keeps any leading U+FEFF it was decoded with
// (UTF-8); UTF-16 gets its BOM back.
function encodeText(text, enc) {
  if (enc === 'latin1') return Buffer.from(text, 'latin1');
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (enc === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beToLe(Buffer.from(text, 'utf16le'))]);
  return Buffer.from(text, 'utf8');
}

module.exports = { decodeText, encodeText, hasNul };
