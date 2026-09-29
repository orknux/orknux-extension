# Slack

The whole Slack surface, wrapped so workflows and agents call it by name: read
a thread, follow a permalink, say who an id is, resolve a mention, post, react,
search, carry files both ways — and the one question the raw API never answers
on its own, *is this the first reply in the thread*, written to be a workflow
condition.

Most of it never touches a token. A plugin has no network, so those calls ask
the **server** to talk to Slack, under a capability somebody accepted and
through a connection the workspace pointed it at. The four file functions are
the exception, and say so below.

## Nineteen functions, eighteen of them tools

Everything except `isFirstReply` is fronted to agents as a tool. That one is a
workflow's gate, written to be a condition — a model reading a thread has
better ways to ask.

Seventeen of those eighteen are the function itself, under a name an agent can
call. The eighteenth, `uploadBinary`, is a tool of its own with a different
signature — see *Two surfaces* below for why.

Every function in the first two groups takes `connection` first — pass the
connection a trigger says its event arrived on, or an empty string to use the
configured `slack` parameter; the section after the tables says why. The one
exception is `toSlack`, which reaches nothing and so is told nothing.

### Reading

| Function | Answers |
|---|---|
| `readThread(connection, channel, threadTs, limit, withNames)` | `messages` — each with `ts`, `user`, `text` and whether it is the `parent` — and `replies`, Slack's own count of the whole thread rather than of the page. `limit` defaults to 20. |
| `readMessage(connection, link)` | The one message a permalink points at: `channel`, `ts`, `user`, `text`, `threadTs`. For when a message quotes another by link. |
| `findChannels(query, limit, withArchived)` | Channels by name, topic or purpose — with `member` saying whether the bot is in it, which decides what else you can do with it. An empty query lists what is there. |
| `listThreads(channel, days, limit, withNames)` | The threads in one channel, newest activity first: what each is about, how many replied, and the `ts` `readThread` takes. |
| `findUsers(query, limit)` | People by **name or email**, for turning "the person called Ada" into the `U…` id everything else takes. An email is one exact request; a name reads the directory. Runs on `botToken`. |
| `whoIs(connection, userId)` | Who an id belongs to: `id`, `name`, `realName`, `displayName`, `bot`. Takes the id bare or as the whole `<@U…>` notation a message carries it in. |
| `search(connection, query, limit)` | `matches` — `channel`, `channelName`, `ts`, `user`, `text`, `permalink` each — and `total`, how many the whole search holds. Slack's search syntax works: `in:#channel`, `from:@name`, `"an exact phrase"`. |
| `findRecent(query, channel, days, limit, withNames, pages, cursor, threads)` | `matches` in the same shape, newest first, by **reading history with the bot token** and filtering it — for a workspace with no user token to search with. Plus how much was read and whether the window was whole. With one channel named it reads five pages of 200 (up to twenty), opens threads to search their replies (up to thirty, a match says its `threadTs`), and answers `nextCursor` where there is more: pass it back as `cursor` to carry on, piece by piece, to the end of the window, a year back at most. Takes no `connection`: it runs on `botToken`. |
| `isFirstReply(connection, channel, threadTs, ts)` | `true` only if this message is the first reply in its thread. **Not a tool** — a workflow condition. |

### Writing

| Function | Answers |
|---|---|
| `post(connection, channel, text, threadTs, attachments)` | The new message's `channel` and `ts`. An empty `threadTs` posts to the channel itself. `attachments` hangs files on the message and takes **either kind**: a permalink string for a file already on Slack, or a map for one that isn't there yet — `{filename, content}`, `{filename, base64}`, or `{url}` — which is uploaded first. See below. |
| `react(connection, channel, ts, emoji)` | `true`. The emoji's short name, with or without colons. Already-reacted counts as done. |
| `mention(connection, name)` | The notation Slack renders as a ping — `<@U…>` for a person, `<!subteam^S…>` for a group — from a display name, username, email, id or group handle. Put the answer in a message as it is, and never write `<@…>` from a guessed id. |
| `toSlack(markdown)` | The same text as mrkdwn — the conversion `post` does on the way out, on its own, for text going somewhere else. Takes no `connection`, reaches nothing, sends nothing. |

### Files out

All four need `botToken`. Which one you want follows from the shape the content
is in:

| Function | For |
|---|---|
| `upload(channel, filename, content, comment, threadTs, contentKey)` | **Any file** Slack will host. Answers the file's `id` and `permalink`. An empty `channel` uploads without sharing, and the permalink then goes into a later `post`'s `attachments`. **The two surfaces differ:** agents pass a `contentKey` and nothing else - the server records whether a key holds text or bytes (`orknux.session.store.kind`), so one tool uploads either as what it is; the workflow function still takes `content`, because a workflow has no session to keep a key in. |
| `uploadBinary(channel, filename, …, comment, threadTs)` | **Bytes** Slack will host — a PDF, a rendered diagram. Up to the http door's 10 MB. **The two surfaces differ:** agents pass a `contentKey` and have no base64 argument at all; the workflow function still takes `base64`, because a workflow has no session and so never had a key. See *Two surfaces* below. |
| `uploadFromUrl(channel, url, filename, comment, threadTs)` | **Copying a file from a url onto Slack**, so the channel holds the file rather than a link. Fetches up to 5 MB. An empty `filename` is derived from the url and its content type. |
| `remoteFile(channel, url, title, filetype)` | **Pointing at a url without copying it.** Slack keeps a pointer and shows a card. The right door when the bytes should stay where they are, or exceed the caps above. |

### Files in

| Function | Answers |
|---|---|
| `listAttachments(channel, ts)` | `files` hanging on one message — `id`, `name`, `title`, `filetype`, `mimetype`, `size`, `permalink` each. A message with no files answers an empty list. Reads channel history, falling back to the thread, because a reply is not in the channel's history. |
| `readAttachment(file)` | One attachment by id: `name`, `mimetype`, `size`, and exactly one of `content` (text as text) or `base64` (binary as bytes), the other `null` — plus a `key` naming whichever it was. Hand that straight to `uploadBinary` or `upload` as `contentKey` to move a file between channels without either of you retyping it. |

## Finding a channel, and what is being talked about in it

`findChannels` matches every word against name, topic and purpose, so
`findChannels('deploy')` turns up `#deploys` by its name and a channel whose
purpose says "deploy policy". An empty query lists what is there. Archived
channels are left out unless `withArchived` asks for them.

**The bot's own channels are read first**, and not only to be quick. A channel
somebody added the bot to is always in that list; the list is short where the
workspace's is not; and it is the only list anything else here can read. An
exact name found in it is answered immediately, without touching the
directory.

That ordering exists because of how Slack pages. `conversations.list` does not
answer `limit` channels and stop — it answers **up to** that many, often far
fewer, and hands back a cursor. A workspace of 9,499 channels sent thirty-seven
a page, so an early version that asked for 200 and read five pages saw 185
channels and reported that a channel the bot was sitting in did not exist. The
fix is to follow the cursor, which this now does, up to 25 pages of a thousand.

`complete: false` still means the directory ran past that cap — on a workspace
that large, trust `member: true` results and treat a miss as "not found yet".

The field to read is **`member`**. It says whether the bot is in the channel,
and that is what decides whether anything else here can read it —
`listThreads` and `findRecent` see what the bot was invited to, and no scope
substitutes for an invitation.

`listThreads` then answers what is being discussed without reading any of it:

```
listThreads('#deploys')  →  threads, newest activity first, each with
                            text, replies, repliers, and the ts readThread takes
```

**Slack has no call that lists threads.** A thread is a message that has been
replied to, and Slack writes that count on the parent and nowhere else — so
this reads the channel's recent history and picks the parents out of it. Two
consequences worth knowing:

- it sees the window `days` asks for, not the archive behind it
- a thread whose **parent** is older than the window is not in the answer,
  however recently somebody replied to it

Sorting is by last reply rather than by when the thread started: a question
from Monday answered an hour ago is the live conversation, and this morning's
ignored thread is not. `complete: false` means older messages in the window
went unread.

Scopes: `channels:read` for finding channels and `channels:history` for
listing threads, plus the `groups:*` pair for private ones.

## Finding somebody

`findUsers` answers the question an id cannot: who is Ada, and what is her
`U…`. The two halves of it are not alike, and the difference is Slack's:

| given | what happens | cost |
|---|---|---|
| `ada@acme.com` | `users.lookupByEmail` — an exact answer | one request |
| `ada lovelace` | `users.list`, filtered here | a page per 200 accounts, five pages max |

There is no user search for a bot token, which is why a name means reading
the directory. Every word has to appear somewhere across username, real name,
display name and address, so `lovelace` and `ada lovelace` both find her while
`ada bob` finds nobody. Deactivated accounts are skipped.

`complete: false` means a large workspace ran past the page cap and somebody
further down may match — narrow the query, or use an address, which never
pages at all. Nobody at an address is an answer rather than a failure: the
question was whether they are here.

Scopes: `users:read`, plus `users:read.email` for anything involving
addresses. Without the second, `email` is null and an email query finds
nothing.

## A thread reads as people, not as ids

Slack writes an author as `U0123ABCD` on every message, so a thread arrives
as four ids and a model has to look each of them up to understand who is
talking — or guess. `readThread` and `findRecent` resolve them: every message
carries a `userName` beside its `user`.

**Each person is looked up once.** A thread of forty messages from three
people is three requests, because the same id is the same person all day.
That saving is the reason this belongs in the plugin rather than in whatever
reads the thread.

| | |
|---|---|
| `withNames` | on by default; pass `false` where the ids are all you need |
| cost | one lookup per **distinct** author, capped at twenty per call |
| a failed lookup | leaves that name null — an unresolved author beats a failed read |
| `search` | free: Slack's own match carries the name beside the id |

The name is the display name, falling back to the real name where somebody
set none. `whoIs` is still there for one id on its own.

## Passing content by key

A tool's answer reaches the next tool call by going **through the model**,
which has to write every character of it back out. A few kilobytes does not
survive that trip: a rendered diagram went to Slack with one stray character in
the middle of it and the whole call was rejected as malformed JSON.

So both upload functions take a `contentKey` as well as their content:

```
pdf_fromHtml('<h1>Q3</h1>')   → { base64: 'JVBERi0…', bytes: 18402, key: 'pdf.1k3af9' }
slack_uploadBinary('C123', 'q3.pdf', 'pdf.1k3af9', 'the quarter', '')
```

The key is a dozen characters, and what it names never leaves the server — the
render puts the bytes in the session store on the way out, and the upload reads
them back from there.

**Preferred, not exclusive.** A caller holding the text passes `content` as
before, and a workflow node has no session to keep anything in, so `content`
stays the path that always works. A key that names nothing throws and says to
pass the content or render again, rather than uploading an empty file.

**A diagram goes as a picture.** Slack draws no SVG — it hosts one as a file
and shows a card with a filename on it, so an SVG in a channel is something
people have to download before they can see it. Whatever draws the diagram
answers a `png` unless asked otherwise; send that, with a `.png` filename,
through `uploadBinary`. SVG is for a reader that is not a person.

**Everything else that is text goes to `upload`, not `uploadBinary`.** A CSV, a
log, JSON, a config. Encoding text to base64 to send it as bytes doubles its
length and puts it back through the model, which is the problem this exists to
avoid.

## Two surfaces, on purpose

`uploadBinary` is the one call here whose tool is not its function, and the
signatures differ by one argument:

| | |
|---|---|
| **function** — a workflow step calls this | `uploadBinary(channel, filename, base64, comment, threadTs, contentKey)` |
| **tool** — an agent calls this | `uploadBinary(channel, filename, contentKey, comment, threadTs)` |

`post` is split the same way and for the same reason: its `attachments` take a
map, and a map could carry `base64`. The tool refuses that and names
`contentKey`; the function still takes bytes. `readAttachment` is the third —
its tool answers the key for a file and the text for text.

The function keeps its `base64`. A workflow has no session, so a key was never
on offer to it, and taking the argument away would close the only door it has.

The tool has nowhere to put bytes at all. A model has a key every time —
everything that makes bytes answers one — and it still wrote five thousand
characters of base64 into the argument, where it arrived a character wrong and
the whole call was rejected as malformed before anything ran. Advice did not
fix that, and a refusal would only have described it after the fact. An
argument a model should never fill is an argument that should not be in front
of it.

That only works because nothing that makes bytes leaves them unnamed:

| Answers a key | |
|---|---|
| `pdf_fromHtml` | the document |
| `charts_render` | the picture |
| `slack_readAttachment` | whichever half it read — so a file moves between channels without passing through anybody |

## A variable can be a Slack user

The plugin defines one value type, `SlackUser`, for a workspace's variables to
be. A variable of that type gets the picker the workflow editor's target box
has - type part of a handle, a real name or an email and pick the member - and
a check at the save: an id that is nobody's, or somebody's who has left, is
refused with a sentence saying so. What a function is handed is the id, which
is what every function here takes.

A `SlackUser` variable is told which Slack connection to look in. That is a
choice on the variable rather than the plugin's own `slack` parameter, because
a workspace with two Slacks has to say, and a variable that says keeps working
when the plugin's configured connection changes underneath it. Left unsaid, the
configured one is used.

## One workflow action

`respond` is the plugin's first *action* - a block the editor's Action node is
pointed at, beside "Send Message" and "HTTP Request", rather than a function a
node calls positionally. Its inputs are wired by name and arrive as one object,
so the `commands` the Slack trigger heard reach it as the list they are.

| Input | |
|---|---|
| `commands` (array) | The slash commands the trigger heard. |
| `channel` | Where to post: a channel id or a `#name`. |
| `threadTs` (optional) | The thread to answer in; leave it unwired to post to the channel. |
| `text` | What to say, as markdown. |

It posts through the configured `slack` parameter and answers `ts` and
`channel`, which the next node reads under those names.

## Parameters

| Name | |
|---|---|
| `slack` | A `SLACK` connection: the Slack to read through when a function is not handed one. Optional. |
| `botToken` | A **bot** token (`xoxb-`), **secret**. The four file functions, `readAttachment`, and `post` when an attachment is a file rather than a permalink. |
| `userToken` | A **user** token (`xoxp-`), **secret**. `search` alone — see *Two tokens* below. Optional: without it, search falls back to the connection's own User Token field. |

## Attaching a file to a message

`post` takes both kinds of attachment, and which one you want follows from
whether the file is on Slack already:

```js
// Already there — a permalink an event or readThread carried. Costs nothing.
post(conn, 'C123', 'here it is', '', ['https://acme.slack.com/files/U1/F2/report.pdf'])

// Not there yet — uploaded first, with botToken, then attached.
post(conn, 'C123', 'this quarter', '', [
  { filename: 'q3.csv',    content: 'region,revenue
EMEA,41000' },
  { filename: 'q3.pdf',    base64:  pdfFromHtml.base64 },
  { url: 'https://ci.acme.com/build/42/chart.png' },
])
```

A string is used as it is and needs no token at all. A map is a file that does
not exist yet: it is uploaded with `botToken` and its permalink goes into the
message with the others, so both kinds end up in one message.

**The upload deliberately does not share to the channel.** Sharing at upload
time makes Slack post the file as its own message — a second message nobody
asked for, arriving before the text that explains it. A permalink in the
message that follows is Slack's own way of hanging a file on a message
somebody wrote, which is why `post` needs nothing beyond `SLACK_POST_MESSAGE`
for the permalink half.

Use the `upload*` functions directly when you want the file to *be* the
message, or when you want its id back.

## post writes mrkdwn, and `toSlack` is the same conversion on its own

Slack reads *mrkdwn*, which resembles markdown closely enough to be mistaken
for it: `**bold**` arrives with its asterisks showing, `[text](url)` as literal
brackets, `#` as a hash and a space. Whatever wrote the message cannot see it
afterwards, so nothing corrects it — which is why `post` converts on the way
out rather than leaving it to somebody's memory.

The conversion was the markdown plugin's `toSlack` and moved in here with that
plugin's removal, because this is where it is used and a caller who has to
remember another plugin first is a caller who forgets. It is also still a call
of its own — **`slack_toSlack(markdown)`** answers the converted text and posts
nothing — for text that is not going straight into a message: a comment
composed a step earlier, something another plugin will send, or simply seeing
what your markdown becomes. It is the one function here that takes no
connection, because it reaches nothing.

Callers of the old `markdown_toSlack` have to be pointed at the new name; the
conversion itself is the same one, with the fixes below. What it does: fences, inline code, links and images
are lifted out and parked before anything runs — an asterisk inside a code span
is an asterisk, and a URL inside a link is not text — then headings become bold
lines, tables become their rows, `---` becomes a rule, and bullets and numbered
items get Slack's own spacing.

Three rules are this plugin's own rather than the converter's:

- **A single `*` or `_` is never touched.** One asterisk is *bold* in mrkdwn
  and one underscore is *italic*, so text that was already right has to come
  through unchanged. Converting it would break the messages that needed no
  fixing.
- **Slack's own markup is parked, not escaped.** `<@U0123ABCD>` is a person
  `mention` just answered, `<#C0123|general>` is a channel, `<https://x|text>`
  is a link already spelled the way Slack spells them. The markdown plugin
  escaped every `<` it saw, because nothing reaching it was ever Slack's.
- **`>` is not escaped at all**, because at the start of a line it is the
  blockquote the posting skill tells a model to use when it answers a message
  that is not the one above it.

### And a line break written as `\n` is repaired

A message arrived in a channel reading
`*Using my friend*\n\n> why did you not use your friend?\n\nI managed…` — the
whole answer on one line, escape sequences printed. The model had written the
two characters instead of the newline, and the cost is not one blank line: a
`>` is only a quote at the *start* of a line, and Slack will not close a `*`
span that a backslash follows, so the quote and the bold both died with it.

`post` turns those into real line breaks when the message holds no real one, or
holds `\n\n` — neither of which a path or a filename can be — and code is
parked first, so a message *about* `\n`, written in backticks, still says it.
A reply an agent writes as its own answer passes through none of this: there,
as the skill says, a real line break is the only thing that is one.

## Two tokens, because Slack needs two

| | |
|---|---|
| `botToken` | `xoxb-`. Uploads files **as the bot**, under the bot's name and picture. |
| `userToken` | `xoxp-`. Runs `search`, which Slack will not answer for a bot at all: `search.messages` refuses a bot token with `not_allowed_token_type`. |

They used to share a field, and the failure mode was quiet: somebody needs
search, puts a user token in `botToken` because that is the only token field
there is, and from then on every file the workspace uploads is posted by that
person rather than by the app. `tokenOf` still warns when it sees an `xoxp-`,
and now has somewhere to point.

`userToken` is optional. Left empty, `search` uses the connection's own **User
Token** field, which is where a workspace that has one usually keeps it — so
nothing that works today stops working.

## Why the connection is an argument, not just a setting

A workspace with two Slack connections has two Slacks. A reply that arrived on
one has to be read through that one — read through the other it is a thread
that does not exist, or worse, a different thread with the same timestamp.

So every call takes a connection, and a trigger says which one its event came
in on: wire `trigger.connection` to the argument and it is right by
construction rather than by whichever connection happened to be configured.
Passing an empty string falls back to the `slack` parameter, which is what a
workspace with one Slack wants and one fewer thing to wire.

## What it asks for, and why

`TEXT_ENCODING`, for the byte length a file upload declares — the length of
text is a fact about its UTF-8 encoding, not its character count.

Eight Slack capabilities, one per call: `SLACK_READ_THREAD`,
`SLACK_READ_MESSAGE`, `SLACK_READ_USER`, `SLACK_MENTION`,
`SLACK_POST_MESSAGE`, `SLACK_ADD_REACTION`, `SLACK_SEARCH`, `SLACK_SUGGEST`.
Each is the server
making one call for the plugin; the plugin never sees a token and could not use
one.

`NETWORK_REQUEST` — **for the functions that hold a token.** The server's
capability vocabulary has no spelling for "put a file on Slack", so the file
functions go straight at Slack's Web API with `botToken`; `post` joins them
when an attachment is a file rather than a permalink, and `search` does when
`userToken` is set. Everything else here runs on capabilities and never sees a
credential.

### Slack-side scopes

| For | Scope |
|---|---|
| `upload`, `uploadBinary`, `uploadFromUrl`, `post` with a file attachment | `files:write` |
| `remoteFile` | `remote_files:write`, `remote_files:share` |
| `listAttachments` | `files:read`, plus the conversation's history scope |
| `readAttachment` | `files:read` |
| `search` via `userToken` | `search:read` — or the granular `search:read.public`, `.private`, `.im`, `.mpim` — on a user token |
| `findRecent` | `channels:history`, `channels:read` on the bot token — plus `groups:*` for private ones |

## Two caveats worth knowing before you debug them

**Search answers only for a user token.** `search.messages` refuses a bot token
with `not_allowed_token_type`, which comes back as the error — so a search runs
on either the `userToken` parameter or the connection's **User Token** field,
and on nothing else.

**`findRecent` is the answer where there is no user token to have.** Slack
exposes no message search to a bot token at any plan — `search.messages`,
`search.files` and `search.all` are all user-token-only, and
`admin.conversations.search` searches channels rather than what was said in
them. So `findRecent` does the other thing: it reads recent history with the
**bot** token and filters it.

That trades away a great deal and buys the boundary people usually want.
Gone: relevance ranking, the archive behind the window, and any channel the
bot was never invited to. Gained: the reach is *membership*, not scope — a bot
in nothing private can read nothing private, whatever anybody grants it, and
you widen it by inviting the bot rather than by editing a token.

| | |
|---|---|
| scopes | `channels:history` and `channels:read`; add `groups:*` only if private channels should be readable |
| cost | one request per channel, plus one `users.conversations` and one `auth.test` — inside a single call, which is why it reads fifteen channels at most |
| window | `days`, a week by default, one page of 200 messages per channel |
| matching | every word somewhere in the message, any order, any case — **not** Slack search syntax, so `in:#channel` belongs in the `channel` argument |

`complete` says whether the window was read whole. False means a channel had
more behind its page, or more than fifteen channels were asked for — narrow
the days or name a channel, and do not read a `false` as "that is everything".

**`search:read` is the scope that works, and the narrow ones are not a
substitute.** Slack publishes granular search scopes — `search:read.public`,
`.private`, `.im`, `.mpim` — and a token carrying only `search:read.public` is
refused by `search.messages` even when freshly minted. The endpoint searches
every source the identity can see and has no parameter to say otherwise, so it
asks for the whole grant rather than the part a query happens to touch. A
refusal now carries Slack's own `needed` and `provided` beside it, which is the
pair that says which scope is short.

**So the lever is whose token it is, not which scope it carries.** A user token
searches exactly what that person can see — `search:read` on somebody who is in
forty private channels searches all forty. The way to keep a search out of
private conversations is therefore a Slack account that is not in any: make one
for the purpose, add it to the public channels it should read, authorise with
it, and put its token in `userToken`. That parameter exists for this — the
searching identity does not have to be whoever the connection belongs to.

**A condition that cannot be decided must not quietly decide.** `isFirstReply`
throws when the thread cannot be read rather than answering `false`: "we could
not read the thread" and "this is not the first reply" are different facts, and
a workflow treating them alike would silently stop firing the day a scope was
revoked.

## The four skills it brings

The page a workspace marks *Always* is the first one, and it is 5 KB rather
than the 16 KB it used to be: the half about files was loaded into every
conversation that never sent one.

**"Posting to Slack so people read it"**, id `posting-to-slack-so-people-read-it`
— how a message is written and where the reply goes: mrkdwn rather than
markdown, never a hand-written mention, reply in the thread, quote the message
being answered when it is not the one directly above, and read the thread
before adding to it.

**"Sending a file to Slack"**, id `slack-sending-a-file` — when the answer is a
document, a picture or a page rather than a sentence. Which call takes it, what
each extension gets the reader, why an HTML page arrives as markup, and why a
link to something on the orknux side is not delivery.

**"Ending a Slack turn"**, id `slack-ending-the-turn` — your answer is already
a message, so a call that posts and an answer that repeats it send the same
thing twice. `finish_answer` is how a turn ends when the work already went out.

**"New Slack Thread"**, id `new-thread` — the exception to replying in the
thread: post to the channel with an empty `threadTs`, open with a line of
context, hang any file off the `ts` that call answered.

Granted like any other skill catalog; nothing is automatic.
