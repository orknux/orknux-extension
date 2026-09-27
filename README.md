# Orknux plugins and SDK

[![CI](https://github.com/michjak-szymanski/orknux-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/michjak-szymanski/orknux-extension/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@orknux/plugin?label=npm)](https://www.npmjs.com/package/@orknux/plugin)
[![plugin API](https://img.shields.io/badge/plugin%20API-1-blue)](plugin/src/limits.ts)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](package.json)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

Seven production plugins — Slack, GitHub, Jira, Confluence, Jenkins, Prometheus
and Teams — with the library and CLI to write your own.

Extending [orknux-server](https://github.com/michjak-szymanski/orknux-server):
the library you write a plugin against, and the tool that turns it into the one
file the server takes.

```
plugin/              @orknux/plugin — the library and the orknux-plugin CLI
plugins/             the production plugins, each with its marketplace manifest
examples/teammates/  a plugin that builds, in the style the server's template uses
```

A plugin is JavaScript loaded into an installation to give workflows functions
— and agents tools — the platform does not ship: one ES module, one default
export extending `OrknuxPlugin`, evaluated in a sandbox with no network, no
filesystem and no module resolution. What `functions()` declares becomes
functions every workspace can call; what `tools()` declares becomes tools an
agent can be granted, most often the plugin's own functions fronted by an
`OrknuxFunctionTool` proxy.

[plugin/README.md](plugin/README.md) is how to write one. This file is how to
work on the library itself.

## The plugins

This repository is now the canonical home of the production plugins — they used
to live in the orknux-server repository. The admin Plugins page loads a plugin
straight from a raw URL, so each one below can be handed to it as it stands:

**[github](plugins/github/github.js)** verifies that a webhook delivery really
came from GitHub, by its HMAC signature, and turns GitHub's pull request, review
comment and push payloads into one flat answer a condition can read.

    https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/github/github.js

**[slack](plugins/slack/slack.js)** answers what a Slack payload alone cannot —
whether a message is the first reply in its thread, what a permalink points at,
who a user id is — by asking the server to read Slack through a connection the
workspace pointed it at. The three lookups are also fronted to agents as tools.

    https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/slack/slack.js

**[teams](plugins/teams/teams.js)** receives a Microsoft Teams outgoing webhook:
it verifies the HMAC signature Teams sends with every request, reads the sender
and the text off an activity, and builds the Graph request bodies and addresses
a reply is sent with.

    https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/teams/teams.js

**[confluence](plugins/confluence/confluence.js)** searches the wiki — plain
words or CQL — and opens a page whole: title, space, version and body.

    https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/confluence/confluence.js

**[jira](plugins/jira/jira.js)** finds issues by JQL, opens one whole, comments,
moves it through its workflow and raises new ones — the other half of the
sentence the github plugin starts.

    https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/jira/jira.js

**[jenkins](plugins/jenkins/jenkins.js)** answers the question asked in the
minute after a build goes red — the job's state, the build's result, the failing
tests, the end of the log — finds the job by name wherever it lives, reads the
test report a case at a time so "the build takes eighteen minutes" becomes "four
tests take eleven of them", and runs the job again. The log is fetched by its
tail rather than whole, because a console log is megabytes and a sandbox is not.

    https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/jenkins/jenkins.js

**[prometheus](plugins/prometheus/prometheus.js)** lists the metric names a
Prometheus knows and executes PromQL against it, so a condition can ask what the
running system is doing.

    https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/prometheus/prometheus.js

Each folder holds the plugin, its `plugin.json` marketplace manifest, the
`README.md` that manifest names and the two icons — one file each, as the
server loads them.

### What used to be here

`mermaid`, `plantuml`, `nomnoml`, `charts`, `pdf`, `markdown` and `date` were
plugins and are now the server's own. A drawing, a document and a calendar are
things the product needs rather than things a workspace chooses, and each was
paying the sandbox's price for it: a hand-written mermaid parser that knew five
diagram kinds, fonts carried as base64 subsets, a chart that could not get into
a page because the two bundles had a session store between them. The names an
agent calls are unchanged — `pdf_fromHtml` is still `pdf_fromHtml` — so nothing
written against them has to be rewritten. Their history is in this repository
up to the commit that took them out.

## Working here

There is no Node on the development machine. Everything goes through the compose
`dev` service:

```
docker compose run --rm dev npm install      # also builds the CLI, via prepare
docker compose run --rm dev npm test
docker compose run --rm dev npm run typecheck
docker compose run --rm dev npm run example  # builds examples/teammates
```

`npm install` builds the library on its way through, because the example and the
tests run the CLI by the name npm links it under — and npm will not link a bin
whose file is not there yet.

## What the tests are for

`plugin/test/bundle.test.js` is the one that matters. It bundles a plugin the
way the CLI does and then loads the result, which is the only thing that proves
the promise this library makes: that importing `@orknux/plugin` does not break
the check the server does.

The server checks the default export **by prototype** — `exported.prototype
instanceof globalThis.OrknuxPlugin`. A library that bundled its own copy of that
class would pass every type and fail that check. So `plugin/src/contract.ts`
exports a *binding* to the global rather than a class, and the fallback beneath
it — for tests and for `check`, where nothing has defined the globals — is a
copy of the server's own contract with its wording intact.

**That copy has to track the server.** It lives in `PluginRunner.CONTRACT` in
orknux-server, along with the loader's own checks; `plugin/src/validate.ts` is
the same again for `PluginDeclarations.validated`, `validatedTools` and
`validatedParameters`;
`plugin/src/limits.ts` holds the numbers both sides enforce and the two
vocabularies — `PluginPermission` and `PluginCapability` — a plugin declares
against; and the `orknux` helper types in `plugin/src/types.ts` and
`plugin/types/globals.d.ts` follow `HostHelpers` and the server's own template.
When one of them changes there, it changes here, and the tests are written in
the server's wording so a rewording shows up as a failure rather than as drift —
including `plugin/test/plugins.test.js`, which holds the three production
plugins in `plugins/` to the same answer the upload would give.

## Publishing

`plugin/` is the published package; the root is a private workspace root and is
not. `prepare` builds, `files` ships `dist/`, `src/` and `types/`, and the
version in `plugin/package.json` is the one that goes out.

A tag publishes it, and nothing else does:

```
# plugin/package.json first, then
git tag v0.1.0 && git push origin v0.1.0
```

CI refuses a tag whose number does not match `plugin/package.json` — a `v0.2.0`
tag over a `0.1.0` package would publish `0.1.0` again and say nothing — and
publishes only after the same commit has typechecked, passed the suite and built
the example.

It authenticates with an npm automation token in the repository's `NPM_TOKEN`
secret, so the first release needs two things done by hand: the `@orknux` scope
has to exist on npm, and the token has to be there. Publishing from a checkout
still works when it has to:

```
docker compose run --rm dev sh -c "cd plugin && npm publish --access public"
```

## Licence

Apache-2.0 — see [LICENSE](LICENSE). The server is AGPL-3.0 and this is not,
deliberately: a few lines of this library end up inlined in every plugin anybody
builds, and what their plugin is licensed under should be their decision.
