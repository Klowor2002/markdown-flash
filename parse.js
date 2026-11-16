// markdown-flash: dependency-free markdown renderer matching marked 18.1.3
// default options (gfm:true, breaks:false, pedantic:false).
// Authored from scratch for the markdown-render-speed-02 competition.

// ---------- character helpers ----------
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
function isAsciiPunct(ch) { return ch !== undefined && ASCII_PUNCT.has(ch); }
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUniPunct(ch) {
  if (ch === undefined) return false;
  const c = ch.codePointAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  return UNICODE_PUNCT_RE.test(ch);
}

// ---------- escaping ----------
const ENTITY_SHAPE = /^&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;
function escapeCodeChar(ch) {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return null;
  }
}
function escapeCode(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const e = escapeCodeChar(s[i]);
    if (e !== null) { out += s.slice(last, i) + e; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}
// Entity-aware escape used for running text and attribute values.
function escapeRun(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '&') {
      const m = ENTITY_SHAPE.exec(s.slice(i, i + 34));
      if (m && m[0][1] !== '#') { out += m[0]; i += m[0].length; continue; }
      if (m && m[0][1] === '#') {
        // numeric reference: decode
        const body = m[0];
        let cp;
        if (body[2] === 'x' || body[2] === 'X') cp = parseInt(body.slice(3, -1), 16);
        else cp = parseInt(body.slice(2, -1), 10);
        if (cp > 0x10FFFF) { out += '&amp;'; i++; continue; }
        if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF)) { out += escapeCode('\uFFFD'); i += body.length; continue; }
        out += escapeCode(String.fromCodePoint(cp)); i += body.length; continue;
      }
      out += '&amp;'; i++; continue;
    }
    const e = escapeCodeChar(ch);
    if (e !== null) { out += e; i++; continue; }
    let j = i + 1;
    while (j < s.length) {
      const c2 = s[j];
      if (c2 === '&' || c2 === '<' || c2 === '>' || c2 === '"' || c2 === "'") break;
      j++;
    }
    out += s.slice(i, j); i = j;
  }
  return out;
}
function escapeAttr(s) { return escapeRun(s); }
function cleanUrl(href) {
  let enc;
  try { enc = encodeURI(href); } catch { enc = href; }
  return enc.replace(/%25/g, '%');
}

// ---------- label folding ----------
function foldLabel(s) {
  let t = s.replace(/[ \t\r\n]+/g, ' ').trim().toLowerCase();
  t = t.replace(/ß/g, 'ss').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi')
       .replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
       .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
  return t;
}

// ---------- line splitting ----------
function splitLines(src) {
  const lines = [];
  let i = 0, start = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { lines.push(src.slice(start, i + 1)); i++; start = i; }
    else if (ch === '\r') {
      if (src[i + 1] === '\n') { lines.push(src.slice(start, i + 2)); i += 2; }
      else { lines.push(src.slice(start, i + 1)); i++; }
      start = i;
    } else i++;
  }
  if (start < src.length) lines.push(src.slice(start));
  return lines;
}
function lineBody(line) {
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  if (line.endsWith('\n') || line.endsWith('\r')) return line.slice(0, -1);
  return line;
}
function lineTerm(line) {
  if (line.endsWith('\r\n')) return '\r\n';
  if (line.endsWith('\n')) return '\n';
  if (line.endsWith('\r')) return '\r';
  return '';
}

// ---------- per-line cursor (CommonMark-style column math) ----------
class Cursor {
  constructor(body, term) {
    this.s = body; this.term = term;
    this.offset = 0; this.column = 0;
    this.partialTab = 0; // spaces remaining from a partially consumed tab
    this.computeIndent();
  }
  computeIndent() {
    let off = this.offset, col = this.column + this.partialTab;
    while (off < this.s.length) {
      const ch = this.s[off];
      if (ch === ' ') { off++; col++; }
      else if (ch === '\t') { off++; col += 4 - (col % 4); }
      else break;
    }
    this.nextNonspace = off;
    this.indent = col - this.column;
    this.blank = off >= this.s.length;
  }
  // current char, materializing partial tab as a space
  peek() {
    if (this.partialTab > 0) return ' ';
    return this.offset < this.s.length ? this.s[this.offset] : undefined;
  }
  remainder() {
    if (this.partialTab > 0) return ' '.repeat(this.partialTab) + this.s.slice(this.offset);
    return this.s.slice(this.offset);
  }
  // advance n columns; if columnsOnly, stop mid-tab leaving partial remainder
  advance(n, columnsOnly) {
    while (n > 0) {
      if (this.partialTab > 0) {
        const take = Math.min(n, this.partialTab);
        this.partialTab -= take; this.column += take; n -= take;
        continue;
      }
      if (this.offset >= this.s.length) break;
      const ch = this.s[this.offset];
      if (ch === '\t') {
        const w = 4 - (this.column % 4);
        if (columnsOnly && n < w) { this.offset++; this.partialTab = w - n; this.column += n; n = 0; }
        else { this.offset++; this.column += w; n -= w; }
      } else { this.offset++; this.column++; n--; }
    }
    this.computeIndent();
  }
  advanceChars(n) { // advance n characters regardless of columns (tabs count 1 char but full width)
    while (n > 0 && (this.partialTab > 0 || this.offset < this.s.length)) {
      if (this.partialTab > 0) { this.column += this.partialTab; this.partialTab = 0; n--; continue; }
      const ch = this.s[this.offset];
      if (ch === '\t') this.column += 4 - (this.column % 4); else this.column++;
      this.offset++; n--;
    }
    this.computeIndent();
  }
  atEnd() { return this.partialTab === 0 && this.offset >= this.s.length; }
}

// ---------- block tree ----------
let BID = 0;
class Block {
  constructor(type) {
    this.type = type; this.children = []; this.parent = null;
    this.literal = ''; this.id = BID++;
  }
  appendChild(b) { b.parent = this; this.children.push(b); return b; }
  get lastChild() { return this.children.length ? this.children[this.children.length - 1] : null; }
}

// HTML block tag sets
const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol p param section summary table tbody td tfoot th thead title tr track ul').split(' '));
const HTML_TYPE1_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

// Try to recognize an HTML block start at cursor remainder (indent <=3 assumed).
// Returns {htype} or null. Sets nothing.
function htmlBlockStart(rem) {
  if (rem[0] !== '<') return null;
  const c1 = rem[1];
  if (c1 === '!') {
    if (rem.startsWith('<!--')) return { htype: 2 };
    if (/^<!\[CDATA\[/.test(rem)) return { htype: 5 };
    if (/^<![A-Z]/.test(rem)) return { htype: 4 };
    return null;
  }
  if (c1 === '?') return { htype: 3 };
  if (c1 === '/') {
    const m = /^<\/([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|>|$)/.exec(rem);
    if (m && HTML_BLOCK_TAGS.has(m[1].toLowerCase())) return { htype: 6 };
    const tagParsed = parseHtmlTag(rem, 0);
    if (tagParsed && /^[ \t]*$/.test(rem.slice(tagParsed.end))) return { htype: 7 };
    return null;
  }
  const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(rem);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const after = rem[m[0].length];
  const okAfter = after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/';
  if (!okAfter) return null;
  if (HTML_TYPE1_TAGS.has(tag)) return { htype: 1 };
  if (HTML_BLOCK_TAGS.has(tag)) return { htype: 6 };
  // type 7: single complete open/close tag alone on the line
  const tagParsed = parseHtmlTag(rem, 0);
  if (tagParsed && tagParsed.end <= rem.length) {
    const rest = rem.slice(tagParsed.end);
    if (/^[ \t]*$/.test(rest) && !HTML_TYPE1_TAGS.has(tag)) return { htype: 7 };
  }
  return null;
}
function htmlBlockEnded(b, joinedBefore) {
  const lit = b.literal;
  switch (b.htype) {
    case 1: {
      const t = b.htag;
      return new RegExp('</' + t + '[ \\t]*>', 'i').test(lit);
    }
    case 2: return lit.includes('-->');
    case 3: return lit.includes('?>');
    case 4: return lit.includes('>');
    case 5: return lit.includes(']]>');
    default: return false;
  }
}

// ---------- strict HTML tag parsing (CommonMark grammar) ----------
// Returns {end, raw, closing, tagName} or null. s[i] must be '<'.
function parseHtmlTag(s, i) {
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  const nameM = /^[A-Za-z][A-Za-z0-9-]*/.exec(s.slice(j, j + 40));
  if (!nameM) return null;
  const tagName = nameM[0];
  j += tagName.length;
  if (closing) {
    while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r') j++;
    if (s[j] === '>') return { end: j + 1, raw: s.slice(i, j + 1), closing, tagName };
    return null;
  }
  // attributes
  for (;;) {
    let ws = 0;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) { j++; ws++; }
    if (s[j] === '>') return { end: j + 1, raw: s.slice(i, j + 1), closing, tagName };
    if (s[j] === '/' && s[j + 1] === '>') return { end: j + 2, raw: s.slice(i, j + 2), closing, tagName };
    if (ws === 0) return null;
    const attrM = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(s.slice(j, j + 60));
    if (!attrM) return null;
    j += attrM[0].length;
    // optional value
    let k = j;
    while (s[k] === ' ' || s[k] === '\t') k++;
    if (s[k] === '=') {
      k++;
      while (s[k] === ' ' || s[k] === '\t') k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, k + 1);
        if (close === -1) return null;
        j = close + 1;
      } else {
        const vm = /^[^ \t\r\n"'=<>`]+/.exec(s.slice(k));
        if (!vm) return null;
        j = k + vm[0].length;
      }
    }
  }
}
// Inline comment / declaration / PI / CDATA. Returns {end, raw} or null.
function parseHtmlSpecial(s, i) {
  if (s.startsWith('<!--', i)) {
    // comments <!--> and <!---> are complete empty comments
    if (s.startsWith('<!-->', i)) return { end: i + 5, raw: s.slice(i, i + 5) };
    if (s.startsWith('<!--->', i)) return { end: i + 6, raw: s.slice(i, i + 6) };
    const close = s.indexOf('-->', i + 4);
    if (close === -1) return null;
    return { end: close + 3, raw: s.slice(i, close + 3) };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const close = s.indexOf(']]>', i + 9);
    if (close === -1) return null;
    return { end: close + 3, raw: s.slice(i, close + 3) };
  }
  if (s.startsWith('<?', i)) {
    const close = s.indexOf('?>', i + 2);
    if (close === -1) return null;
    return { end: close + 2, raw: s.slice(i, close + 2) };
  }
  if (s.startsWith('<!', i)) {
    const m = /^<![A-Za-z][^>]*>/.exec(s.slice(i));
    if (m) return { end: i + m[0].length, raw: m[0] };
    return null;
  }
  return null;
}

// ---------- link destination / title scanning ----------
// Scan a link label starting at s[i]=='[' with bracket depth (one nesting level).
// Returns {label, end} (end just past ']') or null.
function scanLabel(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (ch === '[') { depth++; if (depth > 2) return null; j++; continue; }
    if (ch === ']') {
      depth--;
      if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 };
      j++; continue;
    }
    j++;
  }
  return null;
}
// Scan destination at s[j] (after optional whitespace handled by caller conventions).
// mode: 'def' (newline rules) or 'inline'.
// Returns {dest, end} or null. Pointy: no backslash processing; backslash before > invalid.
function scanDest(s, j, pointyNoNewline) {
  if (s[j] === '<') {
    let k = j + 1;
    while (k < s.length) {
      const ch = s[k];
      if (ch === '>') {
        if (s[k - 1] === '\\') return null;
        return { dest: s.slice(j + 1, k), end: k + 1, pointy: true };
      }
      if (ch === '<' || ch === '\n') return null;
      k++;
    }
    return null;
  }
  // bare destination: balanced parens, backslash escapes punctuation
  let k = j, depth = 0, out = '';
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\' && isAsciiPunct(s[k + 1])) { out += s[k + 1]; k += 2; continue; }
    if (ch === '(') { depth++; out += ch; k++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; out += ch; k++; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '<') break;
    if (ch < ' ') break;
    out += ch; k++;
  }
  if (depth !== 0) return null;
  return { dest: out, end: k, pointy: false };
}
// Scan title at s[j]; j points at the quote char. Returns {title, end} or null.
function scanTitle(s, j) {
  const q = s[j];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let k = j + 1, out = '';
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\' && isAsciiPunct(s[k + 1])) { out += s[k + 1]; k += 2; continue; }
    if (ch === close) return { title: out, end: k + 1 };
    if (q === '(' && ch === '(') return null;
    out += ch; k++;
  }
  return null;
}
function skipInlineWs(s, j, allowNewline) {
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ' || ch === '\t' || ch === '\r') { j++; continue; }
    if (ch === '\n' && allowNewline) { j++; continue; }
    break;
  }
  return j;
}

// ---------- link reference definitions ----------
// Try to parse one def at the start of text t (position p, paragraph first line
// may have up to 3 leading spaces already stripped by block layer).
// Returns {label, dest, title, end} or null. `end` consumes through end of line
// (including the newline) when a full def (with optional title) is present.
function parseDefAt(t, p) {
  let j = p;
  // up to 3 leading spaces on the first line
  let sp = 0;
  while (t[j] === ' ' && sp < 4) { j++; sp++; }
  if (sp > 3 || t[j] !== '[') return null;
  const lab = scanLabel(t, j);
  if (!lab) return null;
  if (!/\S/.test(lab.label)) return null; // whitespace-only label invalid
  // marked rejects def labels containing unescaped brackets
  for (let q = 0; q < lab.label.length; q++) {
    if (lab.label[q] === '\\') { q++; continue; }
    if (lab.label[q] === '[' || lab.label[q] === ']') return null;
  }
  j = lab.end;
  if (t[j] !== ':') return null;
  j++;
  // whitespace incl. at most one newline
  let nl = 0;
  while (j < t.length) {
    const ch = t[j];
    if (ch === ' ' || ch === '\t' || ch === '\r') j++;
    else if (ch === '\n') { nl++; if (nl > 1) return null; j++; }
    else break;
  }
  if (j >= t.length) return null;
  const d = scanDest(t, j, false);
  if (!d) return null;
  if (!d.pointy && d.dest === '') return null;
  j = d.end;
  const afterDest = j;
  // optional title: must be preceded by whitespace (may include one newline)
  let k = j, sawWs = false; nl = 0;
  while (k < t.length) {
    const ch = t[k];
    if (ch === ' ' || ch === '\t' || ch === '\r') { sawWs = true; k++; }
    else if (ch === '\n') { sawWs = true; nl++; if (nl > 1) break; k++; }
    else break;
  }
  let title = null, endPos = -1;
  if (sawWs && k < t.length && (t[k] === '"' || t[k] === "'" || t[k] === '(')) {
    const ti = scanTitle(t, k);
    if (ti) {
      // after title only whitespace to EOL
      let m = ti.end;
      while (m < t.length && (t[m] === ' ' || t[m] === '\t' || t[m] === '\r')) m++;
      if (m >= t.length || t[m] === '\n') {
        title = ti.title;
        endPos = (m < t.length && t[m] === '\n') ? m + 1 : m;
      }
    }
  }
  if (endPos === -1) {
    // title-less def: valid only if rest of the destination line is blank
    let m = afterDest;
    while (m < t.length && (t[m] === ' ' || t[m] === '\t' || t[m] === '\r')) m++;
    if (m < t.length && t[m] !== '\n') {
      // failed-title fallback: junk after a title-like start on the NEXT line
      // means the def ends at the destination (handled by caller semantics);
      // junk on the SAME line invalidates. Distinguish: if the whitespace
      // run between dest and junk contains a newline, accept title-less.
      if (t.slice(afterDest, m).includes('\n')) {
        endPos = m; // leave the junk line as paragraph text (do not consume its newline)
        // but consume up to start of junk line content
        const nlIdx = t.indexOf('\n', afterDest);
        endPos = nlIdx + 1;
      } else return null;
    } else {
      endPos = (m < t.length && t[m] === '\n') ? m + 1 : m;
    }
  }
  return { label: lab.label, dest: d.dest, title, end: endPos };
}
// Strip defs from the front of a paragraph literal; register into defs map.
// Returns remaining text.
function stripDefs(text, defs) {
  let rest = text;
  for (;;) {
    const d = parseDefAt(rest, 0);
    if (!d) break;
    const key = foldLabel(d.label);
    if (key && !defs.has(key)) defs.set(key, { href: d.dest, title: d.title });
    rest = rest.slice(d.end);
    if (rest === '') break;
  }
  return rest;
}

// ---------- small block-start matchers (operate on cursor) ----------
// Thematic break on remainder string (no terminator): only spaces/tabs and
// 3+ of the same char among - _ *.
function isThematicBreak(rem) {
  let ch = null, count = 0;
  for (let i = 0; i < rem.length; i++) {
    const c = rem[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '-' && c !== '_' && c !== '*') return false;
    if (ch === null) ch = c;
    else if (c !== ch) return false;
    count++;
  }
  return count >= 3;
}
// ATX heading on remainder; returns {level, text} or null.
function matchATX(rem) {
  const m = /^(#{1,6})(?:[ \t]|$)/.exec(rem);
  if (!m) return null;
  let text = rem.slice(m[0].length);
  text = text.replace(/^[ \t]+/, '');
  text = text.replace(/[ \t]+#+[ \t]*$/, '');
  text = text.replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  return { level: m[1].length, text };
}
// Setext underline on remainder; returns level or 0.
function matchSetext(rem) {
  const t = rem.replace(/[ \t]+$/, '');
  if (/^=+$/.test(t)) return 1;
  if (/^-+$/.test(t)) return 2;
  return 0;
}
// Fence start on remainder; returns {ch, len, info} or null.
function matchFence(rem) {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(rem);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { ch: m[1][0], len: m[1].length, info: m[2] };
}
// List marker at cursor position (cursor sits at first nonspace).
// Returns {bullet char or null, num, delim, markerWidthCols, paddingCols,
// contentIndentFromMarkerStart, empty, endOffset...} or null.
function matchListMarker(cur) {
  const s = cur.s;
  let pos = cur.nextNonspace;
  // materialize: work on remainder string with column tracking from cur.column+cur.indent
  const rem = cur.remainder().slice(cur.nextNonspace - cur.offset >= 0 ? 0 : 0);
  // Simpler: build the string from nextNonspace accounting partial tab.
  let str;
  if (cur.partialTab > 0) str = ' '.repeat(cur.partialTab) + s.slice(cur.offset);
  else str = s.slice(cur.nextNonspace);
  const startCol = cur.column + cur.indent;
  let bullet = null, num = null, delim = null, mlen = 0;
  const c0 = str[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') { bullet = c0; mlen = 1; }
  else if (c0 >= '0' && c0 <= '9') {
    const m = /^(\d{1,9})([.)])/.exec(str);
    if (!m) return null;
    num = parseInt(m[1], 10); delim = m[2]; mlen = m[0].length;
  } else return null;
  const afterCh = str[mlen];
  if (afterCh !== undefined && afterCh !== ' ' && afterCh !== '\t') {
    // marker must be followed by whitespace or EOL
    if (mlen >= str.length) { /* EOL */ } else return null;
  }
  // scan whitespace run in columns
  let col = startCol + mlen, idx = mlen, wsCols = 0, wsChars = 0;
  while (idx < str.length) {
    const c = str[idx];
    if (c === ' ') { col++; wsCols++; idx++; wsChars++; }
    else if (c === '\t') { const w = 4 - (col % 4); col += w; wsCols += w; idx++; wsChars++; }
    else break;
  }
  const empty = idx >= str.length;
  let contentIndent; // columns from line start (after containers) to content
  if (empty) { contentIndent = startCol + mlen + 1; }
  else if (wsCols >= 5) contentIndent = startCol + mlen + 1;
  else contentIndent = startCol + mlen + wsCols;
  return { bullet, num, delim, startCol, markerEndCol: startCol + mlen, wsCols, wsChars, empty, contentIndent, strAfterMarker: str };
}

// ---------- block parsing ----------
function curBlank(cur) {
  const r = cur.remainder();
  for (let i = 0; i < r.length; i++) if (r[i] !== ' ' && r[i] !== '\t') return false;
  return true;
}
function blankKind(cur) {
  const r = cur.remainder();
  if (r.length === 0) return 'empty';
  let tab = false;
  for (let i = 0; i < r.length; i++) { if (r[i] === '\t') tab = true; else if (r[i] !== ' ') return 'notblank'; }
  return tab ? 'tab' : 'spaces';
}
function expandLeadingTabs(str, startCol) {
  let out = '', col = startCol, i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ') { out += ' '; col++; i++; }
    else if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out + str.slice(i);
}
function unescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

function subtreeLastContent(b) {
  let m = b.lastContent || 0;
  for (const c of b.children) m = Math.max(m, subtreeLastContent(c));
  return m;
}
class Parser {
  constructor(src) {
    this.defs = new Map();
    this.doc = new Block('document');
    this.stack = [this.doc];
    this.src = src;
    this.lineNo = 0;
    this.lastBlankAt = 0;
    this.lastPlainBlankAt = 0;
  }
  tip() { return this.stack[this.stack.length - 1]; }
  addBlock(type, parent) {
    const b = new Block(type);
    const host = parent || this.tip();
    // looseness: a blank line after the previous child's last content and
    // before this child means the item's children are blank-separated
    if (host.type === 'item' && host.children.length > 0 &&
        (host.lastEffBlankAt || 0) > subtreeLastContent(host.lastChild)) {
      host.blankSeparated = true;
    }
    host.appendChild(b);
    return b;
  }
  openBlock(b) { this.stack.push(b); }
  // close blocks down to (and including) index idx in stack
  closeTo(idx) {
    while (this.stack.length - 1 >= idx) {
      const b = this.stack.pop();
      if (b.type === 'item') b.endBlank = (b.lastEffBlankAt || 0) > subtreeLastContent(b);
      this.stripHtmlTail(b);
    }
  }
  stripHtmlTail(container) {
    let n = container;
    while (n && n.lastChild) {
      n = n.lastChild;
      if (n.type === 'html') {
        if (!n.stripped && n.literal.endsWith('\n')) { n.literal = n.literal.slice(0, -1); n.stripped = true; }
        return;
      }
    }
  }
  parse() {
    const lines = splitLines(this.src);
    for (const raw of lines) {
      const body = lineBody(raw);
      this.processLine(body, lineTerm(raw) !== '');
    }
    // register link reference definitions in document order (first wins),
    // so forward references resolve
    const walk = (b) => {
      for (const c of b.children) {
        if (c.type === 'paragraph' || c.type === 'heading') stripDefs(c.literal, this.defs);
        walk(c);
      }
    };
    walk(this.doc);
    return this.doc;
  }

  processLine(body, hasTerm) {
    this.lineNo++;
    this.lineWasBlank = false;
    this.curTerm = hasTerm === false ? '' : '\n';
    this.processLineInner(body);
    if (!this.lineWasBlank) {
      for (const b of this.stack) b.lastContent = this.lineNo;
    }
  }
  processLineInner(body) {
    const cur = new Cursor(body, '');
    const stack = this.stack;
    // ---- Phase 1: match open containers ----
    let lastMatched = 0; // index in stack
    let i = 1;
    let siblingForList = null; // list block whose item failed but sibling starts
    for (; i < stack.length; i++) {
      const b = stack[i];
      if (b.type === 'blockquote') {
        if (cur.indent <= 3 && cur.partialTab === 0 && cur.s[cur.nextNonspace] === '>') {
          cur.advance(cur.indent, false);
          cur.advanceChars(1);
          if (cur.peek() === ' ' || (cur.partialTab === 0 && cur.offset < cur.s.length && cur.s[cur.offset] === '\t')) {
            // optional single space / tab-by-column
            const beforeOff = cur.offset;
            cur.advance(1, true);
            if (cur.offset === beforeOff && cur.partialTab === 0) { /* nothing */ }
          }
          // tab right after quote marker becomes 2 spaces for content purposes
          if (cur.partialTab === 0 && cur.offset < cur.s.length && cur.s[cur.offset] === '\t' && cur.indent >= 0) {
            // only when the tab is the first content char
            cur.quoteTab = true;
          }
          lastMatched = i;
        } else break;
      } else if (b.type === 'list') {
        lastMatched = i; // tentative; confirmed by item or sibling
      } else if (b.type === 'item') {
        if (b.closedByBlank) {
          const parentList = stack[i - 1];
          if (parentList && parentList.type === 'list' && !curBlank(cur)) {
            const snap = { offset: cur.offset, column: cur.column, partialTab: cur.partialTab };
            const mk = matchListMarker(cur);
            if (mk && listCompatible(parentList, mk) && cur.indent <= 3) siblingForList = parentList;
            cur.offset = snap.offset; cur.column = snap.column; cur.partialTab = snap.partialTab; cur.computeIndent();
          }
          break;
        }
        if (curBlank(cur)) { lastMatched = i; }
        else {
          const target = b.relIndent;
          if (cur.indent >= target || cur.column + cur.indent >= cur.column + target) {
            if (cur.indent >= target) { cur.advance(target, true); lastMatched = i; }
            else break;
          } else {
            // maybe a sibling item starts for the parent list
            const parentList = stack[i - 1];
            if (parentList && parentList.type === 'list') {
              const snap = { offset: cur.offset, column: cur.column, partialTab: cur.partialTab };
              const mk = matchListMarker(cur);
              if (mk && listCompatible(parentList, mk) && cur.indent <= 3) { siblingForList = parentList; }
              cur.offset = snap.offset; cur.column = snap.column; cur.partialTab = snap.partialTab; cur.computeIndent();
            }
            break;
          }
        }
      } else {
        // leaf block: reaching it means all containers above matched
        lastMatched = i;
        break;
      }
    }
    // a list whose item failed to match (and no sibling starts) is itself unmatched
    if (siblingForList === null && lastMatched >= 1 && stack[lastMatched].type === 'list' &&
        stack[lastMatched + 1] && stack[lastMatched + 1].type === 'item') {
      lastMatched--;
    }
    const matched = lastMatched === stack.length - 1;
    const tipB = this.tip();
    const blank = curBlank(cur);

    // ---- leaf continuations ----
    if (tipB.type === 'code' && tipB.fenced) {
      const fence = tipB;
      const rem = cur.remainder();
      const isClose = (() => {
        if (cur.indent > 3) return false;
        const t = rem.replace(/[ \t]+$/, '');
        const m = new RegExp('^' + (fence.fch === '`' ? '`' : '~') + '{' + fence.flen + ',}$').exec(t.trimStart ? t : t);
        // remainder may have leading spaces (indent<=3); strip them for the test
        const stripped = rem.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        const mm = /^(`{3,}|~{3,})$/.exec(stripped);
        return mm && mm[1][0] === fence.fch && mm[1].length >= fence.flen;
      })();
      if (matched || isClose || (fence.gotMatchedContent && this.unmatchedAreItems(lastMatched))) {
        let content;
        if (matched) content = this.fenceContentLine(fence, cur);
        else content = body; // absorbed raw line
        if (isClose && (matched || true)) {
          // closing fence must be recognized on the (possibly raw) line
          const rawStrip = body.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '');
          const mm = /^(`{3,}|~{3,})$/.exec(rawStrip);
          if (matched || (mm && mm[1][0] === fence.fch && mm[1].length >= fence.flen)) {
            fence.closed = true;
            this.stack.pop();
            return;
          }
        }
        if (!isClose || matched) {
          fence.literal += content + this.curTerm;
          if (matched) fence.gotMatchedContent = true;
          fence.stripped = false;
          return;
        }
      }
      // fence ends (unclosed): fall through, close it
      this.stack.pop();
    } else if (tipB.type === 'code' && !tipB.fenced) {
      if (matched && cur.indent >= 4) {
        cur.advance(4, true);
        tipB.literal += cur.remainder() + this.curTerm;
        return;
      }
      if (matched && blank) {
        // blank line inside indented code: excess columns beyond 4 kept
        tipB.literal += (cur.indent > 4 ? ' '.repeat(cur.indent - 4) : '') + this.curTerm;
        return;
      }
      this.stack.pop();
    } else if (tipB.type === 'html' && tipB.htype >= 6 && matched && !blank) {
      tipB.literal += cur.remainder() + this.curTerm;
      tipB.stripped = false;
      return;
    } else if (tipB.type === 'html' && tipB.htype <= 5 && !htmlBlockEnded(tipB)) {
      if (matched) {
        tipB.literal += cur.remainder() + this.curTerm;
        tipB.stripped = false;
        return;
      }
      // unmatched: html block ends; fall through
    } else if (tipB.type === 'table') {
      if (matched) {
        const rem = cur.remainder();
        const kind = blankKind(cur);
        if (kind === 'tab' || (!blank && !/^ *$/.test(rem) && !this.isTableEndLine(cur))) {
          tipB.rows.push(rem);
          return;
        }
      }
      this.stack.pop();
    }

    // ---- blank line handling ----
    if (blank) {
      this.lineWasBlank = true;
      this.lastBlankAt = this.lineNo;
      // html trailing-newline strip
      const kind = blankKind(cur);
      // a spaces-only line that matched a blockquote is paragraph content
      const quoteMatched = this.stack.slice(1, lastMatched + 1).some(b => b.type === 'blockquote');
      if (quoteMatched && kind === 'spaces' && this.tip().type === 'paragraph') {
        this.tip().literal += '\n' + cur.remainder();
        return;
      }
      this.htmlStripOnBlank(kind);
      // record the blank on every open item for which it is not internal
      // to a matched blockquote sitting below that item
      for (let k = 1; k < this.stack.length; k++) {
        if (this.stack[k].type !== 'item') continue;
        let internal = false;
        for (let m = k + 1; m <= lastMatched && m < this.stack.length; m++) {
          if (this.stack[m].type === 'blockquote') { internal = true; break; }
        }
        if (!internal) this.stack[k].lastEffBlankAt = this.lineNo;
      }
      // a blank line that did not match an open blockquote closes it
      for (let k = this.stack.length - 1; k > lastMatched; k--) {
        if (this.stack[k].type === 'blockquote') { this.closeTo(k); break; }
      }
      // an item with no content yet is ended by a blank line
      {
        const t = this.tip();
        if (t.type === 'item' && t.children.length === 0) t.closedByBlank = true;
      }
      // record own-level blank on the deepest item (for ends-with-blank):
      // own level = nothing above the item in the stack but paragraphs
      for (let k = this.stack.length - 1; k >= 1; k--) {
        if (this.stack[k].type === 'item') {
          let own = true;
          for (let m = k + 1; m < this.stack.length; m++) {
            if (this.stack[m].type !== 'paragraph') { own = false; break; }
          }
          if (own) this.stack[k].ownBlankAt = this.lineNo;
          break;
        }
      }
      // close paragraph / html 6-7 / table
      const t = this.tip();
      if (t.type === 'paragraph' || t.type === 'table' || (t.type === 'html' && t.htype >= 6)) this.stack.pop();
      return;
    }

    // ---- lazy paragraph continuation ----
    const tipNow = this.tip();
    if (!matched && tipNow.type === 'paragraph' && !siblingForList) {
      if (!this.lazyWouldStart(cur)) {
        const rem = cur.remainder();
        const firstNonspace = rem.replace(/^[ \t]+/, '');
        if (matchSetext(firstNonspace) > 0 || isThematicBreak(firstNonspace)) {
          tipNow.literal += '\n    ' + firstNonspace.replace(/[ \t]+$/, '');
        } else if (cur.indent >= 4) {
          tipNow.literal += '\n' + firstNonspace;
        } else {
          tipNow.literal += '\n' + rem;
        }
        return;
      }
      // else fall through: close unmatched and run starts
    }

    // ---- close unmatched containers ----
    if (!matched) {
      // find close index: keep blocks up to lastMatched, honoring sibling list
      let keep = lastMatched;
      if (siblingForList) {
        const li = this.stack.indexOf(siblingForList);
        keep = Math.max(keep, li);
      }
      // strip html tail of containers being closed
      this.closeTo(keep + 1);
    }

    // ---- starts ----
    this.tryStarts(cur, false);
  }

  unmatchedAreItems(lastMatched) {
    for (let k = lastMatched + 1; k < this.stack.length; k++) {
      const t = this.stack[k].type;
      if (t !== 'list' && t !== 'item' && t !== 'code') return false;
    }
    return true;
  }
  fenceContentLine(fence, cur) {
    let rem = cur.remainder();
    const inQuote = this.stack.some(b => b.type === 'blockquote');
    if (cur.quoteTab) rem = '  ' + rem.replace(/^\t/, '');
    if (inQuote || cur.column > 0) rem = expandLeadingTabs(rem, cur.column);
    if (fence.fch === '`') {
      // strip up to fence.indentChars whitespace chars
      let n = fence.indentChars, i = 0;
      while (n > 0 && i < rem.length && (rem[i] === ' ' || rem[i] === '\t')) { i++; n--; }
      rem = rem.slice(i);
    }
    return rem;
  }
  htmlStripOnBlank(kind) {
    // walk last-child chain from doc
    let n = this.doc, target = null;
    while (n.lastChild) { n = n.lastChild; if (n.type === 'html') target = n; }
    if (!target || target.stripped || !target.literal.endsWith('\n')) return;
    if (target.htype >= 6) { target.literal = target.literal.slice(0, -1); target.stripped = true; }
    else if (kind !== 'tab') { target.literal = target.literal.slice(0, -1); target.stripped = true; }
  }
  isTableEndLine(cur) {
    if (cur.indent <= 3) {
      const rem = cur.remainder();
      const first = rem.replace(/^[ \t]+/, '');
      if (first[0] === '>') return true;
      if (matchATX(first)) return true;
      if (matchFence(first)) return true;
      if (isThematicBreak(first)) return true;
      if (htmlBlockStart(first)) return true;
      const snap = { offset: cur.offset, column: cur.column, partialTab: cur.partialTab };
      const mk = matchListMarker(cur);
      cur.offset = snap.offset; cur.column = snap.column; cur.partialTab = snap.partialTab; cur.computeIndent();
      if (mk) return true;
    }
    return false;
  }
}
function listCompatible(list, mk) {
  if (list.ordered) return mk.bullet === null && mk.delim === list.delim;
  return mk.bullet === list.bulletChar;
}

// ---------- table row splitting (no code-span shielding; only \| protected) ----------
function splitTableRow(rowStr) {
  const s = rowStr.trim();
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '|') { cur += '|'; i += 2; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  if (s[0] === '|' && cells.length && cells[0] === '') cells.shift();
  if (s.length > 1 && s[s.length - 1] === '|' && s[s.length - 2] !== '\\' && cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// ---------- starts (phase 2 + 3) ----------
Parser.prototype.tryStarts = function (cur, lazyFallthrough) {
  // pop already-ended html blocks sitting on top
  while (this.tip().type === 'html' && this.tip().htype <= 5 && htmlBlockEnded(this.tip())) this.stack.pop();
  // container loop
  let openedAny = false;
  for (;;) {
    const tip = this.tip();
    if (tip.type === 'code' || tip.type === 'html' || tip.type === 'table') break;
    if (cur.indent <= 3) {
      const rem = cur.remainder();
      const first = rem.replace(/^[ \t]+/, '');
      if (first[0] === '>') {
        openedAny = true;
        const bq = this.addBlock('blockquote', tip.type === 'paragraph' ? tip.parent : tip);
        if (tip.type === 'paragraph') this.stack.pop();
        this.openBlock(bq);
        cur.advance(cur.indent, false);
        cur.advanceChars(1);
        if (cur.peek() === ' ' || (cur.partialTab === 0 && cur.offset < cur.s.length && cur.s[cur.offset] === '\t')) cur.advance(1, true);
        if (cur.partialTab === 0 && cur.offset < cur.s.length && cur.s[cur.offset] === '\t') cur.quoteTab = true;
        continue;
      }
      const setextLike = tip.type === 'paragraph' && matchSetext(first.replace(/[ \t]+$/, '')) > 0;
      if (!setextLike && isThematicBreak(first)) {
        if (tip.type === 'paragraph') this.stack.pop();
        if (this.tip().type === 'list' && !openedAny) this.stack.pop();
        this.addBlock('hr', this.tip());
        return true;
      }
      // list item
      const mk = matchListMarker(cur);
      if (mk && !setextLike) {
        let interruptOk = true;
        if (tip.type === 'paragraph' && tip.parent && tip.parent.type !== 'item') {
          if (mk.empty) interruptOk = false;
          else if (mk.bullet === null && mk.num !== 1) interruptOk = false;
        }
        if (interruptOk) {
          openedAny = true;
          const parent = tip.type === 'paragraph' ? tip.parent : tip;
          if (tip.type === 'paragraph') this.stack.pop();
          const baseCol = cur.column;
          let list;
          if (tip.type === 'list' && listCompatible(tip, mk)) {
            list = tip;
          } else {
            list = this.addBlock('list', parent);
            list.ordered = mk.bullet === null;
            list.start = mk.num;
            list.delim = mk.delim;
            list.bulletChar = mk.bullet;
            list.markerCol = mk.startCol;
            this.openBlock(list);
          }
          const item = this.addBlock('item', list);
          item.relIndent = mk.contentIndent - baseCol;
          item.hadBlank = false; item.blankSeparated = false;
          this.openBlock(item);
          cur.advance(mk.contentIndent - baseCol, true);
          continue;
        }
      }
    }
    break;
  }
  // leaf phase
  const tip = this.tip();
  const rem = cur.remainder();
  const first = rem.replace(/^[ \t]+/, '');
  if (curBlank(cur)) return true; // containers-only line: no leaf block starts
  if (tip.type === 'paragraph') {
    if (cur.indent <= 3) {
      const lvl = matchSetext(first);
      if (lvl > 0) {
        const stripped = stripDefs(tip.literal, this.defs);
        if (/\S/.test(stripped)) {
          tip.type = 'heading'; tip.level = lvl;
          this.stack.pop();
          return true;
        }
        // not a heading: fall to continuation below
      } else {
        // table conversion
        if (!tip.literal.includes('\n') && tip.literal.includes('|')) {
          const dcells = splitTableRow(rem);
          const hcells = splitTableRow(tip.literal);
          if (dcells.length === hcells.length && dcells.length > 0 &&
              dcells.every(c => /^:?-+:?$/.test(c.trim()))) {
            tip.type = 'table';
            tip.header = hcells.map(c => c.trim());
            tip.aligns = dcells.map(c => {
              const t = c.trim();
              const l = t[0] === ':', r = t[t.length - 1] === ':';
              return l && r ? 'center' : l ? 'left' : r ? 'right' : null;
            });
            tip.rows = [];
            return true;
          }
        }
        const atx = matchATX(first);
        if (atx) {
          const parent = tip.parent; this.stack.pop();
          const h = this.addBlock('heading', parent); h.level = atx.level; h.text = atx.text;
          return true;
        }
        const fence = matchFence(first);
        if (fence) {
          const parent = tip.parent; this.stack.pop();
          this.startFence(parent, fence, cur);
          return true;
        }
        const hb = htmlBlockStart(first);
        if (hb && hb.htype <= 6) {
          const parent = tip.parent; this.stack.pop();
          this.startHtml(parent, hb, cur);
          return true;
        }
      }
    }
    // paragraph continuation: after a hard break the next line is stripped;
    // otherwise the remainder is kept verbatim.
    const lastNl = tip.literal.lastIndexOf('\n');
    const lastLine = lastNl === -1 ? tip.literal : tip.literal.slice(lastNl + 1);
    const hardBreak = /  $/.test(lastLine) || lastLine.endsWith('\\');
    if (hardBreak) tip.literal += '\n' + first;
    else tip.literal += '\n' + rem;
    return true;
  }
  // tip is a container (document / blockquote / item / list)
  if (tip.type === 'list') return true; // stray; ignore line (should not happen)
  if (cur.indent >= 4) {
    cur.advance(4, true);
    const code = this.addBlock('code', tip);
    code.fenced = false;
    code.literal = cur.remainder() + this.curTerm;
    this.openBlock(code);
    return true;
  }
  if (cur.indent <= 3) {
    const atx = matchATX(first);
    if (atx) { const h = this.addBlock('heading', tip); h.level = atx.level; h.text = atx.text; return true; }
    const fence = matchFence(first);
    if (fence) { this.startFence(tip, fence, cur); return true; }
    const hb = htmlBlockStart(first);
    if (hb) { this.startHtml(tip, hb, cur); return true; }
  }
  const p = this.addBlock('paragraph', tip);
  p.literal = rem;
  this.openBlock(p);
  return true;
};
Parser.prototype.startFence = function (parent, fence, cur) {
  const b = this.addBlock('code', parent);
  b.fenced = true; b.fch = fence.ch; b.flen = fence.len;
  b.indentChars = (cur.partialTab > 0 ? 1 : 0) + Math.max(0, cur.nextNonspace - cur.offset);
  const info = fence.info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  b.info = info;
  const firstWord = info.split(/[ \t]+/)[0] || '';
  b.lang = unescapeStr(firstWord);
  b.literal = '';
  b.closed = false; b.gotMatchedContent = false;
  this.openBlock(b);
};
Parser.prototype.startHtml = function (parent, hb, cur) {
  const b = this.addBlock('html', parent);
  b.htype = hb.htype;
  if (hb.htype === 1) {
    const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(cur.remainder().replace(/^[ \t]+/, ''));
    b.htag = m ? m[1].toLowerCase() : '';
  }
  b.literal = cur.remainder() + (this.curTerm !== undefined ? this.curTerm : '\n');
  b.stripped = false;
  this.openBlock(b);
};

// Would a line that failed to match all containers still start a new block
// (and thus NOT be a lazy paragraph continuation)?
Parser.prototype.lazyWouldStart = function (cur) {
  if (cur.indent > 3) return false;
  const rem = cur.remainder();
  const first = rem.replace(/^[ \t]+/, '');
  if (first[0] === '>') return true;
  if (isThematicBreak(first)) return true;
  if (matchATX(first)) return true;
  if (matchFence(first)) return true;
  const hb = htmlBlockStart(first);
  if (hb && hb.htype <= 6) return true;
  if (matchSetext(first) > 0) return false; // setext-shaped lazy lines use the quirk path
  const snap = { offset: cur.offset, column: cur.column, partialTab: cur.partialTab };
  const mk = matchListMarker(cur);
  cur.offset = snap.offset; cur.column = snap.column; cur.partialTab = snap.partialTab; cur.computeIndent();
  if (mk) return true;
  return false;
};

// ---------- inline parsing ----------
const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/y;
const SPECIAL_CHARS = new Set(['\\', '`', '[', ']', '!', '<', '*', '_', '~', '\n']);
function isWsCh(ch) {
  if (ch === undefined) return true;
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
  return ch > '\u007F' && /\s/.test(ch);
}

class InlineParser {
  constructor(text, defs) {
    this.s = text; this.defs = defs;
    this.nodes = []; this.delims = []; this.brackets = [];
    this.inlink = false;
  }
  pushText(str) {
    if (!str) return;
    const last = this.nodes[this.nodes.length - 1];
    if (last && last.t === 'text' && !last.noMerge) last.s += str;
    else this.nodes.push({ t: 'text', s: str });
  }
  pushNode(n) { this.nodes.push(n); return n; }
  makeBracket(node, isImage, contentStart, startPos) {
    const br = { node, isImage, contentStart, delimLen: this.delims.length, active: true, tickInert: false, labelEnd: -1 };
    const lab = scanLabel(this.s, startPos);
    if (lab) {
      br.labelEnd = lab.end - 1;
      br.tickInert = labelTickInert(lab.label);
    }
    return br;
  }
  innermostBracket() {
    return this.brackets.length ? this.brackets[this.brackets.length - 1] : null;
  }
  parse() {
    const s = this.s;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      // autolink attempts at token boundaries
      if ((i === 0 || isWsCh(s[i - 1]) || isUniPunct(s[i - 1])) && !this.inlink &&
          (ch === 'w' || ch === 'h' || ch === 'H' || ch === 'm' || ch === 'x' ||
           (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'))) {
        const auto = this.tryAutolink(i);
        if (auto) { this.pushNode(auto.node); i = auto.end; continue; }
        if (auto === false) { /* rejected candidate: fall through to text */ }
      }
      if (ch === '\\') {
        const nxt = s[i + 1];
        if (nxt === '\n') { this.pushNode({ t: 'br' }); i += 2; continue; }
        if (isAsciiPunct(nxt)) { this.pushNode({ t: 'lit', s: nxt }); i += 2; continue; }
        this.pushText('\\'); i++; continue;
      }
      if (ch === '\n') {
        // hard break: 2+ trailing spaces in current text
        const last = this.nodes[this.nodes.length - 1];
        if (last && last.t === 'text') {
          const m = / {2,}$/.exec(last.s);
          if (m) {
            last.s = last.s.slice(0, last.s.length - m[0].length);
            if (last.s === '') this.nodes.pop();
            this.pushNode({ t: 'br' });
            i++; continue;
          }
        }
        this.pushText('\n'); i++; continue;
      }
      if (ch === '`') {
        let n = 0; while (s[i + n] === '`') n++;
        // a bracket whose label holds a 2+ run with a stray shorter tick
        // after it treats all its backticks as literal text
        const brInert = this.innermostBracket();
        if (brInert && brInert.tickInert && i < brInert.labelEnd) {
          this.pushText('`'.repeat(n)); i += n; continue;
        }
        const close = this.findCodeClose(i + n, n);
        if (close === -1) { this.pushText('`'.repeat(n)); i += n; continue; }
        let content = s.slice(i + n, close).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        this.pushNode({ t: 'code', s: content });
        i = close + n; continue;
      }
      if (ch === '!') {
        if (s[i + 1] === '[') {
          const node = { t: 'text', s: '![', noMerge: true };
          this.pushNode(node);
          this.brackets.push(this.makeBracket(node, true, i + 2, i));
          i += 2; continue;
        }
        this.pushText('!'); i++; continue;
      }
      if (ch === '[') {
        const node = { t: 'text', s: '[', noMerge: true };
        this.pushNode(node);
        this.brackets.push(this.makeBracket(node, false, i + 1, i));
        i++; continue;
      }
      if (ch === ']') {
        const res = this.tryBracket(i);
        if (res) { i = res; continue; }
        this.pushText(']'); i++; continue;
      }
      if (ch === '<') {
        const sp = parseHtmlSpecial(s, i);
        if (sp) { this.pushNode({ t: 'html', s: sp.raw }); i = sp.end; continue; }
        const auto = this.tryAngleAutolink(i);
        if (auto) { this.pushNode(auto.node); i = auto.end; continue; }
        const tag = parseHtmlTag(s, i);
        if (tag) {
          this.pushNode({ t: 'html', s: tag.raw });
          const tn = tag.tagName.toLowerCase();
          if (tn === 'a' && !tag.raw.endsWith('/>')) this.inlink = !tag.closing;
          i = tag.end; continue;
        }
        this.pushText('<'); i++; continue;
      }
      if (ch === '*' || ch === '_') {
        let n = 0; while (s[i + n] === ch) n++;
        const node = { t: 'text', s: ch.repeat(n), noMerge: true };
        this.pushNode(node);
        const prev = i > 0 ? s[i - 1] : undefined;
        const next = i + n < s.length ? s[i + n] : undefined;
        const lf = !isWsCh(next) && (!isUniPunct(next) || isWsCh(prev) || isUniPunct(prev));
        const rf = !isWsCh(prev) && (!isUniPunct(prev) || isWsCh(next) || isUniPunct(next));
        let canOpen, canClose;
        if (ch === '*') { canOpen = lf; canClose = rf; }
        else {
          canOpen = lf && (!rf || isUniPunct(prev));
          canClose = rf && (!lf || isUniPunct(next));
        }
        this.delims.push({ node, char: ch, num: n, origNum: n, canOpen, canClose, pairings: 0 });
        i += n; continue;
      }
      if (ch === '~') {
        let n = 0; while (s[i + n] === '~') n++;
        if (n <= 2) {
          const node = { t: 'text', s: '~'.repeat(n), noMerge: true };
          this.pushNode(node);
          const prev = i > 0 ? s[i - 1] : undefined;
          const next = i + n < s.length ? s[i + n] : undefined;
          this.delims.push({ node, char: '~', num: n, origNum: n, canOpen: !isWsCh(next), canClose: !isWsCh(prev), pairings: 0 });
        } else this.pushText('~'.repeat(n));
        i += n; continue;
      }
      // plain text run (stops after punctuation so autolinks get a boundary)
      let j = i;
      while (j < s.length && !SPECIAL_CHARS.has(s[j]) && !isWsCh(s[j])) {
        const c = s[j]; j++;
        if (isUniPunct(c)) break;
      }
      if (j === i) { this.pushText(ch); i++; } // whitespace char
      else { this.pushText(s.slice(i, j)); i = j; }
    }
    this.processEmphasis(0);
    return this.nodes;
  }
  findCodeClose(from, n) {
    const s = this.s;
    let j = from;
    while (j < s.length) {
      if (s[j] === '`') {
        let m = 0; while (s[j + m] === '`') m++;
        if (m === n) return j;
        j += m;
      } else j++;
    }
    return -1;
  }
  tryAngleAutolink(i) {
    const s = this.s;
    const close = s.indexOf('>', i + 1);
    if (close === -1) return null;
    const inner = s.slice(i + 1, close);
    if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*$/.test(inner)) {
      return { node: { t: 'link', href: cleanUrl(inner), title: null, auto: 'angle', children: [{ t: 'text', s: inner }] }, end: close + 1 };
    }
    if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(inner)) {
      return { node: { t: 'link', href: cleanUrl('mailto:' + inner), title: null, auto: 'angle', children: [{ t: 'text', s: inner }] }, end: close + 1 };
    }
    return null;
  }
  tryAutolink(i) {
    const s = this.s;
    // mailto: / xmpp:
    for (const pre of ['mailto:', 'xmpp:']) {
      if (s.startsWith(pre, i)) {
        EMAIL_RE.lastIndex = i + pre.length;
        const m = EMAIL_RE.exec(s);
        if (m) {
          let end = i + pre.length + m[0].length;
          let text = s.slice(i, end);
          if (pre === 'xmpp:' && s[end] === '/') {
            let segEnd = end + 1;
            while (segEnd < s.length && !isWsCh(s[segEnd]) && s[segEnd] !== '/' && s[segEnd] !== '<') segEnd++;
            const seg = s.slice(end + 1, segEnd);
            if (seg.includes('@')) { while (segEnd < s.length && !isWsCh(s[segEnd]) && s[segEnd] !== '<') segEnd++; }
            end = segEnd; text = s.slice(i, end);
          }
          if (/[-_]$/.test(m[0])) return null;
          if ((s[end] === '-' || s[end] === '_') && !/[A-Za-z0-9]/.test(s[end + 1] || '')) return null;
          return { node: { t: 'link', href: text, title: null, auto: 'ext', children: [{ t: 'text', s: text }] }, end };
        }
        return null;
      }
    }
    // http(s):// case-insensitive, www. case-sensitive
    const head = s.slice(i, i + 8).toLowerCase();
    let prefixLen = 0, isWww = false;
    if (head.startsWith('https://')) prefixLen = 8;
    else if (head.startsWith('http://')) prefixLen = 7;
    else if (s.startsWith('www.', i)) { prefixLen = 4; isWww = true; }
    if (prefixLen > 0) {
      let j = i + prefixLen;
      while (j < s.length && !isWsCh(s[j]) && s[j] !== '<' && s[j] !== '>' && s[j] !== ']' && s[j] !== '[') j++;
      if (j === i + prefixLen) return null;
      let url = s.slice(i, j);
      url = trimAutolink(url);
      if (!url || url.length <= prefixLen) return null;
      const href = isWww ? 'http://' + url : url;
      return { node: { t: 'link', href, title: null, auto: 'ext', children: [{ t: 'text', s: url }] }, end: i + url.length };
    }
    // bare email
    EMAIL_RE.lastIndex = i;
    const m = EMAIL_RE.exec(s);
    if (m) {
      if (/[-_]$/.test(m[0])) return null;
      const after = s[i + m[0].length];
      if ((after === '-' || after === '_') && !/[A-Za-z0-9]/.test(s[i + m[0].length + 1] || '')) return null;
      const text = m[0];
      return { node: { t: 'link', href: 'mailto:' + text, title: null, auto: 'ext', children: [{ t: 'text', s: text }] }, end: i + text.length };
    }
    return null;
  }
}
function trimAutolink(url) {
  let u = url;
  for (;;) {
    if (!u) return u;
    const last = u[u.length - 1];
    if ('?!.,:*_~\'' .includes(last) || last === '"') { u = u.slice(0, -1); continue; }
    if (last === ';') {
      const amp = u.lastIndexOf('&');
      const tail = amp >= 0 ? u.slice(amp) : '';
      if (/^&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);$/.test(tail)) u = u.slice(0, amp);
      else u = u.slice(0, -1);
      continue;
    }
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      let depth = 0;
      for (const c of u) { if (c === open) depth++; else if (c === last) depth--; }
      if (depth < 0) { u = u.slice(0, -1); continue; }
    }
    break;
  }
  // unmatched opening paren: truncate at the first unmatched '('
  {
    const stack = [];
    let opens = 0, closes = 0;
    for (let k = 0; k < u.length; k++) {
      if (u[k] === '(') { stack.push(k); opens++; }
      else if (u[k] === ')') { closes++; if (stack.length) stack.pop(); }
    }
    if (opens > closes && stack.length) {
      u = u.slice(0, stack[0]);
      while (u && '?!.,:*_~\'' .includes(u[u.length - 1])) u = u.slice(0, -1);
      if (u.endsWith('+')) u = u.slice(0, -1);
    }
  }
  return u;
}

// ---------- bracket formation + emphasis ----------
InlineParser.prototype.tryBracket = function (i) {
  const s = this.s;
  // nearest active bracket
  let bi = this.brackets.length - 1;
  while (bi >= 0 && !this.brackets[bi].active) bi--;
  if (bi < 0) return null;
  const br = this.brackets[bi];
  const startIdx = this.nodes.indexOf(br.node);
  if (startIdx === -1) { this.brackets.splice(bi, 1); return null; }
  const contentNodes = this.nodes.slice(startIdx + 1);
  const hasLink = contentNodes.some(n => n.t === 'link' && !n.auto);
  let dest = null, title = null, endPos = -1, usedRef = false;
  // inline link
  let j = i + 1;
  if (s[j] === '(') {
    let k = skipInlineWs(s, j + 1, true);
    let d = null;
    if (s[k] === ')') { d = { dest: '', end: k + 1 }; }
    else {
      d = scanDest(s, k, false);
      if (d) {
        let m = skipInlineWs(s, d.end, true);
        if (s[m] === ')') { d = { dest: d.dest, end: m + 1 }; }
        else {
          const ti = (m > d.end) ? scanTitle(s, m) : null;
          if (ti) {
            const m2 = skipInlineWs(s, ti.end, true);
            if (s[m2] === ')') { d = { dest: d.dest, end: m2 + 1, title: ti.title }; }
            else d = null;
          } else d = null;
        }
      }
    }
    if (d) { dest = d.dest; title = d.title || null; endPos = d.end; }
  }
  if (endPos === -1) {
    // full / collapsed / shortcut reference
    if (s[j] === '[') {
      const lab = scanLabel(s, j);
      if (lab) {
        usedRef = true;
        const labelText = lab.label === '' ? s.slice(br.contentStart, i) : lab.label;
        const def = this.defs.get(foldLabel(labelText));
        if (def) { dest = def.href; title = def.title; endPos = lab.end; }
      }
    }
    if (endPos === -1 && !usedRef) {
      const labelText = s.slice(br.contentStart, i);
      const def = this.defs.get(foldLabel(labelText));
      if (def) { dest = def.href; title = def.title; endPos = i + 1; }
    }
  }
  if (endPos === -1 || (!br.isImage && hasLink)) {
    br.active = false;
    return null;
  }
  // code-span rejection rules: a 2+ backtick span containing a backtick
  // rejects the link unless the span ends exactly at the ]; a dangling
  // backtick run in the label (not inerted) also rejects it
  const labelSrc = s.slice(br.contentStart, i);
  if (labelHasBadSpan(labelSrc)) { br.active = false; return null; }
  if (!br.tickInert && labelHasDanglingRun(labelSrc)) { br.active = false; return null; }
  // form the link/image
  this.processEmphasis(br.delimLen);
  const children = this.nodes.splice(startIdx + 1);
  this.nodes.pop(); // remove the bracket text node itself (now last)
  unwrapAutolinks(children);
  const node = { t: br.isImage ? 'image' : 'link', href: dest, title, children };
  this.nodes.push(node);
  // drop delimiters that lived inside the bracket
  this.delims.length = Math.min(this.delims.length, br.delimLen);
  this.brackets.length = bi; // remove this bracket and any above (already gone)
  return endPos;
};
function labelHasDanglingRun(label) {
  let i = 0;
  while (i < label.length) {
    if (label[i] === '`') {
      let n = 0; while (label[i + n] === '`') n++;
      let j = i + n, closed = -1;
      while (j < label.length) {
        if (label[j] === '`') {
          let m = 0; while (label[j + m] === '`') m++;
          if (m === n) { closed = j; break; }
          j += m;
        } else j++;
      }
      if (closed === -1) return true;
      i = closed + n; continue;
    }
    i++;
  }
  return false;
}
function labelTickInert(label) {
  let i = 0;
  while (i < label.length) {
    if (label[i] === '`') {
      let n = 0; while (label[i + n] === '`') n++;
      let j = i + n, closed = -1;
      while (j < label.length) {
        if (label[j] === '`') {
          let m = 0; while (label[j + m] === '`') m++;
          if (m === n) { closed = j; break; }
          j += m;
        } else j++;
      }
      if (closed === -1) {
        if (n >= 2 && label.slice(i + n).includes('`')) return true;
        return false;
      }
      i = closed + n; continue;
    }
    i++;
  }
  return false;
}
function labelHasBadSpan(label) {
  let i = 0;
  while (i < label.length) {
    if (label[i] === '`') {
      let n = 0; while (label[i + n] === '`') n++;
      if (n >= 2) {
        // find closing run of exactly n
        let j = i + n, closed = -1;
        while (j < label.length) {
          if (label[j] === '`') {
            let m = 0; while (label[j + m] === '`') m++;
            if (m === n) { closed = j; break; }
            j += m;
          } else j++;
        }
        if (closed !== -1) {
          const content = label.slice(i + n, closed);
          if (content.includes('`') && closed + n !== label.length) return true;
          i = closed + n; continue;
        }
      }
      i += n; continue;
    }
    i++;
  }
  return false;
}
function unwrapAutolinks(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.t === 'link' && n.auto === 'ext') { nodes.splice(k, 1, ...n.children); k += n.children.length - 1; }
    else if (n.children) unwrapAutolinks(n.children);
  }
}
InlineParser.prototype.contentHasGlued = function (opener, closer, tag, tailNoWs) {
  const nodes = this.nodes;
  const oi = nodes.indexOf(opener.node), ci = nodes.indexOf(closer.node);
  if (oi === -1 || ci === -1) return false;
  // a dead star inside exempts the pair
  for (const d of this.delims) {
    if (d.char === '*' && !d.canOpen && !d.canClose) {
      const di = nodes.indexOf(d.node);
      if (di > oi && di < ci) return false;
    }
  }
  for (let k = oi + 1; k < ci; k++) {
    const n = nodes[k];
    if (n.t !== tag) continue;
    // nearest non-empty siblings (consumed delimiter nodes linger as '')
    let prev = null, next = null;
    for (let m = k - 1; m > oi; m--) { if (nodes[m].t === 'text' && nodes[m].s === '') continue; prev = nodes[m]; break; }
    for (let m = k + 1; m < ci; m++) { if (nodes[m].t === 'text' && nodes[m].s === '') continue; next = nodes[m]; break; }
    const leftGlued = prev && prev.t === 'text' && /[A-Za-z0-9]$/.test(prev.s);
    if (leftGlued) continue; // left-glued inner is exempt
    const rightGlued = next && next.t === 'text' && /^[A-Za-z0-9]/.test(next.s);
    if (!rightGlued) continue;
    if (tailNoWs) {
      // the block applies only when nothing but whitespace-free text
      // sits between the inner emphasis and the closer
      let ok = true;
      for (let m = k + 1; m < ci; m++) {
        const nm = nodes[m];
        if (nm.t !== 'text' || /\s/.test(nm.s)) { ok = false; break; }
      }
      if (!ok) continue;
    }
    return true;
  }
  return false;
};
InlineParser.prototype.processEmphasis = function (bottom) {
  const delims = this.delims, nodes = this.nodes;
  let closerIdx = bottom;
  // find first potential closer
  const findCloser = (from) => {
    for (let k = from; k < delims.length; k++) if (delims[k].canClose && delims[k].num > 0) return k;
    return -1;
  };
  closerIdx = findCloser(bottom);
  while (closerIdx !== -1) {
    const closer = delims[closerIdx];
    // find nearest usable opener (per-candidate validation)
    let openerIdx = -1, use = 0, fallback = false;
    for (let k = closerIdx - 1; k >= bottom; k--) {
      const cand = delims[k];
      if (cand.char !== closer.char || !cand.canOpen || cand.num <= 0) continue;
      if (closer.char === '~') { if (cand.num === closer.num) { openerIdx = k; use = closer.num; break; } continue; }
      // rule of three
      if ((cand.canClose || closer.canOpen) &&
          (cand.origNum + closer.origNum) % 3 === 0 &&
          !(cand.origNum % 3 === 0 && closer.origNum % 3 === 0)) continue;
      const u = (cand.num >= 2 && closer.num >= 2) ? 2 : 1;
      // a strong opener cannot pair as an em over a glued inner em
      if (closer.char === '*' && u === 1 && cand.num >= 2 && this.contentHasGlued(cand, closer, 'em')) continue;
      // glued-emphasis rule (marked): a pair is blocked when its content
      // holds a left-free, right-glued emphasis of the opposite strength
      // (strong blocks em pairs; em blocks strong pairs). A blocked pair
      // still forms when the closer run has >= 3 chars, with the leftover
      // chars rendered literally inside the element (fallback pairing).
      if (closer.char === '*' && ((u === 1 && this.contentHasGlued(cand, closer, 'strong')) ||
          (u === 2 && this.contentHasGlued(cand, closer, 'em', true)))) {
        if (closer.num >= 3) { openerIdx = k; use = u; fallback = true; break; }
        continue;
      }
      openerIdx = k; use = u; break;
    }
    if (openerIdx === -1) {
      if (!closer.canOpen) { delims.splice(closerIdx, 1); closerIdx = findCloser(closerIdx); }
      else closerIdx = findCloser(closerIdx + 1);
      continue;
    }
    const opener = delims[openerIdx];
    // wrap nodes between opener.node and closer.node
    const oi = nodes.indexOf(opener.node);
    const ci = nodes.indexOf(closer.node);
    if (oi === -1 || ci === -1 || ci < oi) { // stale; drop closer
      delims.splice(closerIdx, 1); closerIdx = findCloser(closerIdx); continue;
    }
    const inner = nodes.splice(oi + 1, ci - oi - 1);
    const tag = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const wrap = { t: tag, children: inner };
    nodes.splice(oi + 1, 0, wrap);
    // shrink delimiter text nodes
    opener.node.s = opener.node.s.slice(0, opener.node.s.length - use);
    if (fallback) {
      // leftover closer chars render literally inside the element and
      // the closer run is fully consumed
      const left = closer.num - use;
      if (left > 0) wrap.children.push({ t: 'text', s: closer.char.repeat(left) });
      closer.node.s = '';
      closer.num = 0;
    } else {
      closer.node.s = closer.node.s.slice(use);
      closer.num -= use;
    }
    closer.pairings++;
    opener.num -= use;
    // remove delimiters strictly between
    delims.splice(openerIdx + 1, closerIdx - openerIdx - 1);
    closerIdx = openerIdx + 1;
    if (opener.num === 0 && !opener.canClose) { delims.splice(openerIdx, 1); closerIdx = openerIdx; }
    if (closer.num === 0) { delims.splice(closerIdx, 1); }
    closerIdx = findCloser(closerIdx);
  }
  // cleanup: remove empty text nodes left from delimiters? keep (render '' )
};

// ---------- rendering ----------
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'lit' || n.t === 'code' || n.t === 'html') out += n.s;
    else if (n.t === 'br') out += '\n';
    else if (n.children) out += plainText(n.children);
  }
  return out;
}
function renderNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += escapeRun(n.s); break;
      case 'lit': out += escapeCode(n.s); break;
      case 'code': out += '<code>' + escapeCode(n.s) + '</code>'; break;
      case 'html': out += n.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderNodes(n.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(n.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(n.children) + '</del>'; break;
      case 'link':
        out += '<a href="' + escapeAttr(cleanUrl(n.href)) + '"' +
          (n.title != null ? ' title="' + escapeAttr(n.title) + '"' : '') + '>' +
          renderNodes(n.children) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeAttr(cleanUrl(n.href)) + '" alt="' + escapeAttr(plainText(n.children)) + '"' +
          (n.title != null ? ' title="' + escapeAttr(n.title) + '"' : '') + '>';
        break;
    }
  }
  return out;
}
function renderInline(text, ctx) {
  const p = new InlineParser(text, ctx.defs);
  p.inlink = !!ctx.inlink;
  const nodes = p.parse();
  ctx.inlink = p.inlink;
  return renderNodes(nodes);
}

// ---------- block rendering ----------
function listLoose(list) {
  const items = list.children;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.blankSeparated) return true;
    if (it.endBlank && k < items.length - 1) return true;
  }
  return false;
}
function renderBlocks(blocks, ctx, tightPara) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, ctx, tightPara);
  return out;
}
function renderBlock(b, ctx, tightPara) {
  switch (b.type) {
    case 'document': return renderBlocks(b.children, ctx, false);
    case 'paragraph': {
      const text = stripDefs(b.literal, ctx.defs);
      if (text === '') return '';
      if (tightPara) return renderInline(text, ctx);
      return '<p>' + renderInline(text, ctx) + '</p>\n';
    }
    case 'heading': {
      const text = b.text !== undefined ? b.text : stripDefs(b.literal, ctx.defs).trim();
      return '<h' + b.level + '>' + renderInline(text, ctx) + '</h' + b.level + '>\n';
    }
    case 'hr': return '<hr>\n';
    case 'code': {
      if (b.fenced) {
        let content = b.literal;
        if (b.closed) {
          if (content === '\n') content = '';
          else if (content.endsWith('\n\n')) content = content.slice(0, -1);
        }
        const cls = b.lang ? ' class="language-' + escapeAttr(b.lang) + '"' : '';
        return '<pre><code' + cls + '>' + escapeCode(content) + '</code></pre>\n';
      }
      let content = b.literal;
      // drop trailing whitespace-only lines
      const linesArr = content.split('\n');
      while (linesArr.length && /^[ \t]*$/.test(linesArr[linesArr.length - 1])) linesArr.pop();
      // the split leaves a final '' from the trailing newline; rebuild
      content = linesArr.length ? linesArr.join('\n') + '\n' : '';
      return '<pre><code>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'html': return b.literal;
    case 'blockquote': return '<blockquote>\n' + renderBlocks(b.children, ctx, false) + '</blockquote>\n';
    case 'list': {
      const loose = listLoose(b);
      b._loose = loose;
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      return '<' + tag + startAttr + '>\n' + renderBlocks(b.children, ctx, false) + '</' + tag + '>\n';
    }
    case 'item': {
      const loose = b.parent && b.parent._loose;
      if (!b.children.length) return '<li></li>\n';
      let inner = '';
      const kids = b.children;
      for (let k = 0; k < kids.length; k++) {
        const child = kids[k];
        if (child.type === 'paragraph') {
          const text = stripDefs(child.literal, ctx.defs);
          if (text === '') continue;
          // task list check on first paragraph
          let t = text, checkbox = '';
          if (k === 0) {
            const m = /^\[( |x|X|)\] /.exec(t);
            if (m) {
              checkbox = m[1] === '' || m[1] === ' '
                ? '<input disabled="" type="checkbox"> '
                : '<input checked="" disabled="" type="checkbox"> ';
              t = t.slice(4);
            }
          }
          if (loose) inner += '<p>' + checkbox + renderInline(t, ctx) + '</p>\n';
          else inner += checkbox + renderInline(t, ctx);
        } else {
          inner += renderBlock(child, ctx, false);
        }
      }
      return '<li>' + inner + '</li>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const a = b.aligns[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(b.header[k], ctx) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const rowSrc of b.rows) {
          const cells = splitTableRow(rowSrc);
          out += '<tr>\n';
          for (let k = 0; k < b.header.length; k++) {
            const a = b.aligns[k];
            const cell = (cells[k] !== undefined ? cells[k] : '').trim();
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, ctx) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default: return '';
  }
}

// ---------- entry point ----------
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const parser = new Parser(src);
  const doc = parser.parse();
  // mark fences inside items (for the single-blank content rule)
  (function walk(b, inItem) {
    for (const c of b.children) {
      if (c.type === 'code' && c.fenced) c.inItem = inItem;
      walk(c, inItem || c.type === 'item');
    }
  })(doc, false);
  return renderBlock(doc, { defs: parser.defs }, false);
}
