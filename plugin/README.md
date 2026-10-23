# @orknux/plugin

[![npm](https://img.shields.io/npm/v/@orknux/plugin?label=npm)](https://www.npmjs.com/package/@orknux/plugin)
[![CI](https://github.com/michjak-szymanski/orknux-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/michjak-szymanski/orknux-extension/actions/workflows/ci.yml)
[![plugin API](https://img.shields.io/badge/plugin%20API-1-blue)](https://github.com/michjak-szymanski/orknux-extension/blob/main/plugin/src/limits.ts)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](https://github.com/michjak-szymanski/orknux-extension/blob/main/plugin/package.json)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](https://github.com/michjak-szymanski/orknux-extension/blob/main/LICENSE)

Writing plugins for [orknux-server](https://github.com/michjak-szymanski/orknux-server)
in TypeScript, and knowing before you upload one that the server will take it.

```bash
npm install --save-dev @orknux/plugin
npx orknux-plugin init my-plugin
```

## What a plugin is

One file, evaluated as a single ES module in a sandbox with no network, no
filesystem and no module resolution. It exports one class by default, that class
extends `OrknuxPlugin`, and the server questions it when it is loaded: what it
calls itself, which plugin API it was written against, what functions it offers
to workflows and what tools to agents, what it has to be told before it can
work, which JavaScript it needs, and what it asks the server to do on its
behalf.

What it declares becomes functions every workspace can call, named for the plugin
and then for the function — `teammates_isTeammate`. The id is the plugin's
identity, not its filename: loading the same id again replaces what is loaded.

```ts
import { definePlugin, fn } from '@orknux/plugin';

export default definePlugin({
  id: 'teammates',
  functions: [
    fn({
      name: 'isTeammate',
      description: 'Whether an email address belongs to a member of this workspace.',
      params: [{ name: 'email', type: 'string' }],
      returnType: 'boolean',
      run: (email) => email.endsWith('@example.com'),
    }),
  ],
});
```

`email` is a `string` there without being annotated. The parameters are declared
once and `run` is typed from them, so changing `type: 'string'` to `'number'` is a
compile error in the body rather than a plugin that lies about itself.

```bash
npx orknux-plugin build src/plugin.ts -o dist/teammates.js
```

```
dist/teammates.js  4.5 KB

teammates  ·  plugin API 1  ·  4.5 KB  ·  sha256 2a2d7118aa42…

  teammates_isTeammate(email: string): boolean
      Whether an email address belongs to a member of this workspace.

Accepted. Load it with: orkx plugin load --file dist/teammates.js
```

## The types a value may have

`string`, `number`, `boolean`, `map`, `array` — and what each is in TypeScript:

| declared  | in `run`                  |
|-----------|---------------------------|
| `string`  | `string`                  |
| `number`  | `number`                  |
| `boolean` | `boolean`                 |
| `map`     | `Record<string, unknown>` |
| `array`   | `unknown[]`               |

A map is `unknown`-valued and an array `unknown`-elemented because everything
crossing into the sandbox arrived as JSON: what is inside it is genuinely unknown
until the code looks, and `unknown` is what makes the code look.

The server has two more types that a plugin may not use. `none` means "answers
nothing", and a function has to answer something. `object` names one of a
*workspace's* own definitions — and a plugin's functions belong to every
workspace at once, so there is no workspace whose objects they could be naming. A
plugin that wants a structure asks for a `map`.

## Parameters, and `this.settings`

A function's parameters are filled in by whoever calls it, node by node. A
*plugin's* parameters are different: each workspace answers them once — by
typing a value, by pointing at one of its variables, or by picking one of its
connections — and what they come to arrives frozen as `this.settings` on every
call. Declaring them is also how a workspace can see what a plugin is able to
reach, because nothing gets in that is not on the list.

```ts
import { definePlugin, fn, param } from '@orknux/plugin';

export default definePlugin({
  id: 'teammates',
  parameters: [
    param({ name: 'teamDomain', description: 'The mail domain to treat as ours.', type: 'string' }),
  ],
  functions: [
    fn({
      name: 'isTeammate',
      params: [{ name: 'email', type: 'string' }],
      returnType: 'boolean',
      // A method, not an arrow: the sandbox calls `run` with the plugin as
      // `this`, and an arrow written here would close over nothing.
      run(email) {
        const domain = this.settings.teamDomain;
        return typeof domain === 'string' && email.endsWith(`@${domain}`);
      },
    }),
  ],
});
```

A parameter is one of `string`, `number`, `boolean` — what a workspace variable
can hold — or `connection`, which names one of the workspace's connections and
must say which kind with `connectionType: 'SLACK' | 'SMTP' | 'HTTP'`. What then
arrives in `settings` is a handle, an `{ id, type }` — never the connection's
credential. `required` defaults to true; `secret: true` refuses a typed-in
value, so the only way to answer it is a workspace variable, which is where an
installation keeps things it encrypts. A parameter nothing usable is set for is
absent rather than null: `this.settings.token === undefined` is the question to
ask.

## Tools, for agents

Workflows call functions; agents call tools. `tools()` is a surface of its own
because it has a reader of its own: a tool's description is read by a model
deciding whether to call it, where a function's is read by a person building a
workflow. A tool that is really one of the plugin's functions is declared as an
`OrknuxFunctionTool` — `functionTool` in the described style — which proxies it
rather than describing it twice: the params, return type and implementation
stay the function's, including any edit somebody makes to it on the server
later, and only the name and the model-facing description may be the tool's
own. A proxy naming a function `functions()` does not declare is refused at
load.

```ts
import { definePlugin, fn, functionTool, tool } from '@orknux/plugin';

export default definePlugin({
  id: 'teammates',
  functions: [/* … */],
  tools: [
    // The function, fronted. The name defaults to the function's, and so does
    // the description — write one only when the model needs different words.
    functionTool({ function: 'isTeammate' }),

    // Or a tool of its own, with a run of its own, declared like a function.
    tool({
      name: 'countTeammates',
      description: 'How many of a list of email addresses belong to this workspace.',
      params: [{ name: 'addresses', type: 'array' }],
      returnType: 'number',
      run(addresses) {
        /* … */
      },
    }),
  ],
});
```

Tool names are identifiers and unique among the tools; sharing a name with a
function is fine, and is exactly what a proxy defaults to — the two lists have
different readers and never answer the same call. A tool answers a model, so it
has to return one of `string`, `number`, `boolean`, `map`, `array` — neither
`none` nor `object` will do. An agent is granted a tool by its qualified name,
`teammates_isTeammate`, under the same prefix rule the functions follow.

## Skills, for agents to read

A third surface, and a third reader. `functions()` is called by a workflow and
`tools()` by a model; a skill is neither called nor run — it is a page of
markdown an agent reads to learn how this plugin's work is meant to be done. A
plugin that offers a search tool can ship the skill that says when to reach for
it, and the two travel together instead of the second being retyped into every
workspace by hand.

```ts
import { OrknuxPlugin, OrknuxSkill } from '@orknux/plugin';

export default class Deploys extends OrknuxPlugin {
  id() {
    return 'deploys';
  }
  apiVersion() {
    return 1;
  }
  skills() {
    return [
      new OrknuxSkill({
        name: 'Rolling back a deploy',
        id: 'rolling-back',
        description: 'What to do when a release is bad.',
        content: '# Rolling back\n\n- Stop the rollout first.\n- Then page the on-call.',
      }),
    ];
  }
}
```

A skill's name is prose, not an identifier: nothing calls it, an agent reads
it, so `Rolling back a deploy` is a better name than `rolling_back`. The
description is what an agent chooses from before loading anything, so it earns
its place — "What to do when a release is bad" tells a model when to reach for
the page, and "Deploy skill" does not.

The `id` is the identifier the name is not: letters, underscores and hyphens,
unique among your skills, and the one string anything else writes down. A
workflow node naming skills to load holds it, `skill_load` is asked for it, and
a person writes the workspace's command marker and this id in a message to have
an agent load the skill — `!rolling-back`, or `::rolling-back`, depending on
what that workspace's marker is. Leave it out and the server derives one from
the name, which is fine for a skill nothing points at and a trap for one that
is: rename `Rolling back a deploy` and the derived id changes with it, so every
graph and every command naming the old one stops meaning anything. Say your own
and the name is then free to change.

A skill is stored with a `---` frontmatter block naming and describing it, the
way a skill written in the interface is. You may write the block yourself; if
you leave it out, the server writes one from the `name` and `description` above,
because those are the same two facts and stating them twice is a trap. A block
that opens and never closes is refused.

They arrive in an installation as a **skill catalog named after the plugin's
key**, and an agent is granted that catalog from the same field every other
catalog is granted from. Nothing is automatic: a plugin loaded into an
installation teaches nobody until somebody grants it. A workspace's own skill of
the same name wins, the way its own tool wins over a plugin's. At most
`MAX_SKILLS` of them, each at most `MAX_SKILL_CHARS` characters.

## Objects, for shapes to pass around

A plugin's functions belong to every workspace at once, which is why a
parameter or a return may not be `object` — that names one of a *workspace's*
definitions, and there is no single workspace whose definitions a plugin's
functions could mean. `map` has been the answer, and it is a weak one: a map
says nothing about what is in it.

`objects()` is the better answer. A shape declared here belongs to the plugin,
travels with it, and is available wherever the plugin is — under the plugin's
key, so `Issue` declared by `jira` arrives as `jira_Issue`.

```ts
import { OrknuxObject, OrknuxPlugin } from '@orknux/plugin';

export default class Jira extends OrknuxPlugin {
  id() {
    return 'jira';
  }
  apiVersion() {
    return 1;
  }
  objects() {
    return [
      new OrknuxObject({
        name: 'User',
        properties: [{ name: 'email', kind: 'string', description: 'Who they are.' }],
      }),
      new OrknuxObject({
        name: 'Issue',
        description: 'One tracker issue.',
        properties: [
          { name: 'key', kind: 'string', description: 'ABC-1' },
          { name: 'labels', kind: 'array', of: 'string' },
          { name: 'reporter', kind: 'object', of: 'User' },
          { name: 'watchers', kind: 'array', of: 'User' },
        ],
      }),
    ];
  }
}
```

A field's `kind` is one of `string`, `number`, `boolean`, `object`, `array`.
`of` is where a shape stops being flat: required for an `object`, where it names
another of this plugin's objects, and for an `array`, where it is either a
scalar kind or another object's name. It is refused on anything else, because
there would be nothing for it to say. An array of arrays has no shape on this
server.

Inside the plugin, name them as you spelled them — a property whose `of` is
`User` means the `User` *this plugin* declares, and so does a function that
returns `Issue`. The loader rewrites the references when it stores them, and
refuses a name that points at nothing. A `description` on a field is worth
writing: a name says what a field is called and nothing about what belongs in
it, and a model reads the same sentence a person does.

At most `MAX_OBJECTS` shapes, each with at most `MAX_PROPERTIES` fields.

## Connection types, for hosts of its own kind

`connectionTypes()` declares a kind of host - a Prometheus, an AnkiConnect - so
a workspace can hold several by name and a `connection` parameter of that kind
receives its `url`, `authType`, `secret` and `headers`. Two members make the
connection page do more than ask for a URL:

```js
connectionTypes() {
  return [{
    name: 'ankiconnect',
    label: 'AnkiConnect',
    urlPlaceholder: 'http://localhost:8765',
    defaultUrl: 'http://localhost:8765',
    guide: '## Before you start\n\nInstall the add-on…',
    check: (connection) => ({ ok: true, message: 'AnkiConnect 6' }),
  }];
}
```

- `defaultUrl` is the address a connection has unless somebody types another,
  and makes the URL box optional. Declare it only where there really is one:
  `urlPlaceholder` is an example, and most kinds have no address everybody
  shares.
- `guide` is markdown shown beside the form for that kind: what to install,
  where the address comes from, what goes in the credential. At most
  `MAX_CONNECTION_GUIDE_CHARS` characters.
- `check` runs when somebody presses Test. Without one the server can only ask
  whether the address answers, and a login page answers too; with one the
  plugin asks the question only its host can answer. It is handed the
  connection as a function receives it, runs under the plugin's own
  capabilities, and answers `{ ok, message }`; a throw is a failed check whose
  message is the reason.

## Permissions

The sandbox hands out very little JavaScript, on purpose, and a bundle written
for a browser or Node often expects more — `Intl`, `TextEncoder`, `console`. A
plugin declares what it needs from `permissions()`, whoever loads it is shown
the list and has to accept it, and only what was accepted is turned on, for
that plugin alone. The list is closed: `CONSOLE`, `INTL`, `TEXT_ENCODING`,
`PERFORMANCE`, `TEMPORAL`, and nothing else — there is deliberately no spelling
for a file, a socket or a host class, so asking is refused rather than
half-granted. Loading happens with none of them granted, so the top level of
the bundle has to evaluate without them: ask for what `run` needs, not for what
loading needs.

## Capabilities, and the `orknux` helpers

A permission relaxes the sandbox; a capability asks the server to act. The
calls that have to reach outside — reading a Slack thread, posting a message,
making an HTTP request — are made by the server, under a capability the plugin
declares from `capabilities()` and a person accepts, through a connection the
workspace pointed the plugin at. The plugin never holds a token or a socket;
what crosses is data, both ways.

The doors are on the `orknux` object the sandbox defines — `orknux.slack.thread`,
`.post`, `.react`, `.message`, `.user`, `.mention`, `.search`, `.upload`,
`.remoteFile`, `.api`, `.download`, `orknux.http.request`, `.get`, `.post` —
each needing its capability (`SLACK_READ_THREAD`, `SLACK_POST_MESSAGE`,
`SLACK_ADD_REACTION`, `SLACK_READ_MESSAGE`, `SLACK_READ_USER`, `SLACK_MENTION`,
`SLACK_SEARCH`, `SLACK_UPLOAD_FILE` for both file calls, `SLACK_WEB_API_READ`
for Slack's read methods and a file's bytes, `NETWORK_REQUEST`), and each answering
`{ error }` as data rather than throwing when it is refused, so a condition
that could not be decided does not quietly decide. `orknux.log.debug` through
`.error` are always there and never needed granting — nothing is reached by a
log line.

Import style gets the same object as `import { orknux } from '@orknux/plugin'`,
typed; the ambient style has it declared globally. Outside the sandbox — in a
test, or under `check` — every helper answers the ungranted sentence, which is
the truth there too.

## Why an import is safe here

The sandbox defines `OrknuxPlugin` and `OrknuxFunction` on the global object
before it evaluates a plugin, and then checks the default export **by prototype**.
A copy of those classes bundled in from a library would satisfy every type and
fail that check, because it would be a different class with the same shape.

So what this package exports is not a copy — it is a binding:

```js
globalThis.OrknuxPlugin  // ← what `import { OrknuxPlugin }` resolves to
```

which is why bundling this package into a plugin is fine, and why the class the
build produces really is the one the server is looking for. Outside the sandbox —
in a unit test, or in `orknux-plugin check` — nothing has defined those globals,
so the package installs a faithful copy of the server's own contract, wording
included, and a plugin refused locally is refused with the sentence the server
would have used.

## Three ways to write one

**Described.** `definePlugin` is the short one, and what `init` scaffolds. It
returns a real class extending `OrknuxPlugin`.

**Written out.** The same thing, when a method has something to say:

```ts
import { OrknuxFunction, OrknuxPlugin } from '@orknux/plugin';

export default class Teammates extends OrknuxPlugin {
  id() {
    return 'teammates';
  }

  apiVersion() {
    return 1;
  }

  functions() {
    return [new OrknuxFunction({ name: 'isTeammate', returnType: 'boolean', run: () => true })];
  }
}
```

**Against the globals, importing nothing.** This is the style of the template the
server itself hands out, and it needs no bundler at all — `tsc` alone produces
something the server takes:

```jsonc
// tsconfig.json
{ "compilerOptions": { "types": ["@orknux/plugin/globals"] } }
```

```ts
export default class Teammates extends OrknuxPlugin {
  id(): string {
    return 'teammates';
  }
  apiVersion(): number {
    return 1;
  }
  functions(): OrknuxFunction[] {
    return [];
  }
}
```

Do not mix the last one with the first two in a single file: they describe the
same classes, and an import shadowing a global of the same name reads as a
puzzle rather than as the choice it is.

## Building

`orknux-plugin build` bundles with esbuild into one ES module targeting ES2022,
because that is what the sandbox will evaluate: `format: esm`, `platform:
neutral`, nothing external.

Neutral rather than node is the point of it. A plugin that reaches for `node:fs`
fails **the build**, on the line that reached for it — rather than uploading
cleanly and failing the first time it runs, where an unresolved import is
somebody else's incident.

| flag | |
|---|---|
| `-o, --out <file>` | where the bundle goes. Defaults to `dist/<entry>.js` |
| `--minify` | smaller, and unreadable when an administrator downloads it again |
| `--no-check` | bundle without asking whether it would be accepted |

Build to `dist/<id>.js`. The filename becomes what the plugin is *called* on the
Plugins screen — the id is what it *is* — so a bundle named after its entry point
turns up in the list as "plugin".

## Checking

`build` ends by loading the bundle and asking it the questions the upload asks,
then applying the rules the upload applies: identifiers, types, duplicate
names, the parameter kinds, the permission and capability vocabularies, the API
version, the size. It exits non-zero if anything would be refused,
so a plugin that would not load does not pass a build script. `orknux-plugin
check dist/teammates.js` does the same to a file that already exists.

**It is not the sandbox.** Checking imports the bundle into your Node process,
with everything Node has. Run it on a plugin you wrote, not on one somebody sent
you.

The same functions are exported, so a plugin can have its own tests:

```ts
import { validate } from '@orknux/plugin';
import { bundle, inspect } from '@orknux/plugin/tooling';

await bundle({ entry: 'src/plugin.ts', outfile: 'dist/teammates.js' });
const declared = await inspect('dist/teammates.js');

expect(validate(declared)).toEqual([]);
```

## Loading it

Either from the Plugins screen, as an administrator, or:

```bash
orkx plugin load --file dist/teammates.js
```

## What a plugin cannot do

Reach anything it was not handed. The sandbox denies host access, class
loading, IO, threads, processes and the environment; there is no `fetch` and no
`load`, and `console` is itself a permission. A function is given its
arguments, `this.settings`, and whatever `orknux` calls its capabilities were
accepted for — which is why `run` is typed as synchronous, and why there is no
point writing it as `async`: nothing in there can be awaited.

There is also a clock on it: a plugin has ten seconds and ten million statements
to be *loaded* in, which is generous for declaring functions and not generous at
all for doing work at module scope — and loading happens with no permissions
granted, so the module body has to evaluate bare.

## Versions

`apiVersion()` says which plugin API a plugin was written against; a server
refuses a version it does not know rather than guessing. `API_VERSION` and
`SUPPORTED_API_VERSIONS` are exported, and this package's job is to track the
server: when the server learns a version, this changes with it.

The rest of what the server enforces is exported too — `PLUGIN_ID`,
`IDENTIFIER`, `MAX_FUNCTIONS`, `MAX_PARAMETERS`, `MAX_PERMISSIONS`,
`MAX_SOURCE_BYTES`, `VALUE_TYPES`, `PARAMETER_TYPES`, `CONNECTION_TYPES`,
`PERMISSIONS`, `CAPABILITIES` — because the only thing this package really
sells is that they are the same numbers and the same names.

## Licence

Apache-2.0. The server is AGPL-3.0; this is not, deliberately — a few lines of it
end up inlined in every plugin anybody builds, and what somebody's plugin is
licensed under should be their decision.
