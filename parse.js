// FlashMark — a from-scratch Markdown -> HTML renderer that matches
// marked 18.1.3 (default options: gfm on, breaks off) byte for byte,
// written for speed. No dependencies, no state shared between calls.

// ---------------------------------------------------------------- utilities

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.has(ch);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;

// The character (full code point) of `s` at code-unit index `i`, or ''.
function charAt(s, i) {
  if (i < 0 || i >= s.length) return '';
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) return s.slice(i, i + 2);
  return s[i];
}

// The character (full code point) ending just before code-unit index `i`.
function charBefore(s, i) {
  if (i <= 0 || i > s.length) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return s.slice(i - 2, i);
  return s[i - 1];
}

const WS_ASCII = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const PUNCT_ASCII = new Set('!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isWs(ch) {
  if (ch === '') return true;
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return WS_ASCII.has(ch);
  return WS_RE.test(ch);
}

function isPunctU(ch) {
  if (ch === '') return false;
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return PUNCT_ASCII.has(ch);
  return PUNCT_RE.test(ch);
}

// ------------------------------------------------------------- escaping

// Escape a plain text run: & < > " ' — the run holds no entity-shaped
// ampersand sequences (the scanner stops at '&'), so a blanket escape is
// correct here.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;
const ESC_RE_G = /[&<>"']/g;
function escapeTextRun(s) {
  if (!ESC_RE.test(s)) return s;
  return s.replace(ESC_RE_G, (ch) => ESC_MAP[ch]);
}

// Escape one literal character for inclusion in text.
function escapeChar(ch) {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return ch;
  }
}

// Escape code block / code span content: every special char, no entity
// awareness.
function escapeCode(s) {
  if (!ESC_RE.test(s)) return s;
  return s.replace(ESC_RE_G, (ch) => ESC_MAP[ch]);
}

const ENTITY_SHAPE = /&[A-Za-z][A-Za-z0-9]*;/g;

// Entity-aware attribute escaping (href/title/class of ordinary links):
// an '&' that begins an entity-shaped sequence is kept raw.
function escapeAttr(s) {
  if (!ESC_RE.test(s)) return s;
  return s
    .replace(/&(?![A-Za-z][A-Za-z0-9]*;)/g, '&amp;')
    .replace(/[<>"']/g, (ch) => ESC_MAP[ch]);
}

// Full attribute escaping (autolink hrefs): every '&' is escaped.
function escapeAttrFull(s) {
  if (!ESC_RE.test(s)) return s;
  return s.replace(ESC_RE_G, (ch) => ESC_MAP[ch]);
}

// marked's URL cleaning for hrefs.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Process backslash escapes in a string (link destinations, titles,
// fence info): backslash + ASCII punctuation becomes the punctuation.
function unescapeStr(s) {
  if (!s.includes('\\')) return s;
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

// ------------------------------------------------------------ references

// Case folding for reference labels: lowercase, then the special folds
// (sharp s and ligatures) that marked/CommonMark matching applies.
function foldLabel(s) {
  let out = s.toLowerCase();
  if (/[ßﬀﬁﬂﬃﬄﬅﬆ]/.test(out)) {
    out = out
      .replace(/ß/g, 'ss')
      .replace(/ﬀ/g, 'ff')
      .replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl')
      .replace(/ﬃ/g, 'ffi')
      .replace(/ﬄ/g, 'ffl')
      .replace(/ﬅ/g, 'st')
      .replace(/ﬆ/g, 'st');
  }
  return out;
}

function normalizeLabel(raw) {
  return foldLabel(raw.replace(/\s+/g, ' ').trim());
}

// ---------------------------------------------------------- table split

// Split a table row into cell sources. `\|` becomes `|` in the output;
// other backslash pairs are kept verbatim but shield the next char.
// Backtick spans suppress splitting only when a run of the same length
// closes later in the row.
function splitTableRow(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = row.length;
  while (i < n) {
    const c = row[i];
    if (c === '\\' && i + 1 < n) {
      if (row[i + 1] === '|') {
        cur += '|';
        i += 2;
      } else {
        cur += c + row[i + 1];
        i += 2;
      }
      continue;
    }
    // Note: marked's splitter has NO code-span awareness — a pipe
    // inside a code span splits the row like any other pipe; only
    // the escaped \| is protected (handled above).
    if (c === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  // A leading or trailing empty cell produced by an edge pipe is dropped.
  if (cells.length > 1 && cells[0].trim() === '' && row.trimStart().startsWith('|')) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && row.trimEnd().endsWith('|')) cells.pop();
  return cells.map((c) => c.trim());
}

// ============================================================ inline ===

const EMAIL_LOCAL = /[A-Za-z0-9._+\-]/;

// Fast char-class check for email local-part characters.
function isEmailLocalCode(cc) {
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) ||
    (cc >= 97 && cc <= 122) || cc === 46 || cc === 95 || cc === 43 ||
    cc === 45;
}

// Cheap pre-check: does an email candidate start at j? Scans the
// local part with char codes and only then runs the full regex.
function emailAt(text, j) {
  const n = text.length;
  let k = j;
  while (k < n && isEmailLocalCode(text.charCodeAt(k))) k++;
  if (k === j || text[k] !== '@') return false;
  return EMAIL_RE.test(text.slice(j, j + 200));
}

// Cheap scheme check: returns the prefix length for http://,
// https://, ftp:// at j, else 0.
function schemeAt(text, j) {
  const c0 = text[j];
  if (c0 === 'h' || c0 === 'H') {
    const m = /^https?:\/\//i.exec(text.slice(j, j + 8));
    return m ? m[0].length : 0;
  }
  if (c0 === 'f' || c0 === 'F') {
    return /^ftp:\/\//i.test(text.slice(j, j + 6)) ? 6 : 0;
  }
  return 0;
}
const EMAIL_RE = /^[A-Za-z0-9._+\-]+@(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+/;
const CM_EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/;
const SCHEME_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^ <>\n]*)>/;
const URL_SCHEME_RE = /^(?:https?|ftp):\/\//i;

// Try an extended autolink whose full text (prefix + body) starts at
// index i in `text`; the prefix has length prefixLen. Returns the
// trimmed URL text or null. Trimming (marked's, derived from probes):
// repeatedly remove trailing punctuation `?!.,:*_~'"`; a trailing ';'
// removes a whole trailing entity if it completes one, else just the
// ';'; a trailing ')' is removed when it has no matching '(' or when
// the group it closes itself contains a '('; finally, an unclosed '('
// that starts after the last matched ')' cuts the URL short.
function scanUrlBody(text, i, prefixLen, stopBracket) {
  const n = text.length;
  let end = i + prefixLen;
  while (end < n) {
    const c = text[end];
    if (c === '<' || c === ' ' || c === '\t' || c === '\n') break;
    if (stopBracket && c === ']') break; // a ']' closing an open bracket
    if (c === '(') {
      // Consume a balanced paren group (no whitespace inside); an
      // unclosed '(' ends the URL just before it (probed: doc-08).
      let depth = 0;
      let k = end;
      let closed = false;
      while (k < n) {
        const ch = text[k];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<') break;
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { k++; closed = true; break; }
        }
        k++;
      }
      if (!closed) break;
      end = k;
      continue;
    }
    end++;
  }
  let url = text.slice(i, end);
  const minLen = prefixLen + 1;
  for (;;) {
    if (url.length < minLen) return null;
    const last = url[url.length - 1];
    if ('?!.,:*_~\'"'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ';') {
      const amp = url.lastIndexOf('&');
      const tail = amp >= 0 ? url.slice(amp) : '';
      if (/^&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);$/.test(tail)) {
        url = url.slice(0, amp);
      } else {
        url = url.slice(0, -1);
      }
      continue;
    }
    if (last === ')') {
      // Pair up parentheses with a stack.
      const stack = [];
      let matchOpen = -1;
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') stack.push(k);
        else if (url[k] === ')') {
          const o = stack.pop();
          if (k === url.length - 1) matchOpen = o === undefined ? -1 : o;
        }
      }
      if (matchOpen < 0) {
        url = url.slice(0, -1);
        continue;
      }
      if (url.slice(matchOpen + 1, url.length - 1).includes('(')) {
        url = url.slice(0, -1);
        continue;
      }
      // This trailing ')' is fine.
    }
    // Unclosed '(' cut: find first unclosed '(' after the last
    // matched ')'.
    {
      const stack = [];
      let lastClose = -1;
      const matched = new Set();
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') stack.push(k);
        else if (url[k] === ')') {
          if (stack.length) { matched.add(stack.pop()); lastClose = k; }
        }
      }
      let cut = -1;
      for (const o of stack) {
        if (o > lastClose) { cut = o; break; }
      }
      if (cut >= 0) {
        url = url.slice(0, cut);
        continue;
      }
    }
    break;
  }
  return url.length >= minLen ? url : null;
}

// Inline node: doubly linked list entries.
// k: 'text' | 'code' | 'html' | 'br' | 'autolink' | 'delim' | 'open' |
//    'em' | 'strong' | 'del' | 'link' | 'image'
function newNode(k) {
  return { k, prev: null, next: null, first: null, last: null, html: '', raw: '' };
}

function listAppend(head, tail, node) {
  node.prev = tail;
  node.next = null;
  if (tail) tail.next = node;
  return node;
}

// Parse link destination + optional title starting at the '(' at index i.
// Returns {href, title, end} or null.
function parseLinkDest(text, i) {
  const n = text.length;
  let p = i + 1;
  const skipWs = () => {
    let sawNl = 0;
    while (p < n) {
      const c = text[p];
      if (c === ' ' || c === '\t') { p++; continue; }
      if (c === '\n') {
        sawNl++;
        if (sawNl > 1) return false;
        p++;
        continue;
      }
      break;
    }
    return true;
  };
  // Track blank-line crossings precisely: whitespace containing two
  // newlines separated only by spaces/tabs is not allowed.
  const skipWs2 = () => {
    let nl = 0;
    while (p < n) {
      const c = text[p];
      if (c === '\n') { nl++; p++; continue; }
      if (c === ' ' || c === '\t') { p++; continue; }
      break;
    }
    return nl <= 1;
  };
  void skipWs;
  if (!skipWs2()) return null;
  let href = null;
  if (text[p] === '<') {
    let j = p + 1;
    let ok = false;
    while (j < n) {
      const c = text[j];
      if (c === '\n' || c === '<') break;
      if (c === '\\' && text[j + 1] === '>') break;
      if (c === '>') { ok = true; break; }
      j++;
    }
    if (!ok) return null;
    href = text.slice(p + 1, j);
    p = j + 1;
  } else {
    let depth = 0;
    const start = p;
    while (p < n) {
      const c = text[p];
      if (c === '\\' && p + 1 < n && isAsciiPunct(text[p + 1])) { p += 2; continue; }
      if (c === '(') { depth++; p++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        p++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c < ' ') break;
      p++;
    }
    href = unescapeStr(text.slice(start, p));
  }
  const afterDest = p;
  if (!skipWs2()) return null;
  let title = null;
  const tc = text[p];
  if (tc === '"' || tc === "'" || tc === '(') {
    const closer = tc === '(' ? ')' : tc;
    let j = p + 1;
    let ok = false;
    let val = '';
    while (j < n) {
      const c = text[j];
      if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
        val += text[j + 1];
        j += 2;
        continue;
      }
      if (tc === '(' && c === '(') break;
      if (c === closer) { ok = true; break; }
      val += c;
      j++;
    }
    if (!ok) return null;
    title = val;
    p = j + 1;
    if (!skipWs2()) return null;
  } else if (p !== afterDest && text[p] !== ')') {
    // Whitespace then junk that is not a title: not an inline link.
    return null;
  }
  if (text[p] !== ')') return null;
  return { href, title, end: p + 1 };
}

// Scan a reference label starting at the '[' at index i.
// Returns {label, end} (end just past ']') or null.
function scanRefLabel(text, i) {
  const n = text.length;
  let j = i + 1;
  let depth = 0;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '[') {
      // Marked rejects reference labels containing brackets at all
      // (cm-547, cm-590), both in definitions and in full references.
      return null;
    }
    if (c === ']') {
      if (depth === 0) return { label: text.slice(i + 1, j), end: j + 1 };
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Plain-text rendering of a node range (for image alt text).
function plainTextOf(first, last) {
  let out = '';
  for (let nd = first; nd; nd = nd.next) {
    if (nd.k === 'text' || nd.k === 'code' || nd.k === 'html') out += nd.raw;
    else if (nd.k === 'autolink') out += nd.raw;
    else if (nd.k === 'image') out += nd.alt || '';
    else if (nd.k === 'delim') out += nd.raw;
    else if (nd.k === 'open') out += nd.raw;
    else if (nd.k === 'br') out += '\n';
    else if (nd.first) out += plainTextOf(nd.first, nd.last);
    if (nd === last) break;
  }
  return out;
}

function containsLink(first, last) {
  for (let nd = first; nd; nd = nd.next) {
    if (nd.k === 'link') return true;
    if (nd.first && containsLink(nd.first, nd.last)) return true;
    if (nd === last) break;
  }
  return false;
}

// Replace autolink nodes in a range by plain text nodes (used when a
// link/image forms around them: autolinks cannot nest inside links).
function unwrapAutolinks(first, last, parent) {
  for (let nd = first; nd; nd = nd.next) {
    if (nd.k === 'autolink' && !nd.angle) {
      // Extended autolinks inside a link become plain text; <...>
      // autolinks stay as nested links (verified against the oracle).
      nd.k = 'text';
      nd.html = escapeTextRun(nd.raw);
    } else if (nd.first) {
      unwrapAutolinks(nd.first, nd.last, nd);
    }
    if (nd === last) break;
  }
  void parent;
}

// True when a node between the delimiters is an em/strong whose next
// sibling (still inside the pair) starts with a word character.
function hasGluedEmphasis(openNode, closeNode, pairKind) {
  const otherKind = pairKind === 'em' ? 'strong' : 'em';
  // The glued rule only blocks EM pairs (probed: `**a *b*two***`
  // forms its strong despite the glued inner em, while `*a **b**c*`
  // and `**a *b **c**d* e**` keep em-pairs from forming around a
  // glued inner strong).
  if (pairKind !== 'em') return false;
  let prev = openNode;
  for (let nd = openNode.next; nd && nd !== closeNode; nd = nd.next) {
    if (nd.k === otherKind) {
      // The next meaningful sibling: skip consumed delimiter nodes.
      let sib = nd.next;
      while (sib && sib !== closeNode && sib.k === 'delim' &&
             (sib.raw || '') === '') {
        sib = sib.next;
      }
      if (sib && sib !== closeNode) {
        const raw = sib.raw || '';
        const ch = raw === '' ? '' : charAt(raw, 0);
        if (ch !== '' && !isWs(ch) && !isPunctU(ch)) {
          // Blocked only when the inner node is free-standing on its
          // left: at the pair's start, or after whitespace/punctuation.
          // Glued on both sides (foo**bar**baz) forms normally.
          const praw = (prev && prev.raw) || '';
          const pch = praw === '' ? '' : charAt(praw, praw.length - 1);
          if (prev === openNode || pch === '' || isWs(pch) || isPunctU(pch)) {
            return true;
          }
        }
      }
    }
    if (!(nd.k === 'delim' && (nd.raw || '') === '')) prev = nd;
  }
  return false;
}

// The delimiter-run emphasis processor (CommonMark algorithm, with
// marked's equal-length rule for '~').
function processEmphasis(delimStack, bottom, ctx) {
  const findCloser = (from) => {
    let i = Math.max(from, bottom);
    while (i < delimStack.length) {
      if (delimStack[i].canClose) return i;
      i++;
    }
    return -1;
  };
  let closerIdx = findCloser(bottom);
  while (closerIdx >= 0) {
    const closer = delimStack[closerIdx];
    // find nearest matching opener below closer
    let openerIdx = -1;
    for (let i = closerIdx - 1; i >= bottom; i--) {
      const op = delimStack[i];
      if (op.char !== closer.char || !op.canOpen) continue;
      if (ctx && op.char !== '~') {
        // Emphasis inside a bad-span-rejected bracket does not form.
        if (ctx.badZones.some(([z0, z1]) => op.idx >= z0 && closer.idx < z1)) {
          continue;
        }
        // A dangling-tick link formed earlier suppresses this pair
        // when another backtick run follows the closer.
        if (ctx.dangleEnds.some((e) => e <= op.idx) &&
            ctx.text.lastIndexOf('`') > closer.idx) {
          continue;
        }
      }
      if (op.char === '~' && op.len !== closer.len) continue;
      // A single '*' closer does not consume half of a '**' opener
      // when a later '**' closer can still pair with it as a strong
      // (marked matches the strong span as a whole).
      if (op.char === '*' && closer.len === 1 && op.len === 2) {
        let strongLater = false;
        for (let k = closerIdx + 1; k < delimStack.length; k++) {
          if (delimStack[k].char === '*' && delimStack[k].canClose &&
              delimStack[k].len >= 2) {
            strongLater = true;
            break;
          }
        }
        if (strongLater) continue;
      }
      // rule of three
      if (op.char !== '~' &&
          (closer.canOpen || op.canClose) &&
          (op.origLen + closer.origLen) % 3 === 0 &&
          !(op.origLen % 3 === 0 && closer.origLen % 3 === 0)) {
        continue;
      }
      // Marked's glued-emphasis rule ('*' only): the pair must not
      // form if a direct child of the OTHER emphasis kind is
      // immediately followed by a word character (e.g. `*a **b**c*`
      // leaves the outer '*' literal while the strong still forms).
      // Same-kind nesting (em in em) is unaffected.
      if (closer.char === '*' &&
          hasGluedEmphasis(op.node, closer.node,
            op.len >= 2 && closer.len >= 2 ? 'strong' : 'em')) {
        continue;
      }
      openerIdx = i;
      break;
    }
    if (openerIdx < 0) {
      if (closer.canOpen) {
        closerIdx = findCloser(closerIdx + 1);
      } else {
        delimStack.splice(closerIdx, 1);
        closerIdx = findCloser(closerIdx);
      }
      continue;
    }
    const opener = delimStack[openerIdx];
    const use = opener.char === '~'
      ? opener.len
      : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
    const kind = opener.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    // Wrap the nodes between opener.node and closer.node.
    const wrap = newNode(kind);
    const firstChild = opener.node.next;
    const lastChild = closer.node.prev;
    wrap.first = firstChild;
    wrap.last = lastChild;
    if (firstChild) firstChild.prev = null;
    if (lastChild) lastChild.next = null;
    wrap.prev = opener.node;
    wrap.next = closer.node;
    opener.node.next = wrap;
    closer.node.prev = wrap;
    opener.len -= use;
    closer.len -= use;
    opener.node.raw = opener.char.repeat(opener.len);
    closer.node.raw = closer.char.repeat(closer.len);
    // Marked quirk: a strong pair whose content ends with an em node
    // glued to a whitespace-free word (`**a *b*two***`) swallows the
    // closer's leftover stars INSIDE the strong instead of leaving
    // them outside.
    let movedIn = false;
    let prevMeaningful = lastChild ? lastChild.prev : null;
    while (prevMeaningful && prevMeaningful.k === 'delim' &&
           (prevMeaningful.raw || '') === '') {
      prevMeaningful = prevMeaningful.prev;
    }
    if (kind === 'strong' && closer.len > 0 && lastChild &&
        lastChild.k === 'text' && !/\s/.test(lastChild.raw || '') &&
        prevMeaningful && prevMeaningful.k === 'em') {
      wrap.next = closer.node.next;
      if (closer.node.next) closer.node.next.prev = wrap;
      closer.node.prev = wrap.last;
      if (wrap.last) wrap.last.next = closer.node;
      wrap.last = closer.node;
      closer.node.next = null;
      movedIn = true;
    }
    // Remove delimiter entries between opener and closer.
    delimStack.splice(openerIdx + 1, closerIdx - openerIdx - 1);
    closerIdx = openerIdx + 1;
    if (opener.len === 0) {
      // The node stays in the list as an empty delimiter (renders '').
      delimStack.splice(openerIdx, 1);
      closerIdx--;
    }
    if (movedIn) {
      delimStack.splice(closerIdx, 1);
    } else if (closer.len === 0) {
      delimStack.splice(closerIdx, 1);
    }
    // The (possibly same) closer may pair again; rescan from here.
    closerIdx = findCloser(closerIdx);
  }
}

function renderInlineNodes(first) {
  let out = '';
  for (let nd = first; nd; nd = nd.next) {
    switch (nd.k) {
      case 'text':
      case 'code':
      case 'html':
        out += nd.html;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'delim':
      case 'open':
        out += escapeTextRun(nd.raw);
        break;
      case 'autolink': {
        const href = nd.hrefKind === 'www' ? 'http://' + nd.raw : nd.hrefKind === 'email' ? 'mailto:' + nd.raw : nd.raw;
        out += '<a href="' + escapeAttrFull(cleanUrl(href)) + '">' + escapeAttrFull(nd.raw) + '</a>';
        break;
      }
      case 'em':
        out += '<em>' + renderInlineNodes(nd.first) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInlineNodes(nd.first) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInlineNodes(nd.first) + '</del>';
        break;
      case 'link': {
        out += '<a href="' + escapeAttr(cleanUrl(nd.href)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>' + renderInlineNodes(nd.first) + '</a>';
        break;
      }
      case 'image': {
        out += '<img src="' + escapeAttr(cleanUrl(nd.href)) + '" alt="' + escapeAttr(nd.alt) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

// Parse a strict CommonMark inline HTML tag starting at '<' (index i).
// Returns the tag text or null.
function scanTag(text, i) {
  const n = text.length;
  let p = i + 1;
  let closing = false;
  if (text[p] === '/') { closing = true; p++; }
  if (p >= n || !/[A-Za-z]/.test(text[p])) return null;
  p++;
  while (p < n && /[A-Za-z0-9-]/.test(text[p])) p++;
  if (closing) {
    while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p++;
    return text[p] === '>' ? text.slice(i, p + 1) : null;
  }
  for (;;) {
    let ws = 0;
    while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) { p++; ws++; }
    if (p >= n) return null;
    if (text[p] === '>') return text.slice(i, p + 1);
    if (text[p] === '/' && text[p + 1] === '>') return text.slice(i, p + 2);
    if (ws === 0) return null;
    // attribute name
    if (!/[A-Za-z_:]/.test(text[p])) return null;
    p++;
    while (p < n && /[A-Za-z0-9_.:-]/.test(text[p])) p++;
    // optional value
    let q = p;
    while (q < n && (text[q] === ' ' || text[q] === '\t' || text[q] === '\n')) q++;
    if (text[q] === '=') {
      q++;
      while (q < n && (text[q] === ' ' || text[q] === '\t' || text[q] === '\n')) q++;
      if (q >= n) return null;
      const v = text[q];
      if (v === '"' || v === "'") {
        const end = text.indexOf(v, q + 1);
        if (end < 0) return null;
        p = end + 1;
      } else {
        let e = q;
        while (e < n && !/[ \t\n"'=<>`]/.test(text[e])) e++;
        if (e === q) return null;
        p = e;
      }
    }
  }
}

// Scan link text source [a, b) for a code span with run length >= 2
// whose content contains a backtick.
function linkTextHasBadCodeSpan(text, a, b) {
  let i = a;
  while (i < b) {
    const c = text[i];
    if (c === '\\' && i + 1 < b) { i += 2; continue; }
    if (c !== '`') { i++; continue; }
    let j = i;
    while (j < b && text[j] === '`') j++;
    const run = j - i;
    // find a closing run of exactly `run` backticks
    let k = j;
    let contentEnd = -1;
    while (k < b) {
      if (text[k] === '`') {
        let m = k;
        while (m < b && text[m] === '`') m++;
        if (m - k === run) { contentEnd = k; k = m; break; }
        k = m;
      } else k++;
    }
    if (contentEnd < 0) { i = j; continue; }
    // A multi-backtick span whose content holds a backtick is allowed
    // only as the very last element of the link text.
    if (run >= 2 && text.slice(j, contentEnd).includes('`') && k !== b) {
      return true;
    }
    i = k;
  }
  return false;
}

// Marked tracks an inLink state across the whole document's inline
// lexing: an inline '<a ...>' tag token switches it on (extended
// autolinks are then suppressed) until an inline '</a>' token.
// Rendering walks blocks in document order, so a per-parse holder
// reproduces it.
const INLINK = { v: false };

// Loose label scan used to bound code-span searches inside a bracket:
// from just after the '[', walk chars, escapes, nested brackets and
// loosely-matched backtick spans (any run closes any run); return the
// index of the ']' that closes the label, or -1 if there is none.
function looseLabelEnd(text, start) {
  const n = text.length;
  let depth = 0;
  let i = start;
  while (i < n) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      // find the next backtick run (any length) to close the span
      let k = j;
      let closeEnd = -1;
      while (k < n) {
        if (text[k] === '`') {
          let m = k;
          while (m < n && text[m] === '`') m++;
          closeEnd = m;
          break;
        }
        k++;
      }
      if (closeEnd < 0) return -1;
      i = closeEnd;
      continue;
    }
    i++;
  }
  return -1;
}

// True when the source range holds a backtick run with no exact-run
// closing run inside the same range (a "dangling" run, as in the
// label `a ``url`).
function labelHasDanglingTick(text, a, b) {
  let i = a;
  while (i < b) {
    if (text[i] === '\\' && i + 1 < b) { i += 2; continue; }
    if (text[i] !== '`') { i++; continue; }
    let j = i;
    while (j < b && text[j] === '`') j++;
    const run = j - i;
    let k = j;
    let closeEnd = -1;
    while (k < b) {
      if (text[k] === '`') {
        let m = k;
        while (m < b && text[m] === '`') m++;
        if (m - k === run) { closeEnd = m; break; }
        k = m;
      } else k++;
    }
    if (closeEnd < 0) return true;
    i = closeEnd;
  }
  return false;
}

// The inline parser: turns a block's text into HTML.
// Any character or sequence that can trigger inline processing:
// specials, autolink schemes / www. / mailto: / xmpp:, an '@' (email),
// or a hard break (2+ spaces before a newline).
const INLINE_TRIGGER = /[`\\!\[\]<>&*_~@]|https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:| {2}\n/i;

// Run-loop character classes (ASCII): 0 = plain, 1 = hard special
// (break), 2 = autolink-start candidate (h/f/w/m/x), 3 = email-local
// char (word starts may begin an email).
const RUN_CLASS = new Uint8Array(128);
for (const ch of '\\`![]<>&*_~\n') RUN_CLASS[ch.charCodeAt(0)] = 1;
for (const ch of 'hHfF') RUN_CLASS[ch.charCodeAt(0)] = 2;
RUN_CLASS[119] = 2; // w
RUN_CLASS[109] = 2; // m
RUN_CLASS[120] = 2; // x
for (let cc = 48; cc <= 57; cc++) RUN_CLASS[cc] = 3;
for (let cc = 65; cc <= 90; cc++) if (!RUN_CLASS[cc]) RUN_CLASS[cc] = 3;
for (let cc = 97; cc <= 122; cc++) if (!RUN_CLASS[cc]) RUN_CLASS[cc] = 3;
RUN_CLASS[46] = 3; // .
RUN_CLASS[43] = 3; // +
RUN_CLASS[45] = 3; // -

function parseInline(text, refs) {
  // Fast path: nothing in the text can start an inline construct, so
  // the whole span is literal text (INLINK state untouched).
  if (!INLINE_TRIGGER.test(text)) return escapeTextRun(text);
  const n = text.length;
  const sentinel = newNode('root');
  let tail = sentinel;
  const delimStack = [];
  const bracketStack = [];
  let bufHtml = '';
  let bufRaw = '';

  const flushText = () => {
    if (bufHtml !== '') {
      const nd = newNode('text');
      nd.html = bufHtml;
      nd.raw = bufRaw;
      nd.prev = tail;
      tail.next = nd;
      tail = nd;
      bufHtml = '';
      bufRaw = '';
    }
  };
  const appendNode = (nd) => {
    flushText();
    nd.prev = tail;
    tail.next = nd;
    tail = nd;
  };

  // Source ranges of brackets rejected for a bad code span (emphasis
  // inside them does not form in marked), and end positions of formed
  // links/images whose label held a dangling backtick run (they
  // suppress later emphasis when another backtick follows).
  const badZones = [];
  const dangleEnds = [];

  // Attempt to close the bracket opener on top of the stack at the ']'
  // at source index j. Returns the new scan index.
  const closeBracket = (j) => {
    const opener = bracketStack[bracketStack.length - 1];
    if (!opener || !opener.active) {
      if (opener) bracketStack.pop();
      bufHtml += ']';
      bufRaw += ']';
      return j + 1;
    }
    // Marked rejects a link whose text holds a code span of 2+ backticks
    // whose content itself contains a backtick (its link-text pattern
    // only allows single-backtick spans).
    if (linkTextHasBadCodeSpan(text, opener.srcIdx + 1, j)) {
      badZones.push([opener.srcIdx, j]);
      bracketStack.pop();
      bufHtml += ']';
      bufRaw += ']';
      return j + 1;
    }
    const after = j + 1;
    let parsed = null;
    if (text[after] === '(') {
      parsed = parseLinkDest(text, after);
    }
    if (!parsed && text[after] === '[') {
      const lab = scanRefLabel(text, after);
      if (lab) {
        const key = lab.label === ''
          ? normalizeLabel(text.slice(opener.srcIdx + 1, j))
          : normalizeLabel(lab.label);
        const def = refs.get(key);
        if (def) {
          parsed = { href: def.href, title: def.title, end: lab.end };
        } else {
          // A full/collapsed reference that resolves nowhere kills
          // this opener; no shortcut attempt for the same ']'.
          bracketStack.pop();
          bufHtml += ']';
          bufRaw += ']';
          return j + 1;
        }
      }
    }
    if (!parsed) {
      const key = normalizeLabel(text.slice(opener.srcIdx + 1, j));
      const def = refs.get(key);
      if (def) parsed = { href: def.href, title: def.title, end: after };
    }
    if (!parsed) {
      bracketStack.pop();
      bufHtml += ']';
      bufRaw += ']';
      return j + 1;
    }
    // Form the link or image.
    if (labelHasDanglingTick(text, opener.srcIdx + 1, j)) {
      dangleEnds.push(parsed.end);
    }
    bracketStack.pop();
    flushText();
    const openNode = opener.node;
    const firstChild = openNode.next;
    const lastChild = tail;
    // Emphasis inside the bracket uses only delimiters pushed after
    // the bracket opened.
    processEmphasis(delimStack, opener.delimLen);
    // Remove delimiter entries whose nodes lie inside the children
    // (recursively): they must not pair with closers outside.
    if (firstChild) {
      const inside = new Set();
      const collect = (nd) => {
        if (!nd) return;
        inside.add(nd);
        if (nd.first) for (let c = nd.first; c; c = c.next) collect(c);
      };
      for (let nd = firstChild; nd; nd = nd.next) {
        collect(nd);
        if (nd === lastChild) break;
      }
      for (let d = delimStack.length - 1; d >= opener.delimLen; d--) {
        if (inside.has(delimStack[d].node)) delimStack.splice(d, 1);
      }
    }
    if (!opener.isImage && firstChild && containsLink(firstChild, lastChild)) {
      // Links cannot contain links: fail. The children stay as
      // ordinary nodes; the opener renders literally.
      openNode.k = 'text';
      openNode.html = opener.isImage ? '![' : '[';
      openNode.raw = openNode.html;
      bufHtml += ']';
      bufRaw += ']';
      return after;
    }
    unwrapAutolinks(firstChild, lastChild, null);
    const node = newNode(opener.isImage ? 'image' : 'link');
    node.href = parsed.href;
    node.title = parsed.title;
    if (opener.isImage) {
      node.alt = plainTextOf(firstChild, lastChild);
    } else {
      node.first = firstChild;
      node.last = lastChild;
      if (firstChild) firstChild.prev = null;
      if (lastChild) lastChild.next = null;
    }
    node.prev = openNode.prev;
    if (openNode.prev) openNode.prev.next = node;
    if (sentinel === openNode.prev || !openNode.prev) {
      // openNode was first real node
    }
    tail = node;
    if (!opener.isImage) {
      // Deactivate earlier link openers.
      for (const b of bracketStack) if (!b.isImage) b.active = false;
    }
    return parsed.end;
  };

  let i = 0;
  while (i < n) {
    const c = text[i];

    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        // hard break
        appendNode(newNode('br'));
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        bufHtml += escapeChar(nx);
        bufRaw += nx;
        i += 2;
        continue;
      }
      bufHtml += '\\';
      bufRaw += '\\';
      i++;
      continue;
    }

    if (c === '\n') {
      // hard break when preceded by 2+ spaces
      let sp = 0;
      let k = i - 1;
      while (k >= 0 && text[k] === ' ') { sp++; k--; }
      if (sp >= 2) {
        // trim the trailing spaces from the buffer
        bufHtml = bufHtml.replace(/ +$/, '');
        bufRaw = bufRaw.replace(/ +$/, '');
        appendNode(newNode('br'));
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      bufHtml += '\n';
      bufRaw += '\n';
      i++;
      continue;
    }

    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const runLen = j - i;
      // find a closing run of exactly runLen; inside a bracket the
      // search may not cross the label's closing ']' (marked lexes
      // link text as an isolated string).
      let bound = n;
      if (bracketStack.length > 0) {
        const top = bracketStack[bracketStack.length - 1];
        // The bound applies only to a span that starts inside the
        // bracket's label region; a stale bracket whose label region
        // already ended must not suppress spans after it.
        if (top.limit >= 0 && i < top.limit) bound = top.limit;
      }
      let k = j;
      let closeStart = -1;
      while (k < bound) {
        if (text[k] === '`') {
          let m = k;
          while (m < n && text[m] === '`') m++;
          if (m - k === runLen) { closeStart = k; break; }
          k = m;
        } else k++;
      }
      if (closeStart < 0) {
        bufHtml += text.slice(i, j);
        bufRaw += text.slice(i, j);
        i = j;
        continue;
      }
      let content = text.slice(j, closeStart).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      const nd = newNode('code');
      nd.html = '<code>' + escapeCode(content) + '</code>';
      nd.raw = content;
      appendNode(nd);
      i = closeStart + runLen;
      continue;
    }

    if (c === '!' && text[i + 1] === '[') {
      const nd = newNode('open');
      nd.raw = '![';
      nd.html = '![';
      appendNode(nd);
      bracketStack.push({ node: nd, isImage: true, delimLen: delimStack.length, srcIdx: i + 1, active: true, limit: looseLabelEnd(text, i + 2) });
      i += 2;
      continue;
    }

    if (c === '[') {
      const nd = newNode('open');
      nd.raw = '[';
      nd.html = '[';
      appendNode(nd);
      bracketStack.push({ node: nd, isImage: false, delimLen: delimStack.length, srcIdx: i, active: true, limit: looseLabelEnd(text, i + 1) });
      i++;
      continue;
    }

    if (c === ']') {
      i = closeBracket(i);
      continue;
    }

    if (c === '<') {
      // comment
      if (text.startsWith('<!--', i)) {
        let end = -1;
        if (text.startsWith('<!-->', i)) end = i + 5;
        else if (text.startsWith('<!--->', i)) end = i + 6;
        else {
          const f = text.indexOf('-->', i + 4);
          if (f >= 0) end = f + 3;
        }
        if (end >= 0) {
          const nd = newNode('html');
          nd.html = text.slice(i, end);
          nd.raw = nd.html;
          appendNode(nd);
          i = end;
          continue;
        }
      }
      if (text.startsWith('<![CDATA[', i)) {
        const f = text.indexOf(']]>', i + 9);
        if (f >= 0) {
          const nd = newNode('html');
          nd.html = text.slice(i, f + 3);
          nd.raw = nd.html;
          appendNode(nd);
          i = f + 3;
          continue;
        }
      }
      if (text.startsWith('<?', i)) {
        const f = text.indexOf('?>', i + 2);
        if (f >= 0) {
          const nd = newNode('html');
          nd.html = text.slice(i, f + 2);
          nd.raw = nd.html;
          appendNode(nd);
          i = f + 2;
          continue;
        }
      }
      if (text.startsWith('<!', i) && /[A-Z]/.test(text[i + 2] || '')) {
        const f = text.indexOf('>', i + 2);
        if (f >= 0) {
          const nd = newNode('html');
          nd.html = text.slice(i, f + 1);
          nd.raw = nd.html;
          appendNode(nd);
          i = f + 1;
          continue;
        }
      }
      const tag = scanTag(text, i);
      if (tag) {
        const nd = newNode('html');
        nd.html = tag;
        nd.raw = tag;
        appendNode(nd);
        if (/^<a\s/i.test(tag)) INLINK.v = true;
        else if (/^<\/a\s*>/i.test(tag)) INLINK.v = false;
        i += tag.length;
        continue;
      }
      const am = SCHEME_AUTOLINK_RE.exec(text.slice(i, i + 300));
      if (am) {
        const content = am[1];
        const nd = newNode('autolink');
        nd.raw = content;
        nd.hrefKind = 'raw';
        nd.angle = true; // <...> autolinks stay nested inside links
        appendNode(nd);
        i += am[0].length;
        continue;
      }
      // email autolink in angle brackets
      if (text[i + 1] && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\-]/.test(text[i + 1])) {
        const gt = text.indexOf('>', i + 1);
        if (gt > 0 && gt - i < 200) {
          const content = text.slice(i + 1, gt);
          if (!/[\s<]/.test(content) && CM_EMAIL_RE.test(content)) {
            const nd = newNode('autolink');
            nd.raw = content;
            nd.hrefKind = 'email';
            nd.angle = true;
            appendNode(nd);
            i = gt + 1;
            continue;
          }
        }
      }
      bufHtml += '&lt;';
      bufRaw += '<';
      i++;
      continue;
    }

    if (c === '&') {
      const rest = text.slice(i, i + 48);
      let m = /^&#([0-9]+);/.exec(rest) || /^&#[xX]([0-9A-Fa-f]+);/.exec(rest);
      if (m) {
        const cp = m[0][2] === 'x' || m[0][2] === 'X' ? parseInt(m[1], 16) : parseInt(m[1], 10);
        if (cp > 0x10ffff) m = null; // not a reference at all: escape '&'
        else {
          const ch = (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff))
            ? '�'
            : String.fromCodePoint(cp);
          bufHtml += escapeChar(ch);
          bufRaw += ch;
          i += m[0].length;
          continue;
        }
      }
      m = /^&[A-Za-z][A-Za-z0-9]*;/.exec(rest);
      if (m) {
        bufHtml += m[0];
        bufRaw += m[0];
        i += m[0].length;
        continue;
      }
      bufHtml += '&amp;';
      bufRaw += '&';
      i++;
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const runLen = j - i;
      if (c === '~' && runLen > 2) {
        bufHtml += text.slice(i, j);
        bufRaw += text.slice(i, j);
        i = j;
        continue;
      }
      const prevCh = charBefore(text, i);
      const nextCh = charAt(text, j);
      const prevWs = isWs(prevCh);
      const nextWs = isWs(nextCh);
      const prevP = isPunctU(prevCh);
      const nextP = isPunctU(nextCh);
      const leftFlank = !nextWs && (!nextP || prevWs || prevP);
      const rightFlank = !prevWs && (!prevP || nextWs || nextP);
      let canOpen;
      let canClose;
      if (c === '*') {
        canOpen = leftFlank;
        canClose = rightFlank;
      } else if (c === '_') {
        canOpen = leftFlank && (!rightFlank || prevP);
        canClose = rightFlank && (!leftFlank || nextP);
      } else {
        canOpen = !nextWs && nextCh !== '';
        canClose = !prevWs && prevCh !== '';
      }
      const nd = newNode('delim');
      nd.raw = text.slice(i, j);
      nd.dchar = c;
      nd.canOpen = canOpen;
      appendNode(nd);
      delimStack.push({ node: nd, char: c, len: runLen, origLen: runLen, canOpen, canClose, idx: i });
      i = j;
      continue;
    }

    // Extended autolinks and bare emails inside plain text.
    if (!INLINK.v && (c === 'h' || c === 'H' || c === 'f' || c === 'F')) {
      const pm = schemeAt(text, i);
      if (pm) {
        const url = scanUrlBody(text, i, pm, bracketStack.some((b) => b.active));
        if (url) {
          const nd = newNode('autolink');
          nd.raw = url;
          nd.hrefKind = 'raw';
          appendNode(nd);
          i += url.length;
          continue;
        }
      }
    }
    if (!INLINK.v && c === 'w' && text.startsWith('www.', i)) {
      const prevCh = charBefore(text, i);
      if (prevCh === '' || prevCh === ' ' || prevCh === '\t' || prevCh === '\n' ||
          prevCh === '(' || prevCh === '*' || prevCh === '_' || prevCh === '~') {
        const url = scanUrlBody(text, i, 4, bracketStack.some((b) => b.active));
        if (url) {
          const nd = newNode('autolink');
          nd.raw = url;
          nd.hrefKind = 'www';
          appendNode(nd);
          i += url.length;
          continue;
        }
      }
    }
    if (!INLINK.v && (c === 'm' || c === 'x')) {
      const isMailto = text.startsWith('mailto:', i);
      const isXmpp = !isMailto && text.startsWith('xmpp:', i);
      if (isMailto || isXmpp) {
        const prevCh = charBefore(text, i);
        if (!(prevCh !== '' && EMAIL_LOCAL.test(prevCh))) {
          const em = EMAIL_RE.exec(text.slice(i + 7));
          if (em) {
            let full = text.slice(i, i + 7) + em[0];
            let endPos = i + 7 + em[0].length;
            if (isXmpp && text[endPos] === '/') {
              const res = /^\/[^\s\/]+/.exec(text.slice(endPos));
              if (res && res[0].length > 1) {
                full += res[0];
                endPos += res[0].length;
              }
            }
            const lastCh = full[full.length - 1];
            if (lastCh !== '-' && lastCh !== '_') {
              const nd = newNode('autolink');
              nd.raw = full;
              nd.hrefKind = 'raw';
              appendNode(nd);
              i = endPos;
              continue;
            }
          }
        }
      }
    }
    if (!INLINK.v && isEmailLocalCode(text.charCodeAt(i))) {
      const prevCh = charBefore(text, i);
      if (!(prevCh !== '' && EMAIL_LOCAL.test(prevCh)) && emailAt(text, i)) {
        const em = EMAIL_RE.exec(text.slice(i, i + 200));
        if (em) {
          let addr = em[0];
          const lastCh = addr[addr.length - 1];
          if (lastCh === '_') {
            // Trailing underscores are not part of the address when
            // they exactly close a pending '_' delimiter (the address
            // then sits inside a '__' strong); otherwise the whole
            // candidate is rejected, as marked does.
            const trail = /_+$/.exec(addr)[0].length;
            const closesDelim = delimStack.some((d) =>
              d.char === '_' && d.canOpen && d.origLen === trail);
            if (closesDelim) addr = addr.slice(0, -trail);
          }
          const lc = addr[addr.length - 1];
          if (lc !== '-' && lc !== '_') {
            const nd = newNode('autolink');
            nd.raw = addr;
            nd.hrefKind = 'email';
            appendNode(nd);
            i += addr.length;
            continue;
          }
        }
      }
    }

    // Plain text run: consume until the next special character, but
    // stop where an extended autolink or email may begin.
    let j = i + 1;
    while (j < n) {
      const cc = text.charCodeAt(j);
      const cls = cc < 128 ? RUN_CLASS[cc] : 0;
      if (cls === 1) break;
      if (cls === 2) {
        const ch = text[j];
        if (cc === 104 || cc === 72 || cc === 102 || cc === 70) {
          if (schemeAt(text, j)) break;
        } else if (cc === 119 && text.startsWith('www.', j)) {
          const p = text[j - 1];
          if (p === ' ' || p === '\t' || p === '\n' || p === '(' || p === '*' || p === '_' || p === '~') break;
        } else if ((cc === 109 || cc === 120) &&
            (text.startsWith('mailto:', j) || text.startsWith('xmpp:', j))) {
          if (!EMAIL_LOCAL.test(text[j - 1])) break;
        }
        if (isEmailLocalCode(cc) && !isEmailLocalCode(text.charCodeAt(j - 1))) {
          if (emailAt(text, j)) break;
        }
      } else if (cls === 3) {
        if (!isEmailLocalCode(text.charCodeAt(j - 1))) {
          if (emailAt(text, j)) break;
        }
      }
      j++;
    }
    const run = text.slice(i, j);
    bufHtml += escapeTextRun(run);
    bufRaw += run;
    i = j;
  }

  flushText();
  processEmphasis(delimStack, 0, { badZones, dangleEnds, text });
  return renderInlineNodes(sentinel.next);
}

// ============================================================= block ===

// A cursor over one source line, tracking offset (chars) and column
// (with tab expansion) plus a partially consumed tab remainder.
class Cursor {
  constructor(s) {
    this.s = s;
    this.offset = 0;
    this.column = 0;
    this.partial = 0; // spaces left from a partially consumed tab
  }
  clone() {
    const c = new Cursor(this.s);
    c.offset = this.offset;
    c.column = this.column;
    c.partial = this.partial;
    return c;
  }
  peek() {
    if (this.partial > 0) return ' ';
    return this.offset < this.s.length ? this.s[this.offset] : '';
  }
  // Columns from the current position to the next nonspace char.
  indentCols() {
    let cols = 0;
    let i = this.offset;
    const s = this.s;
    let col = this.column;
    if (this.partial > 0) {
      // The tab at `offset` is already partly consumed; its remaining
      // width is `partial` — count it once and move past the tab.
      cols += this.partial;
      col += this.partial;
      i++;
    }
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') { cols++; i++; col++; }
      else if (c === '\t') {
        const w = 4 - (col % 4);
        cols += w;
        col += w;
        i++;
      } else break;
    }
    return cols;
  }
  get blank() {
    const str = this.s;
    for (let k = this.offset; k < str.length; k++) {
      const c = str.charCodeAt(k);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  // Advance by `count` columns (columnsOnly) or characters.
  advance(count, columnsOnly) {
    const s = this.s;
    while (count > 0) {
      if (this.partial > 0) {
        const take = Math.min(count, this.partial);
        // When advancing by characters over a partial tab, the whole
        // tab is consumed once we pass it; columns-only stops inside.
        if (columnsOnly) {
          this.partial -= take;
          this.column += take;
          count -= take;
          if (this.partial === 0) this.offset++;
        } else {
          this.column += this.partial;
          count -= 1;
          this.partial = 0;
          this.offset++;
        }
        continue;
      }
      if (this.offset >= s.length) break;
      const c = s[this.offset];
      if (c === '\t') {
        const w = 4 - (this.column % 4);
        if (columnsOnly && count < w) {
          this.partial = w - count;
          this.column += count;
          count = 0;
        } else if (columnsOnly) {
          this.column += w;
          count -= w;
          this.offset++;
        } else {
          this.column += w;
          count -= 1;
          this.offset++;
        }
      } else {
        this.column += 1;
        count -= 1;
        this.offset++;
      }
    }
  }
  advanceToNonspace() {
    // Advance past spaces/tabs by characters (a tab is fully consumed).
    const s = this.s;
    if (this.partial > 0) {
      this.column += this.partial;
      this.partial = 0;
      this.offset++;
    }
    while (this.offset < s.length && (s[this.offset] === ' ' || s[this.offset] === '\t')) {
      if (s[this.offset] === '\t') this.column += 4 - (this.column % 4);
      else this.column += 1;
      this.offset++;
    }
  }
  // Like remainder(), but a tab at the start is kept raw even when
  // columns were consumed before it (indented-code content lines).
  remainderRaw() {
    if (this.partial > 0) {
      return ' '.repeat(this.partial) + this.s.slice(this.offset + 1);
    }
    return this.s.slice(this.offset);
  }
  // The remainder of the line from the current position, materializing
  // a partially consumed tab (and a tab at the start when some columns
  // were already consumed) as spaces.
  remainder() {
    if (this.partial > 0) {
      return ' '.repeat(this.partial) + this.s.slice(this.offset + 1);
    }
    if (this.column > 0 && this.s[this.offset] === '\t') {
      return ' '.repeat(4 - (this.column % 4)) + this.s.slice(this.offset + 1);
    }
    return this.s.slice(this.offset);
  }
}

function newBlock(type) {
  return {
    type,
    children: [],
    parent: null,
    literal: '',
    literalLines: null, // for indented code: array of lines
    lang: '',
    fenceChar: '',
    fenceLen: 0,
    fenceClosed: false,
    hasMatchedContent: false,
    htmlType: 0,
    htmlTag: '',
    htmlStripped: false,
    level: 0,
    listKind: '', // 'bullet' | 'ordered'
    bulletChar: '',
    delim: '',
    start: 1,
    tight: true,
    contentIndent: 0,
    endsWithBlank: false,
    taskChecked: null, // null | boolean for list items
  };
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Try to match an HTML block start at the cursor (indent already <= 3).
// Returns {type, tag} or null. `fromParagraph` suppresses type 7.
function htmlBlockStart(rem, fromParagraph) {
  if (rem[0] !== '<') return null;
  const rest = rem.slice(1);
  let m;
  if ((m = /^(pre|script|style|textarea)(?=[ \t>]|$)/i.exec(rest))) {
    return { type: 1, tag: m[1].toLowerCase() };
  }
  if (rest.startsWith('!--')) return { type: 2, tag: '' };
  if (rest.startsWith('?')) return { type: 3, tag: '' };
  if (/^![A-Z]/.test(rest)) return { type: 4, tag: '' };
  if (rest.startsWith('![CDATA[')) return { type: 5, tag: '' };
  if ((m = /^\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(rest)) && BLOCK_TAGS.has(m[1].toLowerCase())) {
    return { type: 6, tag: m[1].toLowerCase() };
  }
  if (!fromParagraph) {
    const tag = scanTag(rem, 0);
    if (tag && /^[ \t]*$/.test(rem.slice(tag.length))) return { type: 7, tag: '' };
  }
  return null;
}

// Does an html block of the given type end with this line's remainder?
function htmlBlockEnds(block, rem) {
  const low = rem.toLowerCase();
  switch (block.htmlType) {
    case 1: return low.includes('</' + block.htmlTag);
    case 2: return rem.includes('-->');
    case 3: return rem.includes('?>');
    case 4: return rem.includes('>');
    case 5: return rem.includes(']]>');
    default: return false;
  }
}

const ATX_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
const HR_RE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

// Parse a list marker at the cursor position. Returns marker facts
// (contentIndentCols measured in columns from the cursor's column) or
// null when the line does not start a list item here.
function parseListMarker(cur) {
  const rem = cur.remainder();
  let m = /^([-+*])(?=[ \t]|$)/.exec(rem);
  let kind;
  let start = 1;
  let bulletChar = '';
  let delim = '';
  let markerLen;
  if (m) {
    kind = 'bullet';
    bulletChar = m[1];
    markerLen = 1;
  } else if ((m = /^([0-9]{1,9})([.)])(?=[ \t]|$)/.exec(rem))) {
    kind = 'ordered';
    start = parseInt(m[1], 10);
    delim = m[2];
    markerLen = m[1].length + 1;
  } else {
    return null;
  }
  // Measure the whitespace run after the marker, in columns, starting
  // from a clone advanced past the marker.
  const c2 = cur.clone();
  c2.advance(markerLen, false);
  const markerWidthCols = c2.column - cur.column;
  let runCols = c2.partial;
  let off = c2.offset + (c2.partial > 0 ? 1 : 0);
  let col = c2.column + c2.partial;
  const s = c2.s;
  while (off < s.length && (s[off] === ' ' || s[off] === '\t')) {
    if (s[off] === '\t') {
      const w = 4 - (col % 4);
      runCols += w;
      col += w;
    } else {
      runCols += 1;
      col += 1;
    }
    off++;
  }
  const isEmpty = off >= s.length;
  const contentIndentCols = runCols >= 5 || isEmpty
    ? markerWidthCols + 1
    : markerWidthCols + runCols;
  return { kind, bulletChar, delim, start, markerLen, runCols, isEmpty, contentIndentCols };
}

// ====================================================== block parser ===
// Builder #3: the block-level container parser, paragraph finalization
// (link reference definitions), and the HTML renderer that drive the
// inline engine above. Structure follows the CommonMark container model
// with marked's verified deviations (see dev notes §3).

// Parse a title starting at text[p] ('"', '\'' or '('). Returns
// {title, end} or null. Titles may span one newline but not a blank line.
function parseTitleAt(text, p) {
  const tc = text[p];
  const closer = tc === '(' ? ')' : tc;
  const n = text.length;
  let j = p + 1;
  let val = '';
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
      val += text[j + 1];
      j += 2;
      continue;
    }
    if (tc === '(' && c === '(') return null;
    if (c === '\n') {
      let k = j + 1;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k < n && text[k] === '\n') return null;
    }
    if (c === closer) return { title: val, end: j + 1 };
    val += c;
    j++;
  }
  return null;
}

// Try to parse one link reference definition at text[pos].
// Returns {end, label, href, title} or null.
function parseDefAt(text, pos) {
  const n = text.length;
  if (text[pos] !== '[') return null;
  const lab = scanRefLabel(text, pos);
  if (!lab) return null;
  const label = normalizeLabel(lab.label);
  if (label === '') return null;
  let p = lab.end;
  if (text[p] !== ':') return null;
  p++;
  let nl = 0;
  while (p < n) {
    const c = text[p];
    if (c === ' ' || c === '\t') { p++; continue; }
    if (c === '\n') { nl++; if (nl > 1) return null; p++; continue; }
    break;
  }
  let href;
  if (text[p] === '<') {
    let j = p + 1;
    let ok = false;
    while (j < n) {
      const c = text[j];
      if (c === '\n' || c === '<') break;
      if (c === '\\' && text[j + 1] === '>') break;
      if (c === '>') { ok = true; break; }
      j++;
    }
    if (!ok) return null;
    href = text.slice(p + 1, j);
    p = j + 1;
  } else {
    let depth = 0;
    const start = p;
    while (p < n) {
      const c = text[p];
      if (c === '\\' && p + 1 < n && isAsciiPunct(text[p + 1])) { p += 2; continue; }
      if (c === '(') { depth++; p++; continue; }
      if (c === ')') { if (depth === 0) break; depth--; p++; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c < ' ') break;
      p++;
    }
    if (p === start) return null;
    href = unescapeStr(text.slice(start, p));
  }
  const afterDest = p;
  // Spaces/tabs on the destination's line.
  let q = p;
  while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
  if (q >= n) return { end: q, label, href, title: null };
  // Title candidate on the same line: requires whitespace before it;
  // an unparseable title or junk after it invalidates the whole def
  // (the next-line fallback below does not apply here).
  if (q > afterDest && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
    const t = parseTitleAt(text, q);
    if (!t) return null;
    let r = t.end;
    while (r < n && (text[r] === ' ' || text[r] === '\t')) r++;
    if (r >= n) return { end: r, label, href, title: t.title };
    if (text[r] === '\n') return { end: r + 1, label, href, title: t.title };
    return null;
  }
  if (text[q] === '\n') {
    // Title may sit on the next line.
    let r = q + 1;
    while (r < n && (text[r] === ' ' || text[r] === '\t')) r++;
    if (text[r] === '"' || text[r] === "'" || text[r] === '(') {
      const t = parseTitleAt(text, r);
      if (!t) return null; // e.g. title spanning a blank line
      if (t) {
        let s = t.end;
        while (s < n && (text[s] === ' ' || text[s] === '\t')) s++;
        if (s >= n) return { end: s, label, href, title: t.title };
        if (text[s] === '\n') return { end: s + 1, label, href, title: t.title };
      }
      // Failed-title fallback: def ends just after the newline that
      // followed the destination; the title line becomes text.
      return { end: q + 1, label, href, title: null };
    }
    return { end: q + 1, label, href, title: null };
  }
  void afterDest;
  return null;
}

// Strip link reference definitions from the front of a paragraph's
// literal, registering them (first definition wins). Returns the
// remaining text.
function stripDefs(literal, refs) {
  let pos = 0;
  for (;;) {
    // A definition line may be indented (the paragraph's first line
    // keeps up to 3 leading spaces; later def lines may be indented).
    let p2 = pos;
    while (literal[p2] === ' ' || literal[p2] === '\t') p2++;
    const d = parseDefAt(literal, literal[p2] === '[' ? p2 : pos);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    pos = d.end;
  }
  return literal.slice(pos);
}

// ------------------------------------------------------------ tree utils

function isLeafType(t) {
  return t === 'paragraph' || t === 'fence' || t === 'code' ||
    t === 'html' || t === 'table' || t === 'heading';
}

function tipOf(S) {
  return S.stack[S.stack.length - 1];
}

function linkChild(S, parent, child) {
  child.parent = parent;
  if (parent.type === 'item') {
    if (parent.sawBlank && parent.children.some((c) => !c.removed)) {
      parent.blankSeparated = true;
    }
    parent.sawBlank = false;
  }
  parent.children.push(child);
}

function pushBlock(S, block) {
  linkChild(S, tipOf(S), block);
  S.stack.push(block);
}

function addLeaf(S, block) {
  linkChild(S, tipOf(S), block);
}

function stripHtmlNewline(block) {
  if (!block.htmlStripped && block.literal.endsWith('\n')) {
    block.literal = block.literal.slice(0, -1);
    block.htmlStripped = true;
  }
}

// Walk the last-child chain from `block`; if it ends in an html block,
// strip that block's trailing newline (marked's item-close rule).
function stripHtmlInLastChain(block) {
  let b = block;
  for (;;) {
    const kids = b.children;
    if (!kids || kids.length === 0) break;
    let last = null;
    for (let k = kids.length - 1; k >= 0; k--) {
      if (!kids[k].removed) { last = kids[k]; break; }
    }
    if (!last) break;
    b = last;
    if (b.type === 'html') { stripHtmlNewline(b); return; }
    if (!b.children || b.children.length === 0) return;
  }
}

function lastChildEndsBlank(block) {
  const kids = block.children;
  for (let k = kids.length - 1; k >= 0; k--) {
    if (!kids[k].removed) return !!kids[k].endsWithBlank;
  }
  return false;
}

function finalizeBlock(S, b) {
  if (b.type === 'paragraph') {
    const rest = stripDefs(b.literal, S.refs);
    b.literal = rest;
    if (rest.trim() === '') b.removed = true;
    b.inlineText = rest.endsWith('\n') ? rest.slice(0, -1) : rest;
  } else if (b.type === 'fence') {
    if (b.fenceClosed) {
      if (b.literal === '\n') b.literal = '';
      else if (b.literal.endsWith('\n\n')) b.literal = b.literal.slice(0, -1);
    }
  } else if (b.type === 'item') {
    // Set during blank-line processing: the item ends with a blank when
    // a blank line closed its last child at the item's own level (a
    // blank inside a nested blockquote/list does not count).
    b.endsWithBlank = !!b.blankEnded;
    stripHtmlInLastChain(b);
  } else if (b.type === 'blockquote' || b.type === 'list' || b.type === 'document') {
    b.endsWithBlank = lastChildEndsBlank(b);
  }
}

function closeTop(S) {
  const b = S.stack.pop();
  if (b) finalizeBlock(S, b);
  return b;
}

function listCompatible(list, mk) {
  if (list.listKind !== mk.kind) return false;
  if (mk.kind === 'bullet') return list.bulletChar === mk.bulletChar;
  return list.delim === mk.delim;
}

function addItem(S, list, mk, cur) {
  // A blank line since the previous item's subtree was last active
  // makes that item end with a blank (it loosens the list).
  const prev = list.children[list.children.length - 1];
  if (prev && prev.type === 'item' &&
      (S.lastBlankLine || 0) > (prev.contentLine || 0) &&
      (S.lastBlankLine || 0) < S.lineNo) {
    // The previous item is already finalized by now (it was closed
    // to make room for this sibling), so set endsWithBlank directly.
    prev.blankEnded = true;
    prev.endsWithBlank = true;
  }
  const item = newBlock('item');
  item.activeLine = S.lineNo;
  item.contentLine = S.lineNo;
  item.markerCol = cur.column;
  item.relPad = mk.contentIndentCols;
  item.markerOff = cur.column - (list.regionCol || 0);
  item.needCols = item.markerOff + mk.contentIndentCols;
  item.contentIndent = cur.column + mk.contentIndentCols;
  linkChild(S, list, item);
  S.stack.push(item);
  cur.advance(mk.contentIndentCols, true);
  return item;
}

// Advance cursor `c` past at most `cols` columns of leading whitespace
// (spaces/tabs only); stops at the first non-whitespace character.
function advanceIndentOnly(c, cols) {
  let done = 0;
  while (done < cols) {
    if (c.partial > 0) {
      const take = Math.min(cols - done, c.partial);
      c.partial -= take;
      c.column += take;
      done += take;
      if (c.partial === 0) c.offset++;
      continue;
    }
    const ch = c.s[c.offset];
    if (ch === ' ') { c.offset++; c.column++; done++; }
    else if (ch === '\t') {
      const w = 4 - (c.column % 4);
      if (done + w <= cols) { c.offset++; c.column += w; done += w; }
      else {
        c.partial = w - (cols - done);
        c.column += cols - done;
        done = cols;
      }
    } else break;
  }
}

function fenceStartMatch(rem) {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(rem);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { char: m[1][0], len: m[1].length, info: m[2] };
}

function fenceCloseMatch(block, rem) {
  let i = 0;
  while (i < rem.length && rem[i] === block.fenceChar) i++;
  if (i < block.fenceLen) return false;
  return /^[ \t]*$/.test(rem.slice(i));
}

function isDelimRow(rem) {
  // Fast gate: a delimiter row consists only of | - : space tab.
  let hasDash = false;
  for (let k = 0; k < rem.length; k++) {
    const c = rem.charCodeAt(k);
    if (c === 45) { hasDash = true; continue; }
    if (c === 124 || c === 58 || c === 32 || c === 9) continue;
    return false;
  }
  if (!hasDash) return false;
  const t = rem.trim();
  const cells = splitTableRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

// ------------------------------------------------------------- per line

function processLine(S, line) {
  const stack = S.stack;
  const cur = new Cursor(line);
  const rawBlank = /^[ \t]*$/.test(line);
  S.lazyItemIdx = undefined;

  // Resolve a deferred empty-item break from a previous blank line.
  if (S.pendingBreak && !rawBlank) {
    const item = S.pendingBreak;
    S.pendingBreak = null;
    const list = item.parent;
    let s = line;
    for (;;) {
      const m = /^[ \t]{0,3}>[ \t]?/.exec(s);
      if (m) s = s.slice(m[0].length);
      else break;
    }
    const probe = new Cursor(s);
    const ind = probe.indentCols();
    let sib = false;
    if (ind <= 3) {
      probe.advance(ind, true);
      const mk = parseListMarker(probe);
      if (mk && list && listCompatible(list, mk)) sib = true;
    }
    if (sib) {
      if (list) list.looseBlank = true;
    } else {
      while (stack.length > 1) {
        const b = closeTop(S);
        if (b === list) break;
      }
    }
  }

  // Phase 1: match open containers.
  let i = 1;
  for (; i < stack.length; i++) {
    const b = stack[i];
    if (b.type === 'blockquote') {
      const ind = cur.indentCols();
      let ok = false;
      if (ind <= 3) {
        const probe = cur.clone();
        probe.advance(ind, true);
        if (probe.peek() === '>') {
          cur.offset = probe.offset; cur.column = probe.column; cur.partial = probe.partial;
          cur.advance(1, false);
          if (cur.peek() === ' ') cur.advance(1, false);
          else if (cur.peek() === '\t') { cur.qtab = true; cur.advance(1, true); }
          ok = true;
        }
      }
      if (!ok) break;
    } else if (b.type === 'list') {
      continue;
    } else if (b.type === 'item') {
      if (cur.blank) {
        // Blank lines leniently match items.
      } else {
        // The line belongs to the item when its indent (past the
        // ancestor containers) reaches the item's content offset
        // within its region: marker offset + marker padding.
        const avail = cur.indentCols();
        if (avail >= (b.needCols || 0)) {
          cur.advance(b.needCols || 0, true);
        } else {
          break;
        }
      }
    } else {
      break; // a leaf block: containers end here
    }
  }
  const tipB = stack[stack.length - 1];
  const contMatched = i >= stack.length ||
    (i === stack.length - 1 && isLeafType(stack[i].type));

  // Continuing leaves.
  if (tipB.type === 'fence') {
    if (contMatched) {
      const fp = cur.clone();
      if (fp.indentCols() <= 3) fp.advance(fp.indentCols(), true);
      if (fenceCloseMatch(tipB, fp.remainder())) {
        tipB.fenceClosed = true;
        closeTop(S);
        return;
      }
      // Content = the post-container remainder, minus up to
      // fenceIndent leading whitespace characters (a tab counts as
      // one character). Tilde fences never strip (marked quirk).
      // Inside a blockquote, tabs in the leading whitespace run are
      // first expanded to tab stops computed from each tab's
      // absolute column in the raw line (the cursor's column tracks
      // exactly that), because marked's quote extraction expands
      // them before the fence strip applies.
      let base = cur.remainder();
      if (stack.some((b) => b.type === 'blockquote')) {
        // A tab that immediately follows the quote marker (`> \t` or
        // `>\t`) becomes exactly two spaces in marked's output; any
        // other tab in the run expands by absolute column below.
        if (line[cur.offset] === '\t' &&
            (line[cur.offset - 1] === '>' ||
             (line[cur.offset - 1] === ' ' && line[cur.offset - 2] === '>'))) {
          base = '  ' + line.slice(cur.offset + 1);
        }
        const run = /^[ \t]*/.exec(base)[0];
        if (run.includes('\t')) {
          let col = cur.column;
          let out = '';
          for (const ch of run) {
            if (ch === ' ') { out += ' '; col += 1; } else {
              const w = 4 - (col % 4);
              out += ' '.repeat(w);
              col += w;
            }
          }
          base = out + base.slice(run.length);
        }
      }
      let strip = tipB.fenceChar === '~' ? 0 : tipB.fenceIndent;
      let bi = 0;
      while (strip > 0 && (base[bi] === ' ' || base[bi] === '\t')) {
        bi++;
        strip--;
      }
      tipB.literal += base.slice(bi) + '\n';
      tipB.hasMatchedContent = true;
      return;
    }
    // Absorption: unmatched containers are only items/lists.
    const un = stack.slice(i, stack.length - 1);
    if (un.every((b) => b.type === 'item' || b.type === 'list')) {
      if (rawBlank) {
        tipB.literal += '\n';
        return;
      }
      const fc = new Cursor(line);
      const isClose = fc.indentCols() <= 3 && fenceCloseMatch(tipB, fc.remainder());
      if (tipB.hasMatchedContent || isClose) {
        if (isClose) {
          tipB.fenceClosed = true;
          while (stack.length > i) closeTop(S);
          return;
        }
        // Absorbed lines are stripped of the containing item's
        // absolute content indent (columns, tab-aware), like marked's
        // item-text extraction; then the fence indent strip applies.
        let itemAbs = 0;
        for (let anc = tipB.parent; anc; anc = anc.parent) {
          if (anc.type === 'item') { itemAbs = anc.contentIndent || 0; break; }
        }
        const ac = new Cursor(line);
        if (itemAbs > 0 && ac.indentCols() > 0) {
          ac.advance(Math.min(itemAbs, ac.indentCols()), true);
        }
        let base = ac.remainder();
        let strip = tipB.fenceChar === '~' ? 0 : tipB.fenceIndent;
        let bi = 0;
        while (strip > 0 && (base[bi] === ' ' || base[bi] === '\t')) {
          bi++;
          strip--;
        }
        tipB.literal += base.slice(bi) + '\n';
        return;
      }
    }
  } else if (tipB.type === 'code') {
    if (rawBlank && contMatched) {
      const fc = new Cursor(line);
      let content = '';
      if (fc.indentCols() >= 4) {
        fc.advance(4, true);
        content = fc.remainder();
      }
      tipB.literal += content + '\n';
      return;
    }
    if (contMatched && cur.indentCols() >= 4) {
      const cc = cur.clone();
      cc.advance(4, true);
      tipB.literal += cc.remainderRaw() + '\n';
      return;
    }
  } else if (tipB.type === 'html' && tipB.htmlType >= 1 && tipB.htmlType <= 5) {
    if (contMatched) {
      const rem = cur.remainder();
      tipB.literal += rem + (S.hasNL ? '\n' : '');
      if (htmlBlockEnds(tipB, rem)) closeTop(S);
      return;
    }
    const un = stack.slice(i, stack.length - 1);
    if (un.every((b) => b.type === 'item' || b.type === 'list')) {
      tipB.literal += line + (S.hasNL ? '\n' : '');
      if (htmlBlockEnds(tipB, line)) {
        while (stack.length > i) closeTop(S);
      }
      return;
    }
  } else if (tipB.type === 'html' && tipB.htmlType >= 6) {
    if (contMatched && !cur.blank) {
      tipB.literal += cur.remainder() + (S.hasNL ? '\n' : '');
      return;
    }
  } else if (tipB.type === 'table') {
    // Body rows continue until a blank line; a row need not contain a
    // pipe (gfm-202), but a blockquote line ends the table (§3.5).
    // A line holding only spaces ends the table; a tab-only line is
    // still a row (probed).
    const remRawT = cur.remainderRaw();
    if (contMatched && remRawT !== '' && !/^ *$/.test(remRawT)) {
      const tp = cur.clone();
      if (tp.indentCols() <= 3) tp.advance(tp.indentCols(), true);
      const trem = tp.remainder();
      // A line that starts another block (list, heading, fence, html,
      // thematic break, quote) ends the table instead of becoming a
      // row (probed); plain text lines stay rows.
      const hb = htmlBlockStart(trem, false);
      const blocky = tp.peek() === '>' || HR_RE.test(trem) ||
        ATX_RE.test(trem) || !!fenceStartMatch(trem) ||
        !!parseListMarker(tp) || (hb !== null && hb.type <= 6);
      if (!blocky) {
        const cells = splitTableRow(cur.remainder().trim());
        while (cells.length < tipB.aligns.length) cells.push('');
        tipB.rows.push(cells.slice(0, tipB.aligns.length));
        return;
      }
    }
  }

  const isBlank = rawBlank || cur.blank;

  // Blank line processing.
  if (isBlank) {
    S.lastBlankLine = S.lineNo;
    // Marked's blockquote space-line: a whitespace-only remainder after
    // matching containers (inside a container) continues the paragraph.
    if (!rawBlank && contMatched && tipB.type === 'paragraph' &&
        stack.length > 2 && cur.remainder().length > 0) {
      tipB.literal += cur.remainder() + '\n';
      tipB.prevHard = false;
      return;
    }
    if (tipB.type === 'paragraph') tipB.endsWithBlank = true;
    if (tipB.type === 'html' && tipB.htmlType >= 6) {
      stripHtmlNewline(tipB);
    } else if (!line.includes('\t')) {
      // An html block at the end of the last-child chain loses its
      // trailing newline on a following blank line only when the
      // blank is completely empty, or when the block is type 6/7
      // (blank-terminated). A spaces-only blank after a
      // terminator-ended block (types 1-5) keeps the newline.
      let b = S.doc;
      for (;;) {
        const kids = b.children;
        if (!kids || kids.length === 0) break;
        let last = null;
        for (let k = kids.length - 1; k >= 0; k--) {
          if (!kids[k].removed) { last = kids[k]; break; }
        }
        if (!last) break;
        if (last.type === 'html') {
          if (line === '' || last.htmlType >= 6) stripHtmlNewline(last);
          break;
        }
        if (!last.children || last.children.length === 0) break;
        b = last;
      }
    }
    const popped = new Set();
    while (stack.length > i) {
      const b = closeTop(S);
      if (b) popped.add(b);
    }
    if (tipOf(S).type === 'paragraph') {
      const b = closeTop(S);
      if (b) popped.add(b);
    }
    // An item ends with a blank when this blank line closed its last
    // child at the item's own level.
    for (const b of stack) {
      if (b.type !== 'item') continue;
      const kids = b.children;
      for (let k = kids.length - 1; k >= 0; k--) {
        if (!kids[k].removed) {
          if (popped.has(kids[k])) b.blankEnded = true;
          break;
        }
      }
    }
    // An empty item at a blank line: defer the break decision to the
    // next line (a sibling item rejoins the list, loosely; anything
    // else closes item and list first).
    const t = tipOf(S);
    if (t.type === 'item' && !t.children.some((c) => !c.removed)) {
      S.pendingBreak = t;
    }
    for (const b of stack) if (b.type === 'item') b.sawBlank = true;
    return;
  }

  // Lazy paragraph continuation — but not when the line is a thematic
  // break or starts a sibling item of an enclosing list.
  if (!contMatched && tipB.type === 'paragraph') {
    const lp = cur.clone();
    if (lp.indentCols() <= 3) lp.advance(lp.indentCols(), true);
    const lrem = lp.remainder();
    let blocked = HR_RE.test(lrem) || lp.peek() === '>' ||
      !!parseListMarker(lp) || ATX_RE.test(lrem) || !!fenceStartMatch(lrem) ||
      !!htmlBlockStart(lrem, true);
    if (!blocked) {
      // Lazy lines keep their remainder verbatim, except that a
      // remainder indented by 4+ columns is stripped bare (probed:
      // cm-238 / cm-291 / cm-312 vs doc-06 / probe18).
      const remRawV = cur.remainder();
      const remV = cur.indentCols() >= 4
        ? remRawV.replace(/^[ \t]+/, '')
        : remRawV;
      const remNS = remV.replace(/^[ \t]+/, '');
      // Marked quirk (cm-093): a lazy setext-underline line inside a
      // blockquote paragraph is kept with a 4-space prefix.
      const inQuote = stack.some((b) => b.type === 'blockquote');
      const text = inQuote && SETEXT_RE.test(remNS) ? '    ' + remNS : remV;
      tipB.literal += text + '\n';
      tipB.prevHard = / {2}$/.test(remV) || /\\$/.test(remV);
      return;
    }
  }

  // Paragraph open with all containers matched: setext / table /
  // interruption checks, else continuation.
  if (tipB.type === 'paragraph' && contMatched) {
    leafParagraph(S, cur, line);
    return;
  }

  // Close unmatched containers, then start new blocks.
  while (stack.length > i) closeTop(S);
  starts(S, cur, line);
}

// Container starts + leaf starts on the current cursor position.
function starts(S, cur, line) {
  // Container starts loop.
  for (;;) {
    const t = tipOf(S);
    const ind = cur.indentCols();
    if (ind <= 3) {
      const hp = cur.clone();
      hp.advance(ind, true);
      if (HR_RE.test(hp.remainder())) {
        if (t.type === 'list') { closeTop(S); continue; }
        break; // HR beats a list-item start
      }
    }
    if (t.type === 'list') {
      // A list accepts only a compatible sibling item; anything else
      // closes the list and retries in the parent container.
      let handled = false;
      if (ind <= 3) {
        const probe0 = cur.clone();
        probe0.advance(ind, true);
        const mk0 = parseListMarker(probe0);
        if (mk0 && listCompatible(t, mk0)) {
          cur.offset = probe0.offset; cur.column = probe0.column; cur.partial = probe0.partial;
          addItem(S, t, mk0, cur);
          handled = true;
        }
      }
      if (handled) continue;
      closeTop(S);
      continue;
    }
    if (ind > 3) break;
    // Probe past the indent (<= 3 columns, so no tab can be involved in
    // a way that matters); commit only when a container actually starts.
    const iterStartCol = cur.column;
    const probe = cur.clone();
    probe.advance(ind, true);
    const rem = probe.remainder();
    if (probe.peek() === '>') {
      cur.offset = probe.offset; cur.column = probe.column; cur.partial = probe.partial;
      cur.advance(1, false);
      if (cur.peek() === ' ') cur.advance(1, false);
      else if (cur.peek() === '\t') cur.advance(1, true);
      pushBlock(S, newBlock('blockquote'));
      continue;
    }
    if (HR_RE.test(rem)) break; // HR beats a list-item start
    {
      const mk = parseListMarker(probe);
      if (mk) {
        cur.offset = probe.offset; cur.column = probe.column; cur.partial = probe.partial;
        if (t.type === 'list') {
          if (listCompatible(t, mk)) {
            addItem(S, t, mk, cur);
            continue;
          }
          closeTop(S);
          continue;
        }
        const list = newBlock('list');
        list.listKind = mk.kind;
        list.bulletChar = mk.bulletChar;
        list.delim = mk.delim;
        list.start = mk.start;
        list.regionCol = iterStartCol;
        pushBlock(S, list);
        addItem(S, list, mk, cur);
        continue;
      }
    }
    break;
  }
  while (tipOf(S).type === 'list') closeTop(S);
  if (cur.blank) return; // e.g. a lone list marker line
  leafStart(S, cur, line);
}

function leafStart(S, cur, line) {
  const rem = cur.remainder();
  const ind = cur.indentCols();
  if (ind >= 4) {
    const code = newBlock('code');
    const cc = cur.clone();
    cc.advance(4, true);
    code.literal = cc.remainderRaw() + '\n';
    pushBlock(S, code);
    return;
  }
  const probe = cur.clone();
  probe.advance(ind, true);
  const prem = probe.remainder();
  const fs = fenceStartMatch(prem);
  if (fs) {
    const fence = newBlock('fence');
    fence.fenceChar = fs.char;
    fence.fenceLen = fs.len;
    fence.fenceIndent = ind;
    fence.info = fs.info;
    fence.literal = '';
    pushBlock(S, fence);
    return;
  }
  if (ind <= 3) {
    const atx = ATX_RE.exec(prem);
    if (atx) {
      const h = newBlock('heading');
      h.level = atx[1].length;
      let content = atx[2] || '';
      if (/^#+[ \t]*$/.test(content)) content = '';
      else content = content.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
      h.inlineText = content;
      addLeaf(S, h);
      return;
    }
    if (HR_RE.test(prem)) {
      addLeaf(S, newBlock('hr'));
      return;
    }
    const hb = htmlBlockStart(prem, false);
    if (hb) {
      const html = newBlock('html');
      html.htmlType = hb.type;
      html.htmlTag = hb.tag;
      html.literal = rem + (S.hasNL ? '\n' : '');
      pushBlock(S, html);
      if (hb.type >= 1 && hb.type <= 5 && htmlBlockEnds(html, prem)) closeTop(S);
      return;
    }
  }
  const para = newBlock('paragraph');
  para.literal = rem + '\n';
  para.prevHard = / {2}$/.test(rem) || /\\$/.test(rem);
  pushBlock(S, para);
}

// The open paragraph `tipB` continues or converts.
function leafParagraph(S, cur, line) {
  const para = tipOf(S);
  const rem = cur.remainder();
  const ind = cur.indentCols();
  const probe = cur.clone();
  if (ind <= 3) probe.advance(ind, true);
  const prem = ind <= 3 ? probe.remainder() : rem;
  const lazyItem = S.lazyItemIdx !== undefined && S.lazyItemIdx !== null;
  // Fast continuation: when the line is indented 4+, or its first
  // character cannot begin any interrupting construct (setext, table
  // delimiter, quote, ATX, fence, HR, HTML, list marker), it is a
  // plain continuation — skip all the probes below.
  let fast = false;
  if (!lazyItem) {
    if (ind > 3) fast = true;
    else {
      const c0 = prem.charCodeAt(0);
      fast = !(c0 === 62 || c0 === 35 || c0 === 96 || c0 === 126 ||
        c0 === 60 || c0 === 42 || c0 === 43 || c0 === 45 || c0 === 95 ||
        c0 === 61 || c0 === 124 || c0 === 58 ||
        (c0 >= 48 && c0 <= 57));
    }
  }
  if (!fast && !lazyItem && ind <= 3 && SETEXT_RE.test(prem)) {
    const stripped = stripDefs(para.literal, S.refs);
    if (stripped.trim() !== '') {
      para.type = 'heading';
      para.level = prem[0] === '=' ? 1 : 2;
      let txt = stripped.endsWith('\n') ? stripped.slice(0, -1) : stripped;
      txt = txt.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      para.inlineText = txt;
      S.stack.pop(); // converted; no paragraph finalization needed
      return;
    }
  }
  if (!fast && !lazyItem && ind <= 3 && isDelimRow(prem) && tryTableConvert(S, para, prem)) return;
  // Interruption checks.
  let interrupt = false;
  if (!fast && ind <= 3) {
    if (probe.peek() === '>') interrupt = true;
    else if (ATX_RE.test(prem)) interrupt = true;
    else if (fenceStartMatch(prem)) interrupt = true;
    else if (HR_RE.test(prem)) interrupt = true;
    else if (htmlBlockStart(prem, true)) interrupt = true;
    else {
      const mk = parseListMarker(probe);
      if (mk && !mk.isEmpty) {
        // Inside a list item, any ordered marker interrupts the
        // paragraph; elsewhere only start === 1 does (both probed).
        let inItem = false;
        for (let anc = para.parent; anc; anc = anc.parent) {
          if (anc.type === 'item') { inItem = true; break; }
        }
        if (mk.kind === 'bullet' || mk.start === 1 || inItem) {
          interrupt = true;
        }
      }
    }
  }
  if (interrupt) {
    if (S.lazyItemIdx !== undefined && S.lazyItemIdx !== null) {
      // The paragraph's item only matched lazily (the line is dedented
      // below the item's content indent): the interrupting block lives
      // outside that item. A list marker rejoins the item's list when
      // compatible; anything else closes item and list.
      const li = S.lazyItemIdx;
      const mk = parseListMarker(probe);
      const parentList = S.stack[li - 1];
      if (mk && parentList && parentList.type === 'list' &&
          listCompatible(parentList, mk)) {
        while (S.stack.length > li) closeTop(S); // keep the list
      } else {
        while (S.stack.length > li - 1) closeTop(S); // close item + list
      }
      S.lazyItemIdx = undefined;
      starts(S, cur, line);
      return;
    }
    closeTop(S);
    starts(S, cur, line);
    return;
  }
  // Continuation line: the remainder is kept as-is, except that the
  // line after a hard break is stripped of all leading whitespace.
  // In a blockquote nested inside a list item, a tab adjacent to the
  // quote marker (consumed by the quote match, or starting the
  // remainder's leading run) renders as exactly two spaces.
  let remAdj = rem;
  if (!para.prevHard) {
    let inItem = false, inQuote = false;
    for (let anc = para.parent; anc; anc = anc.parent) {
      if (anc.type === 'item') inItem = true;
      if (anc.type === 'blockquote') inQuote = true;
    }
    if (inItem && inQuote) {
      const rawRem = cur.remainderRaw();
      const run = /^[ \t]*/.exec(rawRem)[0];
      if (run.includes('\t')) {
        remAdj = '  ' + rawRem.slice(run.length);
      } else if (cur.qtab && !/^[ \t]/.test(remAdj)) {
        remAdj = '  ' + remAdj;
      }
    }
  }
  const text = para.prevHard ? rem.replace(/^[ \t]+/, '') : remAdj;
  para.literal += text + '\n';
  para.prevHard = / {2}$/.test(rem) || /\\$/.test(rem);
}

function tryTableConvert(S, para, rem) {
  const headerText = para.literal.endsWith('\n')
    ? para.literal.slice(0, -1)
    : para.literal;
  if (headerText.includes('\n')) return false;
  const header = splitTableRow(headerText);
  const delim = splitTableRow(rem.trim());
  if (header.length === 0 || header.length !== delim.length) return false;
  const aligns = delim.map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : l ? 'left' : r ? 'right' : '';
  });
  // Detach the paragraph and put a table in its place.
  S.stack.pop();
  const parent = para.parent;
  const idx = parent.children.indexOf(para);
  const table = newBlock('table');
  table.header = header;
  table.aligns = aligns;
  table.rows = [];
  table.parent = parent;
  if (idx >= 0) parent.children[idx] = table;
  else parent.children.push(table);
  S.stack.push(table);
  return true;
}

// ------------------------------------------------------------ rendering

function renderChildren(S, block, tight) {
  let out = '';
  for (const c of block.children) {
    if (!c.removed) out += renderBlock(S, c, tight);
  }
  return out;
}

function renderBlock(S, b, tight) {
  switch (b.type) {
    case 'paragraph':
      return tight
        ? parseInline(b.inlineText || '', S.refs)
        : '<p>' + parseInline(b.inlineText || '', S.refs) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + parseInline(b.inlineText || '', S.refs) +
        '</h' + b.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'fence': {
      const info = unescapeStr((b.info || '').trim());
      const lang = info === '' ? '' : info.split(/\s+/)[0];
      return '<pre><code' +
        (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') +
        '>' + escapeCode(b.literal) + '</code></pre>\n';
    }
    case 'code': {
      const ls = b.literal.split('\n');
      if (ls.length && ls[ls.length - 1] === '') ls.pop();
      while (ls.length && /^[ \t]*$/.test(ls[ls.length - 1])) ls.pop();
      const content = ls.length ? ls.join('\n') + '\n' : '';
      return '<pre><code>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'html':
      return b.literal;
    case 'blockquote':
      return '<blockquote>\n' + renderChildren(S, b, false) + '</blockquote>\n';
    case 'list': {
      const items = b.children.filter((c) => !c.removed);
      const loose = !!b.looseBlank || items.some((it, idx) =>
        it.blankSeparated || (idx < items.length - 1 && it.endsWithBlank));
      let out = b.listKind === 'bullet'
        ? '<ul>\n'
        : '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
      for (const it of items) out += renderItem(S, it, !loose);
      out += b.listKind === 'bullet' ? '</ul>\n' : '</ol>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      b.header.forEach((cell, ci) => {
        out += '<th' + (b.aligns[ci] ? ' align="' + b.aligns[ci] + '"' : '') +
          '>' + parseInline(cell, S.refs) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          row.forEach((cell, ci) => {
            out += '<td' + (b.aligns[ci] ? ' align="' + b.aligns[ci] + '"' : '') +
              '>' + parseInline(cell, S.refs) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

function renderItem(S, item, tight) {
  const kids = item.children.filter((c) => !c.removed);
  let checkbox = null;
  if (kids.length && kids[0].type === 'paragraph') {
    const m = /^\[( |x|X)?\] /.exec(kids[0].inlineText || '');
    if (m) {
      checkbox = (m[1] === 'x' || m[1] === 'X')
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
    }
  }
  let inner = '';
  kids.forEach((c, idx) => {
    if (idx === 0 && checkbox !== null && c.type === 'paragraph') {
      const txt = (c.inlineText || '').slice(4);
      inner += tight
        ? checkbox + parseInline(txt, S.refs)
        : '<p>' + checkbox + parseInline(txt, S.refs) + '</p>\n';
    } else {
      inner += renderBlock(S, c, tight);
    }
  });
  return '<li>' + inner + '</li>\n';
}

// ---------------------------------------------------------------- entry

export function parse(src) {
  INLINK.v = false;
  const refs = new Map();
  const doc = newBlock('document');
  const S = { refs, stack: [doc], doc };
  const norm = src.replace(/\r\n?/g, '\n');
  const lines = norm.split('\n');
  const endsNl = norm.endsWith('\n');
  if (endsNl) lines.pop();
  lines.forEach((line, idx) => {
    S.hasNL = idx < lines.length - 1 || endsNl;
    S.lineNo = idx + 1;
    // Track per-block activity with a one-line lag: contentLine is
    // the last line the block was active on BEFORE the current line
    // began (drives the ends-with-blank rule in addItem).
    for (const b of S.stack) {
      b.contentLine = b.activeLine || 0;
      if (!/^[ \t]*$/.test(line)) b.activeLine = S.lineNo;
    }
    processLine(S, line);
  });
  while (S.stack.length > 1) closeTop(S);
  return renderChildren(S, doc, false);
}
