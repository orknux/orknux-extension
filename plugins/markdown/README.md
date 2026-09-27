# Markdown

Every model writes markdown. Almost nowhere renders it.

| Function | |
|----------|---|
| `toText(markdown)` | Markdown stripped to plain readable text, for an email subject, a commit message, a log line, a webhook field. |

Emphasis markers go, links become `text (url)`, headings become their words,
tables become their rows, and code keeps its content without the backticks.
Entities a markdown writer typed — `&amp;`, `&#8212;` — are decoded, because
the destination renders nothing and would print them.

A string transformation and nothing else: no capability, no permission, nothing
to reach and nothing to break.

## `toSlack` lives in the slack plugin now

It used to be here, and the pairing read well: one plugin, both directions. But
the conversion has one caller, and that caller already had to be told to make
the call — which is the kind of instruction a model follows four times out of
five. `slack_post` converts what reaches it, so the whole machinery moved into
the plugin that posts: the parking of fences and code, the links, the headings
and tables mrkdwn has no spelling for.

Two things changed on the way, and both are about the place it arrived in.
Slack's own markup — `<@U0123ABCD>`, `<#C0123|general>`, `<https://x|text>` —
is parked rather than escaped, because there it is what a caller meant rather
than something a writer typed. And `>` is no longer escaped at all, because at
the start of a line it is Slack's blockquote, which the posting skill now tells
a model to use.

## The skill stayed

**"Writing so Slack reads it"** — because the case it is for was never the one
with a call in it. An agent answering in a thread has its reply posted as it
stands, with nothing in between to convert anything, and that is the case a
converter cannot reach: the only fix is having written mrkdwn in the first
place. The page says what to write, and what a line break has to be.
