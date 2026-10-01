import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_OPTIONS,
  qualifiedName,
  validate,
  validateActions,
  validateCapabilities,
  validateConnectionTypes,
  validateFunctions,
  validateParameters,
  validatePermissions,
  validateTools,
} from '../dist/index.js';

/**
 * The rules are the server's, so these tests are written the way the server
 * words them: a declaration that would be accepted produces nothing, and one that
 * would not produces the sentence somebody has to act on.
 */

const teammates = {
  id: 'teammates',
  apiVersion: 1,
  functions: [
    {
      name: 'isTeammate',
      description: 'Whether an email address belongs to a member of this workspace.',
      params: [{ name: 'email', type: 'string' }],
      returnType: 'boolean',
    },
  ],
};

test('a plugin the server would take has nothing wrong with it', () => {
  assert.deepEqual(validate(teammates), []);
});

test('a function is called by the plugin id and its own name', () => {
  assert.equal(qualifiedName('teammates', 'isTeammate'), 'teammates_isTeammate');
});

test('an id that could not prefix a function name is refused', () => {
  const problems = validate({ ...teammates, id: 'team mates' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].part, 'id');
  assert.match(problems[0].message, /cannot be a plugin id/);
});

test('an API version this package does not know is refused', () => {
  const problems = validate({ ...teammates, apiVersion: 4 });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /plugin API version 4, which this server does not know/);
});

test('a name that is not an identifier is refused', () => {
  const problems = validateFunctions([{ name: 'is teammate', params: [], returnType: 'boolean' }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['"is teammate" is not a usable function name'],
  );
});

test('the same name twice is refused', () => {
  const one = { name: 'same', params: [], returnType: 'boolean' };
  const problems = validateFunctions([one, { ...one }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['it declares same more than once'],
  );
});

test('a type the server does not have is refused, and named', () => {
  const problems = validateFunctions([{ name: 'greet', params: [], returnType: 'text' }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['greet returns "text", which is not a type this server has'],
  );
});

test('returning none is refused, because a function has to answer', () => {
  const problems = validateFunctions([{ name: 'post', params: [], returnType: 'none' }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['post must return something, not none'],
  );
});

test('an object names one workspace, so a plugin may not use it', () => {
  const problems = validateFunctions([
    { name: 'ticket', params: [{ name: 'issue', type: 'object' }], returnType: 'object' },
  ]);
  assert.equal(problems.length, 2);
  for (const problem of problems) assert.match(problem.message, /use map instead/i);
});

test('a parameter declared twice is refused', () => {
  const problems = validateFunctions([
    {
      name: 'compare',
      params: [
        { name: 'left', type: 'string' },
        { name: 'left', type: 'string' },
      ],
      returnType: 'boolean',
    },
  ]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['compare declares left twice'],
  );
});

test('every problem is reported, not only the first', () => {
  const problems = validateFunctions([
    { name: 'one two', params: [{ name: 'a b', type: 'nope' }], returnType: 'nope' },
  ]);
  assert.equal(problems.length, 4);
});

test('a tool may share its name with a function, which is what a proxy defaults to', () => {
  const problems = validate({
    ...teammates,
    tools: [
      {
        name: 'isTeammate',
        params: [{ name: 'email', type: 'string' }],
        returnType: 'boolean',
        proxyOf: 'isTeammate',
      },
    ],
  });
  assert.deepEqual(problems, []);
});

test('a tool proxying a function the plugin does not declare is refused', () => {
  const problems = validateTools(
    [{ name: 'missing', params: [], returnType: 'boolean', proxyOf: 'missing' }],
    teammates.functions,
  );
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['tools() proxies "missing", which functions() does not declare'],
  );
});

test('a tool has to answer a model, so none and object are refused by name', () => {
  const problems = validateTools([{ name: 'post', params: [], returnType: 'none' }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [
      'the tool post returns none; a tool answers a model, so it has to return one of ' +
        'string, number, boolean, map, array',
    ],
  );
});

test('the same tool twice is refused', () => {
  const one = { name: 'same', params: [], returnType: 'boolean' };
  const problems = validateTools([one, { ...one }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['it declares the tool same more than once'],
  );
});

test('a tool name that is not an identifier is refused', () => {
  const problems = validateTools([{ name: 'read message', params: [], returnType: 'map' }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['"read message" is not a usable tool name'],
  );
});

test("a tool's parameters are held to the functions' rules, in the tool's name", () => {
  const problems = validateTools([
    {
      name: 'compare',
      params: [
        { name: 'left', type: 'string' },
        { name: 'left', type: 'nope' },
      ],
      returnType: 'boolean',
    },
  ]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [
      'the tool compare declares left twice',
      'the tool compare\'s left is a "nope", which is not a type this server has',
    ],
  );
});

test('a plugin declaring the rest of the contract has nothing wrong with it either', () => {
  const problems = validate({
    ...teammates,
    parameters: [
      { name: 'webhookSecret', type: 'string', required: true, secret: true },
      { name: 'slack', type: 'connection', connectionType: 'SLACK', required: false },
    ],
    permissions: ['TEXT_ENCODING'],
    capabilities: ['SLACK_READ_THREAD'],
  });
  assert.deepEqual(problems, []);
});

test('a parameter of a type a variable cannot hold is refused, with the list', () => {
  const problems = validateParameters([{ name: 'shape', type: 'map' }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [
      'the parameter shape is a "map". A parameter is either typed in, points at one of the ' +
        "workspace's variables, or names one of the workspace's connections, so it has to be " +
        'one of string, number, boolean, connection.',
    ],
  );
});

test('a connection has to say which kind, and the kinds are named', () => {
  const problems = validateParameters([{ name: 'slack', type: 'connection' }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [
      'the parameter slack is a connection but does not say which kind. ' +
        'It has to name one of SLACK, SMTP, HTTP.',
    ],
  );
});

test('a connection cannot be a secret, because it holds none', () => {
  const problems = validateParameters([
    { name: 'slack', type: 'connection', connectionType: 'SLACK', secret: true },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /cannot be a secret/);
});

test('a connection kind on something that is not a connection is refused', () => {
  const problems = validateParameters([
    { name: 'token', type: 'string', connectionType: 'SLACK' },
  ]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['the parameter token names a connection kind but is a "string".'],
  );
});

test('the same parameter twice is refused', () => {
  const one = { name: 'token', type: 'string' };
  const problems = validateParameters([one, { ...one }]);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    ['it declares the parameter token more than once'],
  );
});

test('a permission this server cannot grant is refused, and the grants are named', () => {
  const problems = validatePermissions(['FILESYSTEM']);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [
      'This plugin asks for "FILESYSTEM", which is not something this server can grant. ' +
        'It grants CONSOLE, INTL, TEXT_ENCODING, PERFORMANCE, TEMPORAL.',
    ],
  );
});

test('a permission is a precise request, so its case is not forgiven', () => {
  const problems = validatePermissions(['intl']);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /asks for "intl"/);
});

test('a capability this server does not have is refused', () => {
  const problems = validateCapabilities(['SLACK_DELETE_MESSAGE']);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [
      'This server has no capability called "SLACK_DELETE_MESSAGE". ' +
        'A plugin may only ask for the ones it has.',
    ],
  );
});

test('a capability is matched the way the server matches one: trimmed, any case', () => {
  assert.deepEqual(validateCapabilities([' slack_read_thread ']), []);
});

/*
 * Options on a parameter: what turns a text box into a picker.
 *
 * The rules are about what a picker can be — something to choose from, each
 * row distinct, short enough to read rather than search — and about the two
 * kinds that are not chosen from a list of values at all.
 */
test('a parameter may name the values it takes', () => {
  assert.deepEqual(
    validateParameters([{ name: 'backend', type: 'string', options: ['tavily', 'brave'] }]),
    [],
  );
});

test('an empty set is not a choice', () => {
  const problems = validateParameters([{ name: 'backend', type: 'string', options: [] }]);
  assert.match(problems[0].message, /non-empty array/);
});

test('the same option twice is a picker with one row drawn twice', () => {
  const problems = validateParameters([
    { name: 'backend', type: 'string', options: ['brave', 'brave'] },
  ]);
  assert.match(problems[0].message, /more than once/);
});

test('a secret cannot be one of a set somebody can read', () => {
  const problems = validateParameters([
    { name: 'token', type: 'string', secret: true, options: ['a', 'b'] },
  ]);
  assert.match(problems[0].message, /it is a secret/);
});

test('and a connection already has its own picker', () => {
  const problems = validateParameters([
    { name: 'slack', type: 'connection', connectionType: 'SLACK', options: ['a', 'b'] },
  ]);
  assert.match(problems[0].message, /it is a connection/);
});

test('the bound is the server’s', () => {
  const many = Array.from({ length: MAX_OPTIONS + 1 }, (_unused, at) => `option-${at}`);
  const problems = validateParameters([{ name: 'backend', type: 'string', options: many }]);
  assert.match(problems[0].message, new RegExp(`at most ${MAX_OPTIONS}`));
});

/*
 * `required` and `default` on a function's parameter, which the server takes
 * now — these tests used to assert the refusal that stood in for it.
 *
 * What they pin is the pair of mistakes worth catching where the plugin is
 * written: a default of the wrong type, which otherwise shows up only on the
 * call that leaves the argument out, and an optional parameter before a
 * required one, which is a signature nothing downstream can read because the
 * arguments are positional.
 */

test('a function parameter may be left out, with a default', () => {
  assert.deepEqual(
    validateFunctions([
      {
        name: 'search',
        params: [
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', default: 20 },
        ],
        returnType: 'map',
      },
    ]),
    [],
  );
});

test('a default that is not the parameter’s type is refused', () => {
  const problems = validateFunctions([
    { name: 'search', params: [{ name: 'limit', type: 'number', default: 'twenty' }], returnType: 'map' },
  ]);
  assert.match(problems[0].message, /is a number and its default is not one/);
});

test('a default that can never apply is refused rather than ignored', () => {
  const problems = validateFunctions([
    {
      name: 'search',
      params: [{ name: 'limit', type: 'number', default: 20, required: true }],
      returnType: 'map',
    },
  ]);
  assert.match(problems[0].message, /can never apply/);
});

test('the ones that may be left out come last, because arguments are positional', () => {
  const problems = validateFunctions([
    {
      name: 'search',
      params: [
        { name: 'limit', type: 'number', default: 20 },
        { name: 'query', type: 'string' },
      ],
      returnType: 'map',
    },
  ]);
  assert.match(problems[0].message, /Arguments are positional/);
});

test('and a tool is held to the same rules, named as the tool', () => {
  const problems = validateTools(
    [{ name: 'look', params: [{ name: 'limit', type: 'number', default: 'twenty' }], returnType: 'map' }],
    [],
  );
  assert.ok(problems.some((problem) => /the tool look's limit/.test(problem.message)));
});

test('null is a default for anything, because it is what "nothing" was', () => {
  assert.deepEqual(
    validateFunctions([
      { name: 'search', params: [{ name: 'limit', type: 'number', default: null }], returnType: 'map' },
    ]),
    [],
  );
});

test('a parameter declaring neither is still fine, which is every one shipped', () => {
  assert.deepEqual(
    validateFunctions([{ name: 'search', params: [{ name: 'limit', type: 'number' }], returnType: 'map' }]),
    [],
  );
});

/*
 * The fourth surface. An action's inputs are wired from what a run carries, so
 * they may be arrays and objects where a plugin's own parameters may not - and
 * the rules are the upload's, from `PluginDeclarations.validatedActions`.
 */
test('an action the server would take has nothing wrong with it', () => {
  assert.deepEqual(
    validateActions([
      {
        name: 'respond',
        label: 'Reply in the thread',
        parameters: [
          { name: 'commands', type: 'array' },
          { name: 'channel', type: 'string' },
          { name: 'threadTs', type: 'string', required: false },
          { name: 'extra', type: 'object' },
        ],
        outputs: [{ name: 'ts', type: 'string' }],
      },
    ]),
    [],
  );
});

test('an action needs a usable name and a label', () => {
  const problems = validateActions([
    { name: 'reply now', label: 'Reply', parameters: [], outputs: [] },
    { name: 'respond', label: '  ', parameters: [], outputs: [] },
  ]);
  assert.deepEqual(
    problems.map((one) => one.message),
    ['"reply now" is not a usable action name', 'the action respond has no label'],
  );
});

test("an action's parameters and outputs are held to the action type list, named by side", () => {
  const problems = validateActions([
    {
      name: 'respond',
      label: 'Reply',
      parameters: [
        { name: 'channel', type: 'string' },
        { name: 'channel', type: 'string' },
        { name: 'slack', type: 'connection' },
      ],
      outputs: [{ name: 'ts', type: 'none' }],
    },
  ]);
  assert.deepEqual(
    problems.map((one) => one.message),
    [
      'the action respond declares the parameter channel twice',
      'the action respond\'s slack is a "connection", and a parameter is one of string, number, boolean, array, object, map',
      'the action respond\'s ts is a "none", and an output is one of string, number, boolean, array, object, map',
    ],
  );
});

/*
 * A kind of host a plugin declares, and the one thing it changes elsewhere: a
 * connection parameter may name it, by the bare name, beside the core kinds.
 * The rules are the upload's, from `PluginDeclarations.validatedConnectionTypes`
 * and `validatedParameters`.
 */
test('a connection parameter may name a kind of host its own plugin declares', () => {
  const problems = validate({
    id: 'prometheus',
    apiVersion: 1,
    functions: [],
    connectionTypes: [{ name: 'prometheus', label: 'Prometheus' }],
    parameters: [{ name: 'prometheus', type: 'connection', connectionType: 'prometheus' }],
  });
  assert.deepEqual(problems, []);
});

test('and not one it does not, which is named among the kinds it could have been', () => {
  const problems = validateParameters(
    [{ name: 'server', type: 'connection', connectionType: 'grafana' }],
    [{ name: 'prometheus', label: 'Prometheus' }],
  );
  assert.deepEqual(problems.map((one) => one.message), [
    'the parameter server is a connection but does not say which kind. ' +
      'It has to name one of SLACK, SMTP, HTTP, prometheus.',
  ]);
});

test('a kind of host needs a usable name, declared once, and a label', () => {
  const problems = validateConnectionTypes([
    { name: 'a server', label: 'Server' },
    { name: 'prometheus', label: 'Prometheus' },
    { name: 'prometheus', label: '  ' },
  ]);
  assert.deepEqual(problems.map((one) => one.message), [
    '"a server" is not a usable connection type name',
    'it declares the connection type prometheus more than once',
    'the connection type prometheus has no label',
  ]);
});

test('the same action twice is refused', () => {
  const problems = validateActions([
    { name: 'respond', label: 'Reply', parameters: [], outputs: [] },
    { name: 'respond', label: 'Reply again', parameters: [], outputs: [] },
  ]);
  assert.deepEqual(problems.map((one) => one.message), ['it declares the action respond more than once']);
});
