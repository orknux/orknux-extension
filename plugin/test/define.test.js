import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  API_VERSION,
  definePlugin,
  fn,
  functionTool,
  orknux,
  OrknuxFunction,
  OrknuxFunctionTool,
  OrknuxObject,
  OrknuxParameter,
  OrknuxSkill,
  OrknuxPlugin,
  OrknuxTool,
  param,
  tool,
} from '../dist/index.js';

/**
 * What `definePlugin` returns has to be a class extending the sandbox's own
 * `OrknuxPlugin`, because the server checks the prototype and refuses anything
 * else however right its keys are. That check is the one worth writing down.
 */

const isTeammate = () =>
  fn({
    name: 'isTeammate',
    params: [{ name: 'email', type: 'string' }],
    returnType: 'boolean',
    run: (email) => email.endsWith('@example.com'),
  });

test('a defined plugin is a class extending OrknuxPlugin', () => {
  const Defined = definePlugin({ id: 'teammates', functions: [isTeammate()] });

  assert.equal(typeof Defined, 'function');
  assert.ok(Defined.prototype instanceof OrknuxPlugin);

  const plugin = new Defined();
  assert.equal(plugin.id(), 'teammates');
  assert.equal(plugin.apiVersion(), API_VERSION);
  assert.equal(plugin.functions().length, 1);
});

test('what it answers with cannot be edited from under it', () => {
  const Defined = definePlugin({ id: 'teammates', functions: [isTeammate()] });
  const plugin = new Defined();

  plugin.functions().push(isTeammate());
  assert.equal(plugin.functions().length, 1);
});

test('an id that could not prefix a function name is refused where it is written', () => {
  assert.throws(() => definePlugin({ id: 'team mates' }), /cannot be a plugin id/);
});

test('declaring one name twice is refused where it is written', () => {
  assert.throws(
    () => definePlugin({ id: 'teammates', functions: [isTeammate(), isTeammate()] }),
    /declares isTeammate more than once/,
  );
});

test('a function with nothing to run is refused as it is constructed', () => {
  assert.throws(
    () => new OrknuxFunction({ name: 'isTeammate', returnType: 'boolean' }),
    /needs a run function/,
  );
});

test('a function with no name is refused as it is constructed', () => {
  assert.throws(() => new OrknuxFunction({ returnType: 'boolean', run: () => true }), /needs a name/);
});

test('an absent description is null and absent parameters are none', () => {
  const declared = new OrknuxFunction({ name: 'now', returnType: 'number', run: () => 1 });

  assert.equal(declared.description, null);
  assert.deepEqual(declared.params, []);
});

test('a tool with nothing to run is refused as it is constructed', () => {
  assert.throws(
    () => new OrknuxTool({ name: 'shout', returnType: 'string' }),
    /shout needs a run function; it is what the tool does/,
  );
});

test('a tool of its own carries no proxy, and says so with null', () => {
  const declared = tool({ name: 'now', returnType: 'number', run: () => 1 });

  assert.equal(declared.proxyOf, null);
  assert.equal(declared.description, null);
  assert.deepEqual(declared.params, []);
});

test('a proxy needs a function to front, named by `function`', () => {
  assert.throws(
    () => new OrknuxFunctionTool({ name: 'shout' }),
    /needs a function to proxy, named by `function`/,
  );
});

test('a proxy is named after its function unless it says otherwise', () => {
  const fronted = functionTool({ function: 'shout' });
  assert.equal(fronted.name, 'shout');
  assert.equal(fronted.proxyOf, 'shout');
  assert.equal(fronted.description, null);

  const renamed = functionTool({ function: 'shout', name: 'emphasise', description: 'Louder.' });
  assert.equal(renamed.name, 'emphasise');
  assert.equal(renamed.proxyOf, 'shout');
  assert.equal(renamed.description, 'Louder.');
});

test('what a defined plugin was told to offer agents is what it answers', () => {
  const Defined = definePlugin({
    id: 'teammates',
    functions: [isTeammate()],
    tools: [functionTool({ function: 'isTeammate' })],
  });
  const plugin = new Defined();

  assert.equal(plugin.tools().length, 1);
  assert.equal(plugin.tools()[0].proxyOf, 'isTeammate');

  /* A copy each time, like the functions: nothing can be edited from under it. */
  plugin.tools().push(functionTool({ function: 'isTeammate', name: 'again' }));
  assert.equal(plugin.tools().length, 1);
});

test('a proxy to a function the plugin does not declare is refused where it is written', () => {
  assert.throws(
    () => definePlugin({ id: 'teammates', tools: [functionTool({ function: 'missing' })] }),
    /tools\(\) proxies "missing", which functions\(\) does not declare/,
  );
});

test('declaring one tool name twice is refused where it is written', () => {
  const fronted = () => functionTool({ function: 'isTeammate' });
  assert.throws(
    () => definePlugin({ id: 'teammates', functions: [isTeammate()], tools: [fronted(), fronted()] }),
    /declares the tool isTeammate more than once/,
  );
});

test('what a defined plugin was told to declare is what it answers', () => {
  const Defined = definePlugin({
    id: 'slackish',
    parameters: [param({ name: 'slack', type: 'connection', connectionType: 'SLACK' })],
    permissions: ['TEXT_ENCODING'],
    capabilities: ['SLACK_READ_THREAD'],
  });
  const plugin = new Defined();

  assert.deepEqual(plugin.permissions(), ['TEXT_ENCODING']);
  assert.deepEqual(plugin.capabilities(), ['SLACK_READ_THREAD']);
  assert.equal(plugin.parameters().length, 1);
  assert.equal(plugin.parameters()[0].name, 'slack');
});

test('declaring nothing is answering none, as the base class does', () => {
  const Defined = definePlugin({ id: 'quiet' });
  const plugin = new Defined();

  assert.deepEqual(plugin.tools(), []);
  assert.deepEqual(plugin.parameters(), []);
  assert.deepEqual(plugin.permissions(), []);
  assert.deepEqual(plugin.capabilities(), []);
});

test('declaring one parameter twice is refused where it is written', () => {
  const token = () => param({ name: 'token', type: 'string' });
  assert.throws(
    () => definePlugin({ id: 'twice', parameters: [token(), token()] }),
    /declares the parameter token more than once/,
  );
});

test('a parameter fills its defaults in the way the sandbox does', () => {
  const declared = new OrknuxParameter({ name: 'teamDomain', type: 'string' });

  assert.equal(declared.description, null);
  assert.equal(declared.required, true);
  assert.equal(declared.secret, false);
  assert.equal(declared.connectionType, null);
});

test('a connection that does not say which kind is refused as it is constructed', () => {
  assert.throws(
    () => new OrknuxParameter({ name: 'slack', type: 'connection' }),
    /slack is a connection, so it needs a connectionType/,
  );
});

test('a connection kind on something that is not a connection is refused too', () => {
  assert.throws(
    () => new OrknuxParameter({ name: 'token', type: 'string', connectionType: 'SLACK' }),
    /token names a connectionType but is not a connection/,
  );
});

test('outside the sandbox the settings are there, empty, and frozen', () => {
  const Defined = definePlugin({ id: 'quiet' });
  const plugin = new Defined();

  assert.deepEqual(plugin.settings, {});
  assert.ok(Object.isFrozen(plugin.settings));
});

test('an ungranted helper answers a sentence as data, never a throw', () => {
  const read = orknux.slack.thread({ id: 1, type: 'SLACK' }, 'C123', '1.2');
  assert.equal(read.error, 'this plugin was not granted SLACK_READ_THREAD');

  const answered = orknux.http.get('https://example.com');
  assert.equal(answered.error, 'this plugin was not granted NETWORK_REQUEST');
});

test('and the renderers say what is missing is the renderer, not the grant', () => {
  /*
   * A different sentence from the others on purpose, and the difference is
   * the useful part. `thread` and `get` are refused because this plugin was
   * not granted something, which is a thing an operator can change. The
   * renderers are absent because there is no server here at all - a test run,
   * a bundler, a REPL - and telling somebody to go and grant a capability
   * would send them to fix the one thing that is not wrong.
   *
   * Three doors, and every one of them was outside this test until the third
   * was added: the plugins that draw already lean on the fallback being data
   * rather than a throw, because that is how `nomnoml_render` produces "could
   * not draw the diagram: there is no renderer here" instead of a stack.
   */
  for (const [door, call] of [
    ['pngFromSvg', () => orknux.render.pngFromSvg('<svg/>')],
    ['pngFromPdf', () => orknux.render.pngFromPdf('JVBERi0=', 1)],
    ['htmlFromPdf', () => orknux.render.htmlFromPdf('JVBERi0=')],
  ]) {
    const answered = call();
    assert.equal(typeof answered.error, 'string', `${door} threw instead of answering`);
    assert.match(answered.error, /there is no renderer here/, door);
    assert.equal(answered.base64, undefined, `${door} answered bytes it does not have`);
    assert.equal(answered.html, undefined, `${door} answered text it does not have`);
  }

  /* And reading is not drawing, which the sentence says rather than glossing. */
  assert.match(orknux.render.htmlFromPdf('JVBERi0=').error, /can read one$/);
  assert.match(orknux.render.pngFromPdf('JVBERi0=', 1).error, /can draw one$/);
});

/*
 * The two newest surfaces, which definePlugin did not know about.
 *
 * It handled id, functions, tools, parameters, permissions, capabilities and
 * libraries, and said nothing about skills or objects - so the ergonomic way
 * to write a plugin was quietly the one that could not teach an agent or
 * export a shape. The kind of gap found by somebody confused rather than by a
 * test, which is what this is.
 */
test('definePlugin carries skills and objects like everything else', () => {
  const Plugin = definePlugin({
    id: 'jira',
    skills: [new OrknuxSkill({ name: 'Triage', content: 'Read the title first.' })],
    objects: [new OrknuxObject({ name: 'Issue', properties: [{ name: 'key', kind: 'string' }] })],
  });

  const made = new Plugin();
  assert.deepEqual(made.skills().map((one) => one.name), ['Triage']);
  assert.deepEqual(made.objects().map((one) => one.name), ['Issue']);
});

test('and a plugin that declares neither still answers with empty lists', () => {
  const made = new (definePlugin({ id: 'bare' }))();

  assert.deepEqual(made.skills(), []);
  assert.deepEqual(made.objects(), []);
  assert.deepEqual(made.actions(), []);
});

test('definePlugin carries the kinds of host a plugin declares', () => {
  const made = new (definePlugin({
    id: 'prometheus',
    connectionTypes: [{ name: 'prometheus', label: 'Prometheus' }],
  }))();
  assert.deepEqual(made.connectionTypes().map((one) => one.name), ['prometheus']);
  assert.deepEqual(new (definePlugin({ id: 'bare' }))().connectionTypes(), []);
});

/* The fourth surface: a plain object with a run, refused where it is written when the run is missing. */
test('definePlugin carries actions, and refuses one with nothing to run', () => {
  const respond = {
    name: 'respond',
    label: 'Reply in the thread',
    parameters: [{ name: 'commands', type: 'array' }],
    run: (input) => ({ count: input.commands.length }),
  };
  const made = new (definePlugin({ id: 'slack', actions: [respond] }))();
  assert.deepEqual(made.actions().map((one) => one.label), ['Reply in the thread']);
  assert.deepEqual(made.actions()[0].run({ commands: ['/deploy', '/status'] }, {}), { count: 2 });

  assert.throws(
    () => definePlugin({ id: 'slack', actions: [{ name: 'silent', label: 'Says nothing' }] }),
    /the action silent has no run function/,
  );
  assert.throws(
    () => definePlugin({ id: 'slack', actions: [respond, respond] }),
    /declares the action respond more than once/,
  );
});
