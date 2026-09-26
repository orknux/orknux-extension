/*
 * PDF, as a plugin — jsPDF for the writing, DejaVu for the alphabet, and
 * mermaid diagrams drawn into the page as vectors.
 *
 * The layout is still this file's own: a practical subset of HTML read into
 * blocks, wrapped and paged. What changed hands is everything below that.
 * jsPDF — bundled in by `plugins/build.mjs` — writes the file, and two DejaVu
 * faces travel inside the bundle as base64, so ą, ř and ő are set as the
 * letters they are instead of being folded to a, r and o. The price is that
 * the answer is binary now: it leaves as base64, which is the shape
 * `slack_uploadBinary` and the http door's `upload` take.
 *
 * ## Diagrams, embedded — and still no network
 *
 * A `<pre class="mermaid">` or `<mermaid>` block becomes a diagram *in* the
 * document. beautiful-mermaid renders it to SVG right here — pure JavaScript,
 * no DOM, bundled like everything else — and the SVG's small vocabulary
 * (rect, polygon, polyline, text) is translated to jsPDF's own vector calls,
 * colors resolved from the theme arithmetic the SVG spells as color-mix. So
 * the diagram is real vector drawing in the PDF, and nothing was fetched from
 * anywhere. The kinds that render are beautiful-mermaid's: flowchart/graph,
 * sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram; another kind is
 * refused with a sentence naming what renders.
 *
 * ## What of HTML is understood
 *
 * Headings h1–h3 (h4–h6 read as h3), paragraphs and divs, br and hr, ul and
 * ol with nesting, b/strong (i/em render regular — a third and fourth face
 * would put the bundle over the size a plugin may be), table cells run
 * together as text, and the mermaid blocks above. Scripts, styles and
 * comments are dropped whole; every other tag is ignored and its text kept.
 * Entities, named and numeric, are decoded. A report writer, not a browser:
 * no CSS, no raster images, no links.
 *
 * This file is a build product's *source* — `plugins/pdf/pdf.js` is what the
 * server loads, and editing that by hand is editing a bundle.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

import { jsPDF } from 'jspdf';
import { renderMermaidSync } from 'beautiful-mermaid';
import DEJAVU from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
import DEJAVU_BOLD from 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf';

/**
 * A short name for one document, derived from the document itself.
 *
 * Content rather than a counter or a clock: the same html rendered twice lands
 * on the same key and simply overwrites itself, and nothing here has to ask
 * what time it is or keep a number between calls.
 *
 * FNV-1a because it is four lines and this is a name, not a checksum.
 */
function keyFor(text) {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pdf.${hash.toString(36)}`;
}

/** The alphabet of RFC 4648's base64, in order. */
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/*
 * atob and btoa are HTML's, not ECMAScript's, so GraalJS does not have them —
 * and jsPDF's font machinery reaches for them. Filled in where absent, with
 * binary-string semantics: each character is one byte.
 */
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (encoded) => {
    const clean = String(encoded).replace(/[^A-Za-z0-9+/]/g, '');
    let written = '';
    for (let index = 0; index + 1 < clean.length; index += 4) {
      const one = BASE64.indexOf(clean[index]);
      const two = BASE64.indexOf(clean[index + 1]);
      const three = index + 2 < clean.length ? BASE64.indexOf(clean[index + 2]) : -1;
      const four = index + 3 < clean.length ? BASE64.indexOf(clean[index + 3]) : -1;
      written += String.fromCharCode(((one << 2) | (two >> 4)) & 0xff);
      if (three >= 0) {
        written += String.fromCharCode(((two << 4) | (three >> 2)) & 0xff);
      }
      if (four >= 0) {
        written += String.fromCharCode(((three << 6) | four) & 0xff);
      }
    }
    return written;
  };
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (binary) => {
    const held = String(binary);
    let written = '';
    for (let index = 0; index < held.length; index += 3) {
      const one = held.charCodeAt(index) & 0xff;
      const two = index + 1 < held.length ? held.charCodeAt(index + 1) & 0xff : 0;
      const three = index + 2 < held.length ? held.charCodeAt(index + 2) & 0xff : 0;
      written += BASE64[one >> 2] + BASE64[((one & 3) << 4) | (two >> 4)];
      written += index + 1 < held.length ? BASE64[((two & 15) << 2) | (three >> 6)] : '=';
      written += index + 2 < held.length ? BASE64[three & 63] : '=';
    }
    return written;
  };
}

/** Bytes as base64, for the answer. */
function base64Of(bytes) {
  let written = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const one = bytes[index];
    const two = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const three = index + 2 < bytes.length ? bytes[index + 2] : 0;
    written += BASE64[one >> 2] + BASE64[((one & 3) << 4) | (two >> 4)];
    written += index + 1 < bytes.length ? BASE64[((two & 15) << 2) | (three >> 6)] : '=';
    written += index + 2 < bytes.length ? BASE64[three & 63] : '=';
  }
  return written;
}

/** The page: A4, in points, origin top-left as jsPDF has it. */
const PAGE = { width: 595.28, height: 841.89, margin: 56 };

/** How each kind of block is set: size, weight, and the air around it. */
const STYLES = {
  h1: { size: 20, bold: true, before: 14, after: 8 },
  h2: { size: 16, bold: true, before: 12, after: 6 },
  h3: { size: 13, bold: true, before: 10, after: 5 },
  p: { size: 11, bold: false, before: 0, after: 6 },
  item: { size: 11, bold: false, before: 0, after: 2 },
};

/**
 * The entities worth knowing by name; the numeric kind is decoded by value.
 *
 * Every letter the bundled face can set has its name here, because a model
 * writing HTML spells a letter it is unsure of as an entity - `&oacute;`,
 * `&#322;` - rather than typing it. An entity nobody decodes is set as its
 * own eight characters, and a document that reads `Za&oacute;` where it
 * should read `Zaó` is a document in the wrong language.
 *
 * Case matters, and is kept: `&Oacute;` and `&oacute;` are two letters.
 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', rarr: '→',
  middot: '·', copy: '©', reg: '®', trade: '™',
  deg: '°', laquo: '«', raquo: '»', sect: '§', euro: '€',
  para: '\u00b6', shy: '\u00ad', iexcl: '¡', iquest: '¿', pound: '£', yen: '¥',
  cent: '¢', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', times: '×', divide: '÷',
};

/*
 * The Latin-1 letters, U+00C0 to U+00FF, in the order the block holds them -
 * which is the order HTML names them in, `times` and `divide` included above
 * as the two that are not letters.
 */
(
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
)
  .split(' ')
  .forEach((name, at) => {
    ENTITIES[name] = String.fromCodePoint(0xc0 + at);
  });

/*
 * And the Latin Extended-A letters the README promises a language for -
 * Polish, Czech, Slovak, Hungarian, Romanian, Turkish, the Baltics - by their
 * HTML names, with the code point beside each because that is what a reader
 * checking one wants to see.
 */
for (const [name, point] of [
  ['Aogon', 0x104], ['aogon', 0x105], ['Cacute', 0x106], ['cacute', 0x107],
  ['Eogon', 0x118], ['eogon', 0x119], ['Lstrok', 0x141], ['lstrok', 0x142],
  ['Nacute', 0x143], ['nacute', 0x144], ['Sacute', 0x15a], ['sacute', 0x15b],
  ['Zacute', 0x179], ['zacute', 0x17a], ['Zdot', 0x17b], ['zdot', 0x17c],
  ['Ccaron', 0x10c], ['ccaron', 0x10d], ['Dcaron', 0x10e], ['dcaron', 0x10f],
  ['Ecaron', 0x11a], ['ecaron', 0x11b], ['Ncaron', 0x147], ['ncaron', 0x148],
  ['Rcaron', 0x158], ['rcaron', 0x159], ['Scaron', 0x160], ['scaron', 0x161],
  ['Tcaron', 0x164], ['tcaron', 0x165], ['Uring', 0x16e], ['uring', 0x16f],
  ['Zcaron', 0x17d], ['zcaron', 0x17e], ['Lacute', 0x139], ['lacute', 0x13a],
  ['Racute', 0x154], ['racute', 0x155], ['Odblac', 0x150], ['odblac', 0x151],
  ['Udblac', 0x170], ['udblac', 0x171], ['Abreve', 0x102], ['abreve', 0x103],
  ['Scedil', 0x15e], ['scedil', 0x15f], ['Tcedil', 0x162], ['tcedil', 0x163],
  ['Gbreve', 0x11e], ['gbreve', 0x11f], ['Idot', 0x130], ['inodot', 0x131],
  ['Amacr', 0x100], ['amacr', 0x101], ['Emacr', 0x112], ['emacr', 0x113],
  ['Imacr', 0x12a], ['imacr', 0x12b], ['Omacr', 0x14c], ['omacr', 0x14d],
  ['Umacr', 0x16a], ['umacr', 0x16b], ['Iogon', 0x12e], ['iogon', 0x12f],
  ['Uogon', 0x172], ['uogon', 0x173], ['Gcedil', 0x122], ['gcedil', 0x123],
  ['Kcedil', 0x136], ['kcedil', 0x137], ['Lcedil', 0x13b], ['lcedil', 0x13c],
  ['Ncedil', 0x145], ['ncedil', 0x146], ['OElig', 0x152], ['oelig', 0x153],
  ['Yuml', 0x178],
]) {
  ENTITIES[name] = String.fromCodePoint(point);
}

/** HTML text with its entities decoded. */
function decoded(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    /*
     * As written first, because case is a letter: &Oacute; is not &oacute;.
     * Then folded, for the names that have no capital of their own and were
     * accepted in any case before this - &AMP; and &NBSP; still decode.
     */
    const known = ENTITIES[name] ?? ENTITIES[name.toLowerCase()];
    return known === undefined ? whole : known;
  });
}

/**
 * Every character that will reach the page, decoded - what the alphabet
 * is decided from.
 *
 * Decided from the blocks rather than from the html, because the html is not
 * what gets set. `&#261;` is seven ASCII characters in the source and one
 * Polish letter on the page, and a document written entirely that way -
 * which is how a model writes a letter it is unsure of - tested as ASCII,
 * was set in Helvetica, and came out as `Za|&oacute;B g[l jazD`. Diagram
 * sources count too: their labels are drawn in the same face.
 */
function textOf(blocks) {
  return blocks
    .map((block) => (block.kind === 'diagram' ? block.source : block.runs.map((run) => run.text).join('')))
    .join('\n');
}

/**
 * HTML read into blocks: a flat list of {kind, runs, marker, depth, source},
 * each run a piece of text with its weight. Diagram blocks are lifted out
 * first, whole and entity-decoded with their newlines kept — mermaid needs
 * them — and everything else is walked with a stack of what is open, which
 * is as much structure as this subset needs.
 */
function blocksOf(html) {
  let source = String(html);
  source = source.replace(/<!--[\s\S]*?-->/g, ' ');

  const diagrams = [];
  source = source.replace(
    /<pre\s[^>]*class=["']?mermaid["']?[^>]*>([\s\S]*?)<\/pre\s*>|<mermaid[^>]*>([\s\S]*?)<\/mermaid\s*>/gi,
    (whole, fenced, tagged) => {
      diagrams.push(decoded(fenced === undefined ? tagged : fenced).trim());
      return `<diagram ${diagrams.length - 1}>`;
    },
  );

  source = source.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const body = source.match(/<body[^>]*>([\s\S]*)<\/body\s*>/i);
  if (body !== null) {
    source = body[1];
  }

  const blocks = [];
  let runs = [];
  let kind = 'p';
  let marker = null;
  let depth = 0;
  let bold = 0;
  let italic = 0;
  const lists = []; // a number counts an <ol>; null is a <ul>

  const flush = () => {
    if (runs.some((one) => /\S/.test(one.text) || one.break === true)) {
      blocks.push({ kind: kind, runs: runs, marker: marker, depth: depth });
    }
    runs = [];
    kind = 'p';
    marker = null;
  };

  for (const token of source.split(/(<[^>]*>)/)) {
    if (token.length === 0) {
      continue;
    }
    if (token[0] !== '<') {
      const text = decoded(token).replace(/\s+/g, ' ');
      if (text.length > 0) {
        runs.push({ text: text, bold: bold > 0, italic: italic > 0 });
      }
      continue;
    }

    const name = (token.match(/^<\/?\s*([a-z0-9]+)/i) ?? [])[1];
    const tag = typeof name === 'string' ? name.toLowerCase() : '';
    const closing = token[1] === '/';

    if (tag === 'diagram') {
      flush();
      const index = token.match(/^<diagram (\d+)>$/);
      if (index !== null) {
        blocks.push({ kind: 'diagram', runs: [], marker: null, depth: 0, source: diagrams[Number(index[1])] });
      }
    } else if (/^h[1-6]$/.test(tag)) {
      flush();
      if (!closing) {
        kind = tag === 'h1' || tag === 'h2' ? tag : 'h3';
      }
    } else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'blockquote' || tag === 'tr') {
      flush();
    } else if (tag === 'br') {
      runs.push({ text: '', break: true });
    } else if (tag === 'hr') {
      flush();
      blocks.push({ kind: 'hr', runs: [], marker: null, depth: 0 });
    } else if (tag === 'ul' || tag === 'ol') {
      flush();
      if (closing) {
        lists.pop();
      } else {
        lists.push(tag === 'ol' ? 1 : null);
      }
    } else if (tag === 'li') {
      flush();
      if (!closing) {
        kind = 'item';
        depth = Math.max(lists.length, 1);
        const counting = lists[lists.length - 1];
        if (typeof counting === 'number') {
          marker = `${counting}.`;
          lists[lists.length - 1] = counting + 1;
        } else {
          marker = '•';
        }
      }
    } else if (tag === 'b' || tag === 'strong') {
      bold = Math.max(0, bold + (closing ? -1 : 1));
    } else if (tag === 'i' || tag === 'em') {
      italic = Math.max(0, italic + (closing ? -1 : 1));
    } else if (tag === 'td' || tag === 'th') {
      if (!closing && runs.length > 0) {
        runs.push({ text: '  ', bold: false, italic: false });
      }
    }
    // Every other tag is ignored, and the text it wrapped is kept.
  }
  flush();
  return blocks;
}

/**
 * A `dy`, which SVG allows to be a number or a length.
 *
 * beautiful-mermaid writes `dy="4.55"` for most diagrams and `dy="0.35em"` for
 * an entity relationship one, and `Number('0.35em')` is NaN - which jsPDF
 * refuses with "Invalid arguments passed to jsPDF.text", taking the whole
 * document with it. So every `erDiagram` in a PDF threw, while the four kinds
 * that write plain numbers were fine.
 *
 * An em is the font size, so it is resolved against the size the element is
 * set in, in the SVG's own units - the page's scale is applied afterwards by
 * whoever places it. Anything that is neither is nothing rather than NaN: a
 * label a hair off its baseline is a better answer than no document.
 */
function dyOf(value, size) {
  if (value === undefined || value === null) {
    return 0;
  }
  const written = String(value).trim();
  const ems = written.endsWith('em');
  const measure = Number(ems ? written.slice(0, -2) : written);
  if (!Number.isFinite(measure)) {
    return 0;
  }
  return ems ? measure * size : measure;
}

/**
 * Anything in the text the bundled face has no glyph for.
 *
 * `plugins/build.mjs` subsets DejaVu down to what this plugin actually sets -
 * ASCII, Latin-1, Latin Extended-A and the punctuation prose uses - because
 * carrying all 739 kB of it was most of the time a PDF took. What that gives
 * up is everything else: Cyrillic, Greek, CJK, emoji.
 *
 * Given up quietly is the part worth fixing. A glyph the face lacks is drawn
 * as nothing at all, so a Russian paragraph comes back as a blank page rather
 * than as a refusal - and a blank page looks like this plugin working. So the
 * characters are named, once, in the log.
 *
 * Said rather than thrown: one stray character should not cost somebody the
 * whole document, and a report whose body sets perfectly apart from an emoji
 * in a heading is still the report they asked for.
 */
const SETTABLE = /[\u0000-\u007f\u00a0-\u017f\u2010-\u2015\u2018\u2019\u201c\u201d\u2022\u2026\u20ac\u2192]/;

function noteUnsettable(text) {
  const missing = [];
  for (const character of text) {
    if (!SETTABLE.test(character) && !missing.includes(character)) {
      missing.push(character);
      if (missing.length === 8) break;
    }
  }
  if (missing.length === 0) {
    return '';
  }
  const said =
    `these characters cannot be set and are blank in the document: ${missing.join(' ')}. ` +
    'It sets Latin alphabets - ASCII, Latin-1, Latin Extended-A - which covers Polish, Czech, ' +
    'Hungarian, Turkish, Romanian and the Nordic and Baltic languages, and not Cyrillic, Greek, ' +
    'CJK or emoji.';
  orknux.log.warn(said);
  return said;
}

/**
 * The face this document is being set in.
 *
 * Carried on the document rather than in a variable up here, because it is a
 * fact about one document and two of them should not be able to disagree.
 */
function faceOf(doc) {
  return doc.orknuxFace ?? 'helvetica';
}

/** The width of some text in the face and size the writer would set it. */
function widthOf(doc, text, bold, size) {
  doc.setFont(faceOf(doc), bold ? 'bold' : 'normal');
  doc.setFontSize(size);
  return doc.getTextWidth(text);
}

/**
 * A block's runs broken into words that remember their weight, so a word set
 * half plain and half bold still wraps as one word.
 */
function wordsOf(doc, block, style) {
  const words = [];
  let open = false;
  for (const run of block.runs) {
    if (run.break === true) {
      words.push({ break: true });
      open = false;
      continue;
    }
    const pieces = run.text.split(' ');
    for (let index = 0; index < pieces.length; index++) {
      if (index > 0) {
        open = false;
      }
      if (pieces[index].length === 0) {
        continue;
      }
      const bold = style.bold || run.bold === true;
      const part = { text: pieces[index], bold: bold, width: widthOf(doc, pieces[index], bold, style.size) };
      if (open) {
        words[words.length - 1].parts.push(part);
      } else {
        words.push({ parts: [part] });
      }
      open = true;
    }
  }
  return words;
}

/** Words folded into lines no wider than fits, each part carrying its x offset. */
function linesOf(doc, words, style, available) {
  const space = widthOf(doc, ' ', false, style.size);
  const lines = [];
  let line = [];
  let width = 0;

  const push = () => {
    lines.push(line);
    line = [];
    width = 0;
  };

  for (const word of words) {
    if (word.break === true) {
      push();
      continue;
    }
    const whole = word.parts.reduce((sum, part) => sum + part.width, 0);
    if (line.length > 0 && width + space + whole > available) {
      push();
    }
    let x = width + (line.length > 0 ? space : 0);
    for (const part of word.parts) {
      line.push({ text: part.text, bold: part.bold, x: x });
      x += part.width;
    }
    width = x;
  }
  if (line.length > 0) {
    push();
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* The diagram translator: beautiful-mermaid's SVG, drawn as vectors. */
/* ------------------------------------------------------------------ */

/** One tag's attributes, read without a DOM. */
function attrsOf(held) {
  const attrs = {};
  for (const one of held.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    attrs[one[1]] = one[2];
  }
  return attrs;
}

/** #RGB or #RRGGBB as [r, g, b]. */
function channelsOf(hex) {
  const held = hex.trim();
  if (/^#[0-9a-f]{3}$/i.test(held)) {
    return [held[1], held[2], held[3]].map((one) => parseInt(one + one, 16));
  }
  if (/^#[0-9a-f]{6}$/i.test(held)) {
    return [held.slice(1, 3), held.slice(3, 5), held.slice(5, 7)].map((one) => parseInt(one, 16));
  }
  return null;
}

/** fg mixed into bg by a share, which is what the SVG's color-mix computes. */
function mixed(fg, bg, share) {
  return fg.map((one, index) => Math.round(one * share + bg[index] * (1 - share)));
}

/**
 * The share of fg in each derived variable, as the SVG's own stylesheet
 * declares them — and which explicit theme variable overrides each, where a
 * theme sets one.
 */
const DERIVED = {
  '_text': { share: 1 },
  '_text-sec': { share: 0.6, from: 'muted' },
  '_text-muted': { share: 0.4, from: 'muted' },
  '_text-faint': { share: 0.25 },
  '_line': { share: 0.5, from: 'line' },
  '_arrow': { share: 0.85, from: 'accent' },
  '_node-fill': { share: 0.03, from: 'surface' },
  '_node-stroke': { share: 0.2, from: 'border' },
  '_group-fill': { share: 0 },
  '_group-hdr': { share: 0.05 },
  '_inner-stroke': { share: 0.12 },
  '_key-badge': { share: 0.1 },
};

/** A paint attribute resolved to [r, g, b], or null for none/unknown. */
function colorOf(value, vars) {
  if (typeof value !== 'string' || value.length === 0 || value === 'none') {
    return null;
  }
  const direct = channelsOf(value);
  if (direct !== null) {
    return direct;
  }
  const named = value.match(/^var\(--([a-z_-]+)\)$/i);
  if (named === null) {
    return null;
  }
  const key = named[1];
  if (vars[key] !== undefined) {
    return channelsOf(vars[key]);
  }
  const derived = DERIVED[key];
  if (derived !== undefined) {
    if (derived.from !== undefined && vars[derived.from] !== undefined) {
      return channelsOf(vars[derived.from]);
    }
    const fg = channelsOf(vars.fg ?? '#27272A');
    const bg = channelsOf(vars.bg ?? '#FFFFFF');
    return mixed(fg, bg, derived.share);
  }
  return channelsOf(vars.fg ?? '#27272A');
}

/** "x,y x,y …" as [[x, y], …]. */
function pointsOf(value) {
  return value
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));
}

/** An arrowhead at `tip`, pointing the way `from` → `tip` does. */
function arrowheadAt(doc, from, tip, place, scale, color) {
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return;
  }
  const ux = dx / length;
  const uy = dy / length;
  const back = 7 * scale;
  const half = 2.5 * scale;
  const baseX = place(tip[0]) - ux * back;
  const baseY = place.y(tip[1]) - uy * back;
  doc.setFillColor(color[0], color[1], color[2]);
  doc.setDrawColor(color[0], color[1], color[2]);
  doc.triangle(
    place(tip[0]),
    place.y(tip[1]),
    baseX - uy * half,
    baseY + ux * half,
    baseX + uy * half,
    baseY - ux * half,
    'FD',
  );
}

/** The size the SVG root declares for itself, in its own units. */
function svgSize(svg) {
  const root = svg.match(/<svg\b([^>]*)>/);
  const rootAttrs = attrsOf(root === null ? '' : root[1]);
  const width = Number(rootAttrs.width);
  const height = Number(rootAttrs.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('the rendered diagram carries no size');
  }
  return { width: width, height: height };
}

/**
 * One diagram, rendered by beautiful-mermaid and drawn onto the page with
 * jsPDF's vector calls. Answers the height it took, in points.
 */
function drawnDiagram(doc, svg, left, top, maxWidth, maxHeight) {
  const root = svg.match(/<svg\b([^>]*)>/);
  const rootAttrs = attrsOf(root === null ? '' : root[1]);
  const { width, height } = svgSize(svg);

  const vars = {};
  for (const one of (rootAttrs.style ?? '').matchAll(/--([a-z-]+):\s*([^;]+)/gi)) {
    vars[one[1]] = one[2].trim();
  }

  /*
   * Drawn to fit the page rather than at whatever size the renderer chose.
   *
   * This used to cap at 1, so a diagram was never enlarged: a two-node
   * flowchart is 152 pt wide and sat in the middle of a 483 pt column, a third
   * of the width, with labels smaller than the body text around them. Nothing
   * about it was low resolution - the whole page is vector - but small reads
   * the same way at a glance.
   *
   * Capped at twice, because a figure is still a figure. Scaling the drawing
   * scales the type inside it, and a diagram whose labels tower over the
   * paragraph explaining them is the opposite mistake.
   */
  const scale = Math.min(2, maxWidth / width, maxHeight / height);
  const place = (x) => left + x * scale;
  place.y = (y) => top + y * scale;

  /*
   * The defs are patterns, not drawing: the arrowhead polygons in there live
   * in marker-local coordinates and are drawn where a polyline references
   * them, never where they are written.
   */
  const drawn = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '');

  const walker = /<(rect|polygon|polyline)\b([^>]*?)\/>|<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (const found of drawn.matchAll(walker)) {
    if (found[1] !== undefined) {
      const attrs = attrsOf(found[2]);
      const fill = colorOf(attrs.fill, vars);
      const stroke = colorOf(attrs.stroke, vars);
      const style = fill !== null && stroke !== null ? 'FD' : fill !== null ? 'F' : stroke !== null ? 'S' : null;
      if (style === null) {
        continue;
      }
      if (fill !== null) {
        doc.setFillColor(fill[0], fill[1], fill[2]);
      }
      if (stroke !== null) {
        doc.setDrawColor(stroke[0], stroke[1], stroke[2]);
        doc.setLineWidth(Number(attrs['stroke-width'] ?? 1) * scale);
      }

      if (found[1] === 'rect') {
        const rx = Number(attrs.rx ?? 0) * scale;
        const x = place(Number(attrs.x));
        const y = place.y(Number(attrs.y));
        const w = Number(attrs.width) * scale;
        const h = Number(attrs.height) * scale;
        if (rx > 0) {
          doc.roundedRect(x, y, w, h, rx, rx, style);
        } else {
          doc.rect(x, y, w, h, style);
        }
      } else {
        const points = pointsOf(attrs.points ?? '');
        if (points.length < 2) {
          continue;
        }
        const deltas = [];
        for (let index = 1; index < points.length; index++) {
          deltas.push([
            (points[index][0] - points[index - 1][0]) * scale,
            (points[index][1] - points[index - 1][1]) * scale,
          ]);
        }
        doc.lines(deltas, place(points[0][0]), place.y(points[0][1]), [1, 1], style, found[1] === 'polygon');

        const arrow = colorOf('var(--_arrow)', vars) ?? [0, 0, 0];
        if (found[1] === 'polyline' && attrs['marker-end'] !== undefined && points.length >= 2) {
          arrowheadAt(doc, points[points.length - 2], points[points.length - 1], place, scale, arrow);
        }
        if (found[1] === 'polyline' && attrs['marker-start'] !== undefined && points.length >= 2) {
          arrowheadAt(doc, points[1], points[0], place, scale, arrow);
        }
      }
    } else {
      const attrs = attrsOf(found[3]);
      const content = decoded(found[4].replace(/<[^>]+>/g, '')).trim();
      if (content.length === 0) {
        continue;
      }
      const color = colorOf(attrs.fill, vars) ?? [0, 0, 0];
      const written = Number(attrs['font-size'] ?? 12);
      const bold = Number(attrs['font-weight'] ?? 400) >= 600;
      doc.setFont(faceOf(doc), bold ? 'bold' : 'normal');
      doc.setFontSize(written * scale);
      doc.setTextColor(color[0], color[1], color[2]);
      const anchor = attrs['text-anchor'];

      const x = place(Number(attrs.x));
      const y = place.y(Number(attrs.y) + dyOf(attrs.dy, written));
      /*
       * A coordinate that did not parse is skipped rather than passed on:
       * jsPDF answers NaN by throwing, and one unplaceable label should not
       * cost the whole document.
       */
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }

      doc.text(content, x, y, {
        align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
      });
    }
  }

  return height * scale;
}

/**
 * The same answer with the bytes taken out, which is what a model wants.
 *
 * An answer reaches a model by being read, every character of it, and this one
 * runs to thousands - read on the way to a key a dozen characters long that
 * names the very same bytes on the server. So the tool below answers the key
 * and leaves them where they are.
 *
 * Unless there was nowhere to leave them: outside a session `put` refuses and
 * the key comes back empty, and then what is in the answer is the only copy
 * there is. Stripping it there would answer nothing at all.
 */
/**
 * The HTML to lay out, from whichever of the three the caller used. Issue #495.
 *
 * A pad first, then a key, then the text itself - the order they cost: reading
 * a pad here costs nothing, a key costs nothing, and text given outright has
 * already been through the model once. A refusal names all three, because a
 * model that passed the wrong one needs to know what the right one was.
 */
function pageFrom(html, scratchpad, contentKey) {
  const named = typeof scratchpad === 'string' ? scratchpad.trim() : '';
  if (named.length > 0) {
    const answer = orknux.scratchpad.read(named);
    if (answer.error !== undefined) {
      throw new Error(`the scratchpad ${named} could not be read: ${answer.error}`);
    }
    const held = answer.ok?.content ?? '';
    if (typeof held !== 'string' || held.trim().length === 0) {
      throw new Error(`the scratchpad ${named} is empty, so there is nothing to lay out`);
    }
    return held;
  }

  const key = typeof contentKey === 'string' ? contentKey.trim() : '';
  if (key.length > 0) {
    const held = orknux.session.store.get(key);
    if (typeof held !== 'string' || held.trim().length === 0) {
      throw new Error(`nothing is kept under ${key} in this session`);
    }
    return held;
  }

  if (typeof html === 'string' && html.trim().length > 0) {
    return html;
  }
  throw new Error(
    'there is no html to lay out: pass scratchpad with the name of the pad holding the page, ' +
      'or contentKey for a page something handed you, or html for a short one written out here',
  );
}

function keyedOnly(made) {
  if (made.key.length === 0) {
    return made;
  }
  return { ...made, base64: '' };
}

/**
 * One page drawn, kept, and answered - the half both surfaces share.
 *
 * The page is kept under a key of its own so it can be handed on without
 * being typed out, the same way everything else here travels.
 */
function drawnPage(base64, page, width) {
  const packed = typeof base64 === 'string' ? base64.replace(/\s+/g, '') : '';
  if (packed.length === 0) {
    throw new Error('there is no document to draw');
  }

  const asked = typeof page === 'number' && page > 0 ? page : 1;
  const drawn = orknux.render.pngFromPdf(
    packed,
    asked,
    typeof width === 'number' && width > 0 ? width : undefined,
  );
  if (drawn.error !== undefined) {
    throw new Error(`could not draw the page: ${drawn.error}`);
  }

  const key = keyFor(drawn.base64);
  const kept = orknux.session.store.put(key, drawn.base64);

  /*
   * `picture`, which is the name the server lifts out.
   *
   * A tool's answer reaches a model as text - the answer to a call is a `tool`
   * message and its content is a string - so base64 under any other name is
   * thousands of characters it can read and cannot see. Under this one the
   * server takes the bytes out, hangs them on a turn of their own as an image,
   * and leaves a sentence here instead. The whole point of drawing a page is
   * that something looks at it.
   */
  return {
    picture: drawn.base64,
    pictureType: 'image/png',
    bytes: drawn.bytes,
    width: drawn.width,
    height: drawn.height,
    pages: drawn.pages,
    key: kept.error === undefined ? key : '',
  };
}

/**
 * What a document says, over a range of its pages.
 *
 * The other half of `drawnPage`. That one answers how a page *looks*, which is
 * what you check a layout with; this answers what it *says*, which is what
 * something can act on - find the total in an invoice, quote a clause back,
 * decide whether a report is worth passing on.
 *
 * Reading order rather than layout: a `<section data-page="N">` per page and a
 * `<p>` per block, with the newlines inside a block folded to spaces because
 * those are where the page wrapped and not where a sentence ended. Columns and
 * tables are flattened, and anything positioned rather than written comes back
 * in the order it was written. For a question about arrangement, draw the page.
 */
function readText(base64, from, to) {
  const packed = typeof base64 === 'string' ? base64.replace(/\s+/g, '') : '';
  if (packed.length === 0) {
    throw new Error('there is no document to read');
  }

  const first = typeof from === 'number' && from > 0 ? from : undefined;
  const last = typeof to === 'number' && to > 0 ? to : undefined;

  const said = orknux.render.htmlFromPdf(packed, first, last);
  if (said.error !== undefined) {
    /*
     * The server's own sentence, which is the one worth having: it names the
     * real page count for a range past the end, and says how many characters
     * a document has when it is too long to hand over at once. Wrapping that
     * in something vaguer would throw away the only number that tells a
     * caller what range to ask for instead.
     */
    throw new Error(`could not read the document: ${said.error}`);
  }

  /*
   * Kept as well as answered, under a key, the way everything here that makes
   * something does - `slack_upload` takes a contentKey for text, so a document
   * read here reaches a channel as a snippet without passing through anybody.
   */
  const key = keyFor(said.html);
  const kept = orknux.session.store.put(key, said.html);

  return {
    html: said.html,
    characters: said.characters,
    pages: said.pages,
    from: said.from,
    to: said.to,
    key: kept.error === undefined ? key : '',
  };
}

export default class Pdf extends OrknuxPlugin {

  id() {
    return 'pdf';
  }

  apiVersion() {
    return 1;
  }

  parameters() {
    return [];
  }

  permissions() {
    // TextEncoder and friends, which jsPDF's unicode font machinery leans on.
    return ['TEXT_ENCODING'];
  }

  capabilities() {
    /*
     * Drawing a page, and only that.
     *
     * The writer, the layout, the renderer and the fonts are all inside this
     * file, so making a document asks the server for nothing. Looking at one
     * is the opposite: rasterising needs a rasteriser, and there is neither
     * one here nor the WebAssembly to bring one.
     *
     * Its own grant rather than RENDER_PNG, which this plugin does not want
     * and does not ask for. The reach is the same - nothing; markup and bytes
     * go out, bytes come back - but the parser is not, and an operator may
     * reasonably draw markup without handing documents to a PDF stack.
     *
     * Worth knowing when accepting it: this plugin asked for nothing at all
     * until `preview` existed.
     */
    return ['RENDER_PDF'];
  }

  /*
   * What a model has to know and was working out by trial.
   *
   * A run asked for "a pdf version of the diagram", tried a mermaid block,
   * got a render error, tried three more shapes of the same call, and told the
   * person PDFs were unavailable - having already produced one, successfully,
   * on the second attempt. Its own reasoning said it had no skill for this.
   * Nothing in that sequence was a bug in the plugin; it was a model with a
   * tool and no idea how the tool is meant to be used.
   */
  skills() {
    return [
      new OrknuxSkill({
        name: 'Making a PDF',
        description:
          'What pdf_fromHtml takes, what it will not take, what to do when a diagram will ' +
          'not draw, and how to look at a document or read one back.',
        content: `# Making a PDF

\`pdf_fromHtml\` takes HTML and answers a document. It is a report writer, not
a browser: it lays out text and draws diagrams, and ignores everything meant
for a screen.

## What it sets

Headings \`h1\`-\`h3\`, paragraphs, \`br\`, \`hr\`, \`ul\` and \`ol\` with nesting, \`b\`/\`strong\`,
and table cells run together as text. Entities are decoded. Every other tag is
ignored and its text kept, so unknown markup degrades to its content.

**No CSS, no images, no links.** A \`style\` attribute is not an error, it simply
does nothing. Do not spend a turn writing one.

**Latin alphabets only.** ASCII, Latin-1 and Latin Extended-A: Polish, Czech,
Hungarian, Turkish, Romanian, the Nordics, the Baltics. Cyrillic, Greek, CJK
and emoji come back blank, and the log says which characters were dropped.

## Diagrams

Put mermaid source in a \`<pre class="mermaid">\` block and it is drawn into the
page as vector art, sized to the column:

    <h2>How a delivery is handled</h2>
    <pre class="mermaid">
    flowchart LR
      A[Webhook] --> B{Verified?}
      B -->|yes| C[Describe]
    </pre>

Five kinds draw: \`flowchart\`/\`graph\`, \`sequenceDiagram\`, \`stateDiagram-v2\`,
\`classDiagram\`, \`erDiagram\`. Any other kind - \`pie\`, \`gantt\`, \`mindmap\` - is
refused by name.

## When a diagram will not draw

**The document is not lost, and the answer tells you what happened.** A diagram
that will not draw leaves a note in the page where it would have been, the rest
of the document is written normally, and \`problems\` in the answer says what was
left out.

**Read \`problems\` every time.** It is empty when nothing went wrong. When it is
not, say so - to whoever asked, in the message you send with the file. Handing
somebody a report as though it were whole, when a diagram is missing out of the
middle of it, is worse than any error.

If the diagram matters enough to try again, try **once**: simplify the source -
plain \`-->\` arrows, short labels, nothing exotic inside \`[...]\`. If that fails
too, send the document you already have and put the same information in a list
beside it. Say what was left out.

## Where it goes when it is done

**Into the message.** \`slack_uploadBinary\` with the key, and the document is in
the channel where whoever asked for it is already looking.

\`save_artifact\` puts a file on the orknux side instead. That is the right place
for something a later step of the same run picks up, and the wrong place for
anything a person is meant to read: reaching it means leaving the conversation
and going to find the run, which is a thing nobody does. A report saved as an
artifact and announced in a channel has not been delivered - it has been filed.

If you are about to announce a file rather than attach one, attach it instead.

## Look at it before you send it

\`pdf_preview(key, page)\` draws a page as a picture you can actually see.

\`problems\` reports what this plugin knew went wrong. **Layout goes wrong in
ways it cannot know** - a heading stranded at the foot of a page, a table that
ran off the side, a diagram crowding its column. None of that raises anything,
because nothing failed; the document is simply worse than you think it is.

So for anything going to a person rather than into a file: make it, preview
page one, look at it, then send it. Otherwise you are reporting that the report
is ready because that is what you *did*, not because that is what came *out*.

## Reading one

\`pdf_read(key)\` answers what a document **says**, as text - which is the call
to reach for when somebody sends you a PDF and asks a question about it. Take
the key from \`slack_readAttachment\`, or from \`pdf_fromHtml\` for one you made.

It answers reading order, not layout: a section per page, a paragraph per
block. Columns and tables are flattened, so \`read\` is the wrong call for *how
is this page arranged* - draw it and look instead.

Long documents are refused rather than truncated, and the refusal says how many
characters there were. Pass \`from\` and \`to\` to take it a range of pages at a
time; the answer says which range it read and how many pages there are in
total, so you know what to ask for next.

Do not call the tool a third time with a third shape of the same diagram. Two
failures mean the diagram rather than the call, and you are holding a document
worth sending either way.

## Getting it to somebody

The answer carries a **key**, not just bytes. Pass the key:

    pdf_fromHtml(html, title)  ->  { key: 'pdf.1k7e78y', pages: 2, bytes: 30887 }
    slack_uploadBinary(channel, 'report.pdf', 'pdf.1k7e78y', comment, threadTs)

\`slack_uploadBinary\` takes that key and nothing else - there is no argument to
put base64 in. A PDF is hundreds of thousands of characters and does not
survive being written back out by you; the key is a dozen characters and what
it names never leaves the server.

## Look at it before you send it

\`pdf_preview\` draws one page as a picture. Pass the key \`fromHtml\` answered,
the page, and a width if you want one:

    pdf_fromHtml(html, title)   ->  { key: 'pdf.1k7e78y', pages: 2, problems: [] }
    pdf_preview('pdf.1k7e78y', 1)  ->  { width: 595, height: 842, pages: 2, shown: true }

\`problems\` tells you what this plugin knows went wrong. Layout goes wrong in
ways it cannot know - a heading stranded at the foot of a page, a diagram
crowding its column, a table that ran off the side - and the only way to catch
that is to look. The picture does not come back as text: the server takes it
out of the answer and shows it to you as a picture,
because seeing it is the point.

Worth doing whenever the document is going to somebody who matters. Reporting
that a report is ready because you made one is not the same as reporting it
because you saw what came out.

## Before you start

Write the document first and the diagram second. The text is what somebody
reads; the diagram is what they look at afterwards.`,
      }),
    ];
  }

  /* What a written document comes back as. */
  objects() {
    return [
      new OrknuxObject({
        name: 'Reading',
        description: 'What a document says, over the pages that were read.',
        properties: [
          {
            name: 'html',
            kind: 'string',
            description:
              'The text in reading order - a <section data-page="N"> per page and a <p> per ' +
              'block. Text that was itself markup comes back escaped, so a document saying ' +
              '<script> reads as &lt;script&gt; rather than becoming one.',
          },
          {
            name: 'characters',
            kind: 'number',
            description:
              'How much text came back. Worth reading before deciding what to do with it: a ' +
              'long document is long here too.',
          },
          {
            name: 'pages',
            kind: 'number',
            description:
              'How many pages the whole document has - not how many were read. One call says ' +
              'both what this range held and how much more there is.',
          },
          {
            name: 'from',
            kind: 'number',
            description: 'The first page read, counting from one.',
          },
          {
            name: 'to',
            kind: 'number',
            description:
              'And the last. Where it is short of pages, there is more document to ask for.',
          },
          {
            name: 'key',
            kind: 'string',
            description:
              'Where this text is kept for the rest of this session. slack_upload takes it as ' +
              'contentKey, so a document read here reaches a channel as a snippet without being ' +
              'copied out and pasted back in. Empty where there was no session to keep it in.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'Preview',
        description: 'One page of a document, drawn so somebody can look at it.',
        properties: [
          {
            name: 'picture',
            kind: 'string',
            description:
              'The page as a picture, base64 - and the one field here the server takes out of the ' +
              'answer: it hangs the bytes on a turn of their own so a model can actually look at ' +
              'the page, and leaves a note where they were.',
          },
          {
            name: 'pictureType',
            kind: 'string',
            description: 'What kind of picture it is; always image/png, and what the server hangs it as.',
          },
          { name: 'bytes', kind: 'number', description: 'How large the picture is.' },
          { name: 'width', kind: 'number', description: 'The picture\'s width in pixels.' },
          { name: 'height', kind: 'number', description: 'And its height, which the page decides.' },
          {
            name: 'pages',
            kind: 'number',
            description:
              'How many pages the whole document has - not this page\'s number. One call says ' +
              'both that the page exists and how many more there are.',
          },
          {
            name: 'key',
            kind: 'string',
            description:
              'Where the picture is kept for the rest of this session. Hand it to ' +
              'slack_uploadBinary as contentKey to show somebody the page. Empty where there was ' +
              'no session to keep it in.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'Document',
        description: 'A PDF that was written.',
        properties: [
          {
            name: 'problems',
            kind: 'array',
            of: 'string',
            description:
              'What went wrong without stopping the document - a diagram that would not draw, ' +
              'characters the face cannot set. Empty when nothing did. A document came back ' +
              'either way, so this is the only place a caller learns that part of it is missing: ' +
              'read it, and say so rather than passing the file on as though it were whole.',
          },
          {
            name: 'base64',
            kind: 'string',
            description:
              'The file itself, as base64. A workflow node wanting the bytes reads this; anything ' +
              'putting the file somewhere passes the key below instead.',
          },
          { name: 'pages', kind: 'number', description: 'How many pages it came to.' },
          { name: 'bytes', kind: 'number', description: 'How large the file is, before base64.' },
          {
            name: 'key',
            kind: 'string',
            description:
              'Where this document is kept for the rest of this session. Hand it to ' +
              'slack_uploadBinary as contentKey - that is the only thing it takes - so the bytes ' +
              'never leave the server. Empty where there was no session to keep it in.',
          },
        ],
      }),
    ];
  }

  /* The agents' surface: the one call, fronted. A proxy, so everything stays the function's own. */
  /*
   * A tool of its own rather than a proxy: a PDF is tens of kilobytes of
   * base64, and a model reads every character of an answer on its way to the
   * key that names the same bytes on the server. The function keeps answering
   * both, for the workflow node that has no session to read a key from.
   */
  tools() {
    const document = this.functions().find((one) => one.name === 'fromHtml');
    return [
      new OrknuxTool({
        name: 'fromHtml',
        description:
          document.description +
          ' The answer carries the key and not the document itself: the bytes stay on the server ' +
          'and the key names them, so pass it to slack_uploadBinary as contentKey rather than ' +
          'looking for base64 here. Where there is no session to keep a document in, the base64 ' +
          'comes back instead, because then it is the only copy there is.' +
          ' Where the page is already in a scratchpad, pass scratchpad with its name and leave ' +
          'html out: the page is read here rather than typed through you, which is what stops a ' +
          'long report being cut off at your output limit. A contentKey works the same way, for ' +
          'a page something else handed you. Reading a pad and writing it back into html is the ' +
          'slow way and the way work gets lost.',
        params: [
          { name: 'html', type: 'string', required: false, default: '' },
          { name: 'scratchpad', type: 'string', required: false, default: '' },
          { name: 'contentKey', type: 'string', required: false, default: '' },
          { name: 'title', type: 'string', required: false, default: '' },
        ],
        returnType: document.returnType,
        /*
         * The page, from wherever it already is. Issue #495.
         *
         * A report an agent has just written lives in a scratchpad, and reading
         * it back to pass it in here sends the whole document through the model
         * twice - which costs the turn and, past the output limit, arrives cut
         * in half. The tool can read it itself; the function behind it goes on
         * taking html, for the workflow node that has no session to read from.
         */
        run: (html, scratchpad, contentKey, title) => {
          const page = pageFrom(html, scratchpad, contentKey);
          return keyedOnly(document.run(page, title));
        },
      }),

      /*
       * A tool of its own so that it takes a key and not a document.
       *
       * A PDF is hundreds of thousands of characters of base64, and an answer
       * reaches the next call by being written out again by whatever read it -
       * which is the one thing that does not survive. `fromHtml` answers a key
       * beside the document; this takes that key. The function behind it keeps
       * taking base64, for the workflow node that has no session and so never
       * had a key.
       *
       * What it answers is not stripped, and that is the difference from
       * everything else here: the picture is the point of asking.
       */
      new OrknuxTool({
        name: 'read',
        description:
          'Reads what a PDF says and answers it as text you can act on - find a total, quote a ' +
          'clause, decide whether a report is worth passing on. Pass contentKey: the key ' +
          'fromHtml answered beside a document it made, or the one slack_readAttachment gave ' +
          'you for a file somebody sent. There is deliberately no base64 argument, because a ' +
          'document typed into a tool call arrives a character wrong. from and to name a range ' +
          'of pages, counting from one, both optional - use them when a document is long, ' +
          'because 200,000 characters is the most one call returns and the refusal says how ' +
          'many there were. ' +
          'What comes back is reading order, not layout: a section per page, a paragraph per ' +
          'block, columns and tables flattened. For how a page is arranged rather than what it ' +
          'says, use preview and look at it.',
        params: [
          { name: 'contentKey', type: 'string' },
          { name: 'from', type: 'number', required: false, default: 0 },
          { name: 'to', type: 'number', required: false, default: 0 },
        ],
        returnType: 'Reading',
        run: (contentKey, from, to) => {
          if (typeof contentKey !== 'string' || contentKey.length === 0) {
            throw new Error(
              'read takes a contentKey, not a document: pass the key the answer that made or ' +
                'fetched it carried.',
            );
          }
          const held = orknux.session.store.get(contentKey);
          if (typeof held !== 'string' || held.length === 0) {
            throw new Error(
              `nothing is kept under ${contentKey} in this session: make or fetch the document ` +
                'again and pass the key that answer carried.',
            );
          }
          return readText(held, from, to);
        },
      }),

      new OrknuxTool({
        name: 'preview',
        description:
          'Draws one page of a PDF as a picture, so you can see what a document actually came ' +
          'out as. Pass contentKey - the key fromHtml answered beside the document - and the ' +
          'page, counting from one; a page past the end is refused by name. width is the ' +
          'picture in pixels, left out for 96 dpi. There is deliberately no base64 argument: a ' +
          'document written into a tool call arrives a character wrong and the call is rejected ' +
          'before anything runs. Answers the picture, its size, how many pages the document has, ' +
          'and a key for the picture itself - give that to slack_uploadBinary to show somebody. ' +
          'Worth doing before you send a document to anybody: problems says what this plugin ' +
          'knows went wrong, and layout goes wrong in ways it cannot know.',
        params: [
          { name: 'contentKey', type: 'string' },
          { name: 'page', type: 'number', required: false, default: 1 },
          { name: 'width', type: 'number', required: false, default: 0 },
        ],
        returnType: 'Preview',
        run: (contentKey, page, width) => {
          if (typeof contentKey !== 'string' || contentKey.length === 0) {
            throw new Error(
              'preview takes a contentKey, not a document: make the PDF first and pass the key ' +
                'that answer carried.',
            );
          }
          const held = orknux.session.store.get(contentKey);
          if (typeof held !== 'string' || held.length === 0) {
            throw new Error(
              `nothing is kept under ${contentKey} in this session: make the document again and ` +
                'pass the key that answer carried.',
            );
          }
          return drawnPage(held, page, width);
        },
      }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'read',
        description:
          'Reads what a PDF says and answers it as text. Pass the document as base64 - which is ' +
          'what fromHtml answered - and optionally from and to, a range of pages counting from ' +
          'one. What comes back is reading order rather than layout: a <section data-page="N"> ' +
          'per page and a <p> per block, with the line breaks inside a block folded away because ' +
          'those are where the page wrapped and not where a sentence ended. Columns and tables ' +
          'are flattened, so for a question about how a page is arranged use preview and look at ' +
          'it instead. 200,000 characters is the most one call returns; past that it is refused ' +
          'with the number, and a range of pages is the way through. Answers the text, how much ' +
          'of it there is, how many pages the whole document has, the range actually read, and a ' +
          'key the text is kept under - slack_upload takes that as contentKey.',
        params: [
          { name: 'base64', type: 'string' },
          { name: 'from', type: 'number', required: false, default: 0 },
          { name: 'to', type: 'number', required: false, default: 0 },
        ],
        returnType: 'Reading',
        run: (base64, from, to) => readText(base64, from, to),
      }),

      new OrknuxFunction({
        name: 'preview',
        description:
          'Draws one page of a PDF as a picture, so you can see what a document actually came ' +
          'out as. Pass the document as base64 and the page, counting from one - a page past the ' +
          'end is refused by name rather than rounded into the first - and a width in pixels, ' +
          'left out for 96 dpi. The page is shown to you as a picture rather than answered as ' +
          'text; what comes back is its width and height, how many pages the whole document has, ' +
          'and a key the picture is kept under for this session - hand that to slack_uploadBinary ' +
          'to show somebody the page. ' +
          'Use it on what fromHtml just made: problems tells you what went wrong that this plugin ' +
          'knows about, and layout goes wrong in ways it does not - a heading stranded at the ' +
          'foot of a page, a diagram crowding its column, a table that ran off the side.',
        params: [
          { name: 'base64', type: 'string' },
          { name: 'page', type: 'number', required: false, default: 1 },
          { name: 'width', type: 'number', required: false, default: 0 },
        ],
        returnType: 'Preview',
        run: (base64, page, width) => drawnPage(base64, page, width),
      }),

      new OrknuxFunction({
        name: 'fromHtml',
        description:
          'Lays HTML out as a PDF on A4: h1-h3, p, br, hr, ul/ol lists, b/strong - and mermaid ' +
          'diagrams, drawn into the page as vectors: put the diagram source in <pre ' +
          'class="mermaid">...</pre> (flowchart/graph, sequenceDiagram, stateDiagram-v2, ' +
          'classDiagram, erDiagram). Latin alphabets with their diacritics - Polish, Czech, ' +
          'Hungarian, Turkish, Romanian, the Nordics and Baltics - set in DejaVu, carried ' +
          'subset to exactly that; Cyrillic, Greek, CJK and emoji are not set and come back ' +
          'blank. A ' +
          'report writer, not a browser: no CSS, no raster images, no links; i/em render regular. ' +
          'Answers problems - what went wrong without stopping the document, empty when nothing ' +
          'did, and the only place you will learn a diagram was left out - the file as base64, ' +
          'its page and byte counts, and a short key it is kept ' +
          'under for this session - hand THAT to slack_uploadBinary as contentKey with a .pdf ' +
          'filename, never the base64, which does not survive being written back out - with ' +
          'its page and byte counts. title is the document\'s title metadata.',
        params: [
          { name: 'html', type: 'string' },
          { name: 'title', type: 'string', required: false, default: '' },
        ],
        returnType: 'Document',
        run: (html, title) => {
          if (typeof html !== 'string' || html.trim().length === 0) {
            throw new Error('there is no html to lay out');
          }
          /*
           * What went wrong without stopping the document.
           *
           * Answered, not only drawn and logged. A note in the page is for
           * whoever reads the PDF; the log is for whoever runs the server;
           * neither is read by the thing that called this. An answer that
           * looks like success while something in it silently did not happen
           * is the worst of the three outcomes - so it comes back in the
           * answer, where the caller cannot miss it.
           */
          const problems = [];

          const blocks = blocksOf(html);
          if (!blocks.some((block) => block.kind === 'hr' || block.kind === 'diagram' || block.runs.length > 0)) {
            throw new Error('the html holds no text to lay out');
          }

          const doc = new jsPDF({ unit: 'pt', format: 'a4' });

          /*
           * DejaVu only where a document actually needs it.
           *
           * The two faces are 1.4 MB of TTF, and jsPDF parses and writes both
           * into every file that asks for them: a page of English cost 277 kB
           * and most of the time spent making it. That is affordable in a
           * browser and is not here - the sandbox interprets, and a call that
           * took 74 ms in node was timing out at ten seconds.
           *
           * So the alphabet decides. Anything past ASCII needs DejaVu, because
           * the built-in faces would fold ą to a; everything else is set in
           * Helvetica, which jsPDF has and embeds nothing for - three
           * kilobytes instead of two hundred and seventy-seven, and no font
           * parsed at all.
           *
           * Tested on what was laid out rather than on the html, because the
           * html is not what gets set: an entity is ASCII in the source and a
           * letter on the page. See textOf.
           */
          const text = textOf(blocks);
          const unsettable = noteUnsettable(text);
          if (unsettable !== '') {
            problems.push(unsettable);
          }

          if (/[^\u0000-\u007f]/.test(text)) {
            doc.orknuxFace = 'DejaVu';
            doc.addFileToVFS('DejaVuSans.ttf', DEJAVU);
            doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
            doc.addFileToVFS('DejaVuSans-Bold.ttf', DEJAVU_BOLD);
            doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
          } else {
            doc.orknuxFace = 'helvetica';
          }
          if (typeof title === 'string' && title.length > 0) {
            doc.setProperties({ title: title });
          }

          const top = PAGE.margin;
          const bottom = PAGE.height - PAGE.margin;
          const usable = PAGE.width - PAGE.margin * 2;
          let y = top;

          const carry = () => {
            doc.addPage();
            y = top;
          };

          for (const block of blocks) {
            if (block.kind === 'hr') {
              if (y + 18 > bottom) {
                carry();
              }
              y += 10;
              doc.setDrawColor(160, 160, 160);
              doc.setLineWidth(0.5);
              doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
              y += 8;
              continue;
            }

            if (block.kind === 'diagram') {
              let svg;
              try {
                svg = renderMermaidSync(block.source);
              } catch (failure) {
                /*
                 * The diagram is lost; the document is not.
                 *
                 * This used to throw, which meant one bad diagram cost the
                 * whole call - and what a caller did with that was call again
                 * with the diagram written a slightly different way, three or
                 * four times, before telling somebody PDFs were unavailable.
                 * It had already been handed a working document on the second
                 * attempt and thrown it away.
                 *
                 * So the page says what happened, where the drawing would
                 * have been, and the rest of the document is written. A report
                 * with a note in it beats no report, and the note is visible
                 * rather than silent: whoever reads the PDF can see that a
                 * diagram was meant to be there.
                 */
                const said = failure instanceof Error ? failure.message : String(failure);
                orknux.log.warn(`a diagram could not be drawn and was left out: ${said}`);
                problems.push(`a diagram was not drawn: ${said}`);

                const note = `[diagram not drawn: ${said}]`;
                doc.setFont(faceOf(doc), 'normal');
                doc.setFontSize(STYLES.p.size);
                doc.setTextColor(120, 120, 120);
                for (const line of doc.splitTextToSize(note, usable)) {
                  if (y > bottom) {
                    carry();
                    y = top + STYLES.p.size * 1.4;
                  }
                  doc.text(line, PAGE.margin, y);
                  y += STYLES.p.size * 1.4;
                }
                y += STYLES.p.after;
                continue;
              }
              /*
               * Sized before placed — the size is on the SVG root, no drawing
               * needed to know it. A diagram taller than what is left of the
               * page starts a fresh one, and one taller than a whole page is
               * scaled to fit it.
               */
              const room = bottom - top;
              const sized = svgSize(svg);
              const claimed = sized.height * Math.min(1, usable / sized.width, room / sized.height);
              if (y + claimed > bottom) {
                carry();
              }
              y += 4;
              drawnDiagram(doc, svg, PAGE.margin, y, usable, room);
              y += claimed + 12;
              continue;
            }

            const style = STYLES[block.kind];
            const indent = block.kind === 'item' ? block.depth * 16 : 0;
            const left = PAGE.margin + indent;
            const leading = style.size * 1.4;
            const lines = linesOf(doc, wordsOf(doc, block, style), style, usable - indent);

            if (y !== top) {
              y += style.before;
            }
            for (let index = 0; index < lines.length; index++) {
              y += leading;
              if (y > bottom) {
                carry();
                y = top + leading;
              }
              doc.setTextColor(39, 39, 42);
              if (index === 0 && block.marker !== null) {
                doc.setFont(faceOf(doc), 'normal');
                doc.setFontSize(style.size);
                const wide = doc.getTextWidth(block.marker);
                doc.text(block.marker, left - wide - 5, y);
              }
              for (const part of lines[index]) {
                doc.setFont(faceOf(doc), part.bold ? 'bold' : 'normal');
                doc.setFontSize(style.size);
                doc.text(part.text, left + part.x, y);
              }
            }
            y += style.after;
          }

          const bytes = new Uint8Array(doc.output('arraybuffer'));
          const encoded = base64Of(bytes);

          /*
           * Kept as well as answered, and the keeping is the half that matters.
           *
           * A PDF is tens of kilobytes of base64, and an answer reaches the
           * next tool call by being written out again by whatever read it.
           * That does not survive: one arrived a character wrong and the call
           * was rejected as malformed before anything ran. `slack_uploadBinary`
           * takes the key and nothing else now, which is why this has to
           * answer one.
           */
          const key = keyFor(encoded);
          const kept = orknux.session.store.put(key, encoded);

          return {
            problems: problems,
            base64: encoded,
            pages: doc.getNumberOfPages(),
            bytes: bytes.length,
            // Empty outside a session, which is exactly when base64 above is
            // the only copy there is - and when a workflow node is the caller.
            key: kept.error === undefined ? key : '',
          };
        },
      }),
    ];
  }
}
