/*
 * Writes every plugin's icons — two of each, and that is the point.
 *
 * ## Why two, rather than one in `currentColor`
 *
 * These files were `currentColor` until it was pointed out that a marketplace
 * almost certainly renders one with `<img src="icon.svg">`. An SVG loaded that
 * way is *its own document*: it inherits no `color` from the page around it,
 * so `currentColor` resolves to the initial value — black — and a black glyph
 * on a dark listing is an empty square. `currentColor` only ever worked
 * because the page I was checking it on inlined the markup.
 *
 * So each plugin gets an explicit pair:
 *
 *   icon.svg        the dark glyph, for a light listing — what a manifest names
 *   icon-white.svg  the same glyph in white, for a dark one
 *
 * Both carry a real colour on a fill or a stroke attribute, which survives
 * whatever sanitizing a marketplace does to uploaded markup and needs nothing
 * from the page. Whoever shows a listing picks the one that suits its ground.
 *
 * ## Where the marks come from
 *
 * [simple-icons] is CC0 — the collection is public domain, each trademark stays
 * its owner's, and using one here is the use trademark law has always allowed:
 * saying what a plugin works with.
 *
 * [Font Awesome Free] is **CC BY 4.0**, which is why every file written from it
 * carries the attribution in a comment. It is here for the two marks
 * simple-icons will not carry: Slack asked for theirs to be removed, and
 * Microsoft's went the same way. What Font Awesome publishes is its own
 * monochrome rendering of each, under a licence that permits redistributing it
 * — these are *Font Awesome's glyphs of* those marks rather than assets from
 * the vendors' own brand portals, and the difference is worth stating. Anyone
 * wanting the exact artwork should take it from those portals under those
 * companies' terms and write it over these files.
 *
 * `teams` wears the Microsoft mark, because no Teams-specific glyph is
 * published.
 *
 * Every plugin left wears a real mark, so nothing is hand-drawn here now — but
 * the table for it stays, because a plugin fronting no service belongs in this
 * file too, so that every icon in the repository comes out of one place and
 * every one of them has both variants.
 *
 *     docker compose run --rm dev npm run build:icons --workspace @orknux/plugins
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as simple from 'simple-icons';
import * as brands from '@fortawesome/free-brands-svg-icons';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The two colours, and the files they are written to. */
const VARIANTS = [
  { file: 'icon.svg', colour: '#1E232B', for: 'a light listing' },
  { file: 'icon-white.svg', colour: '#FFFFFF', for: 'a dark listing' },
];

/** What CC BY 4.0 asks in return, carried in every file it applies to. */
const ATTRIBUTION = 'Font Awesome Free (https://fontawesome.com) — icons licensed CC BY 4.0.';

/** Which plugin wears which mark, and out of which collection. */
const BRANDED = [
  { plugin: 'github', from: 'simple', icon: 'siGithub' },
  { plugin: 'confluence', from: 'simple', icon: 'siConfluence' },
  { plugin: 'jira', from: 'simple', icon: 'siJira' },
  { plugin: 'jenkins', from: 'simple', icon: 'siJenkins' },
  { plugin: 'prometheus', from: 'simple', icon: 'siPrometheus' },
  { plugin: 'slack', from: 'brands', icon: 'faSlack' },
  { plugin: 'teams', from: 'brands', icon: 'faMicrosoft' },
];

/** A collection's own spelling of a name is not always the one to show. */
const TITLES = { slack: 'Slack', microsoft: 'Microsoft' };

/**
 * The ones with nothing to borrow, drawn as strokes rather than filled paths —
 * which is why they would carry their weight and caps with them.
 *
 * Empty today: every plugin left fronts a service with a mark. The loop below
 * stays because the next plugin without one belongs here rather than having a
 * hand-written file beside it, which is how an icon ends up with one variant.
 */
const DRAWN = [];

/** One mark, however its collection spells one. */
function markOf({ from, icon }) {
  if (from === 'simple') {
    const found = simple[icon];
    if (found === undefined) {
      throw new Error(`simple-icons no longer publishes ${icon} — see the note above`);
    }
    return { title: found.title, viewBox: '0 0 24 24', path: found.path, source: found.source, notice: null };
  }

  const found = brands[icon];
  if (found === undefined) {
    throw new Error(`Font Awesome no longer publishes ${icon} — see the note above`);
  }
  /* Font Awesome packs an icon as [width, height, ligatures, unicode, path]. */
  const [width, height, , , path] = found.icon;
  return {
    title: TITLES[found.iconName] ?? found.iconName,
    viewBox: `0 0 ${width} ${height}`,
    path: Array.isArray(path) ? path[0] : path,
    source: `https://fontawesome.com/icons/${found.iconName}?f=brands`,
    notice: ATTRIBUTION,
  };
}

/** Writes one plugin's pair, given something that renders a body per colour. */
function write(plugin, header, viewBox, body) {
  for (const variant of VARIANTS) {
    const svg = `<!--
${header(variant)}
  Regenerate with plugins/icons.mjs; do not hand-edit.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="24" height="24" role="img">
${body(variant)}
</svg>
`;
    writeFileSync(`${here}${plugin}/${variant.file}`, svg);
  }
  console.log(`${plugin}/`.padEnd(13) + 'icon.svg + icon-white.svg');
}

for (const entry of BRANDED) {
  const mark = markOf(entry);
  write(
    entry.plugin,
    (variant) =>
      `  The ${mark.title} mark, for ${variant.for}: ${mark.source}\n` +
      `  The trademark remains ${mark.title}'s own, shown here to say what this\n` +
      `  plugin works with.${mark.notice === null ? '' : `\n  ${mark.notice}`}`,
    mark.viewBox,
    (variant) => `  <title>${mark.title}</title>\n  <path fill="${variant.colour}" d="${mark.path}"/>`,
  );
}

for (const drawn of DRAWN) {
  write(
    drawn.plugin,
    (variant) => `  ${drawn.title}, for ${variant.for}. Drawn here; it fronts no service and has no mark.`,
    '0 0 24 24',
    (variant) =>
      `  <title>${drawn.title}</title>\n` +
      `  <g fill="none" stroke="${variant.colour}" stroke-width="1.75" ` +
      `stroke-linecap="round" stroke-linejoin="round">\n` +
      drawn.paths.map((path) => `    <path d="${path}"/>`).join('\n') +
      '\n  </g>',
  );
}
