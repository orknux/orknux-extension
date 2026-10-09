# GitHub

GitHub is not a connection type and needs no trigger of its own: what an
installation already has is a webhook trigger, and this plugin is the other
half — verify the delivery is really GitHub's, then ask back. Search issues
and code, read a file at a ref, check what a build came to, and leave a
comment where the conversation is.

The functions serve workflows; the tools front them for agents, so a model
can work a repository the way a person does — look first, then speak. Calls
go through the server under `NETWORK_REQUEST`, against the token a workspace
variable holds.

## Twenty functions, eighteen of them tools

Everything except the webhook pair is fronted to agents. `verify` and
`describe` are a trigger's, not a model's: one is an HMAC check and the other
turns a payload into a row a condition can read.

Every function that names a repository takes `owner` and `repo` — and takes
them loosely, which the section after the tables explains.

### The webhook half

| Function | Answers |
|---|---|
| `verify(headers, rawBody)` | Whether a delivery really came from GitHub, by its HMAC signature. This is the function a webhook trigger authenticates with. Needs `webhookSecret`; needs no GitHub credential. |
| `describe(headers, body)` | What a delivery is about, flattened into one `Delivery` a condition can read: `event`, `kind`, `action`, `repository`, `actor`, `title`, `url`, `number`, `ref`, `commits`. The event name lives in the headers, which is why both are arguments. |

### Searching

All three take GitHub's own search syntax, and all three are scoped to
`organization` when the query does not say where to look.

| Function | Answers |
|---|---|
| `searchPulls(query, limit = 20)` | `total` and `matches` — `number`, `title`, `state`, `repository`, `author`, `updated`, `url`. Qualifiers: `repo:owner/name`, `author:login`, `is:open`, `review:required`, `"an exact phrase"`. |
| `searchCode(query, limit = 20)` | `total` and `matches` — `repository`, `path`, `url`, and the matching `fragments`. Qualifiers: `repo:owner/name`, `path:src`, `language:go`, `filename:Dockerfile`. |
| `searchCommits(query, limit = 20)` | `total` and `matches` — `repository`, `sha`, `message`, `author`, `date`, `url`. Qualifiers: `repo:owner/name`, `author:login`, `committer-date:>2026-01-01`. |

### Reading a repository

| Function | Answers |
|---|---|
| `listRepos(owner, limit = 30)` | Repositories, most recently pushed first: `name`, `fullName`, `description`, `defaultBranch`, `private`, `pushed`, `url`. An empty `owner` uses `organization`; with neither, whatever the token itself can see. Works for a user as well as an org. |
| `listFiles(owner, repo, ref = "")` | Every path at one ref, from the git tree: the `ref` read, the `files`, a `count`, and `truncated` where the tree was too large for GitHub to hand over whole. |
| `openFile(owner, repo, path, ref = "")` | One file as the text it is. `path` is from the repository root. |
| `fileHistory(owner, repo, path, limit = 20)` | The commits that touched one file, newest first: `sha`, `message`, `author`, `date`, `url`. |
| `openPull(owner, repo, number)` | One pull request whole — `title`, `body`, `state`, `draft`, `merged`, `author`, `baseRef`, `headRef`, `headSha`, `mergeable`, `additions`, `deletions`, `url` — **and its changed files, each with the patch GitHub shows as the diff.** One call, not a walk. |
| `openCommit(owner, repo, sha)` | One commit whole, the same way: `message`, `author`, `date`, `parents`, counts, `url`, and the changed files with their patches. Takes a ref that names a commit as well as a sha. |
| `reviews(owner, repo, number)` | Where a pull request stands with its reviewers: `approved`, who approved, who is blocking, who was asked and has not answered, and every review in order. GitHub keeps each review as an event — this resolves them to where each person **stands**. |
| `buildStatus(owner, repo, ref)` | What the builds say about one commit, combining the two things GitHub keeps apart: the commit **status** and every **check run**, in one answer. `overall` is `failure`, `pending`, `success`, or `none` where nothing has reported; `statuses` and `checks` carry each reporter by name. Takes a sha, branch or tag. |

### Copilot agent tasks

Starting a cloud agent, watching it, and steering it. See the caveat below
about which token these accept.

| Function | Answers |
|---|---|
| `createAgentTask(owner, repo, prompt, baseRef = "", model = "")` | Starts a task: the agent works the prompt on its own branch and opens a draft pull request. `model` picks who works it; empty uses `defaultModel`, or GitHub's own choice. Answers `id`, `state`, `url`, `created`. |
| `listAgentModels()` | The models Copilot offers the token's plan - `id`, `name`, `vendor`, `preview` - and the configured `defaultModel`. Read from `api.githubcopilot.com/models`, which the installation's proxy rules must allow. |
| `agentTask(owner, repo, taskId)` | The task as GitHub sees it now — `state` (`queued`, `in_progress`, `completed`, `failed`, `waiting_for_user`, …), its pull request, and its **sessions**, whose ids the next function takes. |
| `agentTaskLogs(sessionId)` | The log text of one session: the agent's own account of what it read, decided and changed. |
| `messageAgentTask(owner, repo, pullNumber, message)` | Steers a running or finished task — different approach, more work, a fix. Done the way GitHub does it: a comment mentioning `@copilot` on the task's pull request. |

### Writing back

| Function | Answers |
|---|---|
| `comment(owner, repo, number, text)` | The plain kind, under the conversation. Works on an issue as well as a pull request. `text` is GitHub markdown. Answers the comment's `id` and `url`. |
| `reviewComment(owner, repo, number, path, line, text)` | The review kind, anchored to a file in the diff. `path` is as `openPull` lists it; `line` is the line **in the new version**, or `0` to speak about the file as a whole. |
| `replyToComment(owner, repo, number, commentId, text)` | Replies in the thread under one review comment. `reviewComment` answers an id, and a `review_comment` webhook carries one. |
| `pullComments(owner, repo, number)` | What was said on a PR besides the review summaries: every comment on the diff grouped into threads, each with its file, line and whether it is resolved or outdated, and the comments under the conversation. `unresolved` counts the threads still open. Read through GraphQL, because only GraphQL knows a thread is resolved. Up to 100 threads and 100 comments; `truncated` says when there were more. |
| `approve(owner, repo, number, text?)` | Approves the PR as whoever the token belongs to, with an optional note. GitHub refuses an approval of a PR the token's own account opened. Answers the review as `reviews` lists it. |
| `editPull(owner, repo, number, title?, body?)` | Changes the title, the description, or both; leave either out to keep it. The description is replaced whole, so read it with `openPull` first to change part of it. Answers `number`, `title`, `body` and `url` as they stand afterwards. |
| `markReadyForReview(owner, repo, number)` | Takes a pull request out of draft — the site's *Ready for review* button. Answers `number`, `draft` and `url`; `draft: false` is the proof it moved. A PR already out of draft is answered as it is. |
| `convertToDraft(owner, repo, number)` | The reverse: back into draft while work goes on. |

## What "approved" means, and what it does not

GitHub keeps every review as an event, so the same person shows up as often as
they reviewed. Counting those events answers the wrong question — somebody who
asked for changes in the morning and approved after lunch would read as
blocking. `reviews` resolves the history the way GitHub itself does:

- an approval or a change request **replaces** that person's previous one
- a dismissal **clears** it
- a review that only comments **leaves it exactly as it was**

`approved` is then the useful boolean: somebody approved and nobody is standing
on changes requested. One blocker outweighs any number of approvals.

**It is not `mergeable`.** That field answers whether the branches conflict, and
a pull request can be `mergeable: true` with zero approvals and a branch rule
refusing it — reading it as "ready to merge" is the mistake this call exists to
stop.

`approvers` and `blockers` name the people, which is what a policy asking for
two approvals actually needs; `requested` and `requestedTeams` are the ones who
were asked and have not answered, which is who a nudge goes to.

## Naming a repository three ways

Every repository function takes the same pair, and accepts all of these:

```
openPull('acme', 'web', 42)     // owner and repo
openPull('', 'acme/web', 42)    // the whole thing in one, which is how people say it
openPull('', 'web', 42)         // owner from the `organization` parameter
```

That is deliberate. A model asked about "the web repo" writes `acme/web`
without being told to, and a workspace that lives in one organization should
not spell it into every call. An empty `owner` with no configured
`organization` is the one case that refuses, and says so.

The same fallback runs the searches: a query with no `repo:`, `org:`, `user:`
or `owner:` qualifier gets `org:<organization>` appended, so *"login bug"*
searches the org's work rather than all of GitHub.

## Parameters

| Name | |
|---|---|
| `webhookSecret` | The secret GitHub signs deliveries with. **Secret**, so a typed-in value is refused — a workspace variable is the only answer it takes. Only `verify` uses it. |
| `token` | A fine-grained personal access token, or a GitHub App user token. **Secret**. Every function except the webhook pair needs it. |
| `classicToken` | A classic personal access token with `repo` scope. **Secret**. Only `buildStatus` reaches for it, and only when `token` was refused — see below. |
| `defaultModel` | The model an agent task uses when the call names none, as `listAgentModels` spells it. Optional; empty lets GitHub choose. |
| `organization` | The owner to fall back to, as above. Optional. |
| `apiUrl` | Points the whole surface at a GitHub Enterprise Server. Empty means `api.github.com`. |

All five are optional at load: a workspace that only wants the webhook half
sets `webhookSecret` and nothing else.

### When `buildStatus` wants a classic token

The commit status endpoints refuse a fine-grained token in setups a classic
token still reads, and GitHub refuses it two ways. A token minted without the
*commit statuses* or *checks* permission draws a `403`. A token an
organization has not approved draws a `404`, because GitHub will not admit a
private repository exists to a token it will not show it to. Everything else
may keep working, and the one call that does not is the one a review most
needs.

So `buildStatus` asks under `token` first and, on a `403` or a `404`, asks
again under `classicToken`. Each of its two reads — the combined status and
the check runs — falls back on its own, because a token can be refused one and
not the other. Any other answer, and a refusal with no classic token
configured, is the error it always was. Nothing else in the plugin ever sends
the classic token.

## Setting up the webhook

1. Load the plugin (**Plugins → Load a plugin**) and accept `TEXT_ENCODING`
   and `NETWORK_REQUEST`.
2. Put the webhook secret in a workspace variable and point `webhookSecret`
   at it.
3. Make an object with `repository` and `sender` on it — what every payload
   has in common, and what the trigger checks an arriving body against.
4. Make a webhook trigger on that object, authenticating with the function
   `github_verify`.
5. In the repository's settings, add a webhook at the trigger's URL, content
   type `application/json`, with that same secret.

The run is handed the body, and `webhook.headers` beside it — which is where
GitHub says which event this is. `github_describe` turns the pair into one
flat answer a condition or an action can read.

## What it asks for, and why

`TEXT_ENCODING`, for `TextEncoder` and nothing else. GitHub signs the bytes it
sent, so the body has to become bytes the same way it was written — UTF-8 —
rather than by whatever a hand-rolled loop does with a character outside
ASCII. A pull request title with an accent in it is not an edge case.

`NETWORK_REQUEST`, the widest capability there is, asked for because this
plugin is about exactly one outside service: every request goes to the API
root above, which is GitHub's or the GHES the workspace named. The plugin has
no network of its own — the server makes each call on its behalf.

### Token access

| For | Access |
|---|---|
| Everything that reads | Read on the repositories it should see |
| `comment`, `reviewComment`, `replyToComment`, `messageAgentTask`, `approve`, `editPull`, `markReadyForReview`, `convertToDraft` | Write on pull requests |
| `buildStatus` | Read on commit statuses and checks — or, failing that, a `classicToken` with `repo` scope |
| The agent-task functions | A **user** token with Copilot access |

## Three caveats worth knowing before you debug them

**The Copilot agent API takes a user token only.** It is in public preview, and
a GitHub App installation token is refused by GitHub, not by this file. If
`createAgentTask` fails where everything else works, that is the reason.

**`listFiles` can answer `truncated: true`.** GitHub will not hand over a git
tree past a certain size, and a partial list presented as a whole one is worse
than a flag. Check it before concluding a path is absent.

**A `line` of `0` in `reviewComment` is a value, not a missing argument.** It
means *comment on the file rather than on a line*, which is a thing GitHub
supports and a thing reviewers do.

## The shapes it exports

Nineteen, so a workflow passes a pull request around rather than a bare map,
and a condition reads `.overall` instead of indexing into JSON.

| | |
|---|---|
| Webhook | `Delivery` |
| Pull requests and commits | `PullRequest`, `Commit`, `CommitSummary`, `ChangedFile` |
| Builds | `BuildStatus`, `Reporter` |
| Searches | `PullSearch`, `CodeSearch`, `CommitSearch`, and the `PullMatch`, `CodeMatch`, `CommitMatch` they hold |
| Listings | `RepoList`, `Repo`, `FileList`, `FileHistory` |
| Writing and agents | `Comment`, `PullComments`, `ReviewThread`, `ThreadComment`, `PullText`, `DraftState`, `AgentTask` |

`orkx plugin check` prints every field of every one of them.

## The skills it brings

**"Reviewing a pull request"** — how to read a PR properly before saying
anything about it.

**"Working with the Copilot coding agent"** — starting a task, following it,
and steering it without losing it. A fix to a pull request Copilot opened goes
to that pull request's session with `messageAgentTask`, never to a new PR or a
new task. Handing work over is said first - what was done and the session
link - and only then is the PR followed. Once Copilot has finished, the build is green and a review finds
nothing to object to, the agent takes the PR out of draft with
`markReadyForReview` - and leaves it a draft otherwise.

**"Getting a pull request build green"**, id `autofix-build` — waiting for a
PR's checks with `finish_answer`'s `wake_after_ms` rather than polling, reading
which check failed and what it said, and then either fixing it or handing it to
Copilot with `messageAgentTask` on that same pull request. Never
`createAgentTask` for a fix: that opens a second draft PR, and then the red one
is still red. On green, a Copilot draft that a review finds nothing wrong with
is taken out of draft. It pins its id, because an agent node watching a PR
names it.

All three are granted like any other skill catalog; nothing is automatic.

## How it is laid out

One library travels with the file, and `libraries()` declares it: `lib/api.js`
— the door every REST call goes through, and the readers every answer is
picked apart with. What stays in `github.js` is what the plugin *declares*,
which is the part somebody loading it reads.

Written as JavaScript rather than TypeScript compiled to it: the server runs
JavaScript, and a plugin somebody may need to load in a hurry should not need
a build first.
