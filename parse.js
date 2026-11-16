// markdown-flash — a dependency-free Markdown renderer.
//
// Reproduces the output of marked 18.1.3 with default options
// (gfm: true, breaks: false, pedantic: false) byte for byte, and renders
// faster than the reference. Single entry point: parse(markdown) -> html.
//
// Layout of this file:
//   1. character classes, escaping, entities, URL and label helpers
//   2. the inline parser (delimiter stack + bracket stack)
//   3. the block parser (container stack over lines)
//   4. rendering and the public parse() function

"use strict";

/* ------------------------------------------------------------------ */
/* 1. helpers                                                          */
/* ------------------------------------------------------------------ */

// ASCII punctuation: the only characters a backslash can escape.
const ASCII_PUNCT = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(""));

// Flanking punctuation is wider: Unicode categories P and S. ASCII fast
// table first, single-char regex for the rest.
const ASCII_PUNCT_TABLE = new Array(128).fill(false);
for (const ch of ASCII_PUNCT) ASCII_PUNCT_TABLE[ch.charCodeAt(0)] = true;
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
const UNICODE_SPACE_RE = /\s/;

function isPunctChar(ch) {
  if (ch === undefined || ch === "") return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT_TABLE[code];
  return UNICODE_PUNCT_RE.test(ch);
}
function isSpaceChar(ch) {
  if (ch === undefined || ch === "") return true;
  if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
  return UNICODE_SPACE_RE.test(ch);
}

// Entity-shaped sequence: &name; with an alphanumeric name. marked lets
// every such sequence through unescaped, known name or not.
const ENTITY_SHAPE_RE = /^&[A-Za-z][A-Za-z0-9]*;/;

// Escape running text: & (entity-aware), <, >, double and single quotes.
function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "&") {
      const m = ENTITY_SHAPE_RE.exec(s.slice(i, i + 34));
      if (m) { out += m[0]; i += m[0].length; } else { out += "&amp;"; i++; }
    } else if (c === "<") { out += "&lt;"; i++; }
    else if (c === ">") { out += "&gt;"; i++; }
    else if (c === '"') { out += "&quot;"; i++; }
    else if (c === "'") { out += "&#39;"; i++; }
    else {
      let j = i + 1;
      while (j < n && s[j] !== "&" && s[j] !== "<" && s[j] !== ">" && s[j] !== '"' && s[j] !== "'") j++;
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

// Escape an attribute value (href / title / class): same entity-aware
// ampersand rule as text.
function escapeAttr(s) {
  return escapeText(s);
}

// Escape code content (code spans and code blocks): quotes included,
// ampersand always escaped (entities are not special inside code).
function escapeCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Link destination cleaning: encodeURI, then undo the %25 -> % collapse
// marked applies.
function cleanUrl(href) {
  let out;
  try {
    out = encodeURI(href);
  } catch {
    out = href;
  }
  return out.replace(/%25/g, "%");
}

// Reference label normalisation: collapse internal whitespace to single
// spaces, trim, and case-fold (with the full folds JS misses: ß/ẞ and
// the Latin ligatures).
function normalizeLabel(raw) {
  let s = raw.replace(/\s+/g, " ").trim().toLowerCase();
  s = s
    .replace(/ß/g, "ss")
    .replace(/ﬀ/g, "ff")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl")
    .replace(/ﬅ/g, "st")
    .replace(/ﬆ/g, "st");
  return s;
}

// Remove backslash escapes of ASCII punctuation.
function unescapeBackslashes(s) {
  if (!s.includes("\\")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Decode a numeric character reference body; returns the character or
// null when the value is out of range (not a reference at all).
function numericRefChar(digits, hex) {
  const v = parseInt(digits, hex ? 16 : 10);
  if (v > 0x10ffff) return null;
  if (v === 0 || (v >= 0xd800 && v <= 0xdfff)) return "�";
  return String.fromCodePoint(v);
}

/* Inline HTML ------------------------------------------------------- */

// Scan an inline HTML construct starting at s[i] === '<'. Returns the
// end index (exclusive) or -1 when the text at i is not valid HTML.
function scanHtmlInline(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return -1;
  const c = s[j];
  if (c === "!") {
    if (s.startsWith("<!--", i)) {
      // comments: <!--> and <!---> are complete empty comments;
      // otherwise the comment runs to the first -->
      if (s.startsWith("<!-->", i)) return i + 5;
      if (s.startsWith("<!--->", i)) return i + 6;
      const end = s.indexOf("-->", i + 4);
      if (end === -1) return -1;
      return end + 3;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      return end === -1 ? -1 : end + 3;
    }
    // declaration <!X ... >
    if (j + 1 < n && s[j + 1] >= "A" && s[j + 1] <= "Z") {
      const end = s.indexOf(">", j + 2);
      return end === -1 ? -1 : end + 1;
    }
    return -1;
  }
  if (c === "?") {
    const end = s.indexOf("?>", j + 1);
    return end === -1 ? -1 : end + 2;
  }
  // open or closing tag, strict CommonMark grammar
  let closing = false;
  if (c === "/") { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return -1;
  j++;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (closing) {
    while (j < n && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
    return j < n && s[j] === ">" ? j + 1 : -1;
  }
  // attributes
  for (;;) {
    let ws = 0;
    while (j < n && /\s/.test(s[j])) { j++; ws++; }
    if (j >= n) return -1;
    if (s[j] === ">") return j + 1;
    if (s[j] === "/" && j + 1 < n && s[j + 1] === ">") return j + 2;
    if (ws === 0) return -1;
    // attribute name
    if (!/[A-Za-z_:]/.test(s[j])) return -1;
    j++;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional value
    let k = j;
    while (k < n && (s[k] === " " || s[k] === "\t")) k++;
    if (k < n && s[k] === "=") {
      k++;
      while (k < n && (s[k] === " " || s[k] === "\t")) k++;
      if (k >= n) return -1;
      const q = s[k];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, k + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else {
        // unquoted value: no space, quotes, =, <, >, backtick
        let v = k;
        while (v < n && !/[\s"'=<>`]/.test(s[v])) v++;
        if (v === k) return -1;
        j = v;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. inline parsing                                                   */
/* ------------------------------------------------------------------ */

const EMAIL_ANGLE_RE =
  /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const SCHEME_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/;
const BARE_EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/;
const EXT_PUNCT_TAIL = "?!.,:*_~'\"";

// Trim an extended-autolink candidate per GFM/marked rules.
function trimAutolink(url) {
  let s = url;
  for (;;) {
    if (s.length === 0) return s;
    const last = s[s.length - 1];
    if (EXT_PUNCT_TAIL.includes(last)) { s = s.slice(0, -1); continue; }
    if (last === ";") {
      const m = /&[#A-Za-z0-9]+;$/.exec(s);
      if (m && s.length > m[0].length) s = s.slice(0, s.length - m[0].length);
      else if (m) s = s.slice(0, -1);
      else s = s.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      let opens = 0, closes = 0;
      for (let k = 0; k < s.length; k++) {
        if (s[k] === open) opens++;
        else if (s[k] === last) closes++;
      }
      if (closes > opens) { s = s.slice(0, -1); continue; }
    }
    return s;
  }
}

// Try an extended autolink (www / http(s) / mailto: / xmpp: / bare
// email) at position i of s. Returns {text, href, end} or null.
function matchExtendedAutolink(s, i, inLink) {
  if (inLink) return null;
  const c = s[i];
  // previous character must not glue us to a preceding token
  if (i > 0 && /[A-Za-z0-9._%+\/@_-]/.test(s[i - 1])) return null;
  let kind = null;
  let startLen = 0;
  const low4 = s.slice(i, i + 4).toLowerCase();
  const low5 = s.slice(i, i + 5).toLowerCase();
  const low7 = s.slice(i, i + 7).toLowerCase();
  const low8 = s.slice(i, i + 8).toLowerCase();
  if (c === "w" && s.startsWith("www.", i)) { kind = "www"; startLen = 4; }
  else if (low8 === "https://") { kind = "url"; startLen = 8; }
  else if (low7 === "http://") { kind = "url"; startLen = 7; }
  else if (s.startsWith("mailto:", i)) { kind = "mailto"; startLen = 7; }
  else if (s.startsWith("xmpp:", i)) { kind = "xmpp"; startLen = 5; }
  void low4; void low5;
  if (kind === "www" || kind === "url") {
    let j = i + startLen;
    while (j < s.length && !/[\s<>]/.test(s[j])) j++;
    if (j === i + startLen) return null;
    const raw = s.slice(i, j);
    const text = trimAutolink(raw);
    if (text.length <= startLen) return null;
    const href = kind === "www" ? "http://" + text : text;
    return { text, href, end: i + text.length };
  }
  if (kind === "mailto" || kind === "xmpp") {
    const m = BARE_EMAIL_RE.exec(s.slice(i + startLen));
    if (!m) return null;
    let addr = m[0];
    // a trailing - or _ right after the address kills the whole token
    const afterAddr = s[i + startLen + addr.length];
    if (afterAddr === "-" || afterAddr === "_") return null;
    let extra = "";
    if (kind === "xmpp") {
      const after = i + startLen + addr.length;
      if (s[after] === "/") {
        // one path segment may follow; it may contain @ but a
        // second slash ends the link
        let j = after + 1;
        while (j < s.length && !/[\s<>/]/.test(s[j])) j++;
        if (j > after + 1) extra = s.slice(after, j);
      }
    }
    if (addr.endsWith("-") || addr.endsWith("_")) return null;
    const text = s.slice(i, i + startLen) + addr + extra;
    return { text, href: text, end: i + text.length };
  }
  // bare email
  if (/[A-Za-z0-9]/.test(c)) {
    const m = BARE_EMAIL_RE.exec(s.slice(i));
    if (m) {
      const addr = m[0];
      if (addr.endsWith("-") || addr.endsWith("_")) return null;
      const afterAddr = s[i + addr.length];
      if (afterAddr === "-" || afterAddr === "_") return null;
      return { text: addr, href: "mailto:" + addr, end: i + addr.length };
    }
  }
  return null;
}

// Parse an inline link destination/title starting at s[j] === '('.
// Returns {href, title, end} or null.
function parseInlineDest(s, j) {
  const n = s.length;
  let i = j + 1;
  const skipWs = () => {
    while (i < n && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  };
  skipWs();
  let href;
  if (s[i] === "<") {
    // pointy destination: no backslash processing; a backslash right
    // before the closing > invalidates it
    let k = i + 1;
    while (k < n && s[k] !== ">" && s[k] !== "\n" && s[k] !== "<") k++;
    if (k >= n || s[k] !== ">") return null;
    if (s[k - 1] === "\\") return null;
    href = s.slice(i + 1, k);
    i = k + 1;
  } else {
    let depth = 0;
    let out = "";
    let k = i;
    while (k < n) {
      const ch = s[k];
      if (ch === "\\" && k + 1 < n && ASCII_PUNCT.has(s[k + 1])) {
        out += s[k + 1];
        k += 2;
        continue;
      }
      if (ch === "(") { depth++; out += ch; k++; continue; }
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
        out += ch;
        k++;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
      if (ch.charCodeAt(0) < 0x20) return null;
      out += ch;
      k++;
    }
    href = out;
    i = k;
  }
  const afterDest = i;
  skipWs();
  let title = null;
  if (i < n && (s[i] === '"' || s[i] === "'" || s[i] === "(")) {
    const open = s[i];
    const close = open === "(" ? ")" : open;
    let k = i + 1;
    let out = "";
    let ok = false;
    while (k < n) {
      const ch = s[k];
      if (ch === "\\" && k + 1 < n && ASCII_PUNCT.has(s[k + 1])) {
        out += s[k + 1];
        k += 2;
        continue;
      }
      if (ch === close) { ok = true; break; }
      if (open === "(" && ch === "(") return null;
      if (ch === "\n" && open !== "(") { /* titles may span lines */ }
      out += ch;
      k++;
    }
    if (!ok) return null;
    title = out;
    i = k + 1;
    skipWs();
  } else {
    i = afterDest;
    skipWs();
  }
  if (i < n && s[i] === ")") return { href, title, end: i + 1 };
  return null;
}

// Scan a reference label starting at s[j] === '['. Returns
// {label, end} (end just past ']') or null.
function scanRefLabel(s, j) {
  const n = s.length;
  let i = j + 1;
  while (i < n) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < n) { i += 2; continue; }
    if (ch === "[") return null;
    if (ch === "]") {
      if (i - (j + 1) > 999) return null;
      return { label: s.slice(j + 1, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

function plainTextOf(nodes) {
  let out = "";
  for (const nd of nodes) {
    if (nd.k === "open") out += nd.isImage ? "![" : "[";
    else if (nd.k === "t" || nd.k === "code") out += nd.p;
    else if (nd.k === "d") out += nd.ch.repeat(nd.lit);
    else if (nd.k === "link" || nd.k === "img") out += plainTextOf(nd.kids);
    else if (nd.k === "br") out += "\n";
  }
  return out;
}

function renderNodes(nodes) {
  let out = "";
  for (const nd of nodes) {
    if (nd.k === "open") out += nd.isImage ? "![" : "[";
    else if (nd.k === "t" || nd.k === "code") out += nd.h;
    else if (nd.k === "d") {
      out += nd.closeTags.join("") + nd.ch.repeat(nd.lit) + nd.openTags.join("");
    } else if (nd.k === "br") out += "<br>";
    else if (nd.k === "link") {
      out += '<a href="' + escapeAttr(cleanUrl(nd.href)) + '"';
      if (nd.title !== null && nd.title !== undefined) {
        out += ' title="' + escapeAttr(nd.title) + '"';
      }
      out += ">" + renderNodes(nd.kids) + "</a>";
    } else if (nd.k === "img") {
      out += '<img src="' + escapeAttr(cleanUrl(nd.href)) + '" alt="' +
        escapeAttr(plainTextOf(nd.kids)) + '"';
      if (nd.title !== null && nd.title !== undefined) {
        out += ' title="' + escapeAttr(nd.title) + '"';
      }
      out += ">";
    }
  }
  return out;
}

// Does a node list contain a real (bracket-formed) link, recursively?
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.k === "link" && !nd.auto) return true;
    if ((nd.k === "link" || nd.k === "img") && containsLink(nd.kids)) return true;
  }
  return false;
}

// Replace autolink nodes inside a formed link/image label with text.
function unwrapAutolinks(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.k === "link" && nd.auto) {
      nodes[i] = { k: "t", h: escapeText(nd.text), p: nd.text };
    } else if (nd.k === "link" || nd.k === "img") {
      unwrapAutolinks(nd.kids);
    }
  }
}

const TAG_OPEN_RE = /^<([A-Za-z][A-Za-z0-9-]*)/;

function parseInline(text, ctx) {
  const refs = ctx.refs;
  const state = ctx.state; // { inLink } document-wide autolink suppression
  const s = text;
  const n = s.length;
  const nodes = [];
  const delims = []; // delimiter node refs, in order
  const brackets = []; // {node, isImage, active, delimLen, startPos}
  let bufH = "";
  let bufP = "";
  const flush = () => {
    if (bufH !== "") {
      nodes.push({ k: "t", h: bufH, p: bufP });
      bufH = "";
      bufP = "";
    }
  };
  const addText = (raw) => {
    bufH += escapeText(raw);
    bufP += raw;
  };

  // -- emphasis machinery -------------------------------------------
  function processEmphasis(bottom) {
    let closerIdx = bottom;
    // find first closer at or above bottom
    const findCloser = (from) => {
      for (let k = from; k < delims.length; k++) {
        if (delims[k].canClose && delims[k].n > 0) return k;
      }
      return -1;
    };
    closerIdx = findCloser(bottom);
    while (closerIdx !== -1) {
      const closer = delims[closerIdx];
      // find nearest matching opener below
      let openerIdx = -1;
      for (let k = closerIdx - 1; k >= bottom; k--) {
        const op = delims[k];
        if (op.ch !== closer.ch || !op.canOpen || op.n === 0) continue;
        if (op.ch === "~" && op.n !== closer.n) continue;
        // rule of three / odd match
        if ((op.canClose || closer.canOpen) &&
            (op.orig + closer.orig) % 3 === 0 &&
            !(op.orig % 3 === 0 && closer.orig % 3 === 0)) {
          continue;
        }
        openerIdx = k;
        break;
      }
      if (openerIdx === -1) {
        // no opener: this closer is literal unless it can also open
        if (!closer.canOpen) {
          delims.splice(closerIdx, 1);
          closerIdx = findCloser(closerIdx);
        } else {
          closerIdx = findCloser(closerIdx + 1);
        }
        continue;
      }
      const opener = delims[openerIdx];
      let use;
      let tag;
      if (opener.ch === "~") {
        use = opener.n;
        tag = "del";
      } else if (opener.n >= 2 && closer.n >= 2) {
        use = 2;
        tag = "strong";
      } else {
        use = 1;
        tag = "em";
      }
      opener.openTags.unshift("<" + tag + ">");
      closer.closeTags.push("</" + tag + ">");
      opener.n -= use;
      opener.lit -= use;
      closer.n -= use;
      closer.lit -= use;
      // delimiters between opener and closer leave the stack, but
      // their characters stay as literal text inside the pair
      delims.splice(openerIdx + 1, closerIdx - openerIdx - 1);
      closerIdx = openerIdx + 1;
      if (closer.n === 0) {
        delims.splice(closerIdx, 1);
        closerIdx = findCloser(closerIdx);
      }
    }
  }

  // -- main scan ------------------------------------------------------
  let i = 0;
  let afterBr = false;
  while (i < n) {
    const c = s[i];
    if (afterBr) {
      // the line after a hard break loses its leading spaces
      if (c === " " || c === "\t") { i++; continue; }
      afterBr = false;
    }

    // extended autolinks get a chance at word starts
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
      const auto = matchExtendedAutolink(s, i, state.inLink);
      if (auto) {
        flush();
        nodes.push({
          k: "link", auto: true, text: auto.text,
          href: auto.href, title: null,
          kids: [{ k: "t", h: escapeText(auto.text), p: auto.text }],
        });
        i = auto.end;
        continue;
      }
    }

    if (c === "\\") {
      const nx = s[i + 1];
      if (nx === "\n") {
        flush();
        nodes.push({ k: "br" });
        afterBr = true;
        i += 2;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        bufH += escapeText(nx);
        bufP += nx;
        i += 2;
        continue;
      }
      bufH += "\\";
      bufP += "\\";
      i++;
      continue;
    }

    if (c === "`") {
      let run = 1;
      while (i + run < n && s[i + run] === "`") run++;
      // find a closing run of exactly the same length
      let closeStart = -1;
      let j = i + run;
      while (j < n) {
        if (s[j] === "`") {
          let r2 = 1;
          while (j + r2 < n && s[j + r2] === "`") r2++;
          if (r2 === run) { closeStart = j; break; }
          j += r2;
        } else j++;
      }
      if (closeStart === -1) {
        bufH += "`".repeat(run);
        bufP += "`".repeat(run);
        i += run;
        continue;
      }
      let content = s.slice(i + run, closeStart).replace(/\r\n|\r|\n/g, " ");
      if (content.length >= 2 && content[0] === " " &&
          content[content.length - 1] === " " && !/^ +$/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({
        k: "code",
        h: "<code>" + escapeCode(content) + "</code>",
        p: content,
      });
      i = closeStart + run;
      continue;
    }

    if (c === "!" && s[i + 1] === "[") {
      flush();
      const marker = { k: "open", isImage: true };
      nodes.push(marker);
      brackets.push({
        node: marker, isImage: true, active: true,
        delimLen: delims.length, startPos: i + 2,
      });
      i += 2;
      continue;
    }

    if (c === "[") {
      flush();
      const marker = { k: "open", isImage: false };
      nodes.push(marker);
      brackets.push({
        node: marker, isImage: false, active: true,
        delimLen: delims.length, startPos: i + 1,
      });
      i++;
      continue;
    }

    if (c === "]") {
      // nearest active opener only
      let bi = brackets.length - 1;
      while (bi >= 0 && !brackets[bi].active) bi--;
      if (bi < 0) {
        bufH += "]";
        bufP += "]";
        i++;
        continue;
      }
      const entry = brackets[bi];
      flush();
      const markerIdx = nodes.indexOf(entry.node);
      const kids = nodes.slice(markerIdx + 1);
      let formed = null;
      let endPos = i + 1;
      // inline link?
      if (s[i + 1] === "(") {
        const dest = parseInlineDest(s, i + 1);
        if (dest) {
          formed = { href: dest.href, title: dest.title };
          endPos = dest.end;
        }
      }
      let triedFullRef = false;
      if (!formed && s[i + 1] === "[") {
        const lab = scanRefLabel(s, i + 1);
        if (lab) {
          triedFullRef = true;
          const labelText = lab.label === ""
            ? s.slice(entry.startPos, i)
            : lab.label;
          if (!/^\s*$/.test(labelText)) {
            const ref = refs.get(normalizeLabel(labelText));
            if (ref) {
              formed = { href: ref.href, title: ref.title };
              endPos = lab.end;
            }
          }
        }
      }
      if (!formed && !triedFullRef) {
        const labelText = s.slice(entry.startPos, i);
        if (!/^\s*$/.test(labelText)) {
          const ref = refs.get(normalizeLabel(labelText));
          if (ref) formed = { href: ref.href, title: ref.title };
        }
      }
      if (!formed) {
        entry.active = false;
        bufH += "]";
        bufP += "]";
        i++;
        continue;
      }
      // a link may not contain another link
      if (!entry.isImage && containsLink(kids)) {
        entry.active = false;
        bufH += "]";
        bufP += "]";
        i++;
        continue;
      }
      // emphasis inside the label, bounded below by the bracket
      processEmphasis(entry.delimLen);
      // drop delimiters that live inside the label
      const kidSet = new Set(nodes.slice(markerIdx + 1));
      for (let k = delims.length - 1; k >= entry.delimLen; k--) {
        if (kidSet.has(delims[k])) delims.splice(k, 1);
      }
      unwrapAutolinks(kids);
      const linkNode = {
        k: entry.isImage ? "img" : "link",
        href: formed.href, title: formed.title, kids,
      };
      nodes.length = markerIdx;
      nodes.push(linkNode);
      brackets.length = bi;
      if (!entry.isImage) {
        // deactivate earlier link openers — unless an image opener is
        // open below, in which case this link lives inside an image
        // description and the outer brackets stay in play
        const imageBelow = brackets.some((b) => b.isImage);
        if (!imageBelow) {
          for (const b of brackets) if (!b.isImage) b.active = false;
        }
      }
      i = endPos;
      continue;
    }

    if (c === "<") {
      // angle autolink?
      const rest = s.slice(i, i + 340);
      const sm = SCHEME_AUTOLINK_RE.exec(rest);
      if (sm) {
        flush();
        const text = sm[1] + ":" + sm[2];
        nodes.push({
          k: "link", auto: true, text,
          href: text, title: null,
          kids: [{ k: "t", h: escapeText(text), p: text }],
        });
        i += sm[0].length;
        continue;
      }
      const gt = s.indexOf(">", i + 1);
      if (gt !== -1 && gt - i < 340) {
        const inner = s.slice(i + 1, gt);
        if (EMAIL_ANGLE_RE.test(inner)) {
          flush();
          nodes.push({
            k: "link", auto: true, text: inner,
            href: "mailto:" + inner, title: null,
            kids: [{ k: "t", h: escapeText(inner), p: inner }],
          });
          i = gt + 1;
          continue;
        }
      }
      const end = scanHtmlInline(s, i);
      if (end !== -1) {
        flush();
        const tag = s.slice(i, end);
        nodes.push({ k: "t", h: tag, p: tag });
        // <a ...> suppresses extended autolinks until </a>
        const tm = TAG_OPEN_RE.exec(tag);
        if (tm && tm[1].toLowerCase() === "a") state.inLink = true;
        else if (/^<\/a\s*>$/i.test(tag)) state.inLink = false;
        i = end;
        continue;
      }
      bufH += "&lt;";
      bufP += "<";
      i++;
      continue;
    }

    if (c === "&") {
      // numeric character reference?
      if (s[i + 1] === "#") {
        const m = /^&#([0-9]+);/.exec(s.slice(i, i + 12)) ||
                  /^&#[xX]([0-9A-Fa-f]+);/.exec(s.slice(i, i + 12));
        if (m) {
          const ch = numericRefChar(m[1], m[0][2] === "x" || m[0][2] === "X");
          if (ch !== null) {
            bufH += escapeText(ch);
            bufP += ch;
            i += m[0].length;
            continue;
          }
        }
      }
      const m = ENTITY_SHAPE_RE.exec(s.slice(i, i + 34));
      if (m) {
        bufH += m[0];
        bufP += m[0];
        i += m[0].length;
        continue;
      }
      bufH += "&amp;";
      bufP += "&";
      i++;
      continue;
    }

    if (c === "*" || c === "_" || c === "~") {
      let run = 1;
      while (i + run < n && s[i + run] === c) run++;
      if (c === "~" && run > 2) {
        addText("~".repeat(run));
        i += run;
        continue;
      }
      const before = i > 0 ? s[i - 1] : "";
      const after = i + run < n ? s[i + run] : "";
      const beforeWs = i === 0 || isSpaceChar(before);
      const afterWs = i + run >= n || isSpaceChar(after);
      const beforeP = isPunctChar(before);
      const afterP = isPunctChar(after);
      const left = !afterWs && (!afterP || beforeWs || beforeP);
      const right = !beforeWs && (!beforeP || afterWs || afterP);
      let canOpen, canClose;
      if (c === "*") { canOpen = left; canClose = right; }
      else if (c === "_") {
        canOpen = left && (!right || beforeP);
        canClose = right && (!left || afterP);
      } else {
        canOpen = !afterWs;
        canClose = !beforeWs;
      }
      flush();
      const dnode = {
        k: "d", ch: c, n: run, lit: run, orig: run, canOpen, canClose,
        openTags: [], closeTags: [],
      };
      nodes.push(dnode);
      delims.push(dnode);
      i += run;
      continue;
    }

    if (c === "\n") {
      // hard break: two or more trailing spaces
      if (/  +$/.test(bufP)) {
        bufP = bufP.replace(/ +$/, "");
        bufH = bufH.replace(/ +$/, "");
        flush();
        nodes.push({ k: "br" });
        afterBr = true;
      } else {
        bufH += "\n";
        bufP += "\n";
      }
      i++;
      continue;
    }

    // plain text run: consume until the next special character
    let j = i;
    while (j < n) {
      const ch = s[j];
      if (ch === "\\" || ch === "`" || ch === "[" || ch === "]" ||
          ch === "<" || ch === "&" || ch === "*" || ch === "_" ||
          ch === "~" || ch === "\n") break;
      if (ch === "!" && s[j + 1] === "[") break;
      if ((ch === "w" || ch === "h" || ch === "H" || ch === "m" ||
           ch === "x" || (ch >= "0" && ch <= "9")) && j > i) {
        // possible autolink start mid-run: stop so the main loop sees it
        if (matchExtendedAutolink(s, j, state.inLink)) break;
      }
      j++;
    }
    if (j === i) j = i + 1; // lone '!' etc.
    addText(s.slice(i, j));
    i = j;
  }

  flush();
  processEmphasis(0);
  return renderNodes(nodes);
}

/* ------------------------------------------------------------------ */
/* 3. block parsing                                                    */
/* ------------------------------------------------------------------ */

// A cursor over one source line, tracking character offset, column,
// and partially consumed tabs (CommonMark-style column arithmetic).
class Cursor {
  constructor(line) {
    this.line = line;
    this.off = 0;      // character offset
    this.col = 0;      // column of offset
    this.partial = 0;  // spaces left of a partially consumed tab
    this.nns = -1;     // cached next-nonspace offset
    this.nnsCol = 0;
    this.blank = false;
  }
  computeNns() {
    // invariant: this.col is the visual column of the unconsumed
    // remainder; a partially consumed tab at this.off has this.partial
    // columns left, and finishing it lands on the next tab stop
    let o = this.off;
    let col = this.col;
    const s = this.line;
    if (this.partial > 0) {
      col += this.partial;
      o += 1;
    }
    while (o < s.length && (s[o] === " " || s[o] === "\t")) {
      if (s[o] === "\t") col += 4 - (col % 4);
      else col += 1;
      o++;
    }
    this.nns = o;
    this.nnsCol = col;
    this.blank = o >= s.length;
  }
  get nextNonspace() {
    if (this.nns === -1) this.computeNns();
    return this.nns;
  }
  get nextNonspaceCol() {
    if (this.nns === -1) this.computeNns();
    return this.nnsCol;
  }
  get indent() {
    if (this.nns === -1) this.computeNns();
    return this.nnsCol - this.col;
  }
  get isBlank() {
    if (this.nns === -1) this.computeNns();
    return this.blank;
  }
  // Consume the whitespace up to next nonspace.
  advanceToNonspace() {
    this.off = this.nextNonspace;
    this.col = this.nextNonspaceCol;
    this.partial = 0;
    this.nns = -1;
  }
  // Advance by count characters (columnsOnly=false) or columns.
  advance(count, columnsOnly) {
    const s = this.line;
    let chars = 0;
    let cols = 0;
    if (this.partial > 0) {
      const want = columnsOnly ? count : this.partial;
      if (want >= this.partial) {
        cols += this.partial;
        chars += 1;
        this.partial = 0;
      } else {
        this.partial -= want;
        this.col += want;
        this.nns = -1;
        return;
      }
    }
    while (chars < s.length - this.off) {
      if (columnsOnly ? cols >= count : chars >= count) break;
      const ch = s[this.off + chars];
      if (ch === "\t") {
        const w = 4 - ((this.col + cols) % 4);
        if (columnsOnly && cols + w > count) {
          // partial tab consumption: stay on the tab character, with
          // col advanced to the visual position inside the tab
          this.off += chars;
          this.col += count;
          this.partial = w - (count - cols);
          this.nns = -1;
          return;
        }
        cols += w;
        chars += 1;
      } else {
        cols += 1;
        chars += 1;
      }
    }
    this.off += chars;
    this.col += cols;
    this.nns = -1;
  }
  // The unconsumed remainder, materialising a partial tab as spaces.
  remainder() {
    if (this.partial > 0) {
      return " ".repeat(this.partial) + this.line.slice(this.off + 1);
    }
    return this.line.slice(this.off);
  }
  remainderFromNonspace() {
    const save = { off: this.off, col: this.col, partial: this.partial, nns: this.nns };
    this.advanceToNonspace();
    const r = this.remainder();
    this.off = save.off; this.col = save.col; this.partial = save.partial; this.nns = save.nns;
    return r;
  }
}

function newBlock(type, props) {
  return Object.assign(
    { type, children: [], parent: null, literal: "", endsBlank: false, _open: true },
    props || {}
  );
}

const BLOCK_TAGS = new Set(("address article aside base basefont blockquote body caption center col " +
  "colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset " +
  "h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol " +
  "optgroup option p param search section summary table tbody td tfoot th thead title tr track ul").split(" "));

// HTML block start at the (indent-stripped) remainder. Returns the type
// 1..7 or 0.
function htmlBlockStart(rest) {
  if (rest[0] !== "<") return 0;
  const low = rest.toLowerCase();
  for (const t of ["pre", "script", "style", "textarea"]) {
    if (low.startsWith("<" + t)) {
      const after = rest[1 + t.length];
      if (after === undefined || after === ">" || after === " " || after === "\t" || after === "\n") {
        return 1;
      }
    }
  }
  if (rest.startsWith("<!--")) return 2;
  if (rest.startsWith("<?")) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith("<![CDATA[")) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
    const after = rest[m[0].length];
    if (after === undefined || after === ">" || after === " " || after === "\t" ||
        (after === "/" && rest[m[0].length + 1] === ">")) {
      return 6;
    }
    if (after === "\n") return 6;
  }
  // type 7: one complete tag alone on the line
  const end = scanHtmlInline(rest, 0);
  if (end > 0 && /^[ \t]*$/.test(rest.slice(end))) {
    // not a type-1 tag name (those are type 1 even alone)
    const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (tm && ["pre", "script", "style", "textarea"].includes(tm[1].toLowerCase())) return 0;
    return 7;
  }
  return 0;
}

function htmlBlockEnded(block, lineText) {
  switch (block.htmlType) {
    case 1: {
      const tag = block.htmlTag;
      return lineText.toLowerCase().includes("</" + tag + ">");
    }
    case 2: return lineText.includes("-->");
    case 3: return lineText.includes("?>");
    case 4: return lineText.includes(">");
    case 5: return lineText.includes("]]>");
    default: return false;
  }
}

const HR_RE = /^([-*_])([ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
const ATX_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;

// Split a table row into cell sources. Backslash-pipe is a literal pipe;
// no code-span shielding.
function splitTableRow(row) {
  let s = row.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  const cells = [];
  let cur = "";
  let started = false;
  let i = 0;
  if (s.startsWith("|")) { i = 1; started = true; }
  let lastWasPipe = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      if (s[i + 1] === "|") { cur += "|"; i++; }
      else { cur += ch + s[i + 1]; i++; }
      lastWasPipe = false;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      lastWasPipe = true;
      continue;
    }
    cur += ch;
    lastWasPipe = false;
  }
  cells.push(cur);
  if (lastWasPipe) cells.pop();
  void started;
  return cells.map((c) => c.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""));
}

function isDelimRow(cells) {
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

// Parse a list marker at the cursor's next nonspace. Returns marker
// info or null. Does not move the cursor.
function matchListMarker(cur) {
  const s = cur.line;
  let p = cur.nextNonspace;
  // the indent frame starts at the cursor's current column (after any
  // matched containers), before the marker's own leading spaces;
  // markerEndCol is the absolute column just past the marker
  const col0 = cur.col;
  const markerCol = cur.nextNonspaceCol;
  const ch = s[p];
  let bullet = null;
  let start = null;
  let delim = null;
  let markerEnd; // char offset just past the marker
  let markerEndCol;
  if (ch === "-" || ch === "+" || ch === "*") {
    bullet = ch;
    markerEnd = p + 1;
    markerEndCol = markerCol + 1;
  } else if (ch >= "0" && ch <= "9") {
    let q = p;
    while (q < s.length && s[q] >= "0" && s[q] <= "9" && q - p < 9) q++;
    if (q === p || (s[q] !== "." && s[q] !== ")")) return null;
    start = parseInt(s.slice(p, q), 10);
    delim = s[q];
    markerEnd = q + 1;
    markerEndCol = markerCol + (q - p) + 1;
  } else {
    return null;
  }
  // what follows: whitespace run or end of line
  let q = markerEnd;
  let col = markerEndCol;
  let wsChars = 0;
  while (q < s.length && (s[q] === " " || s[q] === "\t")) {
    if (s[q] === "\t") col += 4 - (col % 4);
    else col += 1;
    q++;
    wsChars++;
  }
  const atEol = q >= s.length;
  if (!atEol && wsChars === 0) return null;
  // contentIndent is measured relative to the marker's own frame (the
  // cursor position where matching started), not in absolute columns
  let contentIndent;
  let contentOff;
  let contentPartial = 0;
  if (atEol) {
    contentIndent = markerEndCol - col0 + 1;
    contentOff = markerEnd;
  } else if (col - markerEndCol >= 5) {
    // content indent is marker end + 1; content starts after ONE
    // whitespace character (a tab is only partially consumed)
    contentIndent = markerEndCol - col0 + 1;
    contentOff = markerEnd;
    // simulate consuming one ws char from markerEnd
    if (s[markerEnd] === "\t") {
      const w = 4 - (markerEndCol % 4);
      contentPartial = w - 1;
      contentOff = markerEnd; // stay on tab; partial holds the rest
    } else {
      contentOff = markerEnd + 1;
    }
  } else {
    contentIndent = col - col0;
    contentOff = q;
  }
  return {
    bullet, start, delim, contentIndent, contentOff,
    contentPartial, markerEndCol, empty: atEol,
  };
}

// Advance the cursor to a list item's content position described by m.
function applyListContent(cur, m) {
  // move to the content offset first (character-wise)
  while (cur.off < m.contentOff) cur.advance(1, false);
  if (m.contentPartial > 0) {
    // one column of the tab was consumed: col moves to the visual
    // position inside the tab, partial holds what is left of it
    cur.partial = m.contentPartial;
    cur.col += 1;
    cur.nns = -1;
  }
}

/* Link reference definitions --------------------------------------- */

// Parse one definition at text[pos]. Returns {end, label, href, title}
// or null. end is just past the definition (including its newline).
function parseDefAt(text, pos) {
  const n = text.length;
  // a definition may not cross a blank line
  let limit = n;
  const blankAt = text.indexOf("\n", pos);
  if (blankAt !== -1) {
    const m = /\n[ \t]*\n/.exec(text.slice(pos));
    if (m) limit = pos + m.index + 1;
  }
  void blankAt;
  // up to three leading spaces before the label
  let lead = 0;
  while (pos + lead < n && text[pos + lead] === " " && lead < 3) lead++;
  pos += lead;
  if (text[pos] !== "[") return null;
  // label: no unescaped brackets inside (marked rejects those defs)
  let i = pos + 1;
  let labelEnd = -1;
  while (i < limit) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < n) { i += 2; continue; }
    if (ch === "[") return null;
    if (ch === "]") { labelEnd = i; break; }
    i++;
  }
  if (labelEnd === -1) return null;
  const label = text.slice(pos + 1, labelEnd);
  if (/^\s*$/.test(label)) return null;
  i = labelEnd + 1;
  if (text[i] !== ":") return null;
  i++;
  // whitespace: spaces/tabs and at most one newline
  const skipWsOneNl = () => {
    let sawNl = false;
    while (i < n) {
      const ch = text[i];
      if (ch === " " || ch === "\t") { i++; continue; }
      if (ch === "\n" && !sawNl) { sawNl = true; i++; continue; }
      break;
    }
  };
  const skipInlineWs = () => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
  };
  skipWsOneNl();
  // destination
  let href;
  if (text[i] === "<") {
    let k = i + 1;
    while (k < n && text[k] !== ">" && text[k] !== "\n" && text[k] !== "<") k++;
    if (k >= n || text[k] !== ">") return null;
    if (text[k - 1] === "\\") return null;
    href = text.slice(i + 1, k);
    i = k + 1;
  } else {
    let d = 0;
    let out = "";
    let k = i;
    while (k < n) {
      const ch = text[k];
      if (ch === "\\" && k + 1 < n && ASCII_PUNCT.has(text[k + 1])) {
        out += text[k + 1];
        k += 2;
        continue;
      }
      if (ch === "(") { d++; out += ch; k++; continue; }
      if (ch === ")") {
        if (d === 0) break;
        d--;
        out += ch;
        k++;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
      out += ch;
      k++;
    }
    if (k === i) return null; // empty destination
    href = out;
    i = k;
  }
  const destEnd = i;
  // optional title: it must be preceded by whitespace
  const wsBeforeTitle = i;
  skipWsOneNl();
  let title = null;
  let titleEnd = -1;
  if (i > wsBeforeTitle && i < n &&
      (text[i] === '"' || text[i] === "'" || text[i] === "(")) {
    const open = text[i];
    const close = open === "(" ? ")" : open;
    let k = i + 1;
    let out = "";
    let ok = false;
    while (k < limit) {
      const ch = text[k];
      if (ch === "\\" && k + 1 < n && ASCII_PUNCT.has(text[k + 1])) {
        out += text[k + 1];
        k += 2;
        continue;
      }
      if (ch === close) { ok = true; break; }
      if (open === "(" && ch === "(") { ok = false; break; }
      out += ch;
      k++;
    }
    if (ok) {
      title = out;
      titleEnd = k + 1;
    }
  }
  if (titleEnd !== -1) {
    i = titleEnd;
    skipInlineWs();
    if (i >= n || text[i] === "\n") {
      if (text[i] === "\n") i++;
      return { end: i, label, href, title };
    }
    // junk after the title: fall through to the title-less check
  }
  // title-less definition: must end at the destination's line end
  i = destEnd;
  skipInlineWs();
  if (i >= n) return { end: i, label, href, title: null };
  if (text[i] === "\n") return { end: i + 1, label, href, title: null };
  return null;
}

// Strip the leading run of definitions from a paragraph's text,
// registering them. Returns the remaining text.
function stripDefs(text, refs) {
  let pos = 0;
  for (;;) {
    const d = parseDefAt(text, pos);
    if (!d) break;
    const key = normalizeLabel(d.label);
    if (!refs.has(key)) refs.set(key, { href: d.href, title: d.title });
    pos = d.end;
  }
  return text.slice(pos);
}

/* ------------------------------------------------------------------ */
/* 4. document parsing                                                 */
/* ------------------------------------------------------------------ */

function endsBlankDeep(b) {
  if (b.endsBlank) return true;
  const kids = b.children;
  if (kids.length === 0) return false;
  return endsBlankDeep(kids[kids.length - 1]);
}

// Same walk, but only blank lines that were blank in the raw source
// (a container-only line like "  >" does not separate list items).
function endsRawBlankDeep(b) {
  if (b.endsRawBlank) return true;
  const kids = b.children;
  if (kids.length === 0) return false;
  return endsRawBlankDeep(kids[kids.length - 1]);
}

function parseDocument(src) {
  const refs = new Map();
  const root = newBlock("doc");
  const stack = [root];

  const tip = () => stack[stack.length - 1];
  const addChild = (parent, child) => {
    if (parent.endsBlank) parent.sawBlankBeforeChild = true;
    parent.endsBlank = false;
    child.parent = parent;
    parent.children.push(child);
    return child;
  };
  // strip one trailing newline from an html block at the end of a
  // container's last-child chain (used on container finalisation)
  const stripHtmlAtContainerEnd = (container) => {
    let b = container;
    while (b.children.length) b = b.children[b.children.length - 1];
    if (b.type === "html" && !b._stripped && b.literal.endsWith("\n")) {
      b.literal = b.literal.slice(0, -1);
      b._stripped = true;
    }
  };
  const finalizeBlock = (b) => {
    b._open = false;
    if (b.type === "para") {
      b.literal = stripDefs(b.literal, refs);
      if (b.literal === "") {
        // a paragraph of definitions only disappears
        const p = b.parent;
        if (p) {
          const ix = p.children.indexOf(b);
          if (ix !== -1) p.children.splice(ix, 1);
        }
      }
    } else if (b.type === "code" && !b.fenced) {
      // indented code: drop trailing blank lines
      let lit = b.literal;
      while (lit.endsWith("\n")) {
        const prev = lit.lastIndexOf("\n", lit.length - 2);
        const lastLine = lit.slice(prev + 1, -1);
        if (/^[ \t]*$/.test(lastLine)) lit = lit.slice(0, prev + 1);
        else break;
      }
      b.literal = lit;
    } else if (b.type === "list") {
      let loose = false;
      const items = b.children;
      for (let ix = 0; ix < items.length; ix++) {
        const item = items[ix];
        if (item.sawBlankBeforeChild) loose = true;
        const kids = item.children;
        for (let k = 0; k < kids.length - 1; k++) {
          if (endsBlankDeep(kids[k])) loose = true;
        }
        if (ix < items.length - 1 && endsRawBlankDeep(item)) loose = true;
      }
      b.tight = !loose;
    }
    if (b.type === "item" || b.type === "quote" || b.type === "list") {
      stripHtmlAtContainerEnd(b);
    }
  };
  const closeTop = () => {
    const b = stack.pop();
    finalizeBlock(b);
    return b;
  };
  const closeDownTo = (depth) => {
    while (stack.length > depth) closeTop();
  };

  const lines = src.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const lastLineNoNl = !src.endsWith("\n") && src.length > 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    // html block lines keep the source's own line ending: a final
    // line without a newline contributes none
    const lineNl = lineIdx === lines.length - 1 && lastLineNoNl ? "" : "\n";
    const cur = new Cursor(rawLine);
    // ---- phase 1: match open containers
    let matchedUpto = 0; // stack index of last matched container
    let pendingSibling = null; // a list whose item should be replaced
    let i = 1;
    while (i < stack.length) {
      const b = stack[i];
      if (b.type === "quote") {
        if (cur.indent <= 3 && cur.remainderFromNonspace()[0] === ">") {
          cur.advanceToNonspace();
          cur.advance(1, false);
          const nx = cur.line[cur.off];
          if (nx === " ") cur.advance(1, false);
          else if (nx === "\t") cur.advance(1, true);
          matchedUpto = i;
          i++;
          continue;
        }
        break;
      }
      if (b.type === "list") {
        // matches provisionally; confirmed by its item or a sibling
        i++;
        continue;
      }
      if (b.type === "item") {
        if (cur.isBlank) {
          matchedUpto = i;
          i++;
          continue;
        }
        // an item that was empty when a blank line passed can no
        // longer pick up content lines (a sibling may still replace it)
        if (b.children.length === 0 && b._blankSeen) {
          // fall through to the sibling check below
        } else if (cur.indent >= b.contentIndent) {
          cur.advance(b.contentIndent, true);
          matchedUpto = i;
          i++;
          continue;
        }
        // maybe a sibling item of the enclosing list starts here
        const lst = stack[i - 1];
        if (lst && lst.type === "list") {
          const m = cur.indent <= 3 && !HR_RE.test(cur.remainderFromNonspace())
            ? matchListMarker(cur) : null;
          if (m && sameListType(lst, m)) {
            pendingSibling = { list: lst, marker: m, itemIndex: i };
            matchedUpto = i - 1;
          }
        }
        break;
      }
      break; // a leaf block: containers are done
    }
    const containersMatched = i >= stack.length ||
      (i === stack.length - 1 && isLeaf(stack[i]));
    let theTip = tip();

    // ---- phase 2: leaf continuation
    let consumed = false;
    if (theTip.type === "code" && theTip.fenced) {
      const rest = cur.remainderFromNonspace();
      const closing = cur.indent <= 3 && isFenceClose(rest, theTip);
      const unmatched = stack.slice(matchedUpto + 1, stack.length - 1);
      const onlyItems = unmatched.every((b) => b.type === "list" || b.type === "item");
      if (containersMatched && closing) {
        applyFenceTrail(theTip);
        closeTop();
        consumed = true;
      } else if (containersMatched || (onlyItems && (theTip._sawMatched || closing))) {
        if (closing && !containersMatched) {
          applyFenceTrail(theTip);
          closeTop();
        } else {
          appendFenceLine(theTip, cur);
          if (containersMatched && !cur.isBlank) theTip._sawMatched = true;
        }
        consumed = true;
      } else {
        closeTop();
        theTip = tip();
      }
    }
    if (!consumed && theTip.type === "code" && !theTip.fenced) {
      if (containersMatched && cur.indent >= 4 && !cur.isBlank) {
        cur.advance(4, true);
        theTip.literal += codeRemainder(cur) + "\n";
        theTip.endsBlank = false;
        consumed = true;
      } else if (containersMatched && cur.isBlank) {
        if (cur.indent >= 4) {
          cur.advance(4, true);
          theTip.literal += cur.remainder() + "\n";
        } else {
          theTip.literal += "\n";
        }
        consumed = true;
      } else {
        closeTop();
        theTip = tip();
      }
    }
    if (!consumed && theTip.type === "html" && theTip.htmlType <= 5) {
      const unmatched = stack.slice(matchedUpto + 1, stack.length - 1);
      const onlyItems = unmatched.every((b) => b.type === "list" || b.type === "item");
      if (containersMatched || onlyItems) {
        const text = cur.remainder();
        theTip.literal += text + lineNl;
        theTip.endsBlank = false;
        if (htmlBlockEnded(theTip, rawLine)) closeTop();
        consumed = true;
      } else {
        closeTop();
        theTip = tip();
      }
    }
    if (!consumed && theTip.type === "html" && theTip.htmlType >= 6) {
      if (containersMatched && !isBlankLine(cur, rawLine)) {
        theTip.literal += cur.remainder() + lineNl;
        theTip.endsBlank = false;
        consumed = true;
      }
    }
    if (!consumed && theTip.type === "table") {
      if (containersMatched && tableRowQualifies(cur)) {
        const cells = splitTableRow(cur.remainder());
        const row = [];
        for (let k = 0; k < theTip.header.length; k++) row.push(cells[k] ?? "");
        theTip.rows.push(row);
        theTip.endsBlank = false;
        consumed = true;
      } else {
        closeTop();
        theTip = tip();
      }
    }
    if (consumed) continue;

    // ---- blank line handling
    if (isBlankLine(cur, rawLine) || (cur.isBlank && tip().type !== "para")) {
      const t = tip();
      if (t !== root) {
        t.endsBlank = true;
        if (/^[ \t]*$/.test(rawLine)) t.endsRawBlank = true;
      }
      if (t.type === "item" && t.children.length === 0) t._blankSeen = true;
      stripHtmlOnBlank(root, rawLine, stack);
      // close everything the line did not match, containers included
      closeDownTo(matchedUpto + 1);
      continue;
    }

    // ---- setext / table conversion on an open paragraph
    if (theTip.type === "para" && containersMatched) {
      const rest = cur.remainderFromNonspace();
      if (cur.indent <= 3 && SETEXT_RE.test(rest)) {
        const strippedText = stripDefs(theTip.literal, refs);
        if (strippedText.trim() !== "") {
          const level = rest[0] === "=" ? 1 : 2;
          const headingText = strippedText
            .replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
          const heading = newBlock("heading", { level, literal: headingText });
          const parent = theTip.parent;
          parent.children[parent.children.indexOf(theTip)] = heading;
          heading.parent = parent;
          stack.pop(); // para replaced; no def registration twice
          theTip._converted = true;
          continue;
        }
        // not a heading: fall through to continuation below
        theTip.literal += "\n" + cur.remainder();
        continue;
      }
      // table conversion
      if (!theTip.literal.includes("\n") && theTip.literal.includes("|")) {
        const cells = splitTableRow(cur.remainderFromNonspace());
        if (isDelimRow(cells)) {
          const header = splitTableRow(theTip.literal);
          if (header.length === cells.length) {
            const aligns = cells.map((c) =>
              c.startsWith(":") && c.endsWith(":") ? "center"
              : c.startsWith(":") ? "left"
              : c.endsWith(":") ? "right" : null);
            const table = newBlock("table", { header, aligns, rows: [] });
            const parent = theTip.parent;
            parent.children[parent.children.indexOf(theTip)] = table;
            table.parent = parent;
            stack[stack.length - 1] = table;
            continue;
          }
        }
      }
    }

    // ---- lazy paragraph continuation
    if (theTip.type === "para" && !containersMatched && !pendingSibling) {
      // when the paragraph hangs below containers the line did not
      // match, any block start at the matched level ends the laziness;
      // when its own parent matched, the paragraph-interruption rules
      // decide instead
      const parentMatched = theTip.parent === stack[matchedUpto];
      const blocked = parentMatched
        ? startsInterruptingBlock(cur)
        : startsAnyBlock(cur);
      if (!blocked) {
        let add = cur.remainderFromNonspace();
        // marked quirk: a lazy setext-underline line inside a blockquote
        // is padded with four spaces when the previous line of the
        // paragraph was itself a lazy line
        if (SETEXT_RE.test(add) && theTip._lastLazy && inQuoteDirect(theTip)) {
          add = "    " + add;
        }
        theTip.literal += "\n" + add;
        theTip._lastLazy = true;
        continue;
      }
    }

    // ---- close unmatched blocks
    if (pendingSibling) {
      closeDownTo(pendingSibling.itemIndex); // close old item (and below)
      // stack top is now the list
      const item = newBlock("item", { contentIndent: pendingSibling.marker.contentIndent });
      addChild(pendingSibling.list, item);
      stack.push(item);
      applyListContent(cur, pendingSibling.marker);
    } else {
      // when every container matched, the open leaf (if any) stays open
      closeDownTo(containersMatched ? stack.length : matchedUpto + 1);
    }

    // ---- phase 3a: container starts
    for (;;) {
      const t = tip();
      const rest = cur.remainderFromNonspace();
      const ind = cur.indent;
      if (ind <= 3 && rest[0] === ">") {
        if (t.type === "para") closeTop();
        const q = newBlock("quote");
        addChild(tip(), q);
        stack.push(q);
        cur.advanceToNonspace();
        cur.advance(1, false);
        const nx = cur.line[cur.off];
        if (nx === " ") cur.advance(1, false);
        else if (nx === "\t") cur.advance(1, true);
        continue;
      }
      if (ind <= 3 && HR_RE.test(rest)) break; // thematic break: leaf phase
      if (ind <= 3) {
        const m = matchListMarker(cur);
        if (m) {
          // sibling items are recognised in phase 1; a marker here
          // always opens a fresh (possibly nested) list
          const t2 = tip();
          const interrupts = t2.type === "para"
            ? (!m.empty && (m.bullet !== null || m.start === 1))
            : true;
          if (t2.type === "para" && !interrupts) {
            // not an interruption: paragraph continuation
            t2.literal += "\n" + cur.remainder();
            consumed = true;
            break;
          }
          if (t2.type === "para") closeTop();
          const lst = newBlock("list", {
            bullet: m.bullet, start: m.start, delim: m.delim, tight: true,
          });
          addChild(tip(), lst);
          stack.push(lst);
          const item = newBlock("item", { contentIndent: m.contentIndent });
          addChild(lst, item);
          stack.push(item);
          applyListContent(cur, m);
          continue;
        }
      }
      break;
    }
    if (consumed) continue;
    if (tip().type === "para" && stack[stack.length - 1]._converted) continue;

    // a line that only opened containers and has nothing left starts
    // no leaf block (it is not a blank line either: no flags are set)
    if (cur.isBlank && tip().type !== "para") {
      continue;
    }

    // ---- phase 3b: leaf starts
    {
      const t = tip();
      const rest = cur.remainderFromNonspace();
      const ind = cur.indent;
      const restRaw = cur.remainder();
      if (t.type === "para") {
        // interrupting leaf starts
        let done = false;
        if (ind <= 3) {
          const atx = ATX_RE.exec(rest);
          const fence = FENCE_RE.exec(rest);
          if (atx) {
            closeTop();
            addChild(tip(), makeHeading(atx));
            done = true;
          } else if (fence && (fence[1][0] === "~" || !fence[2].includes("`"))) {
            closeTop();
            pushFence(stack, addChild, fence, ind);
            done = true;
          } else if (htmlBlockStart(rest) !== 0 && htmlBlockStart(rest) !== 7) {
            closeTop();
            pushHtml(stack, addChild, rest, rawLine, restRaw + lineNl);
            done = true;
          } else if (HR_RE.test(rest)) {
            closeTop();
            addChild(tip(), newBlock("hr"));
            done = true;
          }
        }
        if (!done) {
          t.literal += "\n" + restRaw;
          t.endsBlank = false;
          t._lastLazy = false;
        }
        continue;
      }
      // no open paragraph
      if (ind <= 3) {
        const atx = ATX_RE.exec(rest);
        if (atx) {
          addChild(tip(), makeHeading(atx));
          continue;
        }
        const fence = FENCE_RE.exec(rest);
        if (fence && (fence[1][0] === "~" || !fence[2].includes("`"))) {
          pushFence(stack, addChild, fence, ind);
          continue;
        }
        const ht = htmlBlockStart(rest);
        if (ht !== 0) {
          pushHtml(stack, addChild, rest, rawLine, restRaw + lineNl);
          continue;
        }
        if (HR_RE.test(rest)) {
          addChild(tip(), newBlock("hr"));
          continue;
        }
      }
      if (ind >= 4) {
        const code = newBlock("code", { fenced: false });
        addChild(tip(), code);
        stack.push(code);
        cur.advance(4, true);
        code.literal += codeRemainder(cur) + "\n";
        continue;
      }
      const para = newBlock("para", { literal: restRaw });
      addChild(tip(), para);
      stack.push(para);
    }
  }

  closeDownTo(1);
  return { root, refs };
}

// Is this paragraph directly inside a blockquote (no list between)?
function inQuoteDirect(para) {
  let p = para.parent;
  while (p) {
    if (p.type === "quote") return true;
    if (p.type === "list" || p.type === "item") return false;
    p = p.parent;
  }
  return false;
}

function isLeaf(b) {
  return b.type === "para" || b.type === "code" || b.type === "html" ||
    b.type === "table" || b.type === "heading" || b.type === "hr";
}

function sameListType(list, m) {
  if (list.bullet !== null && m.bullet !== null) return list.bullet === m.bullet;
  if (list.bullet === null && m.bullet === null) return list.delim === m.delim;
  return false;
}

// Blank-line test with the blockquote content-line exception: a line
// whose remainder is only spaces still counts as content when a
// container marker was consumed and left spaces behind.
function isBlankLine(cur, rawLine) {
  if (!cur.isBlank) return false;
  if (/^[ \t]*$/.test(rawLine)) return true;
  return cur.remainder() === "";
}

function isFenceClose(rest, fence) {
  const ch = fence.fenceChar;
  const re = ch === "`" ? /^(`{3,})[ \t]*$/ : /^(~{3,})[ \t]*$/;
  const m = re.exec(rest);
  return m !== null && m[1].length >= fence.fenceLen;
}

function appendFenceLine(block, cur) {
  let text = cur.remainder();
  // a leading tab in the remainder expands by absolute column
  if (text.startsWith("\t") && cur.partial === 0 && cur.col > 0) {
    text = " ".repeat(4 - (cur.col % 4)) + text.slice(1);
  }
  if (block.fenceChar === "`" && block.fenceIndent > 0) {
    let k = 0;
    while (k < text.length && k < block.fenceIndent &&
           (text[k] === " " || text[k] === "\t")) k++;
    text = text.slice(k);
  }
  block.literal += text + "\n";
}

// The fence trailing-blank rule (closed fences only).
function applyFenceTrail(block) {
  let lit = block.literal;
  if (lit === "\n") lit = "";
  else if (lit.endsWith("\n\n")) lit = lit.slice(0, -1);
  block.literal = lit;
}

function codeRemainder(cur) {
  let text = cur.remainder();
  if (text.startsWith("\t") && cur.partial === 0 && cur.col > 0) {
    text = " ".repeat(4 - (cur.col % 4)) + text.slice(1);
  }
  return text;
}

function makeHeading(atxMatch) {
  const level = atxMatch[1].length;
  let content = atxMatch[2] || "";
  content = content.replace(/[ \t]+$/, "");
  if (/^#+$/.test(content)) content = "";
  else content = content.replace(/[ \t]+#+$/, "").replace(/[ \t]+$/, "");
  return newBlock("heading", { level, literal: content });
}

function pushFence(stack, addChild, fenceMatch, indent) {
  const run = fenceMatch[1];
  const info = fenceMatch[2].replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  const code = newBlock("code", {
    fenced: true,
    fenceChar: run[0],
    fenceLen: run.length,
    fenceIndent: indent,
    info,
    _sawMatched: false,
  });
  addChild(stack[stack.length - 1], code);
  stack.push(code);
}

function pushHtml(stack, addChild, rest, rawLine, literalText) {
  const type = htmlBlockStart(rest);
  const block = newBlock("html", { htmlType: type });
  if (type === 1) {
    const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    block.htmlTag = m[1].toLowerCase();
  }
  block.literal = literalText !== undefined ? literalText : rest + "\n";
  addChild(stack[stack.length - 1], block);
  stack.push(block);
  if (type <= 5 && htmlBlockEnded(block, rawLine)) {
    stack.pop();
    block._open = false;
  }
}

// On a blank line: maybe strip one trailing newline from the innermost
// html block in the document's last-child chain.
function stripHtmlOnBlank(root, rawLine, stack) {
  let b = root;
  while (b.children.length) b = b.children[b.children.length - 1];
  if (b.type !== "html" || b._stripped) return;
  if (!b.literal.endsWith("\n")) return;
  const empty = rawLine === "";
  const spacesOnly = /^ *$/.test(rawLine);
  const stillOpen = stack.includes(b);
  if (empty || (b.htmlType >= 6 && (spacesOnly || stillOpen))) {
    b.literal = b.literal.slice(0, -1);
    b._stripped = true;
  }
}

// Would this line start any block at all (used for lazy lines whose
// paragraph sits inside containers the line did not match)?
function startsAnyBlock(cur) {
  const rest = cur.remainderFromNonspace();
  const ind = cur.indent;
  if (ind > 3) return false;
  if (rest[0] === ">") return true;
  if (ATX_RE.test(rest)) return true;
  const fence = FENCE_RE.exec(rest);
  if (fence && (fence[1][0] === "~" || !fence[2].includes("`"))) return true;
  if (HR_RE.test(rest)) return true;
  if (htmlBlockStart(rest) !== 0) return true;
  if (matchListMarker(cur)) return true;
  return false;
}

// Would this line start a block that interrupts a paragraph (used to
// decide lazy continuation)?
function startsInterruptingBlock(cur) {
  const rest = cur.remainderFromNonspace();
  const ind = cur.indent;
  if (ind > 3) return false;
  if (rest[0] === ">") return true;
  if (ATX_RE.test(rest)) return true;
  const fence = FENCE_RE.exec(rest);
  if (fence && (fence[1][0] === "~" || !fence[2].includes("`"))) return true;
  if (HR_RE.test(rest)) return true;
  const ht = htmlBlockStart(rest);
  if (ht !== 0) return true;
  const m = matchListMarker(cur);
  if (m && !m.empty && (m.bullet !== null || m.start === 1)) return true;
  return false;
}

function tableRowQualifies(cur) {
  const rest = cur.remainder();
  if (rest === "" || /^ *$/.test(rest)) return false;
  const restNS = cur.remainderFromNonspace();
  if (cur.indent <= 3) {
    if (restNS[0] === ">") return false;
    if (ATX_RE.test(restNS)) return false;
    if (HR_RE.test(restNS)) return false;
    const fence = FENCE_RE.exec(restNS);
    if (fence && (fence[1][0] === "~" || !fence[2].includes("`"))) return false;
    if (htmlBlockStart(restNS) !== 0) return false;
    if (matchListMarker(cur)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 5. rendering                                                        */
/* ------------------------------------------------------------------ */

function renderBlocks(blocks, ctx) {
  let out = "";
  for (const b of blocks) out += renderBlock(b, ctx);
  return out;
}

function renderBlock(b, ctx) {
  switch (b.type) {
    case "doc":
      return renderBlocks(b.children, ctx);
    case "quote":
      return "<blockquote>\n" + renderBlocks(b.children, ctx) + "</blockquote>\n";
    case "heading":
      return "<h" + b.level + ">" + parseInline(b.literal, ctx) + "</h" + b.level + ">\n";
    case "hr":
      return "<hr>\n";
    case "para":
      return "<p>" + renderParaContent(b, ctx) + "</p>\n";
    case "code": {
      if (b.fenced && b.info) {
        const word = unescapeBackslashes(b.info).split(/\s+/)[0];
        return '<pre><code class="language-' + escapeAttr(word) + '">' +
          escapeCode(b.literal) + "</code></pre>\n";
      }
      return "<pre><code>" + escapeCode(b.literal) + "</code></pre>\n";
    }
    case "html":
      return b.literal;
    case "list": {
      const tag = b.bullet !== null ? "ul" : "ol";
      const startAttr = b.bullet === null && b.start !== 1
        ? ' start="' + b.start + '"' : "";
      return "<" + tag + startAttr + ">\n" +
        renderBlocks(b.children, ctx) + "</" + tag + ">\n";
    }
    case "item":
      return renderItem(b, ctx);
    case "table":
      return renderTable(b, ctx);
    default:
      return "";
  }
}

// Paragraph content with the task-list checkbox rule applied when the
// paragraph opens a list item.
function renderParaContent(b, ctx) {
  return parseInline(b.literal, ctx);
}

function renderItem(item, ctx) {
  const list = item.parent;
  const tight = list && list.tight;
  if (item.children.length === 0) return "<li></li>\n";
  let out = "<li>";
  const kids = item.children;
  for (let k = 0; k < kids.length; k++) {
    const child = kids[k];
    if (child.type === "para" && tight) {
      out += renderItemPara(child, ctx, k === 0);
    } else if (child.type === "para") {
      out += "<p>" + renderItemPara(child, ctx, k === 0) + "</p>\n";
    } else {
      out += renderBlock(child, ctx);
    }
  }
  return out + "</li>\n";
}

function renderItemPara(para, ctx, isFirst) {
  let text = para.literal;
  let prefix = "";
  if (isFirst) {
    const m = /^\[( |x|X)\] /.exec(text);
    const m2 = m ? null : /^\[\] /.exec(text);
    if (m) {
      const checked = m[1] === "x" || m[1] === "X";
      prefix = checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      text = text.slice(4);
    } else if (m2) {
      prefix = '<input disabled="" type="checkbox"> ';
      text = text.slice(3);
    }
  }
  return prefix + parseInline(text, ctx);
}

function renderTable(b, ctx) {
  let out = "<table>\n<thead>\n<tr>\n";
  for (let k = 0; k < b.header.length; k++) {
    const align = b.aligns[k];
    out += "<th" + (align ? ' align="' + align + '"' : "") + ">" +
      parseInline(b.header[k], ctx) + "</th>\n";
  }
  out += "</tr>\n</thead>\n";
  if (b.rows.length) {
    out += "<tbody>";
    for (const row of b.rows) {
      out += "<tr>\n";
      for (let k = 0; k < row.length; k++) {
        const align = b.aligns[k];
        out += "<td" + (align ? ' align="' + align + '"' : "") + ">" +
          parseInline(row[k], ctx) + "</td>\n";
      }
      out += "</tr>\n";
    }
    out += "</tbody>";
  }
  return out + "</table>\n";
}

/* ------------------------------------------------------------------ */
/* public entry point                                                  */
/* ------------------------------------------------------------------ */

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const { root, refs } = parseDocument(src);
  const ctx = { refs, state: { inLink: false } };
  return renderBlocks(root.children, ctx);
}
