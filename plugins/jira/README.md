# Jira

The other half of the sentence the github plugin starts. A pull request merging
is only half of "the work is done"; the other half is a ticket moving, and a
workflow that can read one and not write the other is a workflow somebody
finishes by hand.

So: find issues by JQL, open one whole, comment on it, move it through its
workflow, and raise a new one. Every call is made by the server on the plugin's
behalf under `NETWORK_REQUEST` — the plugin never holds the token.

| Function | |
|----------|---|
| `search(jql, limit)` | Jira's own query language: `project = PROJ AND status = "In Progress"`, `assignee = currentUser() ORDER BY updated DESC`. |
| `openIssue(key)` | One issue whole, description included, as text. Answers the `Issue` shape below rather than a bare map. |
| `comment(key, text)` | A comment, as plain text. |
| `transition(key, to)` | Moves an issue — what dragging its card to another column does. |
| `form(project, type)` | What a new issue of that type in that project has to say: every field by name, which are required, and the values each choice takes. |
| `createIssue(project, type, summary, description, fields = {})` | Raises a new one. `fields` is whatever else the project asks for, keyed by name as `form` lists it. |
| `updateIssue(key, fields)` | Sets fields on an existing issue — the same map, resolved against that issue's own edit form. |
| `link(from, relation, to)` | Links two issues, the relation said as a verb — `"depends on"`, `"blocks"`, `"relates to"` — and matched against this Jira's link types. |
| `groupMembers(group)` | Who is in a Jira group, by name — the way a team is usually kept. |
| `timeLogged(user, from = "", to = "")` | What one person logged in Jira's work log, day by day. Both dates empty means last week, Monday to Sunday. |

`transition` takes a status or transition **by name**, matched whatever the
capitals, because an id is a number out of somebody's workflow configuration
that nobody knows. Which moves are possible depends on where the issue is right
now, so the list is read at the moment of asking and a name that is not
available is refused with the ones that are.

## The fields a project adds

A project can make fields of its own mandatory on a new issue — *Occurs on:
PROD, UAT or DEV*, *Kind of work: one of six* — and Jira refuses a create that
leaves one out. On the wire those are `customfield_10123`, with a shape per
kind: a choice is `{ id }`, a user is `{ accountId }` on Cloud and `{ name }`
on Server, a list is a list of those. Nobody calling from a workflow, and no
model calling from an agent, should have to know any of that.

So `form` reads the create metadata for a project and issue type and answers
the whole form: each field's name, whether it is required, its kind, and the
labels a choice takes. `createIssue` then takes a `fields` map keyed by those
names and valued by those labels, resolves each against the same metadata,
and builds Jira's shape itself:

```
createIssue('OKO', 'Bug', 'Checkout fails on DEV', 'Steps…', {
  'Occurs on': 'DEV',
  'Kind of work': 'Maintenance',
  'Labels': 'checkout, payments',     // a list, as a list or with commas
})
```

A label that is not one of the choices is refused here, with the choices,
rather than by Jira with an id. A field id (`customfield_10123`) works as a key
too, and an object value goes through untouched, so a caller who knows Jira's
shape for something this does not cover can still say it. A create with an
empty `fields` stays one request: the form is only read when there is
something to resolve.

When Jira refuses a create, every field it names is in the sentence, not only
the first — a project that insists on two says so once.

`updateIssue` takes the same map for an issue that already exists — "you
forgot the team" is `updateIssue('OKO-4220', { 'Team': 'Checkout' })`, not a
new ticket. It resolves against that issue's *edit* metadata rather than the
project's create form, because what can be changed depends on the issue, its
status and the token; a field it does not know is refused with the names the
issue does have, so one wrong guess costs one call.

A user field takes a person the way people say them. `"Assignee": "me"` is
whoever the token is, asked of Jira, because an agent does not know its own
account id and should not have to. A display name, a username or an email is
looked up the way the site's own picker does it, and several matches are
refused with their names rather than guessed between.

## The shapes it exports

`objects()` declares **`Issue`**, which arrives in a workspace as `jira_Issue`.
`openIssue` answers it instead of a `map`, so a workflow built against it knows
that `status` is a string and `labels` is a list of them without reading this
file to find out.

| Field | | |
|---|---|---|
| `key` | string | `PROJ-123`, which every other call takes |
| `summary` | string | the one-line title |
| `description` | string | the body, as text — null from a search |
| `status` | string | where it sits in its workflow |
| `type` | string | Task, Bug, Story |
| `priority` | string | null where the project does not use them |
| `assignee` / `reporter` | string | display names |
| `labels` | array of string | empty from a search |
| `resolution` | string | why it closed, or null while open |
| `links` | array of `Link` | what it blocks, depends on, relates to — each with the verb from this issue's side, the other key, its summary and status. Empty from a search |
| `created` / `updated` | string | ISO 8601, as Jira gives it |
| `url` | string | the browse link |

`search` still answers a `map` holding a list of these: it fills `description`,
`labels` and `resolution` as null and empty rather than leaving them out, so
one shape describes both calls and a caller reading `labels` gets a list either
way.

## Checking a team's timesheets

"Did everyone log their hours last week" is a loop over a group, and both
halves are here. `groupMembers` lists a Jira group — each member's `id`,
which is what the next call takes. `timeLogged(user, from, to)` answers what
one person logged, day by day, from Jira's own work log:

```
timeLogged('5b10ac8d82e05b22cc7d4ef5')            // last week, Monday to Sunday
timeLogged('me', '2026-09-14', '2026-09-20')      // any range, inclusive
```

Every calendar day in the range is answered, weekends included, each with
its `weekday`, its `hours` — `0` where nothing was logged — and the entries
behind them. A gap is therefore a weekday with fewer hours than the team
expects, not a date that is missing from the list, and a Saturday with `0`
is not a gap at all. The check itself is the workflow's: it knows whether the
team logs eight hours or seven and a half.

It is two steps inside, because that is how Jira keeps it: JQL finds the
issues somebody logged on in the range, then each issue's work log is read
and only their entries in the range are kept — other people log on the same
issues. A date is read off the entry's `started`, which Jira spells with the
logger's own offset, so a day is the day it was for the person logging it.

Where Tempo or another timesheet app is in use, its entries are mirrored
into Jira's work log and appear here too. Its approval state does not; that
lives in the app's own API.

## Linking two issues

A link type in Jira is a name and two verbs, one per direction: *Blocks* is
"blocks" going out and "is blocked by" coming in. `link` takes the verb a
person would say and reads it against the types this Jira has, so the verb
picks both the type and which end `from` is:

```
link('OKO-4219', 'depends on', 'OKO-4124')
link('OKO-4124', 'is depended on by', 'OKO-4219')   // the same link
```

Every Jira has its own set — the names are somebody's configuration — so a
verb it does not have is refused with the ones it does. `openIssue` answers
`links` from the issue's own side, so what already depends on what is one
call away before a second copy of a link gets made.

`form` answers **`Form`** — `project`, `type`, the `required` names as the
short answer, and `fields`, a list of **`Field`**: `id`, `name`, `required`,
`kind`, `of` for what an array holds, `allowed` for the labels a choice takes,
and `hasDefault`.

## Setting one up

1. Load this plugin and accept `NETWORK_REQUEST`.
2. Add a connection of the kind it brings, **Jira**, with the site root as its
   URL — `https://your-site.atlassian.net` for Cloud, or the base url of a
   Server install.
3. For Cloud, authenticate with Basic and `email:token` as the secret — an API
   token and whose it is. For Server or Data Center, a Bearer personal access
   token.
4. Point the plugin's `jira` parameter at that connection.
5. Optionally set `project`, the key new issues belong to unless a call names
   one.

The connection's auth kind is the same signal the confluence plugin uses,
because it is the same company's two products: Basic means Cloud, Bearer means
Server. Here it also picks the search endpoint, which is the one place the two
genuinely differ.

The address and the credential live on the connection rather than on the
plugin's page, so they are kept encrypted, and a workspace can hold as many
Jira sites as it has.

Coming from 0.9: the `url`, `email` and `token` parameters are gone. Make a
Jira connection from them — Basic with `email:token` as the secret for Cloud,
Bearer with the personal access token for Server — and point `jira` at it.

## Why v2 everywhere except search

Jira's v3 API speaks Atlassian Document Format: a description or a comment is
not a string but a tree of nodes, and posting a one-line comment would mean
building one. v2 takes and answers plain text, so v2 is what this uses for
reading an issue, commenting, transitioning and creating.

Search is the exception, and not by choice. Atlassian **removed**
`/rest/api/2/search` and `/rest/api/3/search` from Cloud through the second half
of 2025 — they answer 410 now — leaving `POST /rest/api/3/search/jql`, which is
bounded: it wants an explicit field list, it pages by a cursor rather than an
offset, and it does not answer a total at all. Server and Data Center still have
v2 search and still answer a total. So `search` picks its endpoint by the same
auth kind, and `total` comes back null on Cloud rather than invented.

Should an instance ever hand back Atlassian Document Format where v2 used to
answer text, the tree is walked for its text rather than shown to a caller as
`[object Object]`.
