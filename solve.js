// A fast, dependency-free reimplementation of makefun-site 1.0.0's build.
// Written from the spec in the vendor README and the reference behaviour:
// same output tree for every input, byte for byte, but with the hot paths
// (inline Markdown, escaping, slug work, template rendering) reworked for
// speed: runs are scanned with one regex instead of per-character escapes,
// blocks are lexed in a single index-based pass without splitting the body
// into lines or building a token list, repeated slug/date work is cached,
// and templates render into one shared output array.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Most strings hold none of them. */
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_ALL, (c) => ESC[c]) : s;
}

const NONASCII = /[^\x00-\x7F]/;
const slugCache = new Map();

/** The slug of `text` (README.md, "Text"). Results are cached: tag names and headings repeat a lot. */
function slugify(text) {
  let s = slugCache.get(text);
  if (s === undefined) {
    s = slugifySlow(text);
    slugCache.set(text, s);
  }
  return s;
}

function slugifySlow(text) {
  if (!NONASCII.test(text)) {
    // ASCII only: NFKD is the identity and no combining mark can occur.
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let a = 0, b = out.length;
    while (a < b && out.charCodeAt(a) === 45) a++;
    while (b > a && out.charCodeAt(b - 1) === 45) b--;
    out = out.slice(a, b);
    if (out.length > 64) {
      out = out.slice(0, 64);
      let c = out.length;
      while (c > 0 && out.charCodeAt(c - 1) === 45) c--;
      out = out.slice(0, c);
    }
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. Dates repeat a lot. */
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, v);
  }
  return v;
}

/** Whether code unit `c` is JavaScript whitespace (the \s set). */
const WS_TABLE = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32, 160]) WS_TABLE[c] = 1;
function isWSCode(c) {
  return c < 256 ? WS_TABLE[c] === 1 : c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. No array is built. */
function wordsOf(s) {
  let n = 0, inW = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13) { inW = false; continue; }
    if (c < 128) { if (!inW) { inW = true; n++; } continue; }
    if (isWSCode(c)) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * Lines are walked by index, never split into an array, and the body is a
 * slice of the text after the closing line (the same text the reference
 * rebuilds by joining lines).
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45 ||
      (text.length > 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  // Find the closing line first: a bad line before it still reports the missing close.
  const firstLine = text.length === 3 ? 3 : 4;
  let closeStart = -1, closeNl = -1;
  let p = firstLine;
  while (p <= text.length) {
    const nl = text.indexOf('\n', p);
    const e = nl === -1 ? text.length : nl;
    if (e - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closeStart = p;
      closeNl = nl;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2;
  p = firstLine;
  while (p < closeStart) {
    const nl = text.indexOf('\n', p);
    const e = nl === -1 ? text.length : nl;
    let j = p, blank = true;
    while (j < e) {
      const c = text.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
      j++;
    }
    if (!blank && text.charCodeAt(p) !== 35) {
      const colon = text.indexOf(':', p);
      let keyOk = colon !== -1 && colon < e && colon > p;
      if (keyOk) {
        for (let k = p; k < colon; k++) {
          const c = text.charCodeAt(k);
          if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
        }
      }
      if (!keyOk) return { error: `line ${lineNo} is not "key: value"` };
      let rawStart;
      if (colon + 1 === e) rawStart = e;
      else if (text.charCodeAt(colon + 1) === 32) rawStart = colon + 2;
      else return { error: `line ${lineNo} is not "key: value"` };
      let rawEnd = e;
      while (rawEnd > rawStart && (text.charCodeAt(rawEnd - 1) === 32 || text.charCodeAt(rawEnd - 1) === 9)) rawEnd--;
      const raw = text.slice(rawStart, rawEnd);
      const key = text.slice(p, colon);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const WS_TEST = /\s/;

/** `s` rendered inline into `out`, over the range [a, b). */
function inlineRange(s, a, b, env, out) {
  let i = a;
  while (i < b) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m !== null && m.index < b ? m.index : b;
    if (j > i) {
      out.push(s.slice(i, j));
      i = j;
      if (i >= b) break;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        out.push('<code>' + esc(s.slice(i + 1, k)) + '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1, b);
        if (k > i + 1) {
          out.push('<em>');
          inlineRange(s, i + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      let m2 = -1;
      if (k !== -1 && s[k + 1] === '(') m2 = s.indexOf(')', k + 2);
      let target = '';
      if (m2 !== -1 && m2 < b) target = s.slice(k + 2, m2);
      if (target !== '' && !WS_TEST.test(target)) {
        out.push('<a href="' + esc(env.link(target)) + '">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m2 + 1;
      } else {
        out.push('[');
        i++;
      }
      continue;
    }
    out.push(ESC[c]);
    i++;
  }
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j <= end - wl; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether the line [s, e) of `src` holds only spaces and tabs. */
function lineBlank(src, s, e) {
  for (let j = s; j < e; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The line [s, e) with spaces and tabs at either end dropped. */
function trimSlice(src, s, e) {
  while (s < e && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  return src.slice(s, e);
}

/** A fence's language, or null when the line [s, e) does not open one. */
function fenceLang(src, s, e) {
  if (src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return null;
  let j = s + 3;
  while (j < e) {
    const c = src.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = src.slice(s + 3, j);
  while (j < e) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether the line [s, e) closes a fence. */
function fenceClose(src, s, e) {
  if (src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let j = s + 3; j < e; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingAt(src, s, e) {
  let d = 0;
  while (d < 6 && src.charCodeAt(s + d) === 35) d++;
  if (d === 0) return null;
  let j = s + d;
  if (src.charCodeAt(j) !== 32 && src.charCodeAt(j) !== 9) return null;
  while (j < e && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
  let te = e;
  while (te > j && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
  if (te <= j) return null;
  return { depth: d, text: src.slice(j, te) };
}

/** Whether the line [s, e) is a thematic break. */
function isHr(src, s, e) {
  if (e - s < 3) return false;
  const c0 = src.charCodeAt(s);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(s + 1) !== c0 || src.charCodeAt(s + 2) !== c0) return false;
  for (let j = s + 3; j < e; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text start, or -1 when the line [s, e) does not open one. */
function bulletAt(src, s, e) {
  const c = src.charCodeAt(s);
  if ((c === 45 || c === 42) && src.charCodeAt(s + 1) === 32) return s + 2;
  return -1;
}

/** An ordered item's [number, text start], or null. */
function orderedAt(src, s, e) {
  let j = s, n = 0;
  while (j < e) {
    const c = src.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
    n++;
  }
  if (n === 0 || n > 9) return null;
  if (src.charCodeAt(j) !== 46 || src.charCodeAt(j + 1) !== 32) return null;
  return [Number(src.slice(s, j)), j + 2];
}

/** Whether the line [s, e) continues a list item (two or more spaces, then a non-space). */
function isContinued(src, s, e) {
  let j = s;
  while (j < e && src.charCodeAt(j) === 32) j++;
  if (j - s < 2) return false;
  if (j >= e) return false;
  return !isWSCode(src.charCodeAt(j));
}

/** Whether the line [s, e) ends a paragraph. */
function endsParagraph(src, s, e) {
  return lineBlank(src, s, e) || fenceLang(src, s, e) !== null || headingAt(src, s, e) !== null || isHr(src, s, e);
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * One index-based pass over the body: no line array, no token list, blocks
 * are rendered as they are found, straight into one output array that is
 * joined once at the end. Only a heading's inline HTML is built apart,
 * because the table of contents keeps it.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const len = src.length;
  let pos = 0;
  while (pos <= len) {
    const nl = src.indexOf('\n', pos);
    const e = nl === -1 ? len : nl;
    const s = pos;
    if (lineBlank(src, s, e)) {
      pos = e + 1;
      continue;
    }
    const lang = fenceLang(src, s, e);
    if (lang !== null) {
      const body = [];
      pos = e + 1;
      while (pos <= len) {
        const nl2 = src.indexOf('\n', pos);
        const e2 = nl2 === -1 ? len : nl2;
        if (fenceClose(src, pos, e2)) {
          pos = e2 + 1;
          break;
        }
        body.push(src.slice(pos, e2));
        pos = e2 + 1;
      }
      out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>');
      for (let k = 0; k < body.length; k++) {
        out.push(esc(body[k]));
        out.push('\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingAt(src, s, e);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inlineStr(hd.text, env);
      out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = e + 1;
      continue;
    }
    if (isHr(src, s, e)) {
      out.push('<hr>\n');
      pos = e + 1;
      continue;
    }
    if (src.charCodeAt(s) === 62) {
      const qlines = [];
      while (pos <= len) {
        const nl2 = src.indexOf('\n', pos);
        const e2 = nl2 === -1 ? len : nl2;
        if (src.charCodeAt(pos) !== 62) break;
        let st = pos + 1;
        if (src.charCodeAt(st) === 32) st++;
        const t = trimSlice(src, st, e2);
        if (t !== '') qlines.push(t);
        pos = e2 + 1;
      }
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const qtext = qlines.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(qtext, 0, qtext.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bText = bulletAt(src, s, e);
    const oMatch = bText === -1 ? orderedAt(src, s, e) : null;
    if (bText !== -1 || oMatch !== null) {
      const isOrdered = oMatch !== null;
      const start = isOrdered ? oMatch[0] : 1;
      const items = [];
      while (pos <= len) {
        const nl2 = src.indexOf('\n', pos);
        const e2 = nl2 === -1 ? len : nl2;
        let mStart = -1;
        if (isOrdered) {
          const om = orderedAt(src, pos, e2);
          if (om !== null) mStart = om[1];
        } else mStart = bulletAt(src, pos, e2);
        if (mStart !== -1) {
          items.push([trimSlice(src, mStart, e2)]);
          pos = e2 + 1;
        } else if (isContinued(src, pos, e2)) {
          items[items.length - 1].push(trimSlice(src, pos, e2));
          pos = e2 + 1;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const parts of items) {
        const text = parts.join('\n');
        out.push('<li>');
        inlineRange(text, 0, text.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const parts = [trimSlice(src, s, e)];
    pos = e + 1;
    while (pos <= len) {
      const nl2 = src.indexOf('\n', pos);
      const e2 = nl2 === -1 ? len : nl2;
      if (endsParagraph(src, pos, e2)) break;
      parts.push(trimSlice(src, pos, e2));
      pos = e2 + 1;
    }
    const text = parts.join('\n');
    out.push('<p>');
    const mark = out.length;
    inlineRange(text, 0, text.length, env, out);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  if (path.length === 1) return v;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text, escaped when the node writes it escaped. Strings, numbers and booleans need no textOf call. */
function varOut(v, raw, out) {
  if (typeof v === 'string') out.push(raw ? v : esc(v));
  else if (typeof v === 'number') out.push(String(v));
  else if (v === true) out.push('true');
  else if (v === false) out.push('false');
  else if (Array.isArray(v)) {
    const t = v.map(textOf).join(', ');
    out.push(raw ? t : esc(t));
  } else out.push('');
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`, in the scope chain. A for-loop's scope and
 * loop record are built once per execution and their per-element fields
 * mutated as it runs, instead of a fresh pair of objects per element.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        varOut(lookup(scope, n.path), false, out);
        break;
      case 'raw':
        varOut(lookup(scope, n.path), true, out);
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (Array.isArray(xs) && xs.length > 0) {
          if (n.name === 'loop') {
            // The element binding would be shadowed by `loop` itself; keep the
            // reference's per-element scope, as it builds one.
            for (let k = 0; k < xs.length; k++) {
              renderNodes(n.body, { vars: { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } }, parent: scope }, ctx, depth, out);
            }
          } else {
            const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
            const vars = { [n.name]: xs[0], loop };
            const child = { vars, parent: scope };
            for (let k = 0; k < xs.length; k++) {
              if (k > 0) {
                vars[n.name] = xs[k];
                loop.index = k + 1;
                loop.first = false;
                loop.last = k === xs.length - 1;
              }
              renderNodes(n.body, child, ctx, depth, out);
            }
          }
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const output = {};
  const report = [];
  const broken = new Set();

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; the first failing check is reported.
  let kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? ['posts', 'tags', 'page'] : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const resolveCache = new Map();
  const resolveCached = (dir, rel) => {
    const key = dir + '\0' + rel;
    if (resolveCache.has(key)) return resolveCache.get(key);
    const path = resolvePath(dir, rel);
    resolveCache.set(key, path);
    return path;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveCached(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
  for (const s of kept) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: esc };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    vars.site = site;
    vars.tags = allTags;
    vars.recent = recent;
    const out = [];
    renderNodes(nodes, { vars, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
