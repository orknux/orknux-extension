# Working in orknux-extension

Notes for anyone — human or agent — changing this repository. See
[README.md](README.md) for what it is, and [plugin/README.md](plugin/README.md)
for what it is like to use.

## Commands

There is no Node on the development machine; the toolchain runs in a container.

```
docker compose run --rm dev npm install
docker compose run --rm dev npm test          # builds, then node --test
docker compose run --rm dev npm run typecheck
docker compose run --rm dev npm run example
docker compose run --rm dev npm run build:plugins   # the plugins that bundle libraries
docker compose run --rm dev npm run build:icons --workspace @orknux/plugins
docker compose run --rm dev npm run pack --workspace @orknux/plugins
```

`plugins/pack.sh` and `plugins/pack.ps1` wrap that last one for a POSIX shell
and for PowerShell, so packing is one command from either:

```
plugins/pack.sh github        # or .\plugins\pack.ps1 github
plugins/pack.sh               # every plugin
```

`npm test` builds first on purpose: the tests import `dist/`, not `src/`, so what
they exercise is what gets published — including the `.d.ts` emit, which is half
of what this package is.

## The rule this repository exists to keep

The server defines `OrknuxPlugin` and `OrknuxFunction` in the sandbox and then
checks a plugin's default export by prototype. **Nothing here may ever bundle a
class of its own into a plugin.** `src/contract.ts` exports bindings to the
globals; the fallback classes beneath them exist for Node, where the globals are
absent, and they are a copy of the server's `PluginRunner.CONTRACT` — wording
included, because the wording is what somebody reads when their plugin is
refused.

Five files mirror the server, and drift in any of them is a broken promise:

| here                  | there                                     |
|-----------------------|-------------------------------------------|
| `src/contract.ts`     | `PluginRunner.CONTRACT`, `HostHelpers`    |
| `src/inspect.ts`      | `PluginRunner.read`                       |
| `src/validate.ts`     | `PluginDeclarations.validated`, `validatedTools` and `validatedParameters`, `PluginPermissions`, `PluginCapabilities` |
| `src/limits.ts`       | `PluginApiVersions`, `PluginUploadAPI`, `PluginRunner`, `PluginPermission`, `PluginCapability`, `ConnectionType` |
| `types/globals.d.ts`  | the TypeScript template `PluginUploadAPI` serves |

Where this is deliberately stricter than the server, the comment says so and
says why — a parameter typed `none` is the one such place today. Stricter is
allowed, because it can only refuse something no plugin should be doing.
Looser is not: the whole point is that a plugin which passes here is one the
upload accepts.

## A parameter that is a closed choice says so

`options: ['tavily', 'brave']` on a plugin parameter replaces the plugin
checking the string itself and throwing a sentence listing the choices — see
`plugin/PARAMETERS.md`. Not on a `secret`, which cannot be one of a set
somebody can read, and not on a `connection`, which already has its own picker.

**The runtime check stays for now.** The server stores `options` but the
settings page does not draw a picker yet, so a text box can still hold a typo —
and falling through to the wrong backend silently is worse than being told. The
check comes out when the picker lands.

**`required` and `default` on a function parameter are accepted now**, and the
sentinel convention they replaced is gone: twenty-two parameters carry a
default, and the "0 for the default" and "an empty string to use the configured
one" sentences came out of the descriptions with them. Those sentences lived in
tool descriptions a model reads on every call, so they cost context repeatedly
and told it to do something it reliably got wrong.

Three things to keep in mind when adding one:

- **The server puts the default in before the call**, so `run` still receives
  every argument. There is no `undefined` to guard and no `limit || 20` to
  write — `pageSize` in the github library lost its fallback parameter for
  exactly this reason and now only caps.
- **Optional parameters go last.** Arguments are positional, so "may be left
  out" means nothing in the middle, and validate refuses a required one after
  an optional one. That is why `connection` — first in every slack function —
  is still required and still takes an empty string: making it optional would
  mean reordering, and reordering breaks every workflow already calling it.
- **A default must be of the parameter's own type**, and a default alongside
  `required: true` is refused rather than ignored.

## Conventions

- **The main entry point must stay bundle-safe.** `src/index.ts` may import
  nothing that touches Node — no `node:fs`, no esbuild, no dynamic import.
  Anything that does goes behind `@orknux/plugin/tooling`, which a plugin never
  imports. A regression here is not a type error; it is a plugin bundle that
  tries to inline esbuild.
- **Types carry the declaration into `run`.** `params` is a tuple, captured with
  a `const` type parameter, and `OrknuxArgs` reads the argument types off it.
  That is the feature; anything that erases it back to `unknown[]` has removed
  the reason to use this over the server's template.
- Comments say why, not what. TSDoc on everything exported.
- No dependencies but esbuild, and it is only reached from the tooling entry
  point. A plugin toolchain that pulled in an argument parser would be a
  dependency in every plugin project for the sake of three flags.

## Drawing is the server's, because nothing here can

`orknux.render.pngFromSvg` turns markup into a picture under `RENDER_PNG`. It is
a capability rather than a library for a reason that will not change: the
sandbox has no rasteriser, no canvas, no WebAssembly to carry one in, and a 5 MB
ceiling that a rasteriser passes before it does anything.

**No plugin here draws through it any more.** `mermaid`, `plantuml`, `nomnoml`,
`charts` and `pdf` were the callers, and the server embeds all five now - so
what is written below is the contract a *third-party* plugin is offered, and the
reason it is worth keeping written down rather than deleted with them.

It is also the narrowest grant on the list. What crosses is bytes a plugin just
produced and what comes back is bytes computed from them - no connection, no
address, no credential - which is worth remembering when weighing whether
something else belongs under the same grant rather than a new one.

There are two grants rather than one. `RENDER_PDF` is its own, and the reason
is worth keeping: the reach is identical - nothing - but the parser is not. A
PDF carries an embedded-file model, an encryption model and a font stack, and
an operator may reasonably draw markup without handing documents to one. Reach
answers what a capability can get at and says nothing about what it can be
handed.

`RENDER_PDF` covers both questions about a document - `pngFromPdf` for how a
page looks and `htmlFromPdf` for what it says - and deliberately so. Same
parser, same embedded-file and encryption and font models, same risk surface:
a second capability would ask an operator to weigh a distinction that is not
there.

`plugin/RENDERING.md` has all three doors and what they answer, with the pdf
plugin's two halves as the worked example - the plugin has gone to the server,
and the shape it showed is the shape any plugin handling bytes wants.

## Crypto is arithmetic, not a grant

`orknux.crypto` — `hash`, `hmac`, `pbkdf2`, `random`, `timingSafeEqual` —
needs no permission and no capability, and `plugin/CRYPTO.md` says why: a
digest reaches nothing, sends nothing and learns nothing. Making a plugin
declare something to compute a SHA-256 would be a dialog with no decision
behind it, and one nobody can answer is one they learn to click through.

Everything crosses as base64, or as `{ text }` for a plugin that would rather
not ask for `TEXT_ENCODING`. Every call answers `{ base64 }` or `{ error }` —
a refusal is data, never a throw.

**`orknux.encoding` is next door, and deliberately not part of it.**
`encodeBase64` and `decodeBase64` are an encoding, not cryptography: nothing
about base64 is secret, keyed or one-way, and filed beside the digests it would
teach the misconception that base64 is a kind of protection. Ungranted for the
same reason crypto is — and that is what let confluence, jira and prometheus
drop their hand-rolled alphabets **and** stop declaring `TEXT_ENCODING`
entirely, because building a Basic credential is now one ungranted call. Seven
of the twelve plugins now ask for no permission at all.

**It replaced two hand-written SHA-256 implementations**, in github and teams,
and took four hundred lines with it. That is not only less code: hashing by
hand cost roughly a thousand statements per 64 bytes, so a large webhook
payload ran the sandbox out of budget and the delivery was refused — a limit
that is simply gone. And `timingSafeEqual` is genuinely constant-time, which a
comparison written in JavaScript stops being the moment a JIT has looked at it.

`src/hosted.ts` is the piece worth knowing about. Crypto is the one helper the
bundle-safe fallbacks cannot honestly stand in for: the Slack calls and the
HTTP door refuse outside the sandbox because they reach something a test has no
business reaching, but crypto reaches nothing — so a plugin verifying a webhook
signature would be untestable while it refused. The Node-only entry point
installs a real implementation, bounded exactly as the server bounds it, which
is why `plugins.test.js` can sign a body and check that github and teams accept
it and refuse a forgery. **That file may never be reached from `src/index.ts`**
— it imports `node:crypto`, and the main entry has to stay bundle-safe.

## What a plugin's folder carries

Every directory under `plugins/` holds the same four things, and
`manifests.test.js` checks that it does:

| file | |
|------|---|
| `<name>.js` | the plugin, as the server loads it — one file, no imports it cannot resolve |
| `plugin.json` | the marketplace manifest |
| `README.md` | the long description, as markdown, which the manifest names |
| `icon.svg` | the face beside the name, drawn in `currentColor` so one file suits a light listing and a dark one |
| `lib/`, `src/` | libraries it ships with, or the source a built plugin is bundled from |

Eight of the icons are the real marks, from two collections, and
`plugins/icons.mjs` writes them all — `npm run build:icons` regenerates them,
so do not hand-edit those eight.

Six come from [simple-icons], which is CC0 while each trademark stays its
owner's. **Slack's and Microsoft's come from [Font Awesome Free] instead**,
which is CC BY 4.0 — so those two files carry the attribution the licence asks
for, in a comment. simple-icons will not carry either mark: Slack asked for
theirs to be removed and Microsoft's went the same way. What Font Awesome
publishes is its own monochrome rendering of each, under a licence that permits
redistributing it, and the difference from the vendors' own artwork is worth
stating rather than glossing. Anyone wanting the exact assets should take them
from those brand portals under those companies' terms and drop them in over the
file; the manifest already points at `icon.svg`. `teams` wears the Microsoft
mark because no Teams-specific glyph is published.

Every plugin here fronts a service with a mark of its own today. A plugin that
does not has its glyph drawn in `icons.mjs` beside the rest rather than
hand-written beside itself, which is how an icon ends up with one variant
instead of two.

**Every plugin ships two icons, and that is not decoration.** `icon.svg` is
the dark glyph for a light listing — what the manifest names — and
`icon-white.svg` is the same glyph in white for a dark one. The marketplace
finds the second by that suffix; only the first is ever named.

They carry a real colour on a fill or a stroke, never `currentColor`. That was
the first attempt and it is wrong: a marketplace renders an icon with `<img
src="icon.svg">`, and an SVG loaded that way is its own document — it inherits
no `color`, resolves `currentColor` to black, and shows an empty square on a
dark listing. It only ever looked right because the page it was checked on
inlined the markup.

`manifests.test.js` holds both halves: both files must exist, neither may
mention `currentColor`, and each must declare a colour of its own.

[Font Awesome Free]: https://fontawesome.com
[simple-icons]: https://simpleicons.org

`plugin.json` is the marketplace's file, not ours: its shape is
`plugins/plugin.schema.json`, copied from that service so editors validate
against it and so the test can. `plugins/plugin.example.json` is a filled-in
one to copy when writing a new plugin.

## Release notes are the bump commit

The marketplace shows, beside each release, what that version changed. Those
notes are sent at publish time by the workflow, and where they come from is
this:

> the commit that set the version in `plugins/<key>/plugin.json`

found with `git log -S` on the version string, subject and body both. Nothing
is written twice and nothing beside the plugin can go stale, because there is
only one copy of the sentence and it is the one in the history.

**So a commit that bumps a version is published prose.** Write it for somebody
deciding whether to update, not only for whoever reads `git log` — say what
changed, and say what it was like before if that is what makes the change make
sense. The commits here already read that way; this is why it matters that
they keep to it.

A version bumped in a commit that changes several plugins gives all of them
the same note. That is honest where the change really was one change, and a
reason to bump separately where it was not.

Notes are derived from the version rather than from the run, so every publish
sends them for every plugin — a plugin republished unchanged is sent the same
words it already had. That is what makes it safe to run twice, and it is why a
listing that has no notes yet gets them at the next release rather than waiting
for its own next bump.

**A descriptor cannot carry them, and that is deliberate.** `plugin.json` used
to take a `notes` string, and it beat the field a publish sent; the marketplace
took the field out of the schema and now ignores the key. The reasoning is worth
keeping, because it is the same reasoning this section rests on: everything else
in a descriptor is what the plugin *is*, the same wherever the zip is opened,
while a release note is what one upload was *for*. Leaving it in the descriptor
meant a commit to say what the last commit did, and then another publish to
carry it.

So `manifests.test.js` still fails if a manifest writes `notes`, for a changed
reason: not that it would quietly win, but that it would quietly do nothing
while looking like the place the sentence lives.

The cap is 4000 characters. A commit body longer than that is cut on a
paragraph and says at the end that it was — prose that stops mid-sentence reads
as a bug, so it would be one.

There is no catalog above these, and there should not be one: a plugin is
described in its own folder and nowhere else, so what is on offer is whatever
carries a `plugin.json`. A list at the root repeating the same prose is one
more thing to write and one more thing that can disagree with the code.

The manifest is prose, with one exception. The marketplace does not read what a
plugin will ask to be allowed and does not vouch for it — permissions,
capabilities and libraries are discovered by the installing server from the
code itself, in its sandbox, when somebody accepts them. The one claim checked
is `key`, which must be what `id()` answers, because a listing keyed
differently from the code is a listing that installs as something else. That
check is the reason `manifests.test.js` exists.

**A function may return a shape the plugin exports.** That is what
`objects()` is for, and `jira` is the plugin that shows it: `openIssue` answers
`Issue`, and a tool fronting it inherits that return because a proxy carries the
function's own. Inside the plugin a shape is spelled as it was declared; the
loader rewrites it to `jira_Issue` when it stores it. A *parameter* still may
not name one — the mirror refuses it whatever the server does, because stricter
is the safe direction for this file to be wrong in.

**A plugin that knows how its work should be done says so in `skills()`.**
A tool description is read one at a time, at the moment of calling, by a model
that has already decided to call something. The decisions worth changing happen
earlier — before the first step, or in the gap between two calls — and a skill
is the only surface read then. So the rule of thumb: if the guidance is *what
this argument means*, it belongs in the tool description; if it is *when to
reach for this at all*, or *what to check first*, it is a skill.

Write the description as the line a model chooses from with the page still
closed — "What to do when a release is bad" earns the click and "Deploy skill"
does not — and leave the frontmatter out, because the server writes it from the
name and description and stating the same two facts twice is how they drift.

**An example in a skill is written the way a model has to emit it**: the tool's
name and a JSON object with double-quoted argument names. Not
\`slack_post(connection, channel, text, '', [])\`. That reads as a signature and
it is one - a *workflow function* takes its arguments positionally, and the
README is where that belongs - but an agent sends a name and an object, and a
page showing it otherwise is teaching a shape whose nearest rendering is
malformed JSON. Single quotes are the sharp end: a model that copies \`''\` into
its arguments sends something no parser accepts, and what comes back is a
truncated call and a 500 nobody can read.

**A skill may not name another skill.** A page that names a sibling by title is
not a cross-reference, it is a pointer, and a model holding `skill_load` follows
pointers: one page saying "this is the opposite of *Posting to Slack so people
read it*" sends it to load that page, and two pages naming each other are a
cycle a model can spend a whole turn inside. Both were written here on
2026-09-27 and both came straight back as loops in somebody's channel. Say the
rule in the page that needs it, in its own words, however much that repeats the
page next door - repetition between two skills costs a paragraph, and a pointer
costs a turn.

Give a skill an `id` where anything points at it. The id is what a workflow node
naming skills to load holds, what `skill_load` is asked for, and what a person
writes after the workspace's command marker in a message. Say nothing and the
server derives one from the name, which changes the moment the name does and
quietly breaks every graph and every command that named the old one.

**Packing is driven by the manifest, never by walking the folder.**
`plugins/pack.mjs` puts the plugin, its `plugin.json`, the README that manifest
names, the icon and the libraries `libraries()` declares at a zip's top level —
and nothing else, so nothing a folder happens to hold can travel with it. Each
plugin is inspected first, the way the server inspects it, so
packing fails on something the server would refuse rather than producing a zip
that fails at the upload. Zips land in `plugins/dist/`, which is ignored, and
are deterministic — every entry carries a fixed 1980 timestamp, so the same
input packs to the same bytes and a zip that differs is a plugin that changed.

**A plugin that bundles a library is a build.** Its source lives in `src/` and
the checked-in `<name>.js` beside it is the artifact — so the artifact is what
the tests load, what a URL serves, and what the manifest's `path` names.
Editing the artifact by hand is editing a bundle. `plugins/build.mjs` mirrors
the tooling's own bundler settings; where it differs — minification, the
`browser` exports condition, the `.ttf` loader, the `fs`/`path` stubs — the
comment there says why.

## Tests

`node:test`, in plain JavaScript against `dist/`. Written in the server's own
wording — `assert.match(problem.message, /is not a usable function name/)` — so
that a message changing there shows up here as a failure rather than as two
products saying different things about the same refusal.

`cli.test.js` runs the real binary and reads the report back. The CLI is the
whole product for somebody checking a plugin before an upload, so a surface it
declares and the report omits is one they learn about from an administrator
instead — which is exactly how libraries, skills and objects went missing for a
while. They landed in the contract, the validation and the tests, and nothing
ever asked the CLI to show them.

`bundle.test.js` is the important one: it builds each fixture the way the CLI
does and then loads the result. `fixtures/imported.ts` proves the import style
survives bundling, `fixtures/ambient.js` proves the no-imports style still
loads, `fixtures/shaped.js` proves that something merely shaped like a plugin is
refused, and `fixtures/reaching.js` proves that a plugin reaching for Node fails
the build rather than the server.

## Releasing the plugins

A `plugins-v*` tag packs every plugin and attaches the zips to a GitHub
release — `.github/workflows/plugins.yml`. A separate namespace from `v*`,
which is the *library's* version: the plugins carry their own versions in their
own `plugin.json` files and change far more often, so tagging the library to
ship a slack fix would say something untrue.

```
git tag plugins-v2026.09.19 && git push origin plugins-v2026.09.19
```

Running it from the Actions tab instead makes no release and leaves the zips as
a build artifact, which is what checking the pack still works wants.

Two guards run before anything is published. The **rebuild check** runs
`build:plugins` and `build:icons` and fails on any diff — a zip is packed from
the checked-in artifact, so an artifact that no longer matches its source would
otherwise ship silently. The **zip check** opens each zip and runs the CLI's
`check` on the plugin inside, so a zip holding something the server would refuse
fails before the release exists rather than on somebody's installation.

The zips stay out of the repository on purpose: they hold only files that are
already committed, in a form git cannot delta, and `pdf` alone is 1.6 MB that
would be rewritten whole every time it is rebuilt.

## Releasing

The version in `plugin/package.json` is the one published, and a `v*` tag is what
publishes it — CI checks that the two agree and refuses the tag if they do not.
The plugin API version this package targets is `API_VERSION` in `src/limits.ts`,
and it is unrelated to both on purpose: this package can go out several times
against one plugin API.

When `API_VERSION` moves, the `plugin API` badge in both READMEs moves with it.
It is a static badge — there is nothing to read it off — so it is the one number
here that can drift without a test noticing.
