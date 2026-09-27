import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspect } from '../dist/tooling.js';

/**
 * Every shipped plugin's marketplace manifest, held to the shape the
 * marketplace's own schema describes — `plugins/plugin.schema.json`, which is
 * that service's file, copied here for editors and for this.
 *
 * The marketplace reads prose and checks one claim: that `key` is what `id()`
 * answers, because a listing keyed differently from the code is a listing
 * that installs as something else. That check is the reason this file exists;
 * it costs nothing here and catches a rename that would otherwise be found by
 * somebody installing the wrong thing.
 *
 * The rest is what a manifest cannot be trusted to get right on its own: the
 * files it names have to be there, because `descriptionPath` pointing at a
 * README nobody wrote is a listing with an empty details pane.
 *
 * There is nothing above these to agree with. A plugin is described in its own
 * folder and nowhere else — no catalog listing the offerings a second time —
 * so what is on offer is whatever carries a `plugin.json`, and this walks the
 * same directories a reader would.
 */

const root = fileURLToPath(new URL('../../plugins/', import.meta.url));

/**
 * Every directory under `plugins/` is a plugin; the loose files beside them
 * are not, and neither is `dist/` — that is where `pack.mjs` writes the zips,
 * it is ignored by git, and it is only there at all on a machine that has
 * packed something.
 */
const BUILT_OUTPUT = 'dist';

const shipped = readdirSync(root).filter((name) => {
  if (name === BUILT_OUTPUT) {
    return false;
  }
  try {
    return statSync(root + name).isDirectory();
  } catch {
    return false;
  }
});

/** The pattern the schema holds `key` to. */
const KEY = /^[a-z][a-z0-9-]{1,63}$/;

test('every plugin ships a manifest, and there is one to copy', () => {
  assert.ok(shipped.length > 0, 'no plugins found');
  for (const name of shipped) {
    const held = readdirSync(root + name);
    assert.ok(held.includes('plugin.json'), `${name} has no plugin.json`);
    /*
     * `plugin.json` and no variation of it. The marketplace reads that one
     * name, so a folder carrying a second spelling is a plugin describing
     * itself twice with nobody able to say which was read.
     */
    for (const variant of ['marketplace.json', 'orknux.json']) {
      assert.ok(!held.includes(variant), `${name} carries a ${variant}; the name is plugin.json`);
    }
  }
  /* The schema itself and a filled-in example, for a plugin written next. */
  const beside = readdirSync(root);
  assert.ok(beside.includes('plugin.schema.json'), 'the schema is not beside the plugins');
  assert.ok(beside.includes('plugin.example.json'), 'there is no example to copy');
});

for (const name of shipped) {
  test(`the ${name} manifest says what the marketplace would take`, async () => {
    const manifest = JSON.parse(readFileSync(`${root}${name}/plugin.json`, 'utf8'));

    /* Required, and shaped, as the schema has it. */
    for (const field of ['key', 'name', 'summary', 'version']) {
      assert.equal(typeof manifest[field], 'string', `${field} is missing`);
      assert.ok(manifest[field].length > 0, `${field} is empty`);
    }
    assert.match(manifest.key, KEY);
    assert.ok(manifest.name.length <= 120, 'name is longer than the schema allows');
    assert.ok(manifest.summary.length <= 300, 'summary is longer than the schema allows');
    assert.ok(manifest.version.length <= 32, 'version is longer than the schema allows');
    if (manifest.author !== undefined) {
      assert.ok(manifest.author.length <= 120, 'author is longer than the schema allows');
    }

    /*
     * No manifest here writes `notes`.
     *
     * The field is gone from the descriptor schema: release notes come with
     * the publish - the field beside the zip on /api/plugins, which this
     * repository's workflow fills from the commit that set the version - and
     * a `notes` key left in a descriptor is now ignored rather than used.
     *
     * So this no longer guards against a manifest quietly beating the commit;
     * it guards against a line that looks like it does something and does
     * not. A note typed here would go out on nothing, and the release it was
     * written for would carry the commit's words instead - which is the worse
     * failure of the two, because it looks like it worked.
     */
    assert.equal(
      manifest.notes,
      undefined,
      `${name} writes its own notes, which the marketplace no longer reads`,
    );

    /*
     * `path` names the file the server loads. Where a plugin is a build, its
     * source sits in `src/` under the same name — so this is the one field
     * that keeps an archive from being published with the unbundled source,
     * which imports libraries and could not load at all.
     */
    const file = manifest.path ?? `${name}.js`;
    const held = readdirSync(root + name);
    assert.ok(held.includes(file), `${file} is not there to load`);

    /* The one claim the marketplace checks against the code. */
    const inspected = await inspect(`${root}${name}/${file}`);

    /*
     * A skill is prose an agent reads rather than a name anything calls, so
     * what can be checked is that it would survive the trip: within the
     * server's bounds, and carrying a description — which is the line a model
     * chooses from before it loads the page at all, so a skill without one is
     * a page nobody opens.
     */
    assert.ok(inspected.skills.length <= 25, `${name} brings more skills than the server takes`);
    for (const skill of inspected.skills) {
      assert.ok(skill.name.length > 0 && skill.name.length <= 120, `a skill of ${name} is badly named`);
      assert.ok(
        typeof skill.description === 'string' && skill.description.length > 0,
        `the ${name} skill "${skill.name}" has no description to be chosen by`,
      );
      assert.ok(
        skill.content.length > 0 && skill.content.length <= 64 * 1024,
        `the ${name} skill "${skill.name}" is empty or longer than the server takes`,
      );
      /*
       * Written without frontmatter on purpose: the server writes the block
       * from the name and description above, and stating the same two facts
       * twice is how they drift apart.
       */
      assert.ok(!skill.content.startsWith('---'), `the ${name} skill "${skill.name}" writes its own frontmatter`);
    }
    assert.equal(
      manifest.key,
      inspected.id,
      `the manifest says ${manifest.key} and the code answers ${inspected.id}`,
    );

    /* And the description it names has to exist, or the listing has none. */
    const described = manifest.descriptionPath ?? 'README.md';
    assert.ok(held.includes(described), `${described} is named but not there`);
    assert.ok(
      readFileSync(`${root}${name}/${described}`, 'utf8').trim().length > 0,
      `${described} is empty`,
    );

    /*
     * An icon may be an emoji standing as itself, a URL, or an SVG in the
     * archive — and where it is the third, there are two of them: the named
     * one for a light ground and a `-white` twin for a dark one. The
     * marketplace finds the second by that suffix, so a plugin shipping only
     * the first would go dark-listed in black.
     */
    const icon = manifest.icon;
    if (typeof icon === 'string') {
      assert.ok(icon.length <= 400, 'icon is longer than the schema allows');
      if (icon.endsWith('.svg') && !/^(https?|data):/.test(icon)) {
        const white = icon.replace(/\.svg$/, '-white.svg');
        assert.ok(held.includes(icon), `${icon} is named but not there`);
        assert.ok(held.includes(white), `${name} has no ${white} for a dark listing`);

        for (const each of [icon, white]) {
          const drawn = readFileSync(`${root}${name}/${each}`, 'utf8');
          assert.match(drawn, /<svg[\s>]/, `${each} is not an svg`);
          /*
           * A real colour, never `currentColor`. An SVG loaded through an
           * `<img>` is its own document and inherits none, so `currentColor`
           * resolves to black — which is an empty square on a dark listing,
           * and is exactly why there are two files.
           */
          assert.doesNotMatch(drawn, /currentColor/, `${each} relies on currentColor, which <img> does not give it`);
          assert.match(drawn, /(fill|stroke)="#[0-9A-Fa-f]{3,8}"/, `${each} declares no colour of its own`);
        }
      }
    }
  });
}
