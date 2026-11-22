// A fast drop-in for makefun-site 1.0.0.
//
// This module is an original implementation of the same behaviour: it reads
// one site ({ site, templates, files }) and returns the same output tree
// (path -> text) that makefun-site 1.0.0's build returns, byte for byte.
// It is written for speed rather than for resemblance to the reference:
//
//   - Markdown is rendered in one sweep over the body's lines, straight
//     into an output array, with no token objects in between. Inline
//     markup is rendered by an index-based scanner over the source text,
//     so nested strong / emphasis / link text never copies a substring.
//   - Templates are parsed once per case and compiled to small JavaScript
//     functions (via the Function constructor), so rendering a page is
//     straight-line code: pushes to an array, direct scope lookups, no
//     node-tree walk and no string concatenation per node.
//   - Slugs are cached per case, and plain-ASCII text skips Unicode
//     normalisation entirely (NFKD is the identity on ASCII).
//   - HTML escaping first tests for an escapable character and returns
//     the string untouched when there is none, which is the common case.
//
// Nothing is cached from one run() call to the next: every case is
// answered alone, from its own input only.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Code-unit order, never the locale's. */
function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

// ---------------------------------------------------------------- text

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const NEED_ESC = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped, and nothing else. */
function esc(text) {
  if (!NEED_ESC.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESC_MAP[c]);
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return day + ' ' + MONTHS[month - 1] + ' ' + year;
}

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}/gu;

/** The slug of `text`, without any cache. */
function slugifyRaw(text) {
  let plain = text;
  if (NON_ASCII.test(text)) {
    plain = text.normalize('NFKD').replace(MARKS, '');
  }
  let out = '';
  let gap = false;
  for (let k = 0; k < plain.length; k++) {
    const ch = plain[k];
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

/** A fresh slug function with a per-case cache. */
function makeSlugger() {
  const cache = new Map();
  return function slug(text) {
    let found = cache.get(text);
    if (found === undefined) {
      found = slugifyRaw(text);
      cache.set(text, found);
    }
    return found;
  };
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  let n = 2;
  while (taken.has(out)) {
    out = slug + '-' + n;
    n++;
  }
  taken.add(out);
  return out;
}

/** Whitespace code units, the complement of \S in JavaScript. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
  8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]) {
  WS_TABLE[c] = 1;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let k = 0; k < text.length; k++) {
    if (WS_TABLE[text.charCodeAt(k)] === 1) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const next = raw[i + 1];
        if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += next;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) {
    return { error: 'a bare string opens on [' };
  }
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    if (s.error !== undefined) return { error: 'key "' + key + '": ' + s.error };
    return s;
  }
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    const bad = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    if (m === null) return { error: bad };
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: bad };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charAt(0) !== '[' || raw.charAt(raw.length - 1) !== ']') {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const list = inner.split(',').map((t) => t.trim());
    for (const t of list) {
      if (t === '' || !TAG_RE.test(t)) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: list };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (NAME_RE.test(raw)) return { value: raw };
    return { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    if (SLUG_RE.test(raw) && raw.length <= 64) return { value: raw };
    return { error: 'key "slug": not a slug' };
  }
  return { error: 'unknown key "' + key + '"' };
}

function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  let closeStart = -1;
  let closeEnd = -1;
  let from = firstNl;
  for (;;) {
    const pos = text.indexOf('\n---', from);
    if (pos === -1) return { error: 'the front matter is not closed' };
    const after = pos + 4;
    if (after === text.length || text[after] === '\n') {
      closeStart = pos + 1;
      closeEnd = after === text.length ? text.length : after + 1;
      break;
    }
    from = pos + 1;
  }
  const lines = text.slice(0, closeStart - 1).split('\n');
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charAt(0) === '#') continue;
    const m = LINE_RE.exec(line);
    if (m === null) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const FENCE_CLOSE_RE = /^```[ \t]*$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS_RE = /\s/;

/** Spaces and tabs at either end dropped. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/**
 * The language of a fence-open line, or null when the line is not one:
 * three backticks and an optional language, then spaces or tabs only.
 */
function fenceLang(line) {
  if (line.length < 3 || line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (!ok && c !== 95 && c !== 43 && c !== 45) break;
    j++;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.length < 3 || line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line[0] !== '#') return null;
  let count = 0;
  while (count < line.length && line[count] === '#') count++;
  if (count === 0 || count > 6) return null;
  if (count >= line.length) return null;
  const sep = line[count];
  if (sep !== ' ' && sep !== '\t') return null;
  let a = count;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: count, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  if (line[1] !== c || line[2] !== c) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * A list marker line: { ordered, start, text }, or null. A bullet is
 * "- " or "* " and an ordered marker is 1-9 digits and ". ".
 */
function listMarker(line) {
  const c0 = line[0];
  if ((c0 === '-' || c0 === '*') && line[1] === ' ') {
    return { ordered: false, start: 1, text: line.slice(2) };
  }
  if (c0 >= '0' && c0 <= '9') {
    let j = 0;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j >= 1 && j <= 9 && line[j] === '.' && line[j + 1] === ' ') {
      return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
    }
  }
  return null;
}

// ------------------------------------------------------------- inline

const ESCAPABLE = new Set([
  '\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>',
]);

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
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

/** The characters that start inline markup: backslash, backtick, star, open bracket. */
const SPECIAL_RE = /[\\`*\[]/g;

/**
 * `s[lo..hi)` rendered inline into `out`; `link(target)` is a link's href.
 * A regex scan jumps straight to the next markup character, so ordinary
 * text is flushed through esc() in one piece and costs no per-character
 * work. The regex's lastIndex is set before every exec, so the recursive
 * calls for strong / emphasis / link text cannot disturb the scan.
 */
function inlineInto(s, lo, hi, link, out) {
  let ps = lo;
  let i = lo;
  for (;;) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    if (m === null || m.index >= hi) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      if (j > ps) out.push(esc(s.slice(ps, j)));
      const n = s[j + 1];
      out.push(n === '>' ? '&gt;' : n);
      i = j + 2;
      ps = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        if (j > ps) out.push(esc(s.slice(ps, j)));
        out.push('<code>');
        out.push(esc(s.slice(j + 1, k)));
        out.push('</code>');
        i = k + 1;
        ps = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '*') {
      if (j + 1 < hi && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          if (j > ps) out.push(esc(s.slice(ps, j)));
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          ps = i;
          continue;
        }
        i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k > j + 1) {
        if (j > ps) out.push(esc(s.slice(ps, j)));
        out.push('<em>');
        inlineInto(s, j + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
        ps = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1, hi);
      let r = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        const q = s.indexOf(')', k + 2);
        if (q !== -1 && q < hi) r = q;
      }
      if (r !== -1) {
        const target = s.slice(k + 2, r);
        if (target !== '' && !WS_RE.test(target)) {
          if (j > ps) out.push(esc(s.slice(ps, j)));
          out.push('<a href="');
          out.push(esc(link(target)));
          out.push('">');
          inlineInto(s, j + 1, k, link, out);
          out.push('</a>');
          i = r + 1;
          ps = i;
          continue;
        }
      }
      i = j + 1;
      continue;
    }
    i = j + 1;
  }
  if (hi > ps) out.push(esc(s.slice(ps, hi)));
}

/** `s` rendered inline, as a string. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `src` rendered in one sweep: its HTML (each block followed by "\n"),
 * its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slug) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const parts = [];
      parts.push('<pre><code');
      if (lang !== '') parts.push(' class="language-' + lang + '"');
      parts.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(esc(lines[i]));
        parts.push('\n');
        i++;
      }
      i++;
      parts.push('</code></pre>\n');
      out.push(parts.join(''));
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slug(heading.text), ids);
      const html = inlineStr(heading.text, link);
      out.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>\n');
      if (heading.depth === 2 || heading.depth === 3) {
        toc.push({ level: heading.depth, id: id, html: html });
      }
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i];
        body.push(l.length > 1 && l[1] === ' ' ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimST(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        const joined = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(joined, 0, joined.length, link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const isOrdered = marker.ordered;
      const start = marker.start;
      const items = [];
      let cur = [trimST(marker.text)];
      items.push(cur);
      i++;
      while (i < n) {
        const m2 = listMarker(lines[i]);
        if (m2 !== null && m2.ordered === isOrdered) {
          cur = [trimST(m2.text)];
          items.push(cur);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          cur.push(trimST(lines[i]));
          i++;
        } else {
          break;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      if (isOrdered && start !== 1) out.push('<ol start="' + start + '">\n');
      else out.push('<' + tag + '>\n');
      for (const parts of items) {
        const joined = parts.join('\n');
        out.push('<li>');
        inlineInto(joined, 0, joined.length, link, out);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>\n');
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimST(lines[i]));
      i++;
    }
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc: toc, excerpt: excerpt === null ? '' : excerpt };
}

// -------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs. */
function spacesOnly(s) {
  for (let k = 0; k < s.length; k++) {
    if (s[k] !== ' ' && s[k] !== '\t') return false;
  }
  return true;
}

/**
 * `src`'s tokens: text, {{ }}, {{{ }}} and {% %}. A {% %} tag alone on
 * its line (only spaces or tabs beside it) takes its whole line with it.
 */
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
      if (close === -1) {
        throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      if (text !== '') tokens.push({ t: 'text', text: text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) {
      throw new TemplateError('template "' + name + '": a {% is not closed');
    }
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = spacesOnly(src.slice(lineStart, open)) && spacesOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text: text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text: text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
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
      if (top.kind !== 'if' || top.else !== null) {
        throw new TemplateError('template "' + name + '": an else outside an if');
      }
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) {
        throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent.kind === 'root' || parent.kind === 'for') body = parent.body;
      else body = parent.else !== null ? parent.else : parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) {
    throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root.body;
}

/** The value at `path` in the scope stack: first name from the nearest frame holding it. */
function lookup(F, path) {
  for (let s = F.length - 1; s >= 0; s--) {
    const frame = F[s];
    if (Object.prototype.hasOwnProperty.call(frame, path[0])) {
      let v = frame[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * One parsed template compiled to a function (F, out, T, depth, LK, TV,
 * TR, ESC): F is the scope stack (frames, root first), out the array the
 * rendering is pushed into, T the map of compiled templates for includes,
 * depth the include depth. Text becomes a push of a literal; a variable
 * becomes a lookup plus textOf (plus escaping); if and for become the
 * same control flow in JavaScript; an include becomes a call.
 */
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  let counter = 0;
  const parts = [];
  const emit = (nodesList) => {
    for (const n of nodesList) emitNode(n);
  };
  const emitNode = (n) => {
    if (n.kind === 'text') {
      parts.push('out.push(' + JSON.stringify(n.text) + ');');
      return;
    }
    if (n.kind === 'var') {
      parts.push('out.push(ESC(TV(LK(F,' + JSON.stringify(n.path) + '))));');
      return;
    }
    if (n.kind === 'raw') {
      parts.push('out.push(TV(LK(F,' + JSON.stringify(n.path) + ')));');
      return;
    }
    if (n.kind === 'if') {
      const cond = (n.not ? '!' : '') + 'TR(LK(F,' + JSON.stringify(n.path) + '))';
      parts.push('if (' + cond + ') {');
      emit(n.then);
      if (n.else !== null) {
        parts.push('} else {');
        emit(n.else);
      }
      parts.push('}');
      return;
    }
    if (n.kind === 'for') {
      const id = counter++;
      const x = '_x' + id;
      const k = '_k' + id;
      const f = '_f' + id;
      parts.push(
        '{ const ' + x + '=LK(F,' + JSON.stringify(n.path) + ');' +
        ' if (Array.isArray(' + x + ')) {' +
        ' for (let ' + k + '=0; ' + k + '<' + x + '.length; ' + k + '++) {' +
        ' const ' + f + '={};' +
        ' ' + f + '[' + JSON.stringify(n.name) + ']=' + x + '[' + k + '];' +
        ' ' + f + '.loop={index:' + k + '+1,first:' + k + '===0,last:' + k + '===' + x + '.length-1,length:' + x + '.length};' +
        ' F.push(' + f + ');',
      );
      emit(n.body);
      parts.push('F.pop(); } } }');
      return;
    }
    if (n.kind === 'include') {
      const id = counter++;
      parts.push(
        '{ if (depth<8) { const _t' + id + '=T.get(' + JSON.stringify(n.name) + ');' +
        ' if (_t' + id + '!==undefined) _t' + id + '(F,out,T,depth+1,LK,TV,TR,ESC); } }',
      );
      return;
    }
  };
  emit(nodes);
  return new Function('F', 'out', 'T', 'depth', 'LK', 'TV', 'TR', 'ESC', parts.join('\n'));
}

// ------------------------------------------------------------------- build

/** `rel` (a link's path) from the directory parts `dirParts` of a source, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slug = makeSlugger();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(cmp);
  for (const name of names) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is
  // not .md is static.
  const files = input.files.slice().sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    } else {
      statics.push(f);
    }
  }

  // 2. Each source's front matter: a refused source is reported and
  // dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const baseSlug = s.data.slug !== undefined ? s.data.slug : slug(s.data.title);
    s.slug = uniqueSlug(baseSlug, set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (schemeRe.test(target) || target.charAt(0) === '/' || target.charAt(0) === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and
  // older neighbours.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const list = s.data.tags === undefined ? [] : s.data.tags;
    const out = [];
    for (const name of list) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name: name, slug: sl, url: base + '/tags/' + sl + '/', posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    for (const name of ownTags(s)) {
      const sl = slug(name);
      const t = bySlug.get(sl);
      if (t !== undefined) s.tagRefs.push(t);
      else s.tagRefs.push({ name: name, slug: sl, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => (y.posts.length - x.posts.length) || cmp(x.slug, y.slug));

  // A post's card, as lists show it. One card per kept source, shared by
  // its page and by every list that shows it.
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date === undefined ? '' : s.data.date,
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary === undefined ? '' : s.data.summary,
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  // A page's link record as templates read it.
  const linkOf = (s) => {
    if (s === null) return null;
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date === undefined ? '' : s.data.date,
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    };
  };

  // A page as its layout reads it.
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer === undefined ? null : s.newer),
    older: linkOf(s.older === undefined ? null : s.older),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    const root = { site: site, tags: allTags, recent: recent };
    for (const k of Object.keys(vars)) root[k] = vars[k];
    fn([root], out, templates, 0, lookup, textOf, truthy, esc);
    return out.join('');
  };
  for (const s of kept) {
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => p.card),
      },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that
  // did not parse, sorted, then the counts.
  const lines = report.concat([...broken]);
  lines.sort(cmp);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(
    'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' +
    tags.length + ' tags and ' + statics.length + ' static files',
  );
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
