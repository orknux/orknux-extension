import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { bundle, inspect } from '../dist/tooling.js';

/**
 * That everything declared is also read.
 *
 * `inspect` is the read half of the mirror: it loads a built plugin, calls
 * every declaration method, and hands back an `Inspection`. Everything
 * downstream — `validate`, the CLI, the packer, most of these tests — reads
 * that `Inspection` rather than the plugin. So a field `inspect` does not copy
 * is a field that does not exist downstream, however carefully the rule for it
 * was written: the check can never fire on a real plugin, only on a
 * declaration a unit test hand-built.
 *
 * That has now happened five times — `skills`, `objects`, `options`, the pair
 * `required`/`default`, and a parameter's `description` — each landing in the
 * contract, in `validate`, and in a passing test suite, while being dropped on
 * the way in. Each was found by accident. These two tests are what finds the
 * sixth on purpose.
 */

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const source = new URL('../src/', import.meta.url);

async function inspected(fixture) {
  const directory = await mkdtemp(join(tmpdir(), 'orknux-mirror-'));
  const outfile = join(directory, 'plugin.js');
  await bundle({ entry: join(fixtures, fixture), outfile });
  return inspect(outfile);
}

test('every optional field a plugin may declare survives being inspected', async () => {
  const seen = await inspected('declaring.js');

  /* A function: its own description, and a parameter carrying all three. */
  const described = seen.functions.find((one) => one.name === 'described');
  assert.equal(described.description, 'A function with a description and an optional parameter.');
  assert.deepEqual(described.params, [
    { name: 'text', type: 'string', description: 'A parameter that says what it holds.' },
    { name: 'limit', type: 'number', required: false, default: 20 },
  ]);

  /* A tool of its own, whose parameters are read by the second reader. */
  const standalone = seen.tools.find((one) => one.name === 'standalone');
  assert.equal(standalone.proxyOf, null);
  assert.deepEqual(standalone.params, [
    { name: 'text', type: 'string', description: 'What to say.' },
    { name: 'loudly', type: 'boolean', required: false, default: false },
  ]);

  /* A proxy, which takes the function's parameters rather than declaring any. */
  const fronted = seen.tools.find((one) => one.proxyOf === 'described');
  assert.deepEqual(fronted.params, described.params);

  /* Plugin parameters: options, secret and connectionType are three fields. */
  const byName = new Map(seen.parameters.map((one) => [one.name, one]));
  assert.deepEqual(byName.get('chosen').options, ['one', 'two']);
  assert.equal(byName.get('token').secret, true);
  assert.equal(byName.get('slack').connectionType, 'SLACK');
  assert.equal(byName.get('chosen').description, 'A parameter that names its values.');

  /* Skills, objects — including a property that points — and libraries. */
  assert.deepEqual(seen.skills, [
    {
      name: 'Doing the thing',
      /* The id a plugin pinned rather than letting the server derive one. */
      id: 'doing-the-thing',
      description: 'What a skill looks like with all three of its fields filled in.',
      /* Trimmed, as every string the loader reads is. */
      content: '# Doing the thing\n\nThere is nothing to do.',
    },
  ]);
  const shape = seen.objects.find((one) => one.name === 'Shape');
  assert.equal(shape.description, 'A shape covering every kind of property, including one that points.');
  assert.deepEqual(shape.properties.at(-1), {
    name: 'nested',
    kind: 'array',
    of: 'Inner',
    description: 'One that points.',
  });
  assert.deepEqual(seen.libraries, ['lib/nothing.js']);

  /* An action: a label, a described array parameter, an optional one, and an output. */
  assert.deepEqual(seen.actions, [
    {
      name: 'described',
      label: 'An action with everything filled in',
      description: 'An action with a description, an optional parameter and declared outputs.',
      parameters: [
        { name: 'commands', type: 'array', description: 'A list, which arrives as one.' },
        { name: 'note', type: 'string', required: false, description: null },
      ],
      outputs: [{ name: 'count', type: 'number', description: 'How many arrived.' }],
    },
  ]);

  /* A kind of host, and a parameter naming it by its bare name. */
  assert.deepEqual(seen.connectionTypes, [
    {
      name: 'server',
      label: 'A server',
      description: 'A kind of host with everything filled in.',
      urlPlaceholder: 'https://server.example.com',
    },
  ]);
  assert.equal(seen.parameters.find((one) => one.name === 'host').connectionType, 'server');
});

test('no field is declared in the contract that inspect has no line for', async () => {
  /*
   * The textual half, and deliberately crude: it asks only whether the field's
   * name appears in the reader at all. It is the cheap net under the test
   * above, and it catches a different thing — a field added to the contract
   * with no fixture written for it, which the round trip by definition cannot
   * see.
   *
   * Its limit is worth stating rather than discovering: a name another shape
   * already uses is invisible to it. Of the six fields that have gone missing,
   * this would have caught `skills`, `objects`, `options` and `default`, and
   * not `required` or `description` — both of which `DeclaredParameter` was
   * already using when `DeclaredParam` grew them. Those are the round trip's.
   *
   * A false positive here is a field named in `validate.ts` that genuinely has
   * nothing to read — add it to `ignored` with the reason, rather than
   * loosening the match.
   */
  const declares = await readFile(new URL('validate.ts', source), 'utf8');
  const reads = await readFile(new URL('inspect.ts', source), 'utf8');

  const ignored = new Set([
    /* Not a field of its own: the loader resolves a proxy's params from the
     * function it fronts, and `properties`/`params` are read as arrays. */
  ]);

  const shapes = [...declares.matchAll(/export interface (Declared\w+) \{([\s\S]*?)\n\}/g)];
  assert.ok(shapes.length >= 7, `expected the Declared* interfaces, found ${shapes.length}`);

  const missing = [];
  for (const [, shape, body] of shapes) {
    for (const [, field] of body.matchAll(/^ {2}(\w+)\??:/gm)) {
      if (ignored.has(field)) continue;
      if (new RegExp(`['"]${field}['"]|\\b${field}:`).test(reads)) continue;
      missing.push(`${shape}.${field}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `inspect.ts has no line for: ${missing.join(', ')} — a declared field nothing reads is inert`,
  );
});
