import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What `check` actually prints.
 *
 * The report is the whole product of the CLI: somebody runs it to see what an
 * upload would see, and a surface the plugin declares but the report leaves out
 * is one they find out about from an administrator instead. That is exactly how
 * libraries, skills and objects went missing — they landed in the contract, in
 * the validation and in the tests, and nothing ever asked the CLI to show them.
 *
 * So this runs the real binary, the way a person does, and reads what came back.
 */

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const shipped = (name) =>
  fileURLToPath(new URL(`../../plugins/${name}/${name}.js`, import.meta.url));

/** The report for one plugin, or the report of why it was refused. */
function checked(file) {
  try {
    return execFileSync(process.execPath, [cli, 'check', file], { encoding: 'utf8' });
  } catch (failure) {
    /* A refusal exits non-zero and still prints; the caller decides. */
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
}

test('the report names the libraries that travel with a plugin', () => {
  const report = checked(shipped('github'));

  assert.match(report, /It ships with:/);
  assert.match(report, /lib\/api\.js/);
  /* And still says the rest of what it always said. */
  assert.match(report, /Loading it means accepting: TEXT_ENCODING, NETWORK_REQUEST/);
  assert.match(report, /github_searchPulls/);
});

test('the report names the workflow actions a plugin offers, label first', () => {
  const report = checked(shipped('slack'));

  assert.match(report, /It offers workflows these actions:/);
  /* The label is what the picker shows; the inputs and outputs are how a node wires it. */
  assert.match(
    report,
    /Respond in Slack {2}\(respond: commands: array, channel: string, threadTs\?: string, text: string\) -> ts: string, channel: string/,
  );
});

test('the report names the skills a plugin brings, and what each is for', () => {
  const report = checked(shipped('github'));

  assert.match(report, /It teaches:/);
  assert.match(report, /Reviewing a pull request/);
  /* The description is the line an agent chooses from, so it earns a line here too. */
  assert.match(report, /How to read a PR properly before saying anything about it/);
  /*
   * The content is not printed. A skill runs to sixty-four thousand
   * characters and this is a report — the size stands in for it.
   */
  assert.doesNotMatch(report, /## Read the whole thing first/);
});

test('the report shows the id of a skill that pinned one', () => {
  /*
   * The string everything else writes down - a graph naming skills to load, a
   * message carrying the command marker, `skill_load` being asked for one - so
   * somebody checking a plugin before an upload has to be able to read it back.
   * It was declared, validated and then dropped by `inspect`, which is the one
   * place that makes a rule unreachable; see mirror.test.js.
   */
  const report = checked(shipped('slack'));

  assert.match(report, /New Slack Thread {2}\[new-thread] {2}\(/);
  /* Including the one whose id had to stay what it was when the page was split. */
  assert.match(report, /Posting to Slack so people read it {2}\[posting-to-slack-so-people-read-it]/);
});

test('the report names the shapes a plugin exports, qualified as they are stored', () => {
  /*
   * Nothing shipped declares objects yet, so this writes one — which is also
   * the only way to see that `of` is printed, and that is the half of a
   * property worth seeing.
   */
  const where = mkdtempSync(join(tmpdir(), 'shapes-'));
  const file = join(where, 'shapes.js');
  writeFileSync(
    file,
    `export default class Shapes extends OrknuxPlugin {
       id() { return 'shapes'; }
       apiVersion() { return 1; }
       objects() {
         return [
           new OrknuxObject({ name: 'User', properties: [{ name: 'email', kind: 'string' }] }),
           new OrknuxObject({
             name: 'Issue',
             properties: [
               { name: 'key', kind: 'string' },
               { name: 'labels', kind: 'array', of: 'string' },
               { name: 'reporter', kind: 'object', of: 'User' },
             ],
           }),
         ];
       }
       functions() {
         return [new OrknuxFunction({ name: 'ping', description: 'x', returnType: 'boolean', run: () => true })];
       }
     }`,
  );

  const report = checked(file);

  assert.match(report, /It exports these shapes:/);
  /* Under the plugin's key, because that is how they arrive in a workspace. */
  assert.match(report, /shapes_User/);
  assert.match(report, /shapes_Issue/);
  assert.match(report, /labels: array of string/);
  assert.match(report, /reporter: object of User/);
});

test('a plugin that declares none of them says nothing about them', () => {
  /*
   * The sections are worth having only where there is something to say. Every
   * plugin shipped here exports a shape now - `markdown`, which exported none,
   * left with the rest of what the server embeds - so this is written rather
   * than picked, the way the shapes test above is.
   */
  const where = mkdtempSync(join(tmpdir(), 'plain-'));
  const file = join(where, 'plain.js');
  writeFileSync(
    file,
    `export default class Plain extends OrknuxPlugin {
       id() { return 'plain'; }
       apiVersion() { return 1; }
       functions() {
         return [new OrknuxFunction({ name: 'ping', description: 'x', returnType: 'boolean', run: () => true })];
       }
     }`,
  );

  const report = checked(file);

  assert.doesNotMatch(report, /It ships with:/);
  assert.doesNotMatch(report, /It exports these shapes:/);
  assert.doesNotMatch(report, /It teaches:/);
  assert.match(report, /plain_ping/);
});

test('the report says which values a parameter takes, where it names them', () => {
  /*
   * Written rather than picked: the plugin that named a set of values - `web`,
   * and its choice of search backend - left with the rest of them, and every
   * parameter shipped here today is a token, a url or a connection.
   */
  const where = mkdtempSync(join(tmpdir(), 'chosen-'));
  const file = join(where, 'chosen.js');
  writeFileSync(
    file,
    `export default class Chosen extends OrknuxPlugin {
       id() { return 'chosen'; }
       apiVersion() { return 1; }
       parameters() {
         return [
           { name: 'backend', type: 'string', description: 'Which one.', options: ['tavily', 'brave'] },
           { name: 'apiKey', type: 'string', description: 'Its key.', secret: true },
         ];
       }
       functions() {
         return [new OrknuxFunction({ name: 'ping', description: 'x', returnType: 'boolean', run: () => true })];
       }
     }`,
  );

  const report = checked(file);

  /* The difference between a text box and a list nobody can mistype. */
  assert.match(report, /backend: string — one of tavily, brave/);
  /* A secret names no set, and is still marked as the secret it is. */
  assert.match(report, /apiKey: string — secret/);
});
