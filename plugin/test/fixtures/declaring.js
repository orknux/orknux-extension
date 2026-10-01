/*
 * A plugin that declares every optional field the contract has.
 *
 * Nothing here is useful. It exists so `mirror.test.js` can put one of each
 * through `inspect` and check it arrives, because five separate fields have
 * now been added to the contract, validated, tested, and silently dropped on
 * the way in. A field with no line in this fixture is a field nothing watches.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

export default class Declaring extends OrknuxPlugin {
  id() {
    return 'declaring';
  }

  apiVersion() {
    return 1;
  }

  parameters() {
    return [
      new OrknuxParameter({
        name: 'chosen',
        description: 'A parameter that names its values.',
        type: 'string',
        required: true,
        options: ['one', 'two'],
      }),
      new OrknuxParameter({
        name: 'token',
        description: 'A parameter the settings page hides.',
        type: 'string',
        required: false,
        secret: true,
      }),
      new OrknuxParameter({
        name: 'slack',
        description: 'A parameter a stored connection fills.',
        type: 'connection',
        connectionType: 'SLACK',
        required: false,
      }),
      new OrknuxParameter({
        name: 'host',
        description: 'A parameter one of its own kinds of host fills.',
        type: 'connection',
        connectionType: 'server',
        required: false,
      }),
    ];
  }

  connectionTypes() {
    return [
      {
        name: 'server',
        label: 'A server',
        description: 'A kind of host with everything filled in.',
        urlPlaceholder: 'https://server.example.com',
      },
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'described',
        description: 'A function with a description and an optional parameter.',
        params: [
          { name: 'text', type: 'string', description: 'A parameter that says what it holds.' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'Shape',
        run: () => ({ name: 'x', count: 0, nested: [] }),
      }),
    ];
  }

  tools() {
    return [
      new OrknuxFunctionTool({ function: 'described' }),
      new OrknuxTool({
        name: 'standalone',
        description: 'A tool with a run of its own rather than a function behind it.',
        params: [
          { name: 'text', type: 'string', description: 'What to say.' },
          { name: 'loudly', type: 'boolean', required: false, default: false },
        ],
        returnType: 'string',
        run: () => 'said',
      }),
    ];
  }

  objects() {
    return [
      new OrknuxObject({
        name: 'Shape',
        description: 'A shape covering every kind of property, including one that points.',
        properties: [
          { name: 'name', kind: 'string', description: 'A plain one.' },
          { name: 'count', kind: 'number', description: 'Another plain one.' },
          { name: 'nested', kind: 'array', of: 'Inner', description: 'One that points.' },
        ],
      }),
      new OrknuxObject({
        name: 'Inner',
        description: 'What the array above holds.',
        properties: [{ name: 'id', kind: 'string', description: 'Only a name.' }],
      }),
    ];
  }

  skills() {
    return [
      new OrknuxSkill({
        name: 'Doing the thing',
        id: 'doing-the-thing',
        description: 'What a skill looks like with all three of its fields filled in.',
        content: '# Doing the thing\n\nThere is nothing to do.\n',
      }),
    ];
  }

  libraries() {
    return ['lib/nothing.js'];
  }

  actions() {
    return [
      {
        name: 'described',
        label: 'An action with everything filled in',
        description: 'An action with a description, an optional parameter and declared outputs.',
        parameters: [
          { name: 'commands', type: 'array', description: 'A list, which arrives as one.' },
          { name: 'note', type: 'string', required: false },
        ],
        outputs: [{ name: 'count', type: 'number', description: 'How many arrived.' }],
        run: (input) => ({ count: input.commands.length }),
      },
    ];
  }
}
