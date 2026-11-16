// FlashMark — a from-scratch Markdown -> HTML renderer.
// Behavior target: marked 18.1.3, marked.parse with default options
// (gfm true, breaks false, pedantic false). No dependencies, no state
// shared between parse() calls: every call builds a fresh parser.

// ---------- character classes ----------
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.indexOf(ch) >= 0;
}
const WS_CHARS = ' \t\n\r\f\v             \u2028\u2029  　\uFEFF';
function isSpaceCh(ch) {
  return ch !== undefined && WS_CHARS.indexOf(ch) >= 0;
}
// Unicode punctuation-or-symbol test, used only for emphasis flanking.
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  if (ch === undefined) return false;
  const c = ch.codePointAt(0);
  if (c < 128) return ASCII_PUNCT.indexOf(ch) >= 0;
  return UNICODE_PUNCT_RE.test(ch);
}
function isAlnumCh(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// ---------- escaping ----------
// Text/code escaping of the five markup characters. In code contexts the
// ampersand is always escaped; in text contexts an entity-shaped &...;
// sequence is passed through raw (handled by the inline scanner, which
// never feeds a bare valid entity into this escaper as text).
function escapeHtml(s, attr) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === '&') rep = '&amp;';
    else if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  return out + s.slice(start);
}
// Attribute escaping: & is escaped only when it does not begin an
// entity-shaped sequence (&name; / &#123; / &#x1F;).
const ENTITY_SHAPE_RE = /^&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/;
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === '&') {
      if (!ENTITY_SHAPE_RE.test(s.slice(i, i + 34))) rep = '&amp;';
    } else if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  return out + s.slice(start);
}
// Link destinations: encodeURI, then undo the %25 doubling so a literal
// percent sign in the source survives as one.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return href;
  }
}

// ---------- entities in text ----------
// Returns {raw, decoded} when s starting at i (which points at &) holds a
// reference marked honors: named &name; passes through raw; numeric
// references decode to their character (0 / surrogates / >0x10FFFF are
// not references at all, except &#0; style zero which becomes U+FFFD —
// in marked &#0; decodes to U+FFFD while an out-of-range value leaves
// the whole thing literal).
function matchEntity(s, i) {
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const ds = j;
    if (hex) {
      while (j < s.length && /[0-9A-Fa-f]/.test(s[j])) j++;
    } else {
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    }
    if (j === ds || s[j] !== ';') return null;
    const num = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (num > 0x10FFFF) return null;
    let cp = num;
    if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { raw: s.slice(i, j + 1), decoded: String.fromCodePoint(cp), len: j + 1 - i };
  }
  const ns = j;
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  if (j === ns || s[j] !== ';') return null;
  if (!/[A-Za-z]/.test(s[ns])) return null;
  return { raw: s.slice(i, j + 1), decoded: null, len: j + 1 - i };
}

// ---------- link labels ----------
// Lookup key: whitespace runs collapse to one space, ends trimmed, full
// case folding (including the German sharp s and the Latin ligatures,
// which plain toLowerCase does not fold).
function foldLabel(label) {
  let t = label.replace(/\s+/g, ' ').trim().toLowerCase();
  t = t.replace(/ß/g, 'ss').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi')
       .replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
       .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
  return t;
}
// Process backslash escapes in a plain string (link text for alt/plain
// rendering and shortcut labels where marked does unescape).
function unescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ---------- line cursor ----------
// One input line, terminator stripped, with column-accurate scanning.
// Columns count tab stops of width 4. A tab may be consumed partially;
// the unconsumed part is remembered and materializes as spaces.
function makeLine(text) {
  return {
    s: text,
    offset: 0,          // char index of the current position
    column: 0,          // column of the current position
    partial: 0,         // spaces still owed by a partially consumed tab
    nextNonspace: 0,
    nextNonspaceColumn: 0,
    indent: 0,
    blank: true,
    afterQuote: false, // remainder starts with a tab right after a quote marker
  };
}
function computeNext(L) {
  let off = L.offset;
  let col = L.column;
  if (L.partial > 0) {
    // a partially consumed tab still counts as blank space ahead
    L.nextNonspace = off;
    L.nextNonspaceColumn = col + L.partial;
    L.indent = L.partial;
    L.blank = false;
    // scan past the tab itself
    off++;
    col += L.partial;
    let extra = 0;
    while (off < L.s.length) {
      const ch = L.s[off];
      if (ch === ' ') { off++; col++; extra++; }
      else if (ch === '\t') { const w = 4 - (col % 4); off++; col += w; extra += w; }
      else break;
    }
    L.nextNonspace = off;
    L.nextNonspaceColumn = col;
    L.indent = L.partial + extra;
    L.blank = off >= L.s.length;
    return;
  }
  let ind = 0;
  while (off < L.s.length) {
    const ch = L.s[off];
    if (ch === ' ') { off++; col++; ind++; }
    else if (ch === '\t') { const w = 4 - (col % 4); off++; col += w; ind += w; }
    else break;
  }
  L.nextNonspace = off;
  L.nextNonspaceColumn = col;
  L.indent = ind;
  L.blank = off >= L.s.length;
}
// Advance the position by n columns (columnsOnly=true) or n chars.
// When columnsOnly and a tab is met, only the needed part is consumed.
function advance(L, n, columnsOnly) {
  let remaining = n;
  while (remaining > 0 && L.offset < L.s.length) {
    if (L.partial > 0) {
      const take = Math.min(remaining, L.partial);
      L.partial -= take;
      L.column += take;
      remaining -= take;
      if (L.partial === 0) L.offset++; // tab fully consumed now
      continue;
    }
    const ch = L.s[L.offset];
    if (ch === '\t') {
      const w = 4 - (L.column % 4);
      if (columnsOnly && remaining < w) {
        L.partial = w - remaining;
        L.column += remaining;
        remaining = 0;
      } else {
        L.offset++;
        L.column += w;
        remaining -= columnsOnly ? w : 1;
      }
    } else {
      L.offset++;
      L.column++;
      remaining--;
    }
  }
  computeNext(L);
}
// The not-yet-consumed text of the line from the current position.
function remainder(L) {
  if (L.partial > 0) {
    return ' '.repeat(L.partial) + L.s.slice(L.offset + 1);
  }
  return L.s.slice(L.offset);
}
function remainderFromNonspace(L) {
  return L.s.slice(L.nextNonspace);
}
// ---------- link reference definitions ----------
// Try to read one definition at text[pos]. Returns
// {label, dest, title, end} or null. The label scan allows one level of
// nested brackets; a backslash before the closing > of a pointy
// destination invalidates it; a title must be preceded by whitespace
// (which may include exactly one newline) and followed only by
// whitespace to the end of its line.
function scanLabelEnd(text, pos) {
  // text[pos] === '['; returns index just past the closing ']' or -1.
  // Marked's labels hold no nested brackets: an unescaped '[' inside
  // invalidates the label, and the first unescaped ']' ends it.
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && isAsciiPunct(text[i + 1])) { i += 2; continue; }
    if (ch === '[') return -1;
    if (ch === ']') return i + 1;
    i++;
  }
  return -1;
}
function skipInlineWs(text, i, allowNewline) {
  // link grammar whitespace is ASCII only (a no-break space is just a
  // character to marked's link parser)
  let nl = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') i++;
    else if (ch === '\n') { nl++; if (nl > (allowNewline ? 1 : 0)) break; i++; }
    else break;
  }
  return i;
}
// Read a link destination at i: pointy <...> (no backslash processing,
// a backslash right before > kills it) or bare with balanced parens and
// backslash escapes. Returns {dest, end} or null.
function scanDest(text, i) {
  if (text[i] === '<') {
    let j = i + 1;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\n') return null;
      if (ch === '>') {
        if (text[j - 1] === '\\') return null;
        return { dest: text.slice(i + 1, j), end: j + 1 };
      }
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let out = '';
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) {
      out += text[j + 1];
      j += 2;
      continue;
    }
    if (ch === '(') { depth++; out += ch; j++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
      out += ch;
      j++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    if (ch === '<') return null;
    out += ch;
    j++;
  }
  if (j === i) return null;
  if (depth !== 0) return null;
  return { dest: out, end: j };
}
// Read a title at i: "..." / '...' / (...). Returns {title, end} or null.
function scanTitle(text, i) {
  const open = text[i];
  let close;
  if (open === '"') close = '"';
  else if (open === "'") close = "'";
  else if (open === '(') close = ')';
  else return null;
  let j = i + 1;
  let out = '';
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) {
      out += text[j + 1];
      j += 2;
      continue;
    }
    if (open === '(' && ch === '(') return null;
    if (ch === close) return { title: out, end: j + 1 };
    out += ch;
    j++;
  }
  return null;
}
function parseDefAt(text, pos) {
  if (text[pos] !== '[') return null;
  const labEnd = scanLabelEnd(text, pos);
  if (labEnd < 0) return null;
  const rawLabel = text.slice(pos + 1, labEnd - 1);
  if (rawLabel.trim() === '') return null; // whitespace-only label: invalid
  if (text[labEnd] !== ':') return null;
  let i = skipInlineWs(text, labEnd + 1, true);
  const d = scanDest(text, i);
  if (!d) return null;
  i = d.end;
  // Optional title. It may sit on the destination's own line (after
  // whitespace) or alone on the next line. Junk after a same-line
  // title invalidates the whole definition; junk after a next-line
  // title leaves a title-less definition standing and the junk line
  // becomes paragraph text.
  let lineEnd = i;
  while (lineEnd < text.length && text[lineEnd] !== '\n') lineEnd++;
  const restOfLine = text.slice(i, lineEnd);
  let title = null;
  let end;
  if (restOfLine.trim() === '') {
    end = lineEnd;
    if (text[lineEnd] === '\n') {
      let j = lineEnd + 1;
      while (text[j] === ' ' || text[j] === '\t') j++;
      const t = scanTitle(text, j);
      if (t) {
        let k = t.end;
        let ok = true;
        while (k < text.length && text[k] !== '\n') {
          if (text[k] !== ' ' && text[k] !== '\t') { ok = false; break; }
          k++;
        }
        if (ok) { title = t.title; end = k; }
      }
    }
  } else {
    let j = i;
    while (text[j] === ' ' || text[j] === '\t') j++;
    if (j === i) return null; // a title needs preceding whitespace
    const t = scanTitle(text, j);
    if (!t) return null;
    // the title may itself span lines; after it, only blanks may
    // remain on ITS final line
    let k = t.end;
    while (text[k] === ' ' || text[k] === '\t') k++;
    if (k < text.length && text[k] !== '\n') return null;
    title = t.title;
    end = k;
  }
  if (text[end] === '\n') end++;
  return { label: foldLabel(rawLabel), dest: d.dest, title, end };
}
// Strip leading definitions from a paragraph's literal. Returns the
// remaining text plus the defs found, in order.
function stripDefs(literal) {
  const defs = [];
  let pos = 0;
  for (;;) {
    // a definition may be indented a little at its line start; only
    // commit the skip when a definition really parses there
    let p = pos;
    while (literal[p] === ' ' || literal[p] === '\t') p++;
    const d = parseDefAt(literal, p);
    if (!d) break;
    defs.push(d);
    pos = d.end;
    if (pos >= literal.length) break;
  }
  if (defs.length === 0) return { text: literal, defs };
  return { text: literal.slice(pos), defs };
}

// ---------- tables ----------
// Split a row into cell sources. A backslash protects the next char
// from splitting; \| becomes a literal | in the cell source. Code spans
// do NOT shield pipes (marked's splitter is deliberately crude here).
function splitTableRow(row) {
  let s = row.trim();
  const cells = [];
  let cur = '';
  let i = 0;
  if (s.startsWith('|')) { i = 1; }
  let endedWithPipe = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const nx = s[i + 1];
      if (nx === '|') { cur += '|'; i++; endedWithPipe = false; continue; }
      cur += ch;
      endedWithPipe = false;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      endedWithPipe = true;
      continue;
    }
    cur += ch;
    endedWithPipe = false;
  }
  if (!endedWithPipe || cur !== '') cells.push(cur);
  return cells.map(c => c.trim());
}
function parseDelimiterRow(row) {
  const cells = splitTableRow(row);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.endsWith(':')) aligns.push('right');
    else if (c.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// ---------- HTML tag grammar (strict, CommonMark-shaped) ----------
const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*/;
const ATTR_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;
// Scan one complete tag at s[i] === '<'. Returns {end, name, closing,
// selfClosing} or null when the text is not a well-formed tag.
function scanTag(s, i) {
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  const nm = TAG_NAME_RE.exec(s.slice(j, j + 64));
  if (!nm) return null;
  const name = nm[0].toLowerCase();
  j += nm[0].length;
  if (closing) {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] === '>') return { end: j + 1, name, closing, selfClosing: false };
    return null;
  }
  for (;;) {
    let ws = 0;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (s[j] === '>') return { end: j + 1, name, closing, selfClosing: false };
    if (s[j] === '/' && s[j + 1] === '>') return { end: j + 2, name, closing, selfClosing: true };
    if (j >= s.length) return null;
    if (ws === 0) return null; // attributes need leading whitespace
    const am = ATTR_NAME_RE.exec(s.slice(j, j + 64));
    if (!am) return null;
    j += am[0].length;
    // optional = value
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      k++;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, k + 1);
        if (e < 0) return null;
        j = e + 1;
      } else {
        const vs = k;
        while (k < s.length && !/[\s"'=<>`]/.test(s[k])) k++;
        if (k === vs) return null;
        j = k;
      }
    }
  }
}
// Comments / declarations / PIs / CDATA as inline raw HTML.
// <!--> and <!---> are complete empty comments on their own.
function scanRawHtml(s, i) {
  if (s.startsWith('<!-->', i)) return { end: i + 5 };
  if (s.startsWith('<!--->', i)) return { end: i + 6 };
  if (s.startsWith('<!--', i)) {
    const e = s.indexOf('-->', i + 4);
    if (e < 0) return null;
    return { end: e + 3 };
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e < 0) return null;
    return { end: e + 2 };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e < 0) return null;
    return { end: e + 3 };
  }
  if (s.startsWith('<!', i) && /[A-Za-z]/.test(s[i + 2] || '')) {
    const e = s.indexOf('>', i + 2);
    if (e < 0) return null;
    return { end: e + 1 };
  }
  const t = scanTag(s, i);
  if (t) return { end: t.end, tag: t };
  return null;
}
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
// ---------- inline rendering of node trees ----------
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't' || nd.k === 'e') out += nd.raw;
    else if (nd.k === 'code') out += nd.content;
    else if (nd.k === 'raw') out += nd.s;
    else if (nd.k === 'br') out += '\n';
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}
function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 't': out += escapeHtml(nd.raw); break;
      case 'e': out += nd.html; break;
      case 'code': out += '<code>' + escapeHtml(nd.content) + '</code>'; break;
      case 'raw': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.children) + '</del>'; break;
      case 'a': {
        out += '<a href="' + escapeAttr(cleanUrl(nd.href)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>' + renderNodes(nd.children) + '</a>';
        break;
      }
      case 'img': {
        out += '<img src="' + escapeAttr(cleanUrl(nd.href)) + '" alt="' + escapeAttr(plainText(nd.children)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}
// Extended autolinks (bare URLs and addresses) inside a formed link
// unwrap back to plain text; angle autolinks stay linked.
function unwrapAutolinks(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.k === 'a' && nd.auto === 'ext') {
      nodes[i] = { k: 't', raw: nd.rawText };
    } else if (nd.children) {
      unwrapAutolinks(nd.children);
    }
  }
}

// ---------- extended autolinks ----------
const URL_TAIL_PUNCT = '?!.,:*_~\'"';
function trimAutolink(url) {
  let u = url;
  for (;;) {
    if (u.length === 0) return u;
    const last = u[u.length - 1];
    if (URL_TAIL_PUNCT.indexOf(last) >= 0) { u = u.slice(0, -1); continue; }
    if (last === ';') {
      const amp = u.lastIndexOf('&');
      if (amp >= 0 && /^&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);$/.test(u.slice(amp))) {
        u = u.slice(0, amp);
      } else {
        u = u.slice(0, -1);
      }
      continue;
    }
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      let depth = 0;
      for (let i = 0; i < u.length; i++) {
        if (u[i] === open) depth++;
        else if (u[i] === last) depth--;
      }
      if (depth < 0) { u = u.slice(0, -1); continue; }
      return u;
    }
    return u;
  }
}
const EMAIL_CAND_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9._-]+/;
const EMAIL_VALID_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
// Validate a bare-email candidate. Returns the linkable length or 0.
function emailLinkLen(cand) {
  if (cand.endsWith('-') || cand.endsWith('_')) return 0;
  let c = cand;
  while (c.endsWith('.')) c = c.slice(0, -1);
  if (!EMAIL_VALID_RE.test(c)) return 0;
  return c.length;
}

// ---------- the inline scanner ----------
// ctx: { defs: Map<label,{dest,title}>, inLink: {v:boolean} }
function parseInline(text, ctx) {
  const nodes = [];
  const delims = [];   // {node, char, len, canOpen, canClose}
  const brackets = []; // {nodeIdx, isImage, delimCount, active, tickTaint}
  let suppressRest = false;
  let buf = '';
  let i = 0;
  const n = text.length;
  function flush() {
    if (buf.length > 0) {
      nodes.push({ k: 't', raw: buf });
      buf = '';
    }
  }
  function lastTextNode() { return nodes[nodes.length - 1]; }

  while (i < n) {
    const ch = text[i];
    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        // hard break: drop trailing spaces already buffered, emit <br>,
        // and skip the next line's leading spaces
        buf = buf.replace(/[ ]+$/, '');
        flush();
        nodes.push({ k: 'br' });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) { buf += nx; i += 2; continue; }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '\n') {
      // hard break by trailing spaces
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ k: 'br' });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run++;
      // inside a bracket whose earlier backtick run was rejected,
      // further backtick runs are inert literal text
      if (brackets.length > 0 && brackets[brackets.length - 1].tickTaint) {
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      // Find a closing run of exactly the same length. Inside an open
      // bracket, when the stretch up to the label end contains any
      // backtick at all, the search is bounded by that label end;
      // otherwise the span may cross the bracket's ] freely.
      let bound = n;
      if (brackets.length > 0) {
        const labelEnd = looseLabelEnd(text, i + run);
        if (text.slice(i + run, labelEnd).includes('`')) bound = labelEnd;
      }
      let j = i + run;
      let closeAt = -1;
      while (j < bound) {
        if (text[j] === '`') {
          let r2 = 0;
          while (j + r2 < n && text[j + r2] === '`') r2++;
          if (r2 === run) { closeAt = j; break; }
          j += r2;
        } else j++;
      }
      if (closeAt < 0) {
        // a run rejected by the bracket-bounded search taints the
        // bracket: later backtick runs inside it are inert too. A
        // run that merely found no partner in open text taints
        // nothing.
        if (brackets.length > 0 && bound < n) brackets[brackets.length - 1].tickTaint = true;
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      flush();
      let content = text.slice(i + run, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      // a 2+-backtick span whose content itself holds a backtick
      // poisons the enclosing bracket: its link is rejected unless
      // the span ends exactly at the bracket's ]
      if (run >= 2 && brackets.length > 0 && content.includes('`')) {
        const top = brackets[brackets.length - 1];
        top.badSpan = true;
        top.badSpanEnd = closeAt + run;
      }
      nodes.push({ k: 'code', content });
      i = closeAt + run;
      continue;
    }
    if (ch === '&') {
      const ent = matchEntity(text, i);
      if (ent) {
        flush();
        if (ent.decoded !== null) nodes.push({ k: 'e', raw: ent.decoded, html: escapeHtml(ent.decoded) });
        else nodes.push({ k: 'e', raw: ent.raw, html: ent.raw });
        i += ent.len;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '<') {
      // angle autolink first
      const rest = text.slice(i, Math.min(n, i + 1300));
      const am = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
      if (am) {
        flush();
        nodes.push({ k: 'a', href: am[1], title: null, auto: 'angle', rawText: am[1], children: [{ k: 't', raw: am[1] }] });
        i += am[0].length;
        continue;
      }
      const em = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/.exec(rest);
      if (em) {
        flush();
        nodes.push({ k: 'a', href: 'mailto:' + em[1], title: null, auto: 'angle', rawText: em[1], children: [{ k: 't', raw: em[1] }] });
        i += em[0].length;
        continue;
      }
      const raw = scanRawHtml(text, i);
      if (raw) {
        flush();
        nodes.push({ k: 'raw', s: text.slice(i, raw.end) });
        if (raw.tag && raw.tag.name === 'a') {
          // an a-tag token switches extended autolinks off until a
          // </a> appears — but only when the tag carries whitespace
          // inside it (attributes or a spaced self-close): <a> and
          // <a/> do not count, <a href="u"> and <a /> do
          if (raw.tag.closing) ctx.inLink.v = false;
          else if (/\s/.test(text.slice(i + 2, raw.end - 1))) ctx.inLink.v = true;
        }
        i = raw.end;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '!' && text[i + 1] === '[') {
      flush();
      nodes.push({ k: 't', raw: '![' });
      brackets.push({ nodeIdx: nodes.length - 1, isImage: true, delimCount: delims.length, active: true, startIdx: i + 2 });
      i += 2;
      continue;
    }
    if (ch === '[') {
      flush();
      nodes.push({ k: 't', raw: '[' });
      brackets.push({ nodeIdx: nodes.length - 1, isImage: false, delimCount: delims.length, active: true, startIdx: i + 1 });
      i++;
      continue;
    }
    if (ch === ']') {
      flush();
      i = formLink(text, i, nodes, delims, brackets, ctx);
      // a link whose label held a dangling backtick run kills
      // emphasis for the rest of the paragraph when another
      // backtick follows later in it
      if (ctx.taintedFormEnd === i) {
        ctx.taintedFormEnd = -1;
        if (text.slice(i).includes('`')) suppressRest = true;
      }
      ctx.lastFormed = false;
      // (delimiters pushed from here on carry the post-taint flag)
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (i + run < n && text[i + run] === ch) run++;
      const before = i > 0 ? text[i - 1] : '\n';
      const after = i + run < n ? text[i + run] : '\n';
      const beforeWs = isSpaceCh(before);
      const afterWs = isSpaceCh(after);
      const beforeP = isUnicodePunct(before);
      const afterP = isUnicodePunct(after);
      const leftFlank = !afterWs && (!afterP || beforeWs || beforeP);
      const rightFlank = !beforeWs && (!beforeP || afterWs || afterP);
      let canOpen, canClose;
      if (ch === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || beforeP);
        canClose = rightFlank && (!leftFlank || afterP);
      } else {
        canOpen = !afterWs;
        canClose = !beforeWs;
      }
      flush();
      nodes.push({ k: 't', raw: text.slice(i, i + run) });
      if (ch !== '~' || run <= 2) {
        delims.push({ node: lastTextNode(), char: ch, len: run, canOpen, canClose, postDead: suppressRest || undefined });
      }
      i += run;
      continue;
    }
    // extended autolinks, tried at word starts inside plain text
    if (!ctx.inLink.v && (ch === 'w' || ch === 'h' || ch === 'H' || ch === 'm' || ch === 'x' || isAlnumCh(ch) || ch === '.' || ch === '_')) {
      const prevCh = i > 0 ? text[i - 1] : ' ';
      if (!/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]/.test(prevCh)) {
        // an autolink sitting in a ]( dest position scans greedily
        // too: that text was a would-be link destination
        const greedy = ctx.greedyAutolink === true || (text[i - 2] === ']' && text[i - 1] === '(');
        if (greedy) ctx.greedyAutolink = false;
        const bound = brackets.length > 0 ? looseLabelEnd(text, i) : text.length;
        const linked = tryExtendedAutolink(text, i, nodes, flush, bound, greedy, delims);
        if (linked > 0) { i += linked; continue; }
        if (linked < 0) { buf += text.slice(i, i - linked); i += -linked; continue; }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  processEmphasis(nodes, delims, 0, true);
  return renderNodes(nodes);
}
// The end of the innermost open bracket's label, found by a loose
// scan from `from`: the first ] that is not balanced by a [ inside.
// Code-span and autolink searches inside a bracket stop there.
function looseLabelEnd(text, from) {
  let depth = 0;
  let j = from;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) { j += 2; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0) return j;
      depth--;
    }
    j++;
  }
  return text.length;
}
// Scan a URL body: everything up to whitespace or <>, bounded by the
// open bracket's label end when inside one.
function scanUrlBody(text, i, bound) {
  let j = i;
  const end = Math.min(text.length, bound === undefined ? text.length : bound);
  while (j < end) {
    const ch = text[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '<' || ch === '>') break;
    j++;
  }
  return text.slice(i, j);
}
// Try an extended autolink at text[i]. On success pushes the node and
// returns the number of source chars consumed (link part only); the
// caller leaves any trimmed tail to be scanned as text. Returns 0 when
// nothing links here.
// Greedy URL body used after a link formation failed on a parsed
// destination: consumes closers and ] freely, plus balanced
// whitespace-free (...) groups; nothing is trimmed afterwards.
function scanGreedyBody(text, i) {
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '<' || ch === '>') break;
    if (ch === '(') {
      let depth = 1;
      let k = j + 1;
      let ok = false;
      while (k < text.length) {
        const c2 = text[k];
        if (c2 === ' ' || c2 === '\t' || c2 === '\n' || c2 === '\r') break;
        if (c2 === '(') depth++;
        else if (c2 === ')') { depth--; if (depth === 0) { ok = true; break; } }
        k++;
      }
      if (!ok) break;
      j = k + 1;
      continue;
    }
    if (ch === ')') {
      // a closer is consumed only as part of a )] pair (the failed
      // link's dest close plus the outer bracket's close)
      if (text[j + 1] === ']') { j += 2; continue; }
      break;
    }
    if (ch === ']') break;
    j++;
  }
  return text.slice(i, j);
}
function tryExtendedAutolink(text, i, nodes, flush, bound, greedy, delims) {
  const rest = text.slice(i);
  // www. (case-sensitive)
  if (rest.startsWith('www.')) {
    if (greedy) {
      const raw = scanGreedyBody(text, i);
      if (raw.length > 4 && raw.slice(4).includes('.')) {
        flush();
        nodes.push({ k: 'a', href: 'http://' + raw, title: null, children: [{ k: 't', raw }], auto: 'ext' });
        return raw.length;
      }
      return 0;
    }
    const raw = scanUrlBody(text, i, bound);
    const url = trimAutolink(raw);
    if (url.length > 4 && url.indexOf('.', 4) > 0) {
      flush();
      nodes.push({ k: 'a', href: 'http://' + url, title: null, auto: 'ext', rawText: url, children: [{ k: 't', raw: url }] });
      return url.length;
    }
    return 0;
  }
  // http:// or https:// (case-insensitive scheme)
  const hm = /^https?:\/\//i.exec(rest);
  if (hm) {
    if (greedy) {
      const raw = scanGreedyBody(text, i);
      if (raw.length > hm[0].length) {
        flush();
        nodes.push({ k: 'a', href: raw, title: null, children: [{ k: 't', raw }], auto: 'ext' });
        return raw.length;
      }
      return 0;
    }
    const raw = scanUrlBody(text, i, bound);
    if (raw.length > hm[0].length) {
      const url = trimAutolink(raw);
      if (url.length > hm[0].length) {
        flush();
        nodes.push({ k: 'a', href: url, title: null, auto: 'ext', rawText: url, children: [{ k: 't', raw: url }] });
        return url.length;
      }
    }
    return 0;
  }
  // mailto: / xmpp: prefixed addresses
  if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) {
    const isXmpp = rest[0] === 'x';
    const pre = isXmpp ? 5 : 7;
    const em = EMAIL_CAND_RE.exec(rest.slice(pre));
    if (!em) return 0;
    const addrLen = emailLinkLen(em[0]);
    if (addrLen === 0) {
      // a candidate ending in - or _ poisons the whole token
      if (em[0].endsWith('-') || em[0].endsWith('_')) return -(pre + em[0].length);
      return 0;
    }
    let total = pre + addrLen;
    if (isXmpp && rest[total] === '/') {
      // one path segment joins the link; if that segment carries an
      // @ the whole remaining token joins instead
      const seg = /^\/[^/\s<>]*/.exec(rest.slice(total));
      if (seg) {
        if (seg[0].indexOf('@') >= 0) {
          const whole = /^[^\s<>]*/.exec(rest.slice(total));
          total += whole[0].length;
        } else {
          total += seg[0].length;
        }
      }
    }
    const linkText = rest.slice(0, total);
    flush();
    nodes.push({ k: 'a', href: linkText, title: null, auto: 'ext', rawText: linkText, children: [{ k: 't', raw: linkText }] });
    return total;
  }
  // bare email
  if (isAlnumCh(text[i]) || text[i] === '.' || text[i] === '_') {
    const em = EMAIL_CAND_RE.exec(rest);
    if (em) {
      let len = emailLinkLen(em[0]);
      if (len <= 0 && em[0].endsWith('_') && delims) {
        // a trailing _ run that exactly closes a pending _ delimiter
        // is not part of the address
        let runLen = 0;
        while (runLen < em[0].length && em[0][em[0].length - 1 - runLen] === '_') runLen++;
        const hasOpener = delims.some((d) => d.char === '_' && d.canOpen && d.len === runLen && !d.dead);
        if (hasOpener) {
          const cand = em[0].slice(0, em[0].length - runLen);
          const l2 = emailLinkLen(cand);
          if (l2 === cand.length) len = l2;
        }
      }
      if (len > 0) {
        const addr = em[0].slice(0, len);
        flush();
        nodes.push({ k: 'a', href: 'mailto:' + addr, title: null, auto: 'ext', rawText: addr, children: [{ k: 't', raw: addr }] });
        return len;
      }
      if (em[0].endsWith('-') || em[0].endsWith('_')) {
        // the whole candidate stays plain text; swallow it into the
        // buffer by reporting a consume of its length as text — the
        // caller treats >0 as a link, so instead handle via sentinel:
        return -em[0].length;
      }
    }
  }
  return 0;
}
// ---------- emphasis ----------
// CommonMark delimiter pairing over the stack slice above `bottom`
// (an index into delims). Pairs wrap the nodes between the two
// delimiter text nodes; leftover delimiter chars stay as text.
function processEmphasis(nodes, delims, bottom, honorPostDead) {
  let ci = bottom;
  let postDeadUsed = false;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (closer.dead) { ci++; continue; }
    // after a tainted link, only the FIRST later emphasis closer is
    // dead; subsequent emphasis in the paragraph behaves normally
    if (honorPostDead && closer.postDead && closer.canClose && closer.len > 0) {
      if (!postDeadUsed) { postDeadUsed = true; ci++; continue; }
    }
    if (!closer.canClose || closer.len === 0) { ci++; continue; }
    // find the nearest matching opener below the closer; a
    // candidate vetoed by the marked glued-span rule does not end
    // the search — an earlier opener may still take the closer
    let oi = ci - 1;
    let opener = null;
    let use = 0;
    while (oi >= bottom) {
      const cand = delims[oi];
      if (!cand.dead && cand.char === closer.char && cand.canOpen && cand.len > 0) {
        // rule of three
        const oddMatch = ((closer.canOpen || cand.canClose) &&
          (cand.len + closer.len) % 3 === 0 &&
          !(cand.len % 3 === 0 && closer.len % 3 === 0));
        if (oddMatch) { oi--; continue; }
        // a single closer never halves a two-run opener when a
        // later two-run closer exists to take the strong as a whole
        if (closer.len === 1 && cand.len === 2 && closer.char !== '~') {
          let laterStrong = false;
          for (let k = ci + 1; k < delims.length; k++) {
            if (delims[k].char === closer.char && delims[k].canClose && delims[k].len >= 2) { laterStrong = true; break; }
          }
          if (laterStrong) { oi--; continue; }
        }
        const u = (cand.len >= 2 && closer.len >= 2) ? 2 : 1;
        if (gluedBlocks(nodes, delims, cand, closer, u)) { oi--; continue; }
        opener = cand;
        use = u;
        break;
      }
      oi--;
    }
    if (!opener) { ci++; continue; }
    opener.len -= use;
    closer.len -= use;
    opener.node.raw = opener.node.raw.slice(0, opener.len);
    closer.node.raw = closer.node.raw.slice(closer.node.raw.length - closer.len);
    // wrap the nodes strictly between the two delimiter nodes
    const oIdx = nodes.indexOf(opener.node);
    const cIdx = nodes.indexOf(closer.node);
    const inner = nodes.splice(oIdx + 1, cIdx - oIdx - 1);
    const tag = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const wrap = { k: tag, children: inner };
    // a leftover closer char slips inside the wrap when the content
    // ends with an emphasis span glued to a word character
    // (`**a *b*one***` keeps one star inside the strong)
    if (closer.len > 0 && use === 2 && inner.length >= 2) {
      const lastN = inner[inner.length - 1];
      let pj = inner.length - 2;
      while (pj >= 0 && inner[pj].k === 't' && inner[pj].raw === '') pj--;
      const prevN = pj >= 0 ? inner[pj] : null;
      if (lastN.k === 't' && prevN && prevN.k === 'em' && lastN.raw.length > 0 &&
          /^\S+$/.test(lastN.raw) && /[A-Za-z0-9]/.test(lastN.raw[lastN.raw.length - 1])) {
        inner.push({ k: 't', raw: closer.char });
        closer.len -= 1;
        closer.node.raw = closer.node.raw.slice(1);
      }
    }
    nodes.splice(oIdx + 1, 0, wrap);
    // drop delimiters between opener and closer
    for (let k = ci - 1; k > oi; k--) delims.splice(k, 1);
    if (closer.len === 0) delims.splice(delims.indexOf(closer), 1);
    if (opener.len === 0) delims.splice(delims.indexOf(opener), 1);
    // resume scanning just past the opener's slot: a closer that still
    // has length retries against earlier openers, and the next closer
    // in line sits right after the opener's old position
    if (closer.len > 0) ci = delims.indexOf(closer);
    else ci = Math.max(bottom, oi);
    if (ci >= delims.length) break;
  }
}
// Marked-specific emphasis veto, refined by oracle probes: a pair is
// blocked when the span it would wrap directly contains a child of the
// OTHER star kind whose closing delimiter is glued to a following word
// character while its opening side is free — the `*a **b**c*` shape,
// where marked keeps the outer singles literal and forms only the
// inner strong. Same-kind children and dead (canOpen=false) stars do
// not trigger the veto.
function gluedBlocks(nodes, delims, opener, closer, use) {
  if (opener.char !== '*' || use !== 1) return false;
  const oIdx = nodes.indexOf(opener.node);
  const cIdx = nodes.indexOf(closer.node);
  for (let k = oIdx + 1; k < cIdx; k++) {
    const nd = nodes[k];
    if (nd.k !== 'strong') continue;
    // the strong's closing delimiter is the delim entry right before
    // the closer whose node follows the strong node; approximate the
    // glue test from the rendered surroundings: strong is right-glued
    // when the node after it is text starting with a word character
    // and the strong is not the last inner node.
    // the strong's right neighbour, skipping emptied delimiter nodes
    let ai = k + 1;
    while (ai < cIdx && nodes[ai].k === 't' && nodes[ai].raw === '') ai++;
    const after = nodes[ai];
    if (after && after.k === 't' && after.raw.length > 0 && /[A-Za-z0-9]/.test(after.raw[0])) {
      // left-free: the content before the strong (skipping emptied
      // delimiter text nodes) ends with whitespace, or the strong
      // starts the span
      let bi = k - 1;
      while (bi > oIdx && nodes[bi].k === 't' && nodes[bi].raw === '') bi--;
      const before = nodes[bi];
      const leftFree = bi === oIdx || (before && before.k === 't' && /\s$/.test(before.raw));
      if (leftFree) return true;
    }
  }
  return false;
}

// ---------- link / image formation on ']' ----------
// Attempts, for the nearest active bracket opener: inline destination,
// then full/collapsed reference, then shortcut reference — with
// marked's rule that a failed full-reference attempt (a second bracket
// pair was present) forbids the shortcut fallback for that opener.
// Returns the new scan index (just past the consumed source).
function formLink(text, i, nodes, delims, brackets, ctx) {
  const closeIdx = i; // text[i] === ']'
  ctx.lastFormed = false;
  // find nearest active bracket
  let bi = brackets.length - 1;
  while (bi >= 0 && !brackets[bi].active) bi--;
  if (bi < 0) {
    nodes.push({ k: 't', raw: ']' });
    return i + 1;
  }
  const br = brackets[bi];
  const openerNode = nodes[br.nodeIdx];
  const contentStart = br.nodeIdx + 1;
  // A bracket whose label held a 2+-backtick span containing a
  // backtick forms no link (unless the span ended exactly at this
  // ]), and emphasis inside it is dead.
  if (br.badSpan && br.badSpanEnd !== i) {
    const contentNodes = new Set(nodes.slice(contentStart));
    for (const d of delims) {
      if (contentNodes.has(d.node)) d.dead = true;
    }
    br.active = false;
    nodes.push({ k: 't', raw: ']' });
    return i + 1;
  }
  let dest = null;
  let title = null;
  let end = -1;
  let isRef = false;
  let labelText = null;

  const after = i + 1;
  if (text[after] === '(') {
    // inline link: destination and optional title up to the close paren
    const parsed = scanInlineLink(text, after);
    if (parsed) {
      dest = parsed.dest;
      title = parsed.title;
      end = parsed.end;
    }
  }
  if (end < 0 && text[after] === '[') {
    const labEnd = scanLabelEnd(text, after);
    if (labEnd > 0) {
      const rawLab = text.slice(after + 1, labEnd - 1);
      labelText = rawLab === '' ? null : rawLab;
      const key = foldLabel(labelText === null ? text.slice(0, 0) : labelText);
      if (labelText !== null) {
        const def = ctx.defs.get(key);
        if (def) { dest = def.dest; title = def.title; end = labEnd; isRef = true; }
      } else {
        // collapsed reference: label is the link text itself, taken
        // as raw source (escapes are NOT processed for lookup)
        const txt = text.slice(br.startIdx, closeIdx);
        const def = ctx.defs.get(foldLabel(txt));
        if (def) { dest = def.dest; title = def.title; end = labEnd; isRef = true; }
      }
      if (end < 0) {
        // failed full/collapsed ref: no shortcut fallback
        br.active = false;
        nodes.push({ k: 't', raw: ']' });
        return i + 1;
      }
    }
  }
  if (end < 0) {
    // shortcut reference: label is the link text as raw source
    // (backslash escapes are NOT processed before lookup)
    const txt = text.slice(br.startIdx, closeIdx);
    const def = ctx.defs.get(foldLabel(txt));
    if (def) { dest = def.dest; title = def.title; end = i + 1; isRef = true; }
  }
  if (end < 0) {
    br.active = false;
    nodes.push({ k: 't', raw: ']' });
    return i + 1;
  }
  // A link (not image) whose content already contains a real link
  // node fails; autolinks inside do not block it and stay linked.
  if (!br.isImage) {
    for (let k = contentStart; k < nodes.length; k++) {
      if (nodes[k].k === 'a' && !nodes[k].auto) {
        // the destination is re-scanned as text next; an autolink
        // found there swallows the rest of the would-be link greedily
        ctx.greedyAutolink = true;
        br.active = false;
        nodes.push({ k: 't', raw: ']' });
        return i + 1;
      }
    }
  }
  // Form it: emphasis inside first, bounded below by the bracket's
  // recorded delimiter count, then wrap. Delimiters pushed inside the
  // bracket are retired with it: they may not pair with anything
  // outside the link, in either direction.
  processEmphasis(nodes, delims, br.delimCount);
  delims.length = Math.min(delims.length, br.delimCount);
  const inner = nodes.splice(contentStart, nodes.length - contentStart);
  unwrapAutolinks(inner);
  const node = br.isImage
    ? { k: 'img', href: dest, title, children: inner }
    : { k: 'a', href: dest, title, children: inner };
  nodes.splice(contentStart, 0, node);
  // the opener text node ('[' or '![') disappears
  nodes.splice(br.nodeIdx, 1);
  brackets.splice(bi, 1);
  ctx.lastFormed = true;
  // only an inline (label+dest) formation carries the taint
  if (br.tickTaint && !isRef) ctx.taintedFormEnd = end;
  return end;
}
// Scan "( dest title )" starting at text[pos] === '('. Whitespace and
// up to one newline may separate the parts. Returns {dest,title,end}.
function scanInlineLink(text, pos) {
  let i = skipInlineWs(text, pos + 1, true);
  if (text[i] === ')') return { dest: '', title: null, end: i + 1 };
  const d = scanDest(text, i);
  if (!d) return null;
  i = skipInlineWs(text, d.end, true);
  let title = null;
  if (text[i] !== ')') {
    const t = scanTitle(text, i);
    if (!t) return null;
    title = t.title;
    i = skipInlineWs(text, t.end, true);
  }
  if (text[i] !== ')') return null;
  return { dest: d.dest, title, end: i + 1 };
}
// ---------- block parsing ----------
const HR_RE = /^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function isHrLine(text) {
  return HR_RE.test(text);
}
// What kind of HTML block (if any) starts with this remainder text?
// Returns 0 or the CommonMark type 1..7.
function htmlBlockStart(text, canInterruptPara) {
  if (text[0] !== '<') return 0;
  const rest = text.slice(1);
  const m1 = /^(pre|script|style|textarea)(?:[\s>]|$|\/>)/i.exec(rest);
  if (m1) return 1;
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (/^![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('![CDATA[')) return 5;
  const tm = /^(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (tm && BLOCK_TAGS.has(tm[2].toLowerCase())) {
    const after = rest.slice(tm[0].length);
    if (after === '' || /^[\s>]/.test(after) || after.startsWith('/>')) return 6;
    return 0;
  }
  if (canInterruptPara) return 0; // type 7 may not interrupt a paragraph
  const tag = scanTag(text, 0);
  if (tag) {
    const tail = text.slice(tag.end);
    if (/^[ \t]*$/.test(tail)) return 7;
  }
  return 0;
}
function htmlBlockEnd(text, type, name) {
  if (type === 1) return text.toLowerCase().includes('</' + name);
  if (type === 2) return text.includes('-->');
  if (type === 3) return text.includes('?>');
  if (type === 4) return text.includes('>');
  if (type === 5) return text.includes(']]>');
  return false;
}
// Parse a list marker at L.nextNonspace. Returns marker info or null.
function scanListMarker(L, src) {
  const i = L.nextNonspace;
  const col = L.nextNonspaceColumn;
  const ch = src[i];
  let bullet = null;
  let start = null;
  let delim = null;
  let mEnd = -1; // char index just past the marker
  let mEndCol = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    const nx = src[i + 1];
    if (nx !== undefined && nx !== ' ' && nx !== '\t' && i + 1 < src.length) return null;
    if (i + 1 >= src.length) { /* marker at EOL: empty item */ }
    bullet = ch;
    mEnd = i + 1;
    mEndCol = col + 1;
  } else if (ch >= '0' && ch <= '9') {
    let j = i;
    let num = 0;
    let digits = 0;
    while (j < src.length && src[j] >= '0' && src[j] <= '9' && digits < 10) {
      num = num * 10 + (src.charCodeAt(j) - 48);
      j++;
      digits++;
    }
    if (digits > 9) return null;
    if (src[j] !== '.' && src[j] !== ')') return null;
    const nx = src[j + 1];
    if (nx !== undefined && nx !== ' ' && nx !== '\t' && j + 1 < src.length) return null;
    start = num;
    delim = src[j];
    mEnd = j + 1;
    mEndCol = col + digits + 1;
  } else {
    return null;
  }
  // measure the whitespace run after the marker, in columns
  let j = mEnd;
  let c = mEndCol;
  let runCols = 0;
  let runChars = 0;
  while (j < src.length) {
    const cc = src[j];
    if (cc === ' ') { j++; c++; runCols++; runChars++; }
    else if (cc === '\t') { const w = 4 - (c % 4); j++; c += w; runCols += w; runChars++; }
    else break;
  }
  const blankAfter = j >= src.length;
  let contentIndent;
  let consumeChars; // whitespace chars to consume after the marker
  if (blankAfter) {
    contentIndent = mEndCol + 1;
    consumeChars = 0;
  } else if (runCols >= 5) {
    contentIndent = mEndCol + 1;
    consumeChars = 1;
  } else {
    contentIndent = mEndCol + runCols;
    consumeChars = runChars;
  }
  return { bullet, start, delim, mEnd, mEndCol, contentIndent, consumeChars, blankAfter, mCol: col };
}

export function parse(markdown) {
  const src = String(markdown);
  const rawLines = src.split(/\r\n|\r|\n/);
  let hasTrailingTerm = true;
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  else hasTrailingTerm = false;
  const lines = rawLines.map((text, idx) => ({
    text,
    term: idx < rawLines.length - 1 ? true : hasTrailingTerm,
  }));

  const defs = new Map();
  const doc = { t: 'doc', children: [] };
  const stack = [doc];
  const tip = () => stack[stack.length - 1];

  function registerDefs(found) {
    for (const d of found) {
      if (!defs.has(d.label)) defs.set(d.label, { dest: d.dest, title: d.title });
    }
  }
  function finalizeNode(node) {
    if (node.t === 'para') {
      const { text, defs: found } = stripDefs(node.literal);
      registerDefs(found);
      node.literal = text;
      if (text === '') node.dead = true;
    } else if (node.t === 'code' && !node.fenced) {
      // indented code: drop leading/trailing blank content lines
      const ls = node.clines;
      let a = 0;
      let b = ls.length;
      while (a < b && ls[a] === '') a++;
      while (b > a && ls[b - 1] === '') b--;
      node.content = ls.slice(a, b).join('\n');
      if (node.content !== '') node.content += '\n';
    } else if (node.t === 'code' && node.fenced) {
      let content = node.clines.map((l, idx) => l + (node.clineTerms[idx] ? '\n' : '')).join('');
      if (node.closed) {
        if (content === '\n') content = '';
        else if (content.endsWith('\n\n')) {
          const lastNl = content.lastIndexOf('\n', content.length - 2);
          const lastLine = content.slice(lastNl + 1, content.length - 1);
          if (lastLine === '') content = content.slice(0, -1);
        }
        if (content !== '' && !content.endsWith('\n')) content += '\n';
      }
      node.content = content;
    } else if (node.t === 'item') {
      stripChainTail(node);
    } else if (node.t === 'list') {
      stripChainTail(node);
      let loose = false;
      const items = node.children.filter(c => c.t === 'item');
      for (let k = 0; k < items.length; k++) {
        if (items[k].blankSeparated) loose = true;
        if (k < items.length - 1 && items[k].endsBlank) loose = true;
      }
      node.loose = loose;
    }
  }
  function closeUpto(idx) {
    // finalize and pop everything above stack index idx
    while (stack.length - 1 > idx) {
      const node = stack.pop();
      finalizeNode(node);
      const parent = tip();
      if (node.dead) {
        const at = parent.children.indexOf(node);
        if (at >= 0) parent.children.splice(at, 1);
      }
    }
  }
  function addChild(node) {
    const parent = tip();
    if (parent.t === 'item' && parent.endsBlank && parent.children.length > 0) {
      parent.blankSeparated = true;
    }
    node.parent = parent;
    parent.children.push(node);
    // fresh content inside every open item ends its blank run
    for (const s of stack) if (s.t === 'item') s.endsBlank = false;
    return node;
  }
  // When a container closes and its last-child chain ends in an html
  // block, that block loses one trailing newline.
  function stripChainTail(node) {
    let cur = node;
    for (;;) {
      const kids = cur.children;
      if (!kids || kids.length === 0) return;
      cur = kids[kids.length - 1];
      if (cur.t === 'html') {
        if (!cur.stripped && cur.literal.endsWith('\n')) {
          cur.literal = cur.literal.slice(0, -1);
          cur.stripped = true;
        }
        return;
      }
    }
  }
  function stripHtmlTail() {
    // walk the last-child chain from the document root
    let node = doc;
    for (;;) {
      const kids = node.children;
      if (!kids || kids.length === 0) break;
      node = kids[kids.length - 1];
      if (node.t === 'html') {
        if (!node.stripped && node.literal.endsWith('\n')) {
          node.literal = node.literal.slice(0, -1);
          node.stripped = true;
        }
        return;
      }
    }
  }

  // ---- per-line processing ----
  for (const { text: lineText, term } of lines) {
    const L = makeLine(lineText);
    computeNext(L);
    // Phase 1: match open containers.
    let matched = 0; // stack index of deepest matched container
    let listRollback = -1;
    for (let idx = 1; idx < stack.length; idx++) {
      const node = stack[idx];
      if (node.t === 'list') { listRollback = matched; matched = idx; continue; }
      if (node.t === 'quote') {
        if (!L.blank && L.indent <= 3 && L.s[L.nextNonspace] === '>') {
          advance(L, L.nextNonspace - L.offset, false);
          advance(L, 1, false);
          const tabAsSpace = L.s[L.offset] === '\t';
          if (L.s[L.offset] === ' ' || L.s[L.offset] === '\t' || L.partial > 0) advance(L, 1, true);
          L.afterQuote = tabAsSpace || (L.partial === 0 && L.s[L.offset] === '\t');
          matched = idx;
          continue;
        }
        break;
      }
      if (node.t === 'item') {
        if (L.blank) { matched = idx; continue; }
        // an empty item separated by a blank line is finished: the
        // next content line no longer belongs to it
        if (node.children.length === 0 && node.endsBlank) break;
        // the indent is measured in the item's local frame: from the
        // current position (after outer containers matched) against
        // the item's content indent relative to its list's frame
        if (L.indent >= node.localIndent) {
          advance(L, node.localIndent, true);
          matched = idx;
          continue;
        }
        break;
      }
      // para / head / code / html / table are leaves: stop matching
      break;
    }
    const cur = tip();
    const leafTip = cur.t === 'para' || cur.t === 'head' || cur.t === 'code' || cur.t === 'html' || cur.t === 'table';
    const allMatched = leafTip ? matched === stack.length - 2 : matched === stack.length - 1;

    // Phase 2: leaf continuation for code / html / table tips.
    if (cur.t === 'code' && cur.fenced) {
      const isClose = allMatched && !L.blank && L.indent <= 3 && fenceClose(L, cur);
      if (allMatched) {
        if (isClose) { cur.closed = true; closeUpto(stack.length - 2); }
        else {
          cur.clines.push(fenceContentLine(L, cur));
          cur.clineTerms.push(term);
          cur.hasContent = true;
        }
        continue;
      }
      // absorption: unmatched containers are only lists/items
      let absorb = true;
      for (let idx = matched + 1; idx < stack.length - 1; idx++) {
        if (stack[idx].t !== 'list' && stack[idx].t !== 'item') { absorb = false; break; }
      }
      if (absorb && (cur.hasContent || (!L.blank && L.indent <= 3 && fenceCloseRaw(lineText, cur)))) {
        if (!L.blank && L.indent <= 3 && fenceCloseRaw(lineText, cur)) {
          cur.closed = true;
          closeUpto(matched);
        } else {
          cur.clines.push(lineText);
          cur.clineTerms.push(term);
        }
        continue;
      }
      // otherwise the fence closes with its containers below
    }
    if (cur.t === 'code' && !cur.fenced) {
      if (allMatched) {
        if (L.blank) {
          // blank line inside indented code: keep the excess indent
          cur.clines.push(blankCodeRemainder(L));
          continue;
        }
        if (L.indent >= 4) {
          const pre = L.column;
          advance(L, 4, true);
          cur.clines.push(codeLineText(L, pre));
          continue;
        }
      }
      closeUpto(stack.length - 2); // indented code ends; reprocess line
      // fall through with the code closed
    } else if (cur.t === 'html' && cur.htype >= 1 && cur.htype <= 5) {
      if (allMatched) {
        cur.literal += remainder(L) + (term ? '\n' : '');
        if (htmlBlockEnd(remainder(L), cur.htype, cur.hname)) closeUpto(stack.length - 2);
        continue;
      }
    } else if (cur.t === 'html' && (cur.htype === 6 || cur.htype === 7)) {
      if (allMatched && !L.blank) {
        cur.literal += remainder(L) + (term ? '\n' : '');
        continue;
      }
    } else if (cur.t === 'table') {
      if (allMatched) {
        if (isSpacesOnlyLine(lineText, L)) {
          closeUpto(stack.length - 2);
          // fall through to blank handling
        } else if (startsBlockLine(L)) {
          closeUpto(stack.length - 2);
          // fall through and reprocess as a fresh block
        } else {
          cur.rows.push(splitTableRow(remainder(L)));
          continue;
        }
      }
    }

    // Phase 3: blank line.
    if (L.blank && remainder(L) !== '' && tip().t === 'para' && allMatched && matched >= 1 && hasAncestor(tip(), 'quote')) {
      // a container-matched whitespace-only line inside a blockquote
      // is paragraph content, not a blank line
      tip().literal += '\n' + remainder(L);
      continue;
    }
    if (L.blank) {
      // html trailing-newline strip: type 6/7 blocks lose it at any
      // blank line; terminated blocks (types 1-5) only at a truly
      // empty line
      const openTip = tip();
      if (openTip.t === 'html' && (openTip.htype === 6 || openTip.htype === 7)) {
        stripHtmlTail();
      } else if (lineText === '') {
        stripHtmlTail();
      }
      // close leaves that a blank line ends
      closeUpto(matched);
      // Items inside the deepest matched blockquote (or anywhere when
      // no quote matched) now provisionally end with this blank; a
      // blank swallowed by a quote does not loosen items outside it,
      // and a later content line inside an item clears its flag again
      let qIdx = -1;
      for (let idx = 1; idx <= matched && idx < stack.length; idx++) {
        if (stack[idx].t === 'quote') qIdx = idx;
      }
      for (let idx = 1; idx < stack.length; idx++) {
        if (stack[idx].t === 'item' && idx > qIdx) stack[idx].endsBlank = true;
      }
      continue;
    }

    // Phase 4: lazy paragraph continuation.
    if (!allMatched && tip().t === 'para') {
      if (!startsBlockLine(L)) {
        const para = tip();
        let add = L.indent >= 4 ? remainderFromNonspace(L) : remainder(L);
        // a lazy line whose remainder starts with a tab right after
        // a matched blockquote marker: the tab becomes two spaces
        if (L.afterQuote && remainder(L).startsWith('\t')) {
          add = expandLeadingTabs(L, remainder(L), L.column);
        }
        // marked pads a lazy setext-shaped line inside a blockquote
        // with four spaces instead of treating it as an underline
        if (SETEXT_RE.test(remainderFromNonspace(L)) && hasAncestor(para, 'quote')) {
          add = '    ' + remainderFromNonspace(L);
        }
        para.literal += '\n' + add;
        continue;
      }
    }

    // Phase 5: close unmatched containers, then start new blocks.
    // An open paragraph whose containers all matched stays open: the
    // line-start logic below decides whether it continues, converts
    // (setext/table) or is interrupted.
    if (tip().t === 'para' && allMatched) closeUpto(stack.length - 1);
    else closeUpto(matched);
    processLineStarts(L, lineText, term);
  }
  closeUpto(0);

  const ctx = { defs, inLink: { v: false }, taintedFormEnd: -1 };
  return renderChildren(doc, ctx, false);

  // ---- helpers closed over the parser state ----
  function fenceClose(L, fence) {
    const m = FENCE_RE.exec(remainderFromNonspace(L));
    if (!m) return false;
    if (m[1][0] !== fence.ch) return false;
    if (m[1].length < fence.len) return false;
    if (fence.ch === '`' && m[2].includes('`')) return false;
    return /^[ \t]*$/.test(m[2]);
  }
  function fenceCloseRaw(text, fence) {
    const t = text.replace(/^[ ]{0,3}/, '');
    return fenceClose(makeLine(t), fence);
  }
  // Expand a leading tab run in a code content line. Only runs that
  // follow consumed container columns expand: the first tab becomes
  // exactly 2 spaces when it directly follows a blockquote marker,
  // otherwise tabs expand to tab stops by absolute column.
  function expandLeadingTabs(L, txt, baseColumn) {
    if (baseColumn <= 0) return txt;
    // a tab that served as the blockquote marker's following space
    // (partially consumed by the quote match) becomes exactly two
    // spaces in total, remnant included
    if (L.afterQuote && L.partial > 0 && txt[0] === ' ') {
      let k = 0;
      while (k < txt.length && txt[k] === ' ' && k < L.partial) k++;
      if (k > 0) return '  ' + txt.slice(k);
    }
    let col = baseColumn;
    let out = '';
    let k = 0;
    while (k < txt.length && (txt[k] === ' ' || txt[k] === '\t')) {
      if (txt[k] === ' ') { out += ' '; col++; k++; continue; }
      let w;
      if (k === 0 && L.afterQuote) w = 2;
      else w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      k++;
    }
    if (k === 0) return txt;
    return out + txt.slice(k);
  }
  function fenceContentLine(L, fence) {
    let txt = expandLeadingTabs(L, remainder(L), L.column);
    if (fence.ch === '~') return txt; // tilde fences never strip indent
    // backtick fences strip up to the opener indent in whitespace chars
    let strip = fence.indent;
    let k = 0;
    while (strip > 0 && k < txt.length && (txt[k] === ' ' || txt[k] === '\t')) { k++; strip--; }
    return txt.slice(k);
  }
  function codeLineText(L, preColumn) {
    return expandLeadingTabs(L, remainder(L), preColumn);
  }
  function blankCodeRemainder(L) {
    // advance up to 4 columns into the blank line; what remains (extra
    // spaces) is content, a short blank becomes an empty line
    const save = { ...L };
    if (L.nextNonspaceColumn - L.column >= 4) {
      advance(L, 4, true);
      return remainder(L);
    }
    Object.assign(L, save);
    return '';
  }
  function isSpacesOnlyLine(text, LL) {
    return LL.blank && !text.includes('\t');
  }
  function startsBlockLine(LL) {
    // does the (post-match) remainder start a block that would
    // interrupt a paragraph / end a table?
    const rem = remainderFromNonspace(LL);
    if (LL.indent > 3) return false;
    if (rem === '') return false;
    const c = rem[0];
    if (c === '>') return true;
    if (isHrLine(rem)) return true;
    if (ATX_RE.test(rem)) return true;
    if (FENCE_RE.test(rem)) {
      const m = FENCE_RE.exec(rem);
      if (m[1][0] === '~' || !m[2].includes('`')) return true;
    }
    if (htmlBlockStart(rem, true) !== 0) return true;
    if (scanListMarker(LL, LL.s)) return true;
    return false;
  }
  function processLineStarts(L, lineText, term) {
    // Container starts and leaf starts for a non-blank line whose
    // containers have been matched and closed down.
    // A list left on top whose item did not match this line ends here,
    // unless the line starts a sibling item of that same list.
    while (tip().t === 'list') {
      computeNext(L);
      if (L.indent <= 3 && isHrLine(remainderFromNonspace(L))) {
        const listNode = stack.pop();
        finalizeNode(listNode);
        continue;
      }
      const mk = L.indent <= 3 ? scanListMarker(L, L.s) : null;
      if (mk && sameListType(tip(), mk)) break; // sibling item follows
      const listNode = stack.pop();
      finalizeNode(listNode);
    }
    for (;;) {
      computeNext(L);
      if (L.blank) return;
      if (tip().t === 'para') break; // leaf logic below owns this line
      const rem = remainderFromNonspace(L);
      const c = rem[0];
      // thematic break beats list-item starts
      if (L.indent <= 3 && isHrLine(rem)) {
        addChild({ t: 'hr' });
        return;
      }
      // blockquote start
      if (L.indent <= 3 && c === '>') {
        const q = addChild({ t: 'quote', children: [] });
        stack.push(q);
        advance(L, L.nextNonspace - L.offset, false);
        advance(L, 1, false);
        const tabAsSpace = L.s[L.offset] === '\t';
        if (L.s[L.offset] === ' ' || L.s[L.offset] === '\t' || L.partial > 0) advance(L, 1, true);
        L.afterQuote = tabAsSpace || (L.partial === 0 && L.s[L.offset] === '\t');
        continue;
      }
      // list item start
      if (L.indent <= 3 && (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9'))) {
        const paraOpen = tip().t === 'para';
        const mk = scanListMarker(L, L.s);
        if (mk && listStartAllowed(mk, paraOpen)) {
          startListItem(L, mk);
          continue;
        }
      }
      break;
    }
    // leaf starts
    computeNext(L);
    if (L.blank) return;
    const rem = remainderFromNonspace(L);
    const para = tip().t === 'para' ? tip() : null;
    if (para) {
      // setext underline? (checked before list markers: a lone '-'
      // or '=' line under a paragraph is an underline, not an item)
      if (L.indent <= 3 && SETEXT_RE.test(rem)) {
        const { text: stripped, defs: found } = stripDefs(para.literal);
        if (stripped.trim() !== '') {
          registerDefs(found);
          const level = rem.trimStart()[0] === '=' ? 1 : 2;
          para.t = 'head';
          para.level = level;
          para.literal = stripped.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
          stack.pop();
          return;
        }
        para.literal += '\n' + remainder(L);
        return;
      }
      // a list marker that may not interrupt a paragraph (ordered
      // start other than 1, or an empty item) is paragraph text
      if (L.indent <= 3) {
        const mk0 = scanListMarker(L, L.s);
        if (mk0 && !listStartAllowed(mk0, true, para)) {
          para.literal += '\n' + continuationText(L, para);
          return;
        }
      }
      // setext underline?
      if (L.indent <= 3 && SETEXT_RE.test(rem)) {
        const { text: stripped, defs: found } = stripDefs(para.literal);
        if (stripped.trim() !== '') {
          registerDefs(found);
          const level = rem.trimStart()[0] === '=' ? 1 : 2;
          para.t = 'head';
          para.level = level;
          para.literal = stripped.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
          stack.pop();
          return;
        }
        // not a heading: the line is paragraph text
        para.literal += '\n' + remainder(L);
        return;
      }
      // table conversion?
      if (!para.literal.includes('\n') && para.literal.includes('|')) {
        const aligns = parseDelimiterRow(rem);
        if (aligns) {
          const header = splitTableRow(para.literal);
          if (header.length === aligns.length) {
            para.t = 'table';
            para.header = header;
            para.aligns = aligns;
            para.rows = [];
            delete para.literal;
            return;
          }
        }
      }
      // thematic break interrupts
      if (L.indent <= 3 && isHrLine(rem)) {
        stack.pop();
        finalizeNode(para);
        if (para.dead) {
          const p = tip();
          p.children.splice(p.children.indexOf(para), 1);
        }
        addChild({ t: 'hr' });
        return;
      }
      // other interrupting starts fall through to container/leaf
      // handling by closing the paragraph first
      if (startsBlockLine(L)) {
        stack.pop();
        finalizeNode(para);
        if (para.dead) {
          const p = tip();
          p.children.splice(p.children.indexOf(para), 1);
        }
        processLineStarts(L, lineText, term);
        return;
      }
      // plain continuation: verbatim remainder, except that inside a
      // list item a remainder indented 4+ columns is stripped bare
      para.literal += '\n' + continuationText(L, para);
      return;
    }
    // ATX heading
    if (L.indent <= 3) {
      const am = ATX_RE.exec(rem);
      if (am) {
        let content = am[2] || '';
        content = content.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
        if (/^#+$/.test(content)) content = '';
        addChild({ t: 'head', level: am[1].length, literal: content });
        return;
      }
      // fence
      const fm = FENCE_RE.exec(rem);
      if (fm && (fm[1][0] === '~' || !fm[2].includes('`'))) {
        const node = addChild({
          t: 'code', fenced: true, ch: fm[1][0], len: fm[1].length,
          info: fm[2].trim(), indent: L.indent, clines: [], clineTerms: [],
          hasContent: false, closed: false,
        });
        stack.push(node);
        return;
      }
      // html block
      const ht = htmlBlockStart(rem, false);
      if (ht !== 0) {
        const node = addChild({
          t: 'html', htype: ht,
          hname: ht === 1 ? /^(pre|script|style|textarea)/i.exec(rem.slice(1))[1].toLowerCase() : '',
          literal: remainder(L) + (term ? '\n' : ''), stripped: false,
        });
        if (ht >= 1 && ht <= 5) {
          if (htmlBlockEnd(remainder(L), ht, node.hname)) { /* closes at once */ }
          else stack.push(node);
        } else {
          stack.push(node);
        }
        return;
      }
      // thematic break
      if (isHrLine(rem)) {
        addChild({ t: 'hr' });
        return;
      }
    }
    // indented code
    if (L.indent >= 4) {
      const node = addChild({ t: 'code', fenced: false, clines: [] });
      const pre = L.column;
      advance(L, 4, true);
      node.clines.push(codeLineText(L, pre));
      stack.push(node);
      return;
    }
    // paragraph
    let firstText = remainder(L);
    if (L.afterQuote && firstText.startsWith('\t')) {
      firstText = expandLeadingTabs(L, firstText, L.column);
    }
    const node = addChild({ t: 'para', literal: firstText });
    stack.push(node);
  }
  function hasAncestor(node, type) {
    let cur = node.parent;
    while (cur) {
      if (cur.t === type) return true;
      cur = cur.parent;
    }
    return false;
  }
  function continuationText(L, para) {
    // a tab right after a blockquote marker becomes two spaces in
    // paragraph text (checked before the item indent strip: that
    // tab is quote-local, not item indentation)
    if (L.afterQuote && remainder(L).startsWith('\t')) {
      return expandLeadingTabs(L, remainder(L), L.column);
    }
    if (L.indent >= 4 && hasAncestor(para, 'item')) return remainderFromNonspace(L);
    return remainder(L);
  }
  function listStartAllowed(mk, paraOpen, para) {
    if (paraOpen) {
      if (mk.blankAfter) return false; // empty items never interrupt
      // ordered lists may interrupt with any start number when the
      // paragraph lives inside a list item; at the top level (and in
      // quotes) only a list starting at 1 interrupts
      if (mk.bullet === null && mk.start !== 1 && !(para && hasAncestor(para, 'item'))) return false;
    }
    return true;
  }
  function startListItem(L, mk) {
    // sibling of the current list, or a fresh list?
    let listNode = null;
    const parent = tip();
    // a marker seen while an item is open always nests inside that
    // item; siblings only ever arrive through the list itself, after
    // the previous item failed to match the new line
    if (parent.t === 'list' && sameListType(parent, mk)) {
      listNode = parent;
    }
    if (!listNode) {
      listNode = addChild({
        t: 'list', children: [], loose: false,
        bullet: mk.bullet, start: mk.start, delim: mk.delim,
        frameColumn: L.column, markerLocal: mk.mCol - L.column,
      });
      stack.push(listNode);
    }
    const item = {
      t: 'item', children: [], contentIndent: mk.contentIndent,
      localIndent: mk.contentIndent - listNode.frameColumn,
      blankSeparated: false, endsBlank: false,
    };
    item.parent = listNode;
    listNode.children.push(item);
    stack.push(item);
    // consume marker + padding: move to the marker, then advance
    advance(L, L.nextNonspace - L.offset, false);
    advance(L, mk.mEnd - L.nextNonspace, false);
    if (!mk.blankAfter) {
      // consume whitespace: all of it, or one char when padding >= 5
      if (mk.consumeChars >= 1 && (mk.contentIndent - mk.mEndCol) >= 1) {
        // advance columns until column reaches contentIndent
        advance(L, mk.contentIndent - L.column, true);
      }
    }
    computeNext(L);
  }
  function sameListType(list, mk) {
    if (mk.bullet !== null) return list.bullet === mk.bullet;
    return list.bullet === null && list.delim === mk.delim;
  }
}
// ---------- block rendering ----------
function renderChildren(node, ctx, tight) {
  let out = '';
  const kids = node.children || [];
  for (const child of kids) out += renderBlock(child, ctx, tight);
  return out;
}
function renderBlock(node, ctx, tight) {
  switch (node.t) {
    case 'doc':
      return renderChildren(node, ctx, false);
    case 'quote':
      return '<blockquote>\n' + renderChildren(node, ctx, false) + '</blockquote>\n';
    case 'list': {
      const open = node.bullet !== null && node.bullet !== undefined
        ? '<ul>\n'
        : '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n';
      const close = node.bullet !== null && node.bullet !== undefined ? '</ul>\n' : '</ol>\n';
      let out = open;
      for (const item of node.children) out += renderBlock(item, ctx, !node.loose);
      return out + close;
    }
    case 'item': {
      const inner = renderChildren(node, ctx, tight);
      return '<li>' + inner + '</li>\n';
    }
    case 'para': {
      let text = node.literal;
      let checkbox = '';
      if (node.parent && node.parent.t === 'item' && node.parent.children[0] === node) {
        const head4 = text.slice(0, 4);
        if (head4 === '[] ' || head4 === '[ ] ') {
          checkbox = '<input disabled="" type="checkbox"> ';
          text = text.slice(4);
        } else if (head4 === '[x] ' || head4 === '[X] ') {
          checkbox = '<input checked="" disabled="" type="checkbox"> ';
          text = text.slice(4);
        }
      }
      const inner = parseInline(text, ctx);
      if (tight) return checkbox + inner;
      return '<p>' + checkbox + inner + '</p>\n';
    }
    case 'head':
      return '<h' + node.level + '>' + parseInline(node.literal, ctx) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      if (node.fenced) {
        let cls = '';
        if (node.info) {
          const word = unescapeStr(node.info).split(/\s+/)[0];
          if (word) cls = ' class="language-' + escapeAttr(word) + '"';
        }
        return '<pre><code' + cls + '>' + escapeHtml(node.content || '') + '</code></pre>\n';
      }
      return '<pre><code>' + escapeHtml(node.content || '') + '</code></pre>\n';
    }
    case 'html':
      return node.literal;
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < node.header.length; k++) {
        const al = node.aligns[k];
        out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + parseInline(node.header[k], ctx) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let k = 0; k < node.header.length; k++) {
            const al = node.aligns[k];
            const cell = k < row.length ? row[k] : '';
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + parseInline(cell, ctx) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}





