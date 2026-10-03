# Jenkins

The question asked in the minute after something goes red: which job, which
build, what broke, and can it be run again. It is answered today by somebody
opening a browser tab, and the answer is nearly always one of four things — the
job's state, a build's result, the failing tests, the last hundred lines of the
log.

Every call is made by the server on the plugin's behalf under
`NETWORK_REQUEST`, against the Jenkins connection the call names - every
function takes it as its first argument, `jenkins`, so one workspace can drive
as many controllers as it has.

| Function | |
|---|---|
| `jobs(jenkins, folder, limit)` | What is on the Jenkins, or inside one folder. `more` says whether there were others. |
| `search(jenkins, query, limit, folder)` | A job by name, wherever it lives — folders included. |
| `job(jenkins, job)` | One job whole, including the **parameters** a build takes. Read this before triggering. |
| `build(jenkins, job, which)` | One build: result, duration, what caused it, and the commits in it. |
| `buildLog(jenkins, job, which, lines)` | The **end** of the console output, which is where a build says why it stopped. |
| `testResults(jenkins, job, which, limit)` | The counts, and the failing cases by name with their messages. |
| `testCases(jenkins, job, which, order, limit)` | Every test, one by one: what it cost, what it did, how long it has been failing. |
| `trigger(jenkins, job, parameters)` | Asks for a build. Answers a queue item, not a build. |
| `queueItem(jenkins, item)` | Whether that queued build has started, and what number it got. |

All nine are fronted to agents, and two skills travel with them: one on
triaging a failure without dragging a megabyte of log into the answer, one on
what triggering actually does.

## Naming a job, and naming a build

`job` takes whatever names it, which is usually whatever somebody pasted:

```
job(ci, 'deploy')                                        // a job at the top level
job(ci, 'platform/services/deploy')                      // a path through folders
job(ci, 'https://ci.example.com/job/platform/job/deploy/')
job(ci, 'https://ci.example.com/job/deploy/412/')        // a link to a build
```

Folders nest, and a folder is **not** listed into: `jobs()` answers it with
`folder: true`, and passing that name back lists what is inside it. That is one
call per level, deliberately — and `search` is the other way to do it, which
reads several levels at once and matches on a name rather than walking them.

`which` takes a build number as a string, or one of Jenkins' own permalinks —
`lastBuild`, `lastCompletedBuild`, `lastStableBuild`, `lastSuccessfulBuild`,
`lastFailedBuild`, `lastUnsuccessfulBuild` — and is `lastBuild` when it is not
given. A url that names a build answers that build whatever `which` says,
because a link to build 412 is a link to build 412.

**Only the path is read out of a url; the host is not.** Every request goes to
the connection the call names, so a link to a *different* Jenkins names a job
on that one, or nothing at all - pass the connection the link belongs to.

## Searching, and why not Jenkins' own search

`search` takes words rather than a path: every one of them has to appear
somewhere in a job's full name or its description, in any order and whatever
the capitals, so `search(ci, "deploy prod")` finds `platform/prod/deploy-api` and
leaves `deploy-staging` alone.

Jenkins has a search of its own — `/search/suggest` — and it is the wrong one
to build on. It answers **display names**: a job in a folder comes back as
`folder » job`, which is not a path anything can then be asked about, and it
says nothing about whether what it found is passing. So `search` reads the job
tree instead, three levels of folders deep in one request, and matches here —
which costs one call and answers the same `Job` shape `jobs` does, status and
last build included.

Three levels is where real installations stop: team, product, branch. A job
deeper than that is not found rather than found slowly, and `folder` is how to
start further in — which is also the answer on a controller too large to read
in one go.

## Looking at the tests one by one

`testResults` answers the shape of a failure. `testCases` answers the shape of
the **run**: every case, what it cost, and how long it has been failing.

| `order` | |
|---|---|
| `slowest` | the default — what the build is spending its time on |
| `failed` | failures and regressions, slowest first |
| `flaky` | only what has been failing for more than one build, oldest first |
| `name` | alphabetical, which is what comparing two builds wants |

"The build takes eighteen minutes" becomes "four tests take eleven of them",
which is something somebody can act on; a log cannot answer that, because a
log says when things happened and not what they cost.

`age` is Jenkins counting something nothing else here can: how many builds a
test has been failing for. 1 means this build broke it. 11 means eleven builds
have been red and nobody looked, which is a different conversation.

**Durations come back in milliseconds**, converted. Jenkins times a build in
milliseconds and a test case in seconds, in the same API, and says so nowhere
— so a plugin that passed both through unchanged would be handing somebody a
trap to fall into once.

## Two answers Jenkins gives that are not answers

**A job's status is a colour.** `blue` is passing, `red` is failing, `yellow`
is unstable, and an `_anime` suffix means it is building right now — so
`red_anime` is "failing, and currently building". Nobody should have to know
that: `status` is a word here (`passing`, `failing`, `unstable`, `aborted`,
`never built`, `disabled`) and `building` is a boolean beside it.

**A link Jenkins writes points wherever its administrator said it lives**,
which on a great many instances is still `http://localhost:8080`. So every
`url` answered here is built from the connection's URL, which is the one
address known to work — it is the one the answer just came back from.

## The log is fetched by the tail, not by the whole

A console log runs to megabytes, and everything handed to a plugin has to fit
in a sandbox. So `buildLog` asks Jenkins how long the log is — `progressiveText`
says so in a header, and takes a byte offset — and fetches only a window off
the end of it. A 40 MB log costs a window rather than 40 MB.

Where that header does not come back — an old controller, a proxy that drops
it, a `HEAD` nobody answers — the whole console is fetched and cut here
instead. Same answer, dearer.

`truncated` says there is more above what came back. There is deliberately no
call that answers a whole log: if the tail does not say, ask for more lines,
and quote the `url` so a person can read the rest.

## The shapes it exports

`Job`, `Jobs`, `Parameter`, `Build`, `Change`, `Log`, `Tests`, `Failure`,
`Case`, `Cases`, `Queued` — so a workflow passes a build around rather than a
bare map, and a condition reads `.result` instead of indexing into JSON.

`Job` is one shape for both calls that answer a job, the way jira's `Issue` is:
a listing leaves `buildable`, `inQueue`, `health` and `parameters` empty rather
than absent, so a caller reading `parameters` gets a list either way instead of
finding out which call it came from. `orkx plugin check` prints every field.

## Setting it up

It brings a connection kind of its own, **Jenkins**. Add one per controller,
with its root as the URL — `https://ci.example.com`, or
`https://example.com/jenkins` where it is served under a path. Each call then
names the one it asks in its `jenkins` argument - picked from a list in a
workflow, passed by id from an agent. There is nothing to configure on the
plugin's own page.

| Auth | |
|---|---|
| Basic | `user:apiToken` as the secret. Jenkins authenticates a token *as somebody*, so the user is part of the credential. Make the token on that user's own configuration page; a password works on most instances and should not be used. |
| None | An instance read anonymously, which is a real way to run a public Jenkins and no way at all to trigger a build on one. |

The address and the credential live on the connection rather than on the
plugin's page, so they are kept encrypted, and a workspace can hold as many
controllers as it has.

**Coming from 0.3:** the plugin's `jenkins` parameter is gone, and every
function takes the connection as its first argument instead. A workflow calling
one needs that argument set to the connection the parameter used to name.

**Coming from 0.2:** the `url`, `user` and `token` parameters are gone. Make a
Jenkins connection from them — Basic auth with `user:token` as the secret, or
no auth where both were empty — and pass it as `jenkins`.

## What it asks for, and why

`NETWORK_REQUEST`, and nothing else. It is the widest capability there is,
asked for because this plugin is about exactly one outside service — every
request goes to the connection a call names. The plugin has no network of its own;
the server makes each call on its behalf.

**No permission at all.** The connection's credential arrives already spelled
as an `Authorization` header, so there is nothing left in the plugin to
encode.

## The CSRF crumb, and why a POST fetches one first

Jenkins protects against cross-site request forgery with a crumb: a token read
from `/crumbIssuer/api/json` and sent back on every POST. Since Jenkins 2.96 a
request authenticated with an **API token** is exempt, so most of the time that
extra GET answers nothing and costs a round trip.

`trigger` makes it anyway, because the instances where the exemption does not
hold — a password used in place of a token, an older controller, a proxy that
loses the distinction — fail with a 403 and an HTML page behind it, which is
the least debuggable answer Jenkins has. A crumb issuer that refuses, or is not
there, is not treated as an error: it means CSRF protection is off, or that
this credential may not ask, and the POST that follows says so itself.

## A caveat worth knowing before you debug it

**A queue item is not a build, and it does not last.** `trigger` answers a
queue id because that is all Jenkins knows yet: the build has been put behind
whatever else is waiting for an executor. `queueItem` says where it got to —
and Jenkins forgets an item about five minutes after the build starts, so past
that it answers that it is gone and points at the job's `lastBuild` instead.

Nothing here polls, because nothing in a plugin can wait: `run` is synchronous
and there is no sleep in the sandbox. A workflow that must act on a result
checks back on its own schedule, or lets the job say so — a post-build step
calling a webhook beats anything that sits and asks.
