/*
 * GitHub, as a plugin.
 *
 * GitHub is not a connection type and there is no GitHub trigger. What this
 * installation already had was a webhook trigger that answers on a path, checks
 * an arriving body against a shape, and asks a function whether the caller may
 * start anything. The first half of this file is that function, and knows
 * GitHub's three payloads well enough to say what one of them is about. The
 * second half faces the other way: functions that ask GitHub's REST API
 * questions — and post answers back — fronted as tools so an agent can work a
 * repository the way a person at the site would.
 *
 * The whole integration is therefore a file somebody loads and a workspace
 * points a trigger at. Nothing about GitHub is in the server, which is the point
 * of it being here: a repository host that changes its signature scheme is a new
 * version of this file, not a release.
 *
 * ## Setting one up
 *
 * 1. Load this plugin (Plugins, Load a plugin) and accept TEXT_ENCODING.
 * 2. Put the webhook secret in one of the workspace's variables, and point the
 *    plugin's `webhookSecret` parameter at it. It is declared as a secret, so a
 *    typed-in value is refused — a variable is the only answer it takes.
 * 3. Make an object with `repository` and `sender` on it, which is what every
 *    payload below has in common and is what the trigger checks an arriving body
 *    against.
 * 4. Make a webhook trigger on that object, authenticating with the function
 *    `github_verify`.
 * 5. In the repository's settings, add a webhook pointing at the trigger's URL,
 *    content type `application/json`, with that same secret, sending pull
 *    requests, pull request review comments and pushes.
 *
 * The run is handed the body, and `webhook.headers` beside it — which is where
 * GitHub says which event this is. `github_describe` turns the pair into one
 * flat answer a condition or an action can read.
 *
 * ## The API surface
 *
 * The webhook half needs no credential of GitHub's; everything else here does.
 * Those functions ask GitHub's REST API — search, repositories, pull requests,
 * commits, builds, files, comments, and the Copilot agent tasks — and a plugin
 * has no network, deliberately and permanently. So each call is made by the
 * *server* on the plugin's behalf, under the NETWORK_REQUEST capability a
 * person accepted, authenticated with the `token` parameter: a fine-grained
 * personal access token (or a GitHub App user token) with read access to the
 * repositories it should see, and write access to pull requests where the
 * commenting and the agent tasks are wanted. Declared as a secret, so it lives
 * in a workspace variable, never typed into a page.
 *
 * `classicToken` is a second credential for one corner of the API. The commit
 * status endpoints refuse a fine-grained token in setups a classic token
 * still reads: a token minted without the commit statuses or checks
 * permission draws a 403, and one an organization has not approved draws a
 * 404, since GitHub will not admit the repository exists to it. So
 * `buildStatus` asks under `token` first and, on either, asks again under the
 * classic one. Nothing else reaches for it, and a workspace whose
 * fine-grained token reads builds fine never sets it.
 *
 * `organization` is the owner every function falls back to when a call does not
 * name one — so "search the backlog" does not need the org spelled into every
 * query — and search queries that do not say where to look are scoped to it.
 * `apiUrl` points the whole surface at a GitHub Enterprise Server instead of
 * api.github.com.
 *
 * The agent-task functions drive GitHub's Copilot cloud agent. That API is in
 * public preview and only answers a *user* token — a GitHub App installation
 * token is refused by GitHub, not by this file. Steering a task that is already
 * running is done the way GitHub does it: a comment on the task's pull request
 * mentioning @copilot, which is what `messageAgentTask` posts.
 *
 * ## How the plugin is laid out
 *
 * One library travels with this file, and `libraries()` declares it:
 * `lib/api.js`, the door every REST call goes through and the readers every
 * answer is picked apart with. What stays here is what the plugin *declares*,
 * which is the part somebody loading it reads.
 *
 * There used to be a second, `lib/hashing.js`, holding SHA-256 and HMAC
 * written out longhand because the sandbox had no crypto. `orknux.crypto`
 * replaced it. That is not only less code: hashing by hand cost roughly a
 * thousand statements per 64 bytes, so a payload in the hundreds of kilobytes
 * ran the sandbox out of budget and the caller was refused — a limit that is
 * simply gone now, along with the advice to narrow which events the webhook
 * sends. The constant-time comparison is better too: one written in
 * JavaScript stops being constant-time the moment a JIT has looked at it.
 *
 * Written as JavaScript rather than as TypeScript compiled to it: the server
 * runs JavaScript, and a plugin somebody may need to load in a hurry should not
 * need a build first.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  at,
  call,
  changedFile,
  escapedPath,
  header,
  ownerOr,
  pageSize,
  read,
  readOrClassic,
  repoNamed,
  repoPath,
  scoped,
  statusError,
} from './lib/api.js';

/**
 * A hex digest as the base64 of the same bytes.
 *
 * GitHub spells its signature in hex and `orknux.crypto` answers base64, so
 * one of them has to be converted before they can be compared as bytes. Null
 * for anything that is not an even run of hex digits, which is not a
 * signature this would have vouched for anyway.
 */
function hexToBase64(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return null;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  for (let at = 0; at < hex.length; at += 2) {
    bytes.push(parseInt(hex.slice(at, at + 2), 16));
  }
  let written = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const one = bytes[at];
    const two = at + 1 < bytes.length ? bytes[at + 1] : 0;
    const three = at + 2 < bytes.length ? bytes[at + 2] : 0;
    written += alphabet[one >> 2] + alphabet[((one & 3) << 4) | (two >> 4)];
    written += at + 1 < bytes.length ? alphabet[((two & 15) << 2) | (three >> 6)] : '=';
    written += at + 2 < bytes.length ? alphabet[three & 63] : '=';
  }
  return written;
}

export default class Github extends OrknuxPlugin {

  id() {
    return 'github';
  }

  apiVersion() {
    return 1;
  }

  parameters() {
    return [
      new OrknuxParameter({
        name: 'webhookSecret',
        description: 'The secret set on the repository\'s webhook, which every delivery is signed with.',
        type: 'string',
        // Optional since the API surface arrived: a workspace that only asks
        // questions of GitHub never sets up a webhook. `verify` answers false
        // while it is unset, which is the safe reading of not knowing.
        required: false,
        // The webhook's own secret. Declared as a secret so it cannot be typed
        // into the plugins page: the only way to answer it is to point at one of
        // the workspace's variables, which is where this installation encrypts
        // what it keeps.
        secret: true,
      }),
      new OrknuxParameter({
        name: 'token',
        description:
          'A GitHub token — fine-grained PAT or App user token — for the API surface. ' +
          'The agent-task functions only answer a user token.',
        type: 'string',
        // Optional the other way round: a workspace that only verifies webhook
        // deliveries never calls the API. Every API function checks for it and
        // says so when it is missing.
        required: false,
        secret: true,
      }),
      new OrknuxParameter({
        name: 'classicToken',
        description:
          'A classic personal access token with repo scope, asked when the token above is refused ' +
          '(403 or 404) reading a commit\'s status or check runs. Only buildStatus reaches for it.',
        type: 'string',
        // Optional twice over: only `buildStatus` falls back to it, and only
        // on a refusal the fine-grained token drew. A workspace whose token reads
        // builds fine never sets it, and one that does keeps it a secret the
        // same way as the other two.
        required: false,
        secret: true,
      }),
      new OrknuxParameter({
        name: 'organization',
        description:
          'The owner every function falls back to when a call does not name one, ' +
          'and the org unqualified searches are scoped to.',
        type: 'string',
        required: false,
      }),
      new OrknuxParameter({
        name: 'apiUrl',
        description:
          'The API root, for a GitHub Enterprise Server (https://ghes.example.com/api/v3). ' +
          'Left empty, it is api.github.com.',
        type: 'string',
        required: false,
      }),
    ];
  }

  permissions() {
    // TextEncoder, and nothing else. GitHub signs the bytes it sent, so the
    // body has to become bytes the same way it was written — UTF-8 — rather
    // than by whatever a hand-rolled loop happens to do with a character
    // outside the ASCII range. A pull request title with an accent in it is
    // not an edge case.
    return ['TEXT_ENCODING'];
  }

  capabilities() {
    // The widest capability there is, asked for because this plugin is about
    // exactly one outside service: every request the functions below make goes
    // to the API root above, which is GitHub's or the GHES the workspace named.
    return ['NETWORK_REQUEST'];
  }

  libraries() {
    // The file that travels with this one — the complete list, shown to
    // whoever loads the plugin. Every relative import above resolves here.
    return ['lib/api.js'];
  }

  /*
   * The shapes these answers actually have.
   *
   * `map` says a structure came back and nothing about what is in it, so every
   * caller reads this file — or guesses — to learn that `patch` can be null
   * and `checks` is a list. Declared here, each travels with the plugin and
   * arrives in a workspace under its key: `github_PullRequest`.
   *
   * One thing deliberately stays a map. `agentTask` passes GitHub's own answer
   * through because that API is in public preview and its shape still moves —
   * a shape declared here would be a promise this file cannot keep.
   */
  objects() {
    return [
      new OrknuxObject({
        name: 'Delivery',
        description: "What one webhook delivery is about, flattened so a condition can read it.",
        properties: [
          { name: 'event', kind: 'string', description: "GitHub's own event name, from the header." },
          { name: 'delivery', kind: 'string', description: 'The delivery id, for finding it in the log.' },
          {
            name: 'kind',
            kind: 'string',
            description: 'pull_request, review_comment, push, or other for anything else.',
          },
          { name: 'action', kind: 'string', description: 'opened, closed, synchronize… Null on a push.' },
          { name: 'repository', kind: 'string', description: 'owner/name.' },
          { name: 'actor', kind: 'string', description: 'The login that caused it.' },
          { name: 'title', kind: 'string', description: 'The PR title, the comment body, or the head commit message.' },
          { name: 'url', kind: 'string', description: 'Where to read whatever this is about.' },
          { name: 'number', kind: 'number', description: 'The PR number, where there is one.' },
          { name: 'ref', kind: 'string', description: 'The branch pushed to. Null unless this is a push.' },
          { name: 'commits', kind: 'number', description: 'How many a push carried. Null unless this is a push.' },
        ],
      }),

      new OrknuxObject({
        name: 'ChangedFile',
        description: 'One file a pull request or a commit touched.',
        properties: [
          { name: 'path', kind: 'string', description: 'Where it sits in the repository.' },
          { name: 'status', kind: 'string', description: 'added, modified, removed, renamed.' },
          { name: 'additions', kind: 'number', description: 'Lines added.' },
          { name: 'deletions', kind: 'number', description: 'Lines taken out.' },
          {
            name: 'patch',
            kind: 'string',
            description: 'The diff GitHub shows. Null for a binary file, or one too large to diff.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'PullRequest',
        description: 'One pull request, whole, with the diff that makes it.',
        properties: [
          { name: 'number', kind: 'number', description: 'What it is called on the site.' },
          { name: 'title', kind: 'string', description: 'The one-line title.' },
          { name: 'body', kind: 'string', description: 'The description, as GitHub markdown.' },
          { name: 'state', kind: 'string', description: 'open or closed — merged is its own field.' },
          { name: 'draft', kind: 'boolean', description: 'Whether it is still marked draft.' },
          { name: 'merged', kind: 'boolean', description: 'Closed and merged, rather than closed and dropped.' },
          { name: 'author', kind: 'string', description: 'The login that opened it.' },
          { name: 'baseRef', kind: 'string', description: 'The branch it would merge into.' },
          { name: 'headRef', kind: 'string', description: 'The branch it is on.' },
          { name: 'headSha', kind: 'string', description: 'What buildStatus and reviewComment anchor to.' },
          { name: 'mergeable', kind: 'boolean', description: 'Null while GitHub is still working it out.' },
          { name: 'additions', kind: 'number', description: 'Lines added across every file.' },
          { name: 'deletions', kind: 'number', description: 'Lines taken out across every file.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
          { name: 'files', kind: 'array', of: 'ChangedFile', description: 'Every file it touches, with patches.' },
        ],
      }),

      new OrknuxObject({
        name: 'Commit',
        description: 'One commit, whole, with the diff that makes it.',
        properties: [
          { name: 'sha', kind: 'string', description: 'The full forty-character sha.' },
          { name: 'message', kind: 'string', description: 'The whole message, subject and body.' },
          { name: 'author', kind: 'string', description: 'The name in the commit itself.' },
          { name: 'login', kind: 'string', description: 'The GitHub account, where one is matched.' },
          { name: 'date', kind: 'string', description: 'When it was authored, ISO 8601.' },
          { name: 'parents', kind: 'array', of: 'string', description: 'Parent shas — two for a merge.' },
          { name: 'additions', kind: 'number', description: 'Lines added.' },
          { name: 'deletions', kind: 'number', description: 'Lines taken out.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
          { name: 'files', kind: 'array', of: 'ChangedFile', description: 'Every file it touches, with patches.' },
        ],
      }),

      new OrknuxObject({
        name: 'CommitSummary',
        description: 'A commit as a list answers it, without the diff.',
        properties: [
          { name: 'sha', kind: 'string', description: 'The full sha; openCommit takes it.' },
          { name: 'message', kind: 'string', description: 'The whole message.' },
          { name: 'author', kind: 'string', description: 'The name in the commit itself.' },
          { name: 'date', kind: 'string', description: 'ISO 8601.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Reporter',
        description: 'One thing that reported on a commit — a status context, or a check run.',
        properties: [
          { name: 'name', kind: 'string', description: 'What the check calls itself.' },
          { name: 'state', kind: 'string', description: 'A commit status: success, failure, pending, error.' },
          { name: 'status', kind: 'string', description: 'A check run: queued, in_progress, completed.' },
          { name: 'conclusion', kind: 'string', description: 'A finished check: success, failure, cancelled…' },
          { name: 'description', kind: 'string', description: 'What it said, where it said anything.' },
          { name: 'url', kind: 'string', description: 'Where to read the run.' },
        ],
      }),

      new OrknuxObject({
        name: 'Review',
        description: 'One review somebody left on a pull request.',
        properties: [
          { name: 'user', kind: 'string', description: 'Who left it.' },
          {
            name: 'state',
            kind: 'string',
            description: 'APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED.',
          },
          { name: 'submitted', kind: 'string', description: 'When, as ISO 8601.' },
          { name: 'body', kind: 'string', description: 'What they wrote, where they wrote anything.' },
          { name: 'url', kind: 'string', description: 'The review, for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Reviews',
        description: 'Where a pull request stands with its reviewers.',
        properties: [
          {
            name: 'approved',
            kind: 'boolean',
            description:
              'Somebody approved and nobody is standing on changes requested. This is the ' +
              'question "has it been approved" actually means, and it is not the same as ' +
              'mergeable, which is only about conflicts.',
          },
          {
            name: 'state',
            kind: 'string',
            description: 'changes requested, approved, commented, or none where nobody has reviewed.',
          },
          { name: 'approvals', kind: 'number', description: 'How many people currently stand at approved.' },
          {
            name: 'changesRequested',
            kind: 'number',
            description: 'How many currently stand at changes requested — any of them blocks.',
          },
          {
            name: 'approvers',
            kind: 'array',
            of: 'string',
            description: 'Who those approvals belong to, which is what a policy asking for two of them needs.',
          },
          {
            name: 'blockers',
            kind: 'array',
            of: 'string',
            description: 'Who is asking for changes, and therefore who has to look again.',
          },
          {
            name: 'requested',
            kind: 'array',
            of: 'string',
            description: 'Asked to review and has not yet — the people a nudge would go to.',
          },
          { name: 'requestedTeams', kind: 'array', of: 'string', description: 'The same, for teams.' },
          {
            name: 'reviews',
            kind: 'array',
            of: 'Review',
            description:
              'Every review left, oldest first — one person appears as often as they reviewed. ' +
              'The counts above already resolve that; this is the history behind them.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'BuildStatus',
        description: 'What every build said about one commit, both reporting schemes together.',
        properties: [
          {
            name: 'overall',
            kind: 'string',
            description: 'failure, pending, success, or none where nothing has reported.',
          },
          { name: 'sha', kind: 'string', description: 'The commit this is about.' },
          { name: 'statuses', kind: 'array', of: 'Reporter', description: 'From the commit status API.' },
          { name: 'checks', kind: 'array', of: 'Reporter', description: 'From check runs — Actions, and apps.' },
        ],
      }),

      new OrknuxObject({
        name: 'Repo',
        description: 'One repository, as a list answers it.',
        properties: [
          { name: 'name', kind: 'string', description: 'Without the owner.' },
          { name: 'fullName', kind: 'string', description: 'owner/name, which every call here takes.' },
          { name: 'description', kind: 'string', description: 'Its one-line description, or null.' },
          { name: 'defaultBranch', kind: 'string', description: 'What an empty ref means.' },
          { name: 'private', kind: 'boolean', description: 'Whether the token is seeing it privately.' },
          { name: 'pushed', kind: 'string', description: 'When it last changed, ISO 8601.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'PullMatch',
        description: 'A pull request as a search answers it.',
        properties: [
          { name: 'number', kind: 'number', description: 'openPull takes it.' },
          { name: 'title', kind: 'string', description: 'The one-line title.' },
          { name: 'state', kind: 'string', description: 'open or closed.' },
          { name: 'draft', kind: 'boolean', description: 'Whether it is still marked draft.' },
          { name: 'repository', kind: 'string', description: 'owner/name.' },
          { name: 'author', kind: 'string', description: 'The login that opened it.' },
          { name: 'updated', kind: 'string', description: 'ISO 8601.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'CodeMatch',
        description: 'A file a code search matched, with the passages that matched.',
        properties: [
          { name: 'repository', kind: 'string', description: 'owner/name.' },
          { name: 'path', kind: 'string', description: 'From the repository root; openFile takes it.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
          {
            name: 'fragments',
            kind: 'array',
            of: 'string',
            description: 'The matching passages — the half of a code search worth reading.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'CommitMatch',
        description: 'A commit a message search matched.',
        properties: [
          { name: 'repository', kind: 'string', description: 'owner/name.' },
          { name: 'sha', kind: 'string', description: 'openCommit takes it.' },
          { name: 'message', kind: 'string', description: 'The whole message.' },
          { name: 'author', kind: 'string', description: 'The name in the commit itself.' },
          { name: 'date', kind: 'string', description: 'ISO 8601.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'PullSearch',
        description: 'What a pull request search came to.',
        properties: [
          {
            name: 'total',
            kind: 'number',
            description: 'How many the whole search holds, not how many came back.',
          },
          { name: 'matches', kind: 'array', of: 'PullMatch', description: 'Capped by limit.' },
        ],
      }),

      new OrknuxObject({
        name: 'CodeSearch',
        description: 'What a code search came to.',
        properties: [
          { name: 'total', kind: 'number', description: 'How many the whole search holds.' },
          { name: 'matches', kind: 'array', of: 'CodeMatch', description: 'Capped by limit.' },
        ],
      }),

      new OrknuxObject({
        name: 'CommitSearch',
        description: 'What a commit search came to.',
        properties: [
          { name: 'total', kind: 'number', description: 'How many the whole search holds.' },
          { name: 'matches', kind: 'array', of: 'CommitMatch', description: 'Capped by limit.' },
        ],
      }),

      new OrknuxObject({
        name: 'RepoList',
        description: 'The repositories an owner has, most recently pushed first.',
        properties: [{ name: 'repos', kind: 'array', of: 'Repo', description: 'Capped by limit.' }],
      }),

      new OrknuxObject({
        name: 'FileList',
        description: 'Every file path in a repository at one ref, from its git tree.',
        properties: [
          {
            name: 'ref',
            kind: 'string',
            description: 'What was actually read — the default branch, where none was named.',
          },
          { name: 'files', kind: 'array', of: 'string', description: 'Paths from the repository root.' },
          { name: 'count', kind: 'number', description: 'How many paths came back.' },
          {
            name: 'truncated',
            kind: 'boolean',
            description: 'True where the tree was too large for GitHub to give whole, so files is incomplete.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'FileHistory',
        description: 'The commits that touched one file, newest first.',
        properties: [{ name: 'commits', kind: 'array', of: 'CommitSummary', description: 'Capped by limit.' }],
      }),

      new OrknuxObject({
        name: 'AgentTask',
        description: 'A Copilot cloud agent task as it was started.',
        properties: [
          { name: 'id', kind: 'string', description: 'What agentTask takes to follow it.' },
          { name: 'state', kind: 'string', description: 'queued, in_progress, completed, failed…' },
          { name: 'url', kind: 'string', description: 'Where to watch it.' },
          { name: 'created', kind: 'string', description: 'ISO 8601.' },
        ],
      }),

      new OrknuxObject({
        name: 'Comment',
        description: 'A comment that was posted.',
        properties: [
          { name: 'id', kind: 'number', description: 'What replyToComment takes to thread onto it.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),
    ];
  }

  /*
   * Two pages, because there are two jobs here that go wrong in different
   * ways. Reviewing is a reading discipline; driving the Copilot agent is an
   * asynchronous protocol with a steering mechanism nobody guesses.
   */
  skills() {
    return [
      new OrknuxSkill({
        name: 'Reviewing a pull request',
        description: 'How to read a PR properly before saying anything about it.',
        content: `# Reviewing a pull request

## Read the whole thing first

\`github_openPull\` answers the description *and* every changed file with its
patch. Read all of it before forming a view. A review written from the title
and the first file is the kind that asks for a change the fourth file already
made.

Then \`github_buildStatus\` on the head sha. It reads both reporting schemes —
the commit status API and check runs — because CI uses both, and reading only
one says "green" about a commit the other knows is red. If it is failing, that
is the review: say which check and stop.

## Where a comment goes

Three doors, and picking wrong is most of what makes review comments
annoying:

- **\`github_reviewComment\`** — about a specific line. Pass the path and the
  line in the new version. This is where nearly everything belongs: a comment
  anchored to the code needs no explanation of where it is about.
- **\`github_comment\`** — about the change as a whole. The summary, the
  verdict, a question about the approach. One of these per review, not five.
- **\`github_replyToComment\`** — answering an existing thread. Use it rather
  than starting a parallel thread saying the same thing.

## What to say

Lead with whether it is correct. Style is worth mentioning once and never
twice. If something is wrong, say what input makes it wrong — a failure the
author can reproduce is a fix; "this looks fragile" is a conversation.

Look things up rather than assuming: \`github_openFile\` at the PR's head sha
shows what a function actually does now, and \`github_fileHistory\` shows
whether the line you are about to question was deliberate.

## Searching first

\`github_searchCode\` before claiming something is unused, duplicated or
missing. "There is no test for this" is embarrassing when there is, in a file
you did not open.`,
      }),

      new OrknuxSkill({
        name: 'Working with the Copilot coding agent',
        description: 'Starting a GitHub agent task, following it, and steering it without losing it.',
        content: `# Working with the Copilot coding agent

\`github_createAgentTask\` hands a prompt to GitHub's Copilot cloud agent. It
works in its own branch and opens a draft pull request. This is asynchronous:
the call returns immediately and the work is not done.

## Write the prompt like a ticket

The agent cannot ask you a question. Everything it needs is in the prompt, so
say which files if you know them, what "done" looks like, and what must not
change. A vague prompt comes back as a vague diff an hour later.

## Following it

\`github_agentTask\` answers the current state — \`queued\`, \`in_progress\`,
\`completed\`, \`failed\`, \`waiting_for_user\` — along with its pull request and
its sessions. **Do not poll it in a loop.** Check it when there is a reason
to, and where the reason is that the work is not finished yet, wait properly:
\`finish_answer\` takes \`wake_after_ms\`, which parks the step and comes back
to it rather than burning rounds.

\`github_agentTaskLogs\` takes a session id and answers the agent's own account
of what it read and decided. Read that before concluding the agent did
something stupid — it usually explains itself, and the explanation is often
that your prompt was ambiguous.

## Steering it

\`github_messageAgentTask\` is how you change course. It takes the **pull
request number**, not the task id, because the mechanism is GitHub's own: a
comment on the PR mentioning \`@copilot\`. The agent reads it and continues.

Use it for "use the existing helper in lib/ rather than writing a new one" or
"the tests fail, look at the timezone handling". One clear instruction at a
time; a comment containing five requests gets partially done.

## Before you accept it

It opened a draft PR, which means review it like any other — the previous
skill applies unchanged. \`github_buildStatus\` on its head sha, read the whole
diff, and remember the agent had no more context than your prompt gave it.

## One limit worth knowing

The agent-task API answers a **user** token only. A GitHub App installation
token is refused by GitHub itself, not by this plugin, and the refusal will
not obviously say so.`,
      }),

      new OrknuxSkill({
        /*
         * Pinned rather than derived, because this is the skill something
         * points at: an agent node watching a pull request names it, and so
         * does somebody typing the command marker into a channel. A derived
         * id would move the day the name did.
         */
        id: 'autofix-build',
        name: 'Getting a pull request build green',
        description:
          "How to wait for a PR's checks and get them passing - a wake-up rather than a poll, and " +
          'Copilot on the same pull request rather than a second one.',
        content: `# Getting a pull request build green

A build takes minutes and you take seconds, so most of this job is waiting
properly. There is a tool for that, and the rest is what to do when the wait
ends badly.

## Waiting is a call, not a loop

**\`finish_answer\` takes \`wake_after_ms\`.** Pass it and your turn ends
here, the step parks, and the run comes back to this same node when that many
milliseconds are up. Nothing is held while it runs down — no round open, no
model billed for the silence — which is why this is the only acceptable way to
wait for a build.

    finish_answer(answer: '<the note, see below>', wake_after_ms: 180000)

Two things the tool itself tells you, and they are worth reading rather than
guessing: **how many waits this step has left**, and **the longest one wait may
be**. Ask for longer and it is quietly shortened to that ceiling. Ask for zero
or less and the call is refused in words, your turn carries on, and you have
spent a round learning that. Where no waits are left the argument is not offered
at all — then finish, and say where things stand.

Do not hold the turn open instead, do not poll \`github_buildStatus\` over and
over inside one turn, and do not try to pass the time by thinking. Polling a
task in a tight loop is the same mistake and has the same answer.

## The note is your only memory

\`answer\` means two different things, and this is the trap:

- **with \`wake_after_ms\`** — it is a note to yourself. You are handed it
  back when the step wakes, under "you stopped here earlier to wait, and left
  yourself this note".
- **without it** — it is what the step answers with, for whatever node comes
  after. Leave it out where nothing follows.

A woken turn is handed the step's original input and that note, **and nothing
else**. No tool results, no reasoning, no record of what you already did. So
write the note as a handover to a stranger:

    PR 412 in acme/api, watching sha 9f2c1ab. Build was failing on
    "unit (3.12)": ImportError on services.billing.rates. Asked @copilot to
    fix it, attempt 2 of 3. If the sha has moved, it pushed.

Repo, PR number, the sha you are watching, which check was failing and what it
said, what you have already asked for, and which attempt this is. A note saying
"waiting for the build" is a note that makes you start again from the top.

## The loop, once

1. **\`github_openPull\`** for the PR — it answers \`number\`,
   \`headRef\`, \`headSha\` and \`url\`. Do this on every pass, waking
   included: a new commit moves the head sha, and the build you were watching
   belongs to a commit nobody is merging any more.
2. **\`github_buildStatus\`** on that head sha. It reads the commit status API
   *and* check runs, because CI uses both, and reading one of them says "green"
   about a commit the other knows is red. \`overall\` is \`failure\`,
   \`pending\`, \`success\` or \`none\`.
3. Then, by what it says:
   - \`pending\` — wait. Size the wait to the build rather than to your
     impatience: a suite that takes eight minutes deserves one wait of
     \`300000\`, not five of \`60000\`. You have a small number of them.
   - \`none\` — nothing has reported yet. One short wait; if it is still
     \`none\` after that, nothing is triggered by this branch and waiting
     longer will not change it. Say so and finish.
   - \`success\` — done. Say it once, in one place, and finish **without**
     \`wake_after_ms\`.
   - \`failure\` — the next two sections.

## When it is red: read it before touching it

\`statuses\` and \`checks\` name every reporter, with what it concluded, what
it said, and a \`url\` for the run. Find the one that failed and read what it
actually said. A build is red for a reason that is usually one line long, and
the whole job here turns on quoting that line rather than paraphrasing it.

\`github_openFile\` at the head sha shows what the failing code is now, and
\`github_fileHistory\` shows whether the line arrived in this PR or was
already there. That is worth a call before blaming anybody: a check that was
failing on the base branch too is not this PR's fault, and saying so is more
useful than a fix.

## Fix it, or hand it back — never open a second pull request

**Fixing it yourself** means using whatever tool you have that can change the
branch. Nothing in this plugin can: it reads code and writes words. So that is
your job only where a repository tool of your own is on the table, and it is the
right one for something small and certain — a missing import, a renamed symbol,
a formatting check.

**Otherwise hand it to Copilot, on the pull request that is failing:**

    github_messageAgentTask(owner, repo, pullNumber, 'the unit (3.12) check
      fails with ImportError: cannot import name rates from services.billing.
      Fix the import and leave the public API alone.')

That posts a comment mentioning \`@copilot\` on **that** PR, so the fix lands
on **that** branch, inside the change it belongs to.

**Do not call \`github_createAgentTask\` for a fix.** It starts a task in a
branch of its own and opens a second draft pull request — so the failing PR is
still failing, a different PR holds the fix, and somebody has to merge the two
in the right order. One red build has become two open PRs and a merge question.
\`createAgentTask\` is for new work; \`messageAgentTask\` is for this.

Write the message as one instruction: the check's name, the error as it was
printed, and what must not change. Five requests in one comment get partly done.

## After you have asked

Wait longer than you would for CI alone — Copilot reads, edits and pushes, and
only then does CI run again. On waking, \`github_openPull\` first: a moved head
sha means it pushed, and you are watching a new build.
\`github_agentTask\` says whether it is \`in_progress\`, and
\`waiting_for_user\` means it is waiting on **you** to answer something.
\`github_agentTaskLogs\` on a session id is its own account of what it did,
which is usually the explanation for a fix that missed.

## When to stop

Stopping well is most of what makes this safe to leave running:

- **Green** — finish. One comment at most, and only where somebody is waiting
  to hear it.
- **The same check failing after the same instruction twice** — stop asking.
  Say on the PR what fails, what was tried and what you think it needs
  (\`github_comment\`), and finish. A third identical comment to an agent that
  has already tried twice is noise in somebody's timeline.
- **The sha has not moved and the task is not working** — the instruction never
  landed. Say that, rather than waiting again.
- **Waits running out** — the tool says how many are left. Spend the last one on
  something that could plausibly change, and where nothing could, finish with
  the truth: what is red, what was asked, and what has not happened yet.

And comment *sparingly*. One comment when you take this on, one when it is over.
A comment on every pass turns a quiet wait into a notification every three
minutes for everybody on the PR.`,
      }),
    ];
  }

  /*
   * The agents' surface: every API function, fronted. Proxies rather than
   * copies, so the params, return types and implementations stay the
   * functions' own. `verify` and `describe` are deliberately not here — they
   * are the webhook trigger's machinery, and a model has no delivery to check.
   */
  tools() {
    return [
      new OrknuxFunctionTool({ function: 'searchPulls' }),
      new OrknuxFunctionTool({ function: 'listRepos' }),
      new OrknuxFunctionTool({ function: 'listFiles' }),
      new OrknuxFunctionTool({ function: 'openPull' }),
      new OrknuxFunctionTool({ function: 'searchCode' }),
      new OrknuxFunctionTool({ function: 'searchCommits' }),
      new OrknuxFunctionTool({ function: 'openCommit' }),
      new OrknuxFunctionTool({ function: 'reviews' }),
      new OrknuxFunctionTool({ function: 'buildStatus' }),
      new OrknuxFunctionTool({ function: 'openFile' }),
      new OrknuxFunctionTool({ function: 'fileHistory' }),
      new OrknuxFunctionTool({ function: 'createAgentTask' }),
      new OrknuxFunctionTool({ function: 'agentTask' }),
      new OrknuxFunctionTool({ function: 'agentTaskLogs' }),
      new OrknuxFunctionTool({ function: 'messageAgentTask' }),
      new OrknuxFunctionTool({ function: 'comment' }),
      new OrknuxFunctionTool({ function: 'reviewComment' }),
      new OrknuxFunctionTool({ function: 'replyToComment' }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'verify',
        description: 'Whether a delivery really came from GitHub, by its HMAC signature.',
        params: [
          { name: 'headers', type: 'map' },
          { name: 'rawBody', type: 'string' },
        ],
        returnType: 'boolean',

        /*
         * The bytes GitHub signed, not the JSON they parse to.
         *
         * `rawBody` is the request exactly as it arrived, which is what the
         * signature is over. Re-serialising the parsed body would reorder keys
         * and drop whitespace, and the digest of that is a digest of something
         * GitHub never sent.
         */
        run: (headers, rawBody) => {
          const secret = this.settings.webhookSecret;
          if (typeof secret !== 'string' || secret.length === 0) {
            // Unset — a workspace that only uses the API surface never answers
            // it. Answering no is the safe reading of not knowing.
            return false;
          }
          if (typeof rawBody !== 'string') {
            return false;
          }

          const sent = header(headers, 'x-hub-signature-256');
          if (sent === null || sent.indexOf('sha256=') !== 0) {
            // Unsigned, or signed with the SHA-1 scheme GitHub still sends in
            // `X-Hub-Signature` for compatibility. Neither is a delivery this
            // will vouch for: accepting the old header would let a caller
            // choose the weaker of the two.
            return false;
          }

          /*
           * `text` rather than bytes of our own: the server encodes it as
           * UTF-8, which is what GitHub signed. A pull request title with an
           * accent in it is not an edge case, and this is where getting the
           * encoding wrong would show up as a delivery quietly refused.
           */
          const mine = orknux.crypto.hmac('sha256', { text: secret }, { text: rawBody });
          if (mine.error !== undefined) {
            // A refusal is data here, and the honest reading of "could not
            // compute the signature" is that this delivery is not vouched for.
            return false;
          }

          /*
           * GitHub sends the digest as hex and crypto answers base64, so the
           * two are compared as the bytes they both stand for. Constant-time,
           * because a comparison that returns early tells whoever is guessing
           * how much of their guess was right, one byte at a time.
           */
          const theirs = hexToBase64(sent.slice('sha256='.length));
          if (theirs === null) {
            return false;
          }
          const same = orknux.crypto.timingSafeEqual({ base64: mine.base64 }, { base64: theirs });
          return same.equal === true;
        },
      }),

      new OrknuxFunction({
        name: 'describe',
        description: 'What a delivery is about: its event, who did it, where, and to what.',
        params: [
          { name: 'headers', type: 'map' },
          { name: 'body', type: 'map' },
        ],
        returnType: 'Delivery',

        /*
         * One answer for the three events the webhook is set up to send, so a
         * condition can ask `kind === 'push'` rather than working out which of
         * GitHub's shapes arrived from which fields happen to be present.
         *
         * `event` is a header rather than a body field, which is why the run is
         * handed `webhook.headers` at all. Anything else GitHub might send is
         * described as far as it has anything in common with these — `other`,
         * with the repository and the actor — rather than refused, because a
         * repository whose webhook was set to send everything should not make
         * this throw.
         */
        run: (headers, body) => {
          const event = header(headers, 'x-github-event');
          const repository = at(body, 'repository');
          const pull = at(body, 'pull_request');
          const comment = at(body, 'comment');

          const described = {
            event: event,
            delivery: header(headers, 'x-github-delivery'),
            kind: 'other',
            action: at(body, 'action'),
            repository: at(repository, 'full_name'),
            actor: at(at(body, 'sender'), 'login'),
            title: null,
            url: null,
            number: null,
            ref: null,
            commits: null,
          };

          if (event === 'pull_request') {
            described.kind = 'pull_request';
            described.number = at(body, 'number');
            described.title = at(pull, 'title');
            described.url = at(pull, 'html_url');
          } else if (event === 'pull_request_review_comment') {
            described.kind = 'review_comment';
            described.number = at(pull, 'number');
            described.title = at(comment, 'body');
            described.url = at(comment, 'html_url');
          } else if (event === 'push') {
            described.kind = 'push';
            described.ref = at(body, 'ref');
            const pushed = at(body, 'commits');
            described.commits = Array.isArray(pushed) ? pushed.length : 0;
            described.title = at(at(body, 'head_commit'), 'message');
            described.url = at(body, 'compare');
          }

          return described;
        },
      }),

      new OrknuxFunction({
        name: 'searchPulls',
        description:
          'Searches pull requests the way the site\'s search box does. GitHub\'s search syntax works: ' +
          'repo:owner/name, author:login, is:open, review:required, "an exact phrase". A query that does ' +
          'not say where to look is scoped to the configured organization. Answers the total and the ' +
          'matches - number, title, state, repository, author, updated and a url each. limit caps the ' +
          'matches.',
        params: [
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'PullSearch',
        run: (query, limit) => {
          const asked = `${scoped(this.settings, query)} is:pr`;
          const found = read(this.settings, {
            path: `/search/issues?q=${encodeURIComponent(asked)}&per_page=${pageSize(limit)}`,
          }).json;
          return {
            total: at(found, 'total_count'),
            matches: (at(found, 'items') ?? []).map((one) => ({
              number: at(one, 'number'),
              title: at(one, 'title'),
              state: at(one, 'state'),
              draft: at(one, 'draft'),
              repository: repoNamed(at(one, 'repository_url')),
              author: at(at(one, 'user'), 'login'),
              updated: at(one, 'updated_at'),
              url: at(one, 'html_url'),
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'listRepos',
        description:
          'Lists repositories, most recently pushed first. Pass an organization or user as owner, or an ' +
          'empty owner for the configured organization - and with neither, the repositories the token ' +
          'itself can see. Answers name, fullName, description, defaultBranch, private, pushed and a url ' +
          'each. limit caps the list.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 30 },
        ],
        returnType: 'RepoList',
        run: (owner, limit) => {
          const query = `per_page=${pageSize(limit)}&sort=pushed`;
          const fallback = this.settings.organization;
          const unnamed =
            (typeof owner !== 'string' || owner.length === 0) &&
            (typeof fallback !== 'string' || fallback.length === 0);

          let answered;
          if (unnamed) {
            answered = read(this.settings, { path: `/user/repos?${query}` });
          } else {
            /*
             * An owner is an organization or a user, and the caller should not
             * have to know which: ask as an org first, and read the one 404
             * that means "not an org" as an instruction to ask again.
             */
            const who = encodeURIComponent(ownerOr(this.settings, owner));
            answered = call(this.settings, { path: `/orgs/${who}/repos?${query}` });
            if (answered.status === 404) {
              answered = read(this.settings, { path: `/users/${who}/repos?${query}` });
            } else if (answered.status >= 400) {
              throw statusError(answered, `/orgs/${who}/repos`);
            }
          }

          const held = Array.isArray(answered.json) ? answered.json : [];
          return {
            repos: held.map((one) => ({
              name: at(one, 'name'),
              fullName: at(one, 'full_name'),
              description: at(one, 'description'),
              defaultBranch: at(one, 'default_branch'),
              private: at(one, 'private'),
              pushed: at(one, 'pushed_at'),
              url: at(one, 'html_url'),
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'listFiles',
        description:
          'Lists every file path in a repository at one ref, from its git tree. Pass owner and repo (or ' +
          'the repo as owner/name, or an empty owner for the configured organization) and a branch, tag ' +
          'or commit sha - or an empty ref for the default branch. Answers the ref read, the paths, and ' +
          'truncated=true where the tree was too large for GitHub to give whole.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'ref', type: 'string', required: false, default: '' },
        ],
        returnType: 'FileList',
        run: (owner, repo, ref) => {
          const base = repoPath(this.settings, owner, repo);
          let marked = ref;
          if (typeof marked !== 'string' || marked.length === 0) {
            marked = at(read(this.settings, { path: base }).json, 'default_branch');
          }
          const tree = read(this.settings, {
            path: `${base}/git/trees/${encodeURIComponent(marked)}?recursive=1`,
          }).json;
          const files = (at(tree, 'tree') ?? [])
            .filter((one) => at(one, 'type') === 'blob')
            .map((one) => at(one, 'path'));
          return { ref: marked, files: files, count: files.length, truncated: at(tree, 'truncated') === true };
        },
      }),

      new OrknuxFunction({
        name: 'openPull',
        description:
          'Opens one pull request whole: title, body, state, draft, merged, author, baseRef, headRef, ' +
          'headSha, mergeable, additions, deletions, url - and its changed files, each with the patch ' +
          'GitHub shows as the diff. Pass owner and repo (or the repo as owner/name, or an empty owner ' +
          'for the configured organization) and the PR number.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'number', type: 'number' },
        ],
        returnType: 'PullRequest',
        run: (owner, repo, number) => {
          const base = repoPath(this.settings, owner, repo);
          const pull = read(this.settings, { path: `${base}/pulls/${number}` }).json;
          const files = read(this.settings, { path: `${base}/pulls/${number}/files?per_page=100` }).json;
          return {
            number: at(pull, 'number'),
            title: at(pull, 'title'),
            body: at(pull, 'body'),
            state: at(pull, 'state'),
            draft: at(pull, 'draft'),
            merged: at(pull, 'merged'),
            author: at(at(pull, 'user'), 'login'),
            baseRef: at(at(pull, 'base'), 'ref'),
            headRef: at(at(pull, 'head'), 'ref'),
            headSha: at(at(pull, 'head'), 'sha'),
            mergeable: at(pull, 'mergeable'),
            additions: at(pull, 'additions'),
            deletions: at(pull, 'deletions'),
            url: at(pull, 'html_url'),
            files: (Array.isArray(files) ? files : []).map(changedFile),
          };
        },
      }),

      new OrknuxFunction({
        name: 'searchCode',
        description:
          'Searches code the way the site\'s search box does. GitHub\'s qualifiers work: repo:owner/name, ' +
          'path:src, language:go, filename:Dockerfile. A query that does not say where to look is scoped ' +
          'to the configured organization. Answers the total and the matches - repository, path, url and ' +
          'the matching fragments each. limit caps the matches.',
        params: [
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'CodeSearch',
        run: (query, limit) => {
          const found = read(this.settings, {
            path: `/search/code?q=${encodeURIComponent(scoped(this.settings, query))}&per_page=${pageSize(limit)}`,
            // The variant that carries the matching fragments, which are the
            // half of a code search worth reading.
            accept: 'application/vnd.github.text-match+json',
          }).json;
          return {
            total: at(found, 'total_count'),
            matches: (at(found, 'items') ?? []).map((one) => ({
              repository: at(at(one, 'repository'), 'full_name'),
              path: at(one, 'path'),
              url: at(one, 'html_url'),
              fragments: (at(one, 'text_matches') ?? []).map((match) => at(match, 'fragment')),
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'searchCommits',
        description:
          'Searches commit messages. GitHub\'s qualifiers work: repo:owner/name, author:login, ' +
          'committer-date:>2026-01-01. A query that does not say where to look is scoped to the ' +
          'configured organization. Answers the total and the matches - repository, sha, message, ' +
          'author, date and a url each. limit caps the matches.',
        params: [
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'CommitSearch',
        run: (query, limit) => {
          const found = read(this.settings, {
            path: `/search/commits?q=${encodeURIComponent(scoped(this.settings, query))}&per_page=${pageSize(limit)}`,
          }).json;
          return {
            total: at(found, 'total_count'),
            matches: (at(found, 'items') ?? []).map((one) => ({
              repository: at(at(one, 'repository'), 'full_name'),
              sha: at(one, 'sha'),
              message: at(at(one, 'commit'), 'message'),
              author: at(at(at(one, 'commit'), 'author'), 'name'),
              date: at(at(at(one, 'commit'), 'author'), 'date'),
              url: at(one, 'html_url'),
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'openCommit',
        description:
          'Opens one commit whole: message, author, date, parents, additions, deletions, url - and its ' +
          'changed files, each with the patch GitHub shows as the diff. Pass owner and repo (or the repo ' +
          'as owner/name, or an empty owner for the configured organization) and the sha, or a ref that ' +
          'names one.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'sha', type: 'string' },
        ],
        returnType: 'Commit',
        run: (owner, repo, sha) => {
          const base = repoPath(this.settings, owner, repo);
          const commit = read(this.settings, {
            path: `${base}/commits/${encodeURIComponent(sha)}`,
          }).json;
          return {
            sha: at(commit, 'sha'),
            message: at(at(commit, 'commit'), 'message'),
            author: at(at(at(commit, 'commit'), 'author'), 'name'),
            login: at(at(commit, 'author'), 'login'),
            date: at(at(at(commit, 'commit'), 'author'), 'date'),
            parents: (at(commit, 'parents') ?? []).map((one) => at(one, 'sha')),
            additions: at(at(commit, 'stats'), 'additions'),
            deletions: at(at(commit, 'stats'), 'deletions'),
            url: at(commit, 'html_url'),
            files: (at(commit, 'files') ?? []).map(changedFile),
          };
        },
      }),

      new OrknuxFunction({
        name: 'reviews',
        description:
          'Where a pull request stands with its reviewers: whether it is approved, who approved ' +
          'it, who is asking for changes, who was asked and has not answered, and every review ' +
          'in order. Pass owner and repo (or the repo as owner/name, or an empty owner for the ' +
          'configured organization) and the pull request number. approved means somebody approved ' +
          'and nobody is standing on changes requested - which is what "has it been approved" ' +
          'asks, and is not what mergeable answers, that being about conflicts alone. GitHub ' +
          'keeps every review event, so one person can appear several times and only their latest ' +
          'approval or change request counts; a comment-only review never changes where they ' +
          'stand. The counts here already resolve that.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'number', type: 'number' },
        ],
        returnType: 'Reviews',
        run: (owner, repo, number) => {
          const base = repoPath(this.settings, owner, repo);
          const at_ = `${base}/pulls/${encodeURIComponent(number)}`;

          /* Oldest first, which is what makes "the latest one wins" a single pass. */
          const listed = read(this.settings, { path: `${at_}/reviews?per_page=100` }).json ?? [];
          const waiting = read(this.settings, { path: `${at_}/requested_reviewers` }).json;

          /*
           * Where each person stands, which is not the same as what they last
           * did. GitHub's own rule: an approval or a change request replaces
           * that person's previous one, a dismissal clears it, and a review
           * that only comments leaves it exactly as it was. Counting the
           * events instead would call a pull request blocked because somebody
           * asked for changes in the morning and approved it after lunch.
           */
          const standing = new Map();
          const reviews = [];
          for (const one of listed) {
            const user = at(at(one, 'user'), 'login');
            const state = at(one, 'state');
            reviews.push({
              user: user,
              state: state,
              submitted: at(one, 'submitted_at'),
              body: at(one, 'body'),
              url: at(one, 'html_url'),
            });
            if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED') {
              standing.set(user, state);
            }
          }

          const approvers = [];
          const blockers = [];
          for (const [user, state] of standing) {
            if (state === 'APPROVED') {
              approvers.push(user);
            } else if (state === 'CHANGES_REQUESTED') {
              blockers.push(user);
            }
          }

          return {
            /* One blocker outweighs any number of approvals, which is how GitHub reads it too. */
            approved: approvers.length > 0 && blockers.length === 0,
            state:
              blockers.length > 0
                ? 'changes requested'
                : approvers.length > 0
                  ? 'approved'
                  : reviews.length > 0
                    ? 'commented'
                    : 'none',
            approvals: approvers.length,
            changesRequested: blockers.length,
            approvers: approvers,
            blockers: blockers,
            requested: (at(waiting, 'users') ?? []).map((one) => at(one, 'login')),
            requestedTeams: (at(waiting, 'teams') ?? []).map((one) => at(one, 'slug')),
            reviews: reviews,
          };
        },
      }),

      new OrknuxFunction({
        name: 'buildStatus',
        description:
          'What the builds say about one commit: the combined commit status and every check run, in one ' +
          'answer. Pass owner and repo (or the repo as owner/name, or an empty owner for the configured ' +
          'organization) and a sha, branch or tag. overall is failure, pending, success, or none where ' +
          'nothing has reported; statuses and checks carry each reporter by name.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'ref', type: 'string' },
        ],
        returnType: 'BuildStatus',
        run: (owner, repo, ref) => {
          const base = repoPath(this.settings, owner, repo);
          const marked = encodeURIComponent(ref);

          /*
           * Both reporting schemes, because CI uses both: the status API is
           * what older integrations set, and check runs are what GitHub
           * Actions and the newer apps write. Reading only one says "success"
           * about a commit the other knows is red.
           *
           * Both through `readOrClassic`: these are the two endpoints a
           * fine-grained token is refused on — 403 or 404 — where a classic
           * one still reads, so each is asked again under `classicToken`
           * when there is one. Each on its own, because a token can be
           * refused one and not the other.
           */
          const combined = readOrClassic(this.settings, { path: `${base}/commits/${marked}/status` }).json;
          const runs =
            at(
              readOrClassic(this.settings, { path: `${base}/commits/${marked}/check-runs?per_page=100` }).json,
              'check_runs',
            ) ?? [];

          const statuses = (at(combined, 'statuses') ?? []).map((one) => ({
            context: at(one, 'context'),
            state: at(one, 'state'),
            description: at(one, 'description'),
            url: at(one, 'target_url'),
          }));
          const checks = runs.map((one) => ({
            name: at(one, 'name'),
            status: at(one, 'status'),
            conclusion: at(one, 'conclusion'),
            url: at(one, 'html_url'),
          }));

          const red = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
          const state = at(combined, 'state');
          const failing =
            state === 'failure' || state === 'error' || checks.some((one) => red.includes(one.conclusion));
          const running =
            checks.some((one) => one.status !== 'completed') || (statuses.length > 0 && state === 'pending');

          return {
            overall: failing ? 'failure' : running ? 'pending' : statuses.length + checks.length > 0 ? 'success' : 'none',
            sha: at(combined, 'sha'),
            statuses: statuses,
            checks: checks,
          };
        },
      }),

      new OrknuxFunction({
        name: 'openFile',
        description:
          'Reads one file out of a repository, as the text it is. Pass owner and repo (or the repo as ' +
          'owner/name, or an empty owner for the configured organization), the path from the repository ' +
          'root, and a branch, tag or sha - or no ref for the default branch.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'path', type: 'string' },
          { name: 'ref', type: 'string', required: false, default: '' },
        ],
        returnType: 'string',
        run: (owner, repo, path, ref) => {
          const base = repoPath(this.settings, owner, repo);
          const marked = typeof ref === 'string' && ref.length > 0 ? `?ref=${encodeURIComponent(ref)}` : '';
          /*
           * The raw variant, asked for in the accept header, so what comes back
           * is the file — not JSON holding the file as base64, which the
           * sandbox has no atob to open.
           */
          const answered = read(this.settings, {
            path: `${base}/contents/${escapedPath(path)}${marked}`,
            accept: 'application/vnd.github.raw+json',
          });
          return answered.body;
        },
      }),

      new OrknuxFunction({
        name: 'fileHistory',
        description:
          'The commits that touched one file, newest first: sha, message, author, date and a url each. ' +
          'Pass owner and repo (or the repo as owner/name, or an empty owner for the configured ' +
          'organization) and the path from the repository root. limit caps the list.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'path', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'FileHistory',
        run: (owner, repo, path, limit) => {
          const base = repoPath(this.settings, owner, repo);
          const commits = read(this.settings, {
            path: `${base}/commits?path=${encodeURIComponent(path)}&per_page=${pageSize(limit)}`,
          }).json;
          return {
            commits: (Array.isArray(commits) ? commits : []).map((one) => ({
              sha: at(one, 'sha'),
              message: at(at(one, 'commit'), 'message'),
              author: at(at(at(one, 'commit'), 'author'), 'name'),
              date: at(at(at(one, 'commit'), 'author'), 'date'),
              url: at(one, 'html_url'),
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'createAgentTask',
        description:
          'Starts a GitHub Copilot cloud agent task: the agent works the prompt in its own branch and ' +
          'opens a draft pull request. Pass owner and repo (or the repo as owner/name, or an empty owner ' +
          'for the configured organization), the prompt saying what to do, and a base branch - or an ' +
          'empty baseRef for the default branch. Answers the task\'s id, state and url; follow it with ' +
          'agentTask. Needs a user token with Copilot access.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'prompt', type: 'string' },
          { name: 'baseRef', type: 'string', required: false, default: '' },
        ],
        returnType: 'AgentTask',
        run: (owner, repo, prompt, baseRef) => {
          if (typeof prompt !== 'string' || prompt.trim().length === 0) {
            throw new Error('an agent task needs a prompt saying what to do');
          }
          const base = repoPath(this.settings, owner, repo);
          const body = { prompt: prompt };
          if (typeof baseRef === 'string' && baseRef.length > 0) {
            body.base_ref = baseRef;
          }
          const made = read(this.settings, { method: 'POST', path: `/agents${base}/tasks`, body: body }).json;
          return {
            id: at(made, 'id'),
            state: at(made, 'state'),
            url: at(made, 'html_url') ?? at(made, 'url'),
            created: at(made, 'created_at'),
          };
        },
      }),

      new OrknuxFunction({
        name: 'agentTask',
        description:
          'One Copilot agent task as GitHub sees it now: its state (queued, in_progress, completed, ' +
          'failed, waiting_for_user, ...), its pull request, and its sessions - whose ids agentTaskLogs ' +
          'takes. Pass owner and repo (or the repo as owner/name, or an empty owner for the configured ' +
          'organization) and the task id createAgentTask answered.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'taskId', type: 'string' },
        ],
        returnType: 'map',
        /*
         * Passed through rather than curated: the agent-tasks API is in public
         * preview and its shape still moves, and here a moved shape should be
         * new data in the answer rather than data this file quietly drops.
         */
        run: (owner, repo, taskId) => {
          const base = repoPath(this.settings, owner, repo);
          return read(this.settings, {
            path: `/agents${base}/tasks/${encodeURIComponent(String(taskId))}`,
          }).json;
        },
      }),

      new OrknuxFunction({
        name: 'agentTaskLogs',
        description:
          'The logs of one Copilot agent session: the agent\'s own account of what it read, decided and ' +
          'changed. Pass a session id from agentTask\'s sessions. The answer is the log text itself.',
        params: [{ name: 'sessionId', type: 'string' }],
        returnType: 'string',
        run: (sessionId) => {
          const answered = read(this.settings, {
            path: `/agents/sessions/${encodeURIComponent(String(sessionId))}/logs`,
          });
          return answered.body;
        },
      }),

      new OrknuxFunction({
        name: 'messageAgentTask',
        description:
          'Tells a running or finished Copilot agent task to change course - different approach, more ' +
          'work, a fix. Pass owner and repo (or the repo as owner/name, or an empty owner for the ' +
          'configured organization), the number of the task\'s pull request (agentTask answers it), and ' +
          'what to say. Answers the comment\'s id and url.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'pullNumber', type: 'number' },
          { name: 'message', type: 'string' },
        ],
        returnType: 'Comment',
        run: (owner, repo, pullNumber, message) => {
          const base = repoPath(this.settings, owner, repo);
          /*
           * Steering is a PR comment that mentions @copilot — that is GitHub's
           * own mechanism, not a workaround — so the mention is guaranteed here
           * rather than hoped for in the message.
           */
          const said = /(^|\s)@copilot\b/i.test(message) ? message : `@copilot ${message}`;
          const made = read(this.settings, {
            method: 'POST',
            path: `${base}/issues/${pullNumber}/comments`,
            body: { body: said },
          }).json;
          return { id: at(made, 'id'), url: at(made, 'html_url') };
        },
      }),

      new OrknuxFunction({
        name: 'comment',
        description:
          'Comments on a pull request or issue - the plain kind, under the conversation. Pass owner and ' +
          'repo (or the repo as owner/name, or an empty owner for the configured organization), the PR ' +
          'or issue number, and the comment as GitHub markdown. Answers the comment\'s id and url. For a ' +
          'comment on a line of the diff, use reviewComment instead.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'number', type: 'number' },
          { name: 'text', type: 'string' },
        ],
        returnType: 'Comment',
        run: (owner, repo, number, text) => {
          const base = repoPath(this.settings, owner, repo);
          const made = read(this.settings, {
            method: 'POST',
            path: `${base}/issues/${number}/comments`,
            body: { body: text },
          }).json;
          return { id: at(made, 'id'), url: at(made, 'html_url') };
        },
      }),

      new OrknuxFunction({
        name: 'reviewComment',
        description:
          'Comments on a pull request\'s diff - the review kind, anchored to a file. Pass owner and repo ' +
          '(or the repo as owner/name, or an empty owner for the configured organization), the PR ' +
          'number, the file\'s path as openPull lists it, the line in the new version the comment is ' +
          'about - or 0 to speak about the file as a whole - and the comment as GitHub markdown. ' +
          'Answers the comment\'s id and url; replyToComment threads onto it.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'number', type: 'number' },
          { name: 'path', type: 'string' },
          { name: 'line', type: 'number' },
          { name: 'text', type: 'string' },
        ],
        returnType: 'Comment',
        run: (owner, repo, number, path, line, text) => {
          const base = repoPath(this.settings, owner, repo);
          /*
           * A review comment is anchored to a commit, and the anchor a reader
           * expects is the head of the pull request as it stands — so it is
           * read here rather than asked of the caller.
           */
          const pull = read(this.settings, { path: `${base}/pulls/${number}` }).json;
          const body = { body: text, commit_id: at(at(pull, 'head'), 'sha'), path: path };
          if (typeof line === 'number' && line > 0) {
            body.line = line;
            body.side = 'RIGHT';
          } else {
            body.subject_type = 'file';
          }
          const made = read(this.settings, {
            method: 'POST',
            path: `${base}/pulls/${number}/comments`,
            body: body,
          }).json;
          return { id: at(made, 'id'), url: at(made, 'html_url') };
        },
      }),

      new OrknuxFunction({
        name: 'replyToComment',
        description:
          'Replies in the thread under one review comment. Pass owner and repo (or the repo as ' +
          'owner/name, or an empty owner for the configured organization), the PR number, the id of the ' +
          'review comment being answered - reviewComment answers one, and a review_comment webhook ' +
          'carries one - and the reply as GitHub markdown. Answers the reply\'s id and url.',
        params: [
          { name: 'owner', type: 'string' },
          { name: 'repo', type: 'string' },
          { name: 'number', type: 'number' },
          { name: 'commentId', type: 'number' },
          { name: 'text', type: 'string' },
        ],
        returnType: 'Comment',
        run: (owner, repo, number, commentId, text) => {
          const base = repoPath(this.settings, owner, repo);
          const made = read(this.settings, {
            method: 'POST',
            path: `${base}/pulls/${number}/comments/${commentId}/replies`,
            body: { body: text },
          }).json;
          return { id: at(made, 'id'), url: at(made, 'html_url') };
        },
      }),
    ];
  }
}
