/*
 * Markdown with its markup taken off.
 *
 * Every model writes markdown. Almost nowhere renders it - and where the
 * destination reads a markup of its own, the conversion belongs with the
 * destination: `slack_post` writes mrkdwn itself now, and `toSlack` moved into
 * that plugin with the rest of the machinery. What is left here is the other
 * direction, and the one no particular service owns.
 *
 * `toText` is for somewhere that renders nothing at all - an email subject, a
 * commit message, a log line, a webhook field - where the punctuation would be
 * read as punctuation. Emphasis markers go, links become `text (url)`,
 * headings become their words, code keeps its content.
 *
 * That is a string transformation and nothing else: this plugin reaches
 * nothing, asks for no capability and no permission, and cannot fail because
 * somebody's API moved.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

/** The entities a markdown writer may have typed, decoded for plain text. */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A table row split into its cells, with the pipes and padding gone. */
function cellsOf(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Whether a line is a table's `|---|:--:|` separator rather than content. */
function isRule(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/** Markdown with its markup taken off, for somewhere that renders nothing at all. */
function toText(markdown) {
  let text = String(markdown).replace(/\r\n?/g, '\n');

  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (whole, code) => code.replace(/\n$/, ''));
  text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1/g, (whole, ticks, code) => code);
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, alt, url) =>
    alt.trim().length > 0 ? `${alt} (${url})` : url,
  );
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, label, url) => `${label} (${url})`);
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1');

  const written = [];
  for (const line of text.split('\n')) {
    if (isRule(line)) {
      continue;
    }
    let held = line;
    held = held.replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, '$1');
    held = held.replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, '');
    held = held.replace(/^(\s*)[-*+]\s+/, '$1• ');
    held = held.replace(/^\s*>\s?/, '');
    if (held.includes('|') && /^\s*\|/.test(held)) {
      held = cellsOf(held).join('  ');
    }
    held = held.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1');
    held = held.replace(/\*\*([\s\S]+?)\*\*/g, '$1');
    held = held.replace(/~~([\s\S]+?)~~/g, '$1');
    held = held.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1$2');
    held = held.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1$2');
    held = held.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
    written.push(held);
  }
  return written.join('\n');
}

export default class Markdown extends OrknuxPlugin {

  id() {
    return 'markdown';
  }

  apiVersion() {
    return 1;
  }

  parameters() {
    return [];
  }

  permissions() {
    return [];
  }

  capabilities() {
    // None, and none possible: this is string in, string out.
    return [];
  }

  /*
   * Where the asterisks come from.
   *
   * A model writes markdown because markdown is what writing looks like. Slack
   * reads mrkdwn, which is near enough to look the same and different enough
   * that `**bold**` arrives with its asterisks showing - and the model cannot
   * see the message it sent, so nothing corrects it.
   *
   * `slack_post` converts what reaches it, which covers every message with a
   * call in it. It does not cover the commoner case: an agent answering in a
   * thread, whose reply is posted as it stands, with no call anywhere. That is
   * what this is for, and it is why the skill outlived the function.
   */
  skills() {
    return [
      new OrknuxSkill({
        name: 'Writing so Slack reads it',
        description: 'Why a message arrives full of asterisks, and the two different fixes.',
        content: `# Writing so Slack reads it

Slack does not read markdown. It reads **mrkdwn**, which looks near enough to
be mistaken for it and is not, so a message written as markdown arrives with
its punctuation showing:

    what you wrote          what the reader sees
    **orknux-server**       **orknux-server**
    * a bullet              * a bullet
    [docs](https://x.com)   [docs](https://x.com)
    # A heading             # A heading

You cannot see the message you sent, so nothing tells you this happened.

## Which fix depends on how your text gets there

**If you are calling \`slack_post\`** - it converts what you give it. The
shapes that are never valid mrkdwn are rewritten on the way out: \`**bold**\`,
\`~~struck~~\`, \`[text](url)\`, \`#\` headings, \`*\` and \`-\` bullets, tables
and numbered lists. Code spans and fences are left exactly as written, and a
single \`*\` or \`_\` is never touched, because those are already mrkdwn and
rewriting them would break the messages that were right.

**If your reply is posted as it stands** - you are answering in a thread and
what you write goes to the channel verbatim - then nothing converts anything.
**Write mrkdwn directly.** This is the case that catches people, because there
is no call involved to remind you, and it is the reason this page exists.

**And write real line breaks.** A message whose newlines arrive as the two
characters \`\\\` and \`n\` lands on one line with its markup showing: a
\`>\` quote is only a quote at the start of a line, and Slack will not close a
\`*\` span that a backslash follows. \`slack_post\` repairs the obvious case,
and a reply that goes out as it stands has nothing to repair it.

## mrkdwn, in full

| you want | write | not |
|---|---|---|
| bold | \`*bold*\` | \`**bold**\` |
| italic | \`_italic_\` | \`*italic*\` |
| strikethrough | \`~struck~\` | \`~~struck~~\` |
| a link | \`<https://x.com|text>\` | \`[text](https://x.com)\` |
| a bullet | \`•\` and a space, or \`-\` | \`*\` |
| code | \`\`code\`\` | the same - backticks are backticks |
| a heading | a bold line | \`#\` |
| a quote | \`>\` | the same |

**There are no headings and no tables.** A \`#\` line is literal text. Make a
heading a bold line on its own; make a table a short list, because a table in
a phone-width message is unreadable whatever the syntax.

## Somewhere that renders nothing

\`markdown_toText\` is the other direction: emphasis gone, links become
\`text (url)\`, headings become their words, code keeps its content. For an email
subject, a commit message, a log line, a webhook field - anywhere the
punctuation would be read as punctuation.

## One habit worth keeping

Write the message, then ask where it is going, then convert or compose
accordingly. Deciding afterwards is how \`**bold**\` reaches a channel: the text
was already written and the thought was already elsewhere.`,
      }),
    ];
  }

  tools() {
    return [
      new OrknuxFunctionTool({ function: 'toText' }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'toText',
        description:
          'Strips markdown down to plain readable text, for somewhere that renders nothing at all - ' +
          'an email subject, a commit message, a log line, a webhook field. Emphasis markers go, ' +
          'links become "text (url)", headings become their words, and code keeps its content ' +
          'without the backticks.',
        params: [{ name: 'markdown', type: 'string' }],
        returnType: 'string',
        run: (markdown) => (typeof markdown === 'string' ? toText(markdown) : ''),
      }),
    ];
  }
}
