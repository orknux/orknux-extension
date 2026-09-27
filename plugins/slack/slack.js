/*
 * Slack, as a plugin.
 *
 * What this exists for is the question a workflow cannot answer from the payload
 * alone: what is in this thread. Slack's `message` event carries `thread_ts` and
 * `parent_user_id` and no count, so "is this the first reply" — which is the
 * commonest thing anybody wants to gate a workflow on — is unanswerable from
 * what arrives. Reading the thread is the only way, and reading it needs the
 * network.
 *
 * A plugin has no network, deliberately and permanently: the sandbox is built
 * with `IOAccess.NONE`, and `PluginPermission` is a closed list with no spelling
 * for a socket. So this asks the *server* to read the thread, under a capability
 * a person accepted, through a connection a workspace pointed it at. For all of
 * that surface the plugin never sees a token and could not use one; the two
 * upload functions are the exception, and the section below says why.
 *
 * ## Setting one up
 *
 * 1. Load this plugin and accept the capabilities it asks for.
 * 2. Point its `slack` parameter at the workspace's Slack connection.
 * 3. Use `slack_isFirstReply` as a function condition.
 *
 * The `orknux.slack` calls are wrapped here on purpose: a workflow's condition
 * and an agent's tool both call by NAME, and a name is exactly what a bare
 * capability call does not have. So each call is declared once as a function -
 * workflows call those - and fronted for agents by an `OrknuxFunctionTool` in
 * `tools()`, one implementation under two surfaces, with descriptions written
 * for the model that reads them. `isFirstReply` is the one thing here the raw
 * API does not answer on its own.
 *
 * ## Why the connection is an argument and not just a setting
 *
 * A workspace with two Slack connections has two Slacks. A reply that arrived on
 * one has to be read through that one — read through the other it is a thread
 * that does not exist, or worse, a different thread with the same timestamp. So
 * every function here takes a connection, and a trigger says which one its event
 * came in on: wire `trigger.connection` to the condition's argument and it is
 * right by construction rather than by whichever connection was configured.
 *
 * Falls back to the `slack` parameter when nothing is passed, which is what a
 * workspace with one Slack wants and is one fewer thing to wire.
 *
 * ## Uploading files
 *
 * The server's capability vocabulary has no spelling for "put a file on Slack",
 * so `upload` and `remoteFile` cannot go through a connection the way the rest
 * of this file does. They go the way the github plugin goes instead: under
 * NETWORK_REQUEST, straight at Slack's Web API, with a bot token the workspace
 * puts in the `botToken` parameter — a secret, so it lives in a variable. Both
 * check for it and say so when it is missing; a workspace that never uploads
 * never sets it, and the rest of the plugin still runs tokenless.
 *
 * What each is for follows from the shapes a sandbox can hold — text, and
 * bytes wearing base64, which is what the http door's `upload` and `download`
 * carry them as:
 *
 * - `upload` puts *text content* on Slack — a CSV, a log, a mermaid source —
 *   through the external upload flow (`files.getUploadURLExternal`, the upload
 *   url, `files.completeUploadExternal`). The scope it needs is `files:write`.
 * - `uploadBinary` puts *bytes* on Slack the same way, passed as base64 — a
 *   PDF the pdf plugin wrote, an image — up to the door's 10 MB.
 * - `uploadFromUrl` copies a file *from a url* onto Slack — a rendered mermaid
 *   diagram, a PDF a build published — fetching up to 5 MB of bytes and
 *   uploading them, so the channel holds the file and not a link.
 * - `remoteFile` attaches a url *without* copying: Slack keeps a pointer and
 *   shows a card, under `remote_files:write` and `remote_files:share`. The
 *   right door when the bytes should stay where they are, or exceed the caps.
 *
 * Reading goes through the same door, and the same shapes come back:
 * `listAttachments` says what files hang on a message (`files:read`, and the
 * history scope of the conversation), and `readAttachment` brings one back —
 * text as text, and binary as base64.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

/** A nested field, or null rather than a thrown error on the way down. */
function at(holder, name) {
  if (holder === null || typeof holder !== 'object') {
    return null;
  }
  const held = holder[name];
  return held === undefined ? null : held;
}

/**
 * One call to Slack's Web API, form-encoded, answered or thrown.
 *
 * Form-encoded because that is the one content type every Web API method
 * takes — the upload methods this file calls refuse JSON bodies. Arguments
 * that are undefined or empty are left out, which is how an optional Slack
 * argument is not passed.
 */
/**
 * The bot token, or the sentence that says which parameter is missing.
 *
 * A user token is accepted and noted rather than refused. Slack takes either
 * for these calls and attributes the result to whoever the token belongs to -
 * so a `xoxp-` here means every file this plugin uploads is posted by that
 * person, under their name and their picture, and the bot's own message
 * afterwards says "I have attached the file" beside somebody else's upload.
 *
 * That is occasionally what somebody wants, which is why this is a line in the
 * log rather than an error. What it usually is, is a `botToken` pointed at
 * the user token `search` needs - the one Slack call here that will not
 * answer to a bot. That token has its own parameter now, `userToken`, so
 * the two no longer have to share a field and uploads can stay the bot's.
 */
function tokenOf(settings) {
  const token = settings.botToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error("the plugin's botToken parameter is not set, and uploading needs it");
  }
  if (token.startsWith('xoxp-')) {
    orknux.log.warn(
      'botToken holds a user token (xoxp-), so Slack will show this upload as posted by that ' +
        'person rather than by the bot. A bot token (xoxb-) uploads as the bot; if this was ' +
        'meant for search, it belongs in the userToken parameter.',
    );
  }
  return token;
}

function slackApi(settings, method, args) {
  const token = tokenOf(settings);

  const body = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');

  const answered = orknux.http.request({
    url: `https://slack.com/api/${method}`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body,
  });
  if (answered.error !== undefined) {
    throw new Error(`could not reach Slack: ${answered.error}`);
  }
  if (at(answered.json, 'ok') !== true) {
    const said = at(answered.json, 'error');
    throw new Error(`Slack refused ${method}: ${typeof said === 'string' ? said : `status ${answered.status}`}`);
  }
  return answered.json;
}

/**
 * A short name for something read out of Slack, derived from the thing itself.
 *
 * Content rather than a counter or a clock: reading the same attachment twice
 * lands on the same key and simply overwrites itself, and nothing here has to
 * ask what time it is or keep a number between calls.
 *
 * FNV-1a because it is four lines and this is a name, not a checksum.
 */
function keyFor(text) {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `slack.${hash.toString(36)}`;
}

/**
 * What one attachment answers, with what it read kept under a key.
 *
 * Both halves of the answer are here because both can be handed straight on:
 * text or bytes to `upload` as its contentKey, with what it is recorded
 * beside it so the upload does not have to guess. Reading a PDF out of a thread and putting it in
 * another channel should not mean either of us typing it out.
 */
function attachmentRead(described, mimetype, size, content, base64) {
  const held = typeof content === 'string' ? content : base64;
  const key = keyFor(held);
  // What it is, said with it: an older server takes the value and ignores the rest.
  const kept = orknux.session.store.put(key, held, {
    contentType: typeof mimetype === 'string' && mimetype.length > 0 ? mimetype : null,
    binary: typeof content !== 'string',
  });

  return {
    name: at(described, 'name'),
    mimetype: mimetype,
    size: size,
    content: content,
    base64: base64,
    // Empty outside a session, which is exactly when the content above is the
    // only copy there is.
    key: kept.error === undefined ? key : '',
  };
}

/**
 * One attachment as a model should be handed it: the text, or the key.
 *
 * Base64 goes, because nobody reads base64. A model reads every character of
 * an answer, and bytes wearing base64 are thousands of them spent to arrive at
 * a key a dozen characters long naming the same bytes on the server - so the
 * key is what comes back and `uploadBinary` is what takes it.
 *
 * Text stays, and this is the difference between this and the renderers. An
 * SVG nobody reads; a CSV or a log is exactly what somebody asked for when
 * they read an attachment at all. Stripping that would answer "there is a file
 * and I will not tell you what is in it".
 *
 * And where there was nowhere to keep it, the key is empty and the bytes are
 * all there is, so they stay.
 */
function readAsKeyed(attachment) {
  if (attachment.key.length === 0 || typeof attachment.base64 !== 'string') {
    return attachment;
  }
  return { ...attachment, base64: '' };
}

/**
 * A filename for a fetched url: its last path segment where that reads as a
 * name, else `file` with the extension its content type implies — because a
 * mermaid.ink url's last segment is the whole encoded diagram, not a name.
 */
function namedFromUrl(url, contentType) {
  const tail = url.split(/[?#]/)[0].split('/').slice(3).filter((one) => one.length > 0).pop() ?? '';
  if (tail.length > 0 && tail.length <= 80 && tail.includes('.')) {
    return tail;
  }
  const known = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/csv': 'csv',
  };
  const extension = known[String(contentType ?? '').split(';')[0].trim()];
  return extension === undefined ? 'file' : `file.${extension}`;
}

/**
 * The last step of the external upload flow, shared by everything that
 * uploads: the file completed, shared where a channel was named, said
 * something about where a comment was — answered as its id and permalink.
 */
function completed(settings, fileId, filename, channel, comment, threadTs) {
  const done = slackApi(settings, 'files.completeUploadExternal', {
    files: JSON.stringify([{ id: fileId, title: filename }]),
    channel_id: channel || undefined,
    initial_comment: comment || undefined,
    thread_ts: threadTs || undefined,
  });
  const file = (at(done, 'files') ?? [])[0];
  return { id: at(file, 'id'), permalink: at(file, 'permalink') };
}

/** The middle step's two failures, which every upload here answers the same way. */
function putOrThrow(put) {
  if (put.error !== undefined) {
    throw new Error(`could not reach Slack's upload url: ${put.error}`);
  }
  if (put.status >= 400) {
    throw new Error(`Slack's upload url answered ${put.status}`);
  }
}

/**
 * Text put on Slack as a file it hosts.
 *
 * Slack's external upload flow, whose three steps are the reason this is one
 * function: ask for an upload url naming the byte length, put the bytes
 * there, then complete - which is also where sharing to a channel and saying
 * something about it happen.
 */
/** Base64 as a validator reads it: whole quads, padding only at the end. */
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function uploadedText(settings, filename, content, channel, comment, threadTs) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('an upload needs a filename');
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('there is no content to upload');
  }

  const opened = slackApi(settings, 'files.getUploadURLExternal', {
    filename: filename,
    length: new TextEncoder().encode(content).length,
  });

  putOrThrow(
    orknux.http.request({
      url: at(opened, 'upload_url'),
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: content,
    }),
  );

  return completed(settings, at(opened, 'file_id'), filename, channel, comment, threadTs);
}

/** Bytes, passed as base64, put on Slack the same way. */
function uploadedBytes(settings, filename, base64, channel, comment, threadTs) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('an upload needs a filename');
  }
  const packed = typeof base64 === 'string' ? base64.replace(/\s+/g, '') : '';
  if (packed.length === 0) {
    throw new Error('there are no bytes to upload');
  }

  /*
   * Slack is told the length in decoded bytes, which base64 carries in its
   * own arithmetic: three bytes per four characters, less what the padding
   * says was never there.
   */
  const size = Math.floor((packed.replace(/=+$/, '').length * 3) / 4);
  const opened = slackApi(settings, 'files.getUploadURLExternal', {
    filename: filename,
    length: size,
  });

  putOrThrow(orknux.http.upload(at(opened, 'upload_url'), packed));

  return completed(settings, at(opened, 'file_id'), filename, channel, comment, threadTs);
}

/** A file fetched from a url and put on Slack, so the workspace holds it. */
function uploadedFromUrl(settings, url, filename, channel, comment, threadTs) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('a file is fetched by its http(s) url, and none was passed');
  }
  tokenOf(settings); // before the fetch, so a missing token costs nothing

  const got = orknux.http.download(url);
  if (got.error !== undefined) {
    throw new Error(`could not fetch the file: ${got.error}`);
  }
  if (got.status >= 400) {
    throw new Error(`${url} answered ${got.status}`);
  }

  const named =
    typeof filename === 'string' && filename.length > 0
      ? filename
      : namedFromUrl(url, got.contentType);
  const opened = slackApi(settings, 'files.getUploadURLExternal', {
    filename: named,
    length: got.size,
  });

  putOrThrow(
    orknux.http.upload(at(opened, 'upload_url'), got.base64, got.contentType ?? undefined),
  );

  return completed(settings, at(opened, 'file_id'), named, channel, comment, threadTs);
}

/*
 * Markdown, turned into what Slack actually reads.
 *
 * This was the markdown plugin's `toSlack` and now lives here, because here is
 * where it is used: `post` converts on the way out, and a caller that has to
 * remember a second plugin first is a caller that forgets. What moved is the
 * machinery - the parking, the ordering, the tables and headings mrkdwn has no
 * spelling for - and what changed on the way is written at each place it did.
 *
 * ## Why it is hand-written rather than a library
 *
 * There is no markdown-to-mrkdwn library worth bundling: the ones that exist
 * are a page of regex, and the hard part is not parsing. The hard part is
 * *what not to touch* - an asterisk inside a code span is an asterisk, a URL
 * inside a link is not text, `<@U0123ABCD>` is a person, and a fenced block is
 * literal to its last character. So all of those are lifted out and parked
 * before anything runs, and put back at the end. That ordering is the trick.
 */

/**
 * The character a lifted-out piece is parked under.
 *
 * A control character, because it is the one thing that cannot occur in
 * anybody's markdown by accident - a placeholder built out of letters could be
 * written by the text it is protecting.
 */
const MARK = '\u0000';

/** Lifts pieces out of the text so nothing below rewrites their insides. */
function protector() {
  const held = [];
  return {
    /** Parks `text` and answers the placeholder standing in for it. */
    park(text) {
      held.push(text);
      return `${MARK}${held.length - 1}${MARK}`;
    },
    /**
     * Puts every parked piece back where its placeholder stands.
     *
     * Repeatedly, because a parked piece can hold a placeholder of its own -
     * bold wrapping a code span parks the code first and then parks the bold
     * around the marker - so one pass would leave the inner one showing.
     */
    restore(text) {
      let written = text;
      const pattern = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
      for (let pass = 0; pass < 10 && written.includes(MARK); pass++) {
        written = written.replace(pattern, (whole, index) => held[Number(index)] ?? '');
      }
      return written;
    },
  };
}

/**
 * Slack's own markup, which is not markdown and must survive untouched.
 *
 * `<@U0123ABCD>` is a person, `<#C0123|general>` a channel, `<!here>` an
 * announcement, `<https://x.com|text>` a link already spelled the way Slack
 * spells them. The markdown plugin escaped every `<` it found, because nothing
 * reaching it was ever Slack's own; here the opposite is true - `mention`
 * answers one of these and the skill says to put it in the text - so they are
 * parked before the escaping rather than eaten by it.
 */
const SLACK_MARKUP = /<(?:[@#!][^>\n]*|(?:https?|mailto):[^>\n]*)>/g;

/** An `&` that already begins an entity, which must not be escaped twice. */
const ENTITY = /^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/;

/**
 * What would otherwise be read as markup, escaped so text stays text.
 *
 * `<` and `&` only. The markdown plugin escaped `>` as well, and that is the
 * one rule that could not come with it: `>` at the start of a line is Slack's
 * blockquote, which the posting skill now tells a model to use when it answers
 * a message that is not the one above it. Escaping it turned every quote into
 * a literal greater-than.
 *
 * A bare `>` elsewhere reads as itself, and cannot close anything, because
 * every `<` left by the time this runs is escaped here.
 */
function escaped(text) {
  return text.replace(/&/g, (whole, at, all) => (ENTITY.test(all.slice(at)) ? whole : '&amp;')).replace(/</g, '&lt;');
}

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

/**
 * A message whose line breaks arrived as the two characters `\` and `n`.
 *
 * Seen in a channel: a whole answer on one line, reading
 * `*Using my friend*\n\n> why you did not use your friend?\n\nI managed to…`.
 * The model wrote the escape sequence instead of the newline - double-escaped
 * on the way into the tool call - and what that costs is not one blank line.
 * The blockquote dies, because `>` is only a quote at the start of a line; the
 * bold dies too, because Slack will not close `*…*` when a backslash follows
 * the closing asterisk. One missing newline reads as a model that ignored
 * every rule it had been given.
 *
 * Advice would not fix it. The model cannot see the message afterwards, and
 * this repository has already learned once - with base64 typed into an upload -
 * that an instruction is not a fix for something a model does while looking
 * the other way.
 *
 * **When it fires**, and the limit is deliberate: either the text holds no real
 * line break at all, which is the shape of the fault and not of a sentence
 * about it, or it holds `\\n\\n`, which no filename and no Windows path can be.
 * A one-line message *about* `\\n` is the case this would get wrong, and the
 * escape hatch is the one that protects everything else here - backticks. Code
 * is parked before this runs.
 */
function unflattened(text) {
  const flattened = !text.includes('\n') || text.includes('\\n\\n');
  return flattened ? text.replace(/\\r\\n|\\n/g, '\n') : text;
}

/**
 * Markdown as Slack's mrkdwn.
 *
 * The order is the whole of it: fences, then inline code, then Slack's own
 * markup, then links - each lifted out and parked - and only then the
 * emphasis, which is the pass that would otherwise chew through a URL or a
 * code span.
 */
function mrkdwn(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  const parked = protector();
  let held = text.replace(/\r\n?/g, '\n');

  /*
   * Fenced blocks first and whole. The language tag goes: Slack has no
   * highlighting to give it to, and shows it as the code's first line.
   */
  held = held.replace(/```[^\n]*\n([\s\S]*?)```/g, (whole, code) =>
    parked.park('```\n' + escaped(code.replace(/\n$/, '')) + '\n```'),
  );
  /* An unterminated fence is still a fence to the end of the message. */
  held = held.replace(/```[^\n]*\n([\s\S]*)$/, (whole, code) => parked.park('```\n' + escaped(code) + '\n```'));

  /* Then inline code, which protects whatever punctuation is inside it. */
  held = held.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1/g, (whole, ticks, code) => parked.park('`' + escaped(code) + '`'));

  /* Then Slack's own markup, which is already right and is nobody's markdown. */
  held = held.replace(SLACK_MARKUP, (whole) => parked.park(whole));

  /* With the code out of reach, a line break written as an escape is a fault. */
  held = unflattened(held);

  /*
   * Then links and images, parked already converted: the url must not meet the
   * emphasis pass, and `[text](url)` and `![alt](url)` differ only in what
   * Slack should show for them.
   */
  held = held.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, alt, url) =>
    parked.park(alt.trim().length > 0 ? `<${url}|${escaped(alt)}>` : `<${url}>`),
  );
  held = held.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, label, url) =>
    parked.park(`<${url}|${escaped(inline(label, parked))}>`),
  );

  /* Everything remaining is text, so it is safe to escape all at once. */
  held = escaped(held);

  const lines = held.split('\n');
  const written = [];
  for (const line of lines) {
    let one = line;

    /* A table's separator row carries no content, and its cells become lines. */
    if (isRule(one) && written.length > 0) {
      continue;
    }
    if (one.includes('|') && /^\s*\|/.test(one)) {
      written.push(cellsOf(one).join('  '));
      continue;
    }

    /* Headings: bold, because mrkdwn has none. */
    one = one.replace(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/, (whole, hashes, said) =>
      said.trim().length > 0 ? parked.park(`*${inline(said.trim(), parked)}*`) : '',
    );

    /* Rules: a line, because three hyphens on their own read as nothing. */
    one = one.replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, '──────────');

    /* Bullets: the character Slack's own lists use, with the nesting kept. */
    one = one.replace(/^(\s*)[-*+][ \t]+/, (whole, indent) => `${indent}•  `);
    /* Ordered items keep their number; only the spacing is made even. */
    one = one.replace(/^(\s*)(\d+)[.)][ \t]+/, (whole, indent, number) => `${indent}${number}.  `);

    written.push(inline(one, parked));
  }

  return parked.restore(written.join('\n'));
}

/**
 * The emphasis pass, on one line's worth of already-protected text.
 *
 * Double before single, always: `**bold**` has to become `*bold*` before
 * anything looks at a lone asterisk, or the second pass eats the first one's
 * output.
 *
 * **And single emphasis is left exactly as it was written**, which is where
 * this parts company with the plugin it came from. There, everything arriving
 * was markdown by definition, so `*italic*` became `_italic_`. Here the text is
 * as often already mrkdwn - a single asterisk is bold and a single underscore
 * is italic - and rewriting those would break the messages that were right,
 * which is a worse fault than the one being fixed. So only the shapes that are
 * *never* valid mrkdwn are touched.
 */
function inline(text, parked) {
  let held = text;

  /*
   * What the double markers become is *parked*, not written back into the
   * line: `*bold*` left in the text is indistinguishable from something a
   * later pass should look at. The contents go round again on the way in, so
   * emphasis nested inside emphasis is converted rather than frozen.
   */
  const bold = (whole, inner) => parked.park(`*${inline(inner, parked)}*`);
  /* ***both*** is bold and italic, which Slack spells by nesting the two. */
  held = held.replace(/\*\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*\*/g, (whole, inner) =>
    parked.park(`*_${inline(inner, parked)}_*`),
  );
  held = held.replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, bold);
  held = held.replace(/__(?!\s)([\s\S]+?)(?<!\s)__/g, bold);
  /* ~~struck~~ loses a tilde; Slack spells it with one. */
  held = held.replace(/~~(?!\s)([\s\S]+?)(?<!\s)~~/g, (whole, inner) => parked.park(`~${inline(inner, parked)}~`));

  return held;
}

/**
 * The permalinks `post` attaches, from whatever a caller passed as attachments.
 *
 * A string is a file already on Slack and is used as it is - the cheap path,
 * and the one that needs no token at all. A map is a file that does not exist
 * yet: it is uploaded here, with `botToken`, and what comes back is its
 * permalink, so both kinds end up in the same list.
 *
 * Uploaded *without* a channel, deliberately. Sharing at upload time makes
 * Slack post the file as its own message, which is a second message nobody
 * asked for and which arrives before the text explaining it. A permalink in
 * the message that follows is Slack's own way of hanging a file on a message
 * somebody wrote.
 */
function attaching(settings, attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  const links = [];
  for (const one of attachments) {
    if (typeof one === 'string') {
      if (one.length > 0) links.push(one);
      continue;
    }
    if (one === null || typeof one !== 'object') {
      continue;
    }

    const filename = at(one, 'filename');
    const named = typeof filename === 'string' ? filename : '';
    const content = at(one, 'content');
    const base64 = at(one, 'base64');
    const url = at(one, 'url');
    const contentKey = at(one, 'contentKey');

    let hosted;
    if (typeof contentKey === 'string' && contentKey.length > 0) {
      /*
       * The way bytes reach this function without being typed: a key the tool
       * that made them answered, and what it names never left the server.
       */
      const held = orknux.session.store.get(contentKey);
      if (typeof held !== 'string' || held.length === 0) {
        throw new Error(
          `nothing is kept under ${contentKey} in this session: make the file again and pass the ` +
            'key that answer carried',
        );
      }
      hosted = uploadedBytes(settings, named, held, '', '', '');
    } else if (typeof base64 === 'string') {
      /*
       * Still here, for the workflow node that has bytes and no session to
       * have kept them in. The agents' `post` refuses this before it arrives -
       * see `tools()` - because a model always has a key and typing bytes into
       * a tool call is the thing that does not survive.
       */
      hosted = uploadedBytes(settings, named, base64, '', '', '');
    } else if (typeof content === 'string') {
      hosted = uploadedText(settings, named, content, '', '', '');
    } else if (typeof url === 'string') {
      hosted = uploadedFromUrl(settings, url, named, '', '', '');
    } else {
      throw new Error(
        'an attachment map says which file by contentKey, content or url, and none was set',
      );
    }
    if (typeof hosted.permalink === 'string' && hosted.permalink.length > 0) {
      links.push(hosted.permalink);
    }
  }
  return links;
}

/**
 * A search run against Slack's own API with the `userToken` parameter.
 *
 * Search is the one call here Slack will not answer for a bot: `search.messages`
 * refuses a `xoxb-` with `not_allowed_token_type`, whoever asks. The capability
 * path reads the User Token field of the connection, which is the right answer
 * when a workspace has filled it in - and this is the answer when it has not,
 * or when the searching identity should not be whoever the connection belongs
 * to. Shaped to match the capability's answer exactly, so the function's
 * callers cannot tell which path ran.
 */
function searchAs(token, query, limit) {
  /*
   * The mistake the other way round, which `tokenOf` has warned about for a
   * while and this had no answer for. A bot token here fails at Slack with a
   * bare `not_allowed_token_type`, which says nothing about which of two
   * parameters is wrong - and the two tokens differ by four characters at the
   * front, so getting them the wrong way round is a typo rather than a
   * misunderstanding.
   */
  if (typeof token === 'string' && token.startsWith('xoxb-')) {
    orknux.log.warn(
      'userToken holds a bot token (xoxb-), and Slack answers search for a user token only. ' +
        'The bot token belongs in botToken; search needs an xoxp- from somebody who can see ' +
        'what is being searched for.',
    );
  }
  const answered = orknux.http.request({
    url: 'https://slack.com/api/search.messages',
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body:
      `query=${encodeURIComponent(query)}&count=${encodeURIComponent(limit)}`,
  });
  if (answered.error !== undefined) {
    return { error: answered.error };
  }
  if (at(answered.json, 'ok') !== true) {
    const said = at(answered.json, 'error');
    const code = typeof said === 'string' ? said : `status ${answered.status}`;
    /*
     * The two fields that answer "which scope", thrown away until somebody
     * spent an afternoon on it. Slack says `missing_scope` and then says
     * exactly what was needed and what the token actually carries - and the
     * usual cause is a token minted before the scope was added to the app,
     * because a scope lives in the token rather than in the configuration.
     *
     * `search:read.public` is worth knowing about here: Slack's granular
     * search scopes are per source, so a token carrying only that one
     * searches public channels and matches nothing in a private one.
     */
    const needed = at(answered.json, 'needed');
    const provided = at(answered.json, 'provided');
    return {
      error:
        typeof needed === 'string'
          ? `${code}: Slack wants ${needed}` +
            `${typeof provided === 'string' ? `, and this token carries ${provided}` : ''}` +
            ' - a scope is minted into a token, so adding one to the app means re-authorising to get a new one'
          : code,
    };
  }

  const messages = at(answered.json, 'messages');
  const matches = (at(messages, 'matches') ?? []).map((one) => ({
    channel: at(at(one, 'channel'), 'id'),
    channelName: at(at(one, 'channel'), 'name'),
    ts: at(one, 'ts'),
    /* Slack answers a search match by name where a thread answers by id. */
    user: at(one, 'user') ?? at(one, 'username'),
    /* And it carries the name beside the id, so this one costs no lookup at all. */
    userName: at(one, 'username') ?? null,
    text: at(one, 'text'),
    permalink: at(one, 'permalink'),
  }));
  return { matches: matches, total: at(messages, 'total') ?? matches.length };
}

/**
 * How many channels one scan will read, and how far back it reads.
 *
 * `findRecent` costs one request per channel, inside a single sandbox call, so
 * the cap is what keeps a workspace of four hundred channels from being a
 * timeout. Fifteen is about what fits comfortably; past that, name the channel.
 */
const SCANNED = 15;

/** One page of history per channel, which is Slack's own maximum for the call. */
const PAGE = 200;

/** The noise a channel keeps that nobody is searching for. */
const NOISE = ['channel_join', 'channel_leave', 'group_join', 'group_leave'];

/**
 * Every channel the bot has been invited to.
 *
 * `users.conversations` answers the token's own memberships, which for a bot
 * token is exactly what it can read — so this is both the list to scan and the
 * boundary the scan cannot cross. A bot in no private channel cannot be asked
 * to read one, and no scope changes that.
 */
function joined(settings) {
  return pagesOf(
    settings,
    'users.conversations',
    { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000' },
    MEMBERSHIPS,
  ).items;
}

/**
 * Every page of a listing, to a cap.
 *
 * Slack's paged calls do not answer `limit` items and then stop - they answer
 * *up to* that many, often far fewer, and hand back a cursor. A workspace of
 * nine and a half thousand channels sent thirty-seven a page, so a scan that
 * asked for two hundred and read five pages saw a hundred and eighty-five
 * conversations and concluded the channel did not exist. Following the cursor
 * is the whole of the fix; the caps below are what keeps that bounded.
 */
function pagesOf(settings, method, args, cap) {
  const items = [];
  let cursor = '';
  let complete = false;
  for (let page = 0; page < cap; page += 1) {
    const answered = slackApi(settings, method, { ...args, cursor: cursor });
    for (const one of at(answered, 'channels') ?? []) {
      items.push(one);
    }
    cursor = at(at(answered, 'response_metadata'), 'next_cursor') ?? '';
    if (typeof cursor !== 'string' || cursor.length === 0) {
      complete = true;
      break;
    }
  }
  return { items: items, complete: complete };
}

/**
 * The workspace's own address, so a permalink is built rather than fetched.
 *
 * `chat.getPermalink` answers one link per call, which would be a request per
 * match. `auth.test` needs no scope at all and answers the workspace url once,
 * and a permalink is that url, the channel and the timestamp with its dot
 * taken out — which is a string, not a round trip.
 */
function workspaceUrl(settings) {
  const who = slackApi(settings, 'auth.test', {});
  const url = at(who, 'url');
  return typeof url === 'string' ? url.replace(/\/+$/, '') : null;
}

/**
 * How many people one call will look up before it stops asking.
 *
 * A name costs a request, and a busy channel has a long tail of one-message
 * authors. Twenty covers a thread or a scan several times over; past that the
 * ids come back unresolved rather than the call taking a minute.
 */
const NAMED = 20;

/**
 * Names for the people who wrote a set of messages, each asked for once.
 *
 * A thread of forty messages from three people is three lookups, not forty:
 * Slack writes an author as `U0123ABCD` on every single one, and the same id
 * resolves to the same person all day. A lookup that fails leaves the name
 * null rather than failing the read - an unresolved author is a worse answer
 * than an id, and a missing thread is worse than both.
 */
function namesFor(connection, settings, ids, cap) {
  const names = new Map();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || names.has(id)) {
      continue;
    }
    if (names.size >= cap) {
      names.set(id, null);
      continue;
    }
    const found = through((use) => orknux.slack.user(use, id), connection, settings.slack);
    names.set(
      id,
      found.error === undefined
        ? at(found, 'displayName') || at(found, 'realName') || at(found, 'name') || null
        : null,
    );
  }
  return names;
}

/** The same messages, each carrying who wrote it rather than only their id. */
function withAuthors(connection, settings, messages) {
  const names = namesFor(connection, settings, messages.map((one) => at(one, 'user')), NAMED);
  return messages.map((one) => ({ ...one, userName: names.get(at(one, 'user')) ?? null }));
}

/**
 * How much of a workspace's directory one search will read.
 *
 * `users.list` is the only way to match a name - Slack has no user search for
 * a bot - and it answers two hundred accounts a page. Five pages covers a
 * thousand people, which is most workspaces whole; past that the answer says
 * it was cut rather than pretending nobody else matched.
 */
const DIRECTORY = 25;

/**
 * And the pages of the bot's *own* channels, which is a much shorter list.
 *
 * Three covers a bot in a few thousand conversations, and it is read first
 * because a channel somebody has added the bot to is always in it - which
 * turns "find #ipit-185" from a walk through nine thousand channels into one
 * request that already has the answer.
 */
const MEMBERSHIPS = 3;

/** What an address looks like, closely enough to decide which call to make. */
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** One conversation as the declared `Channel` shape — see objects(). */
function channelOf(one, site) {
  const id = at(one, 'id');
  return {
    id: id,
    name: at(one, 'name'),
    private: at(one, 'is_private') === true,
    archived: at(one, 'is_archived') === true,
    /*
     * Whether the bot is in it, which is the field that decides what else can
     * be done with the answer: findRecent and listThreads read the channels
     * the bot was invited to and nothing else.
     */
    member: at(one, 'is_member') === true,
    members: at(one, 'num_members'),
    topic: at(at(one, 'topic'), 'value'),
    purpose: at(at(one, 'purpose'), 'value'),
    url: site === null || typeof id !== 'string' ? null : `${site}/archives/${id}`,
  };
}

/** A Slack timestamp as a moment anybody can read. */
function whenOf(ts) {
  const seconds = Number(String(ts ?? '').split('.')[0]);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/** One Slack account as the declared `User` shape — see objects(). */
function userOf(one) {
  const profile = at(one, 'profile');
  const shown = at(profile, 'display_name');
  return {
    id: at(one, 'id'),
    name: at(one, 'name'),
    realName: at(profile, 'real_name') ?? at(one, 'real_name'),
    /* Slack writes an empty string for somebody who set none; null says it plainer. */
    displayName: typeof shown === 'string' && shown.length > 0 ? shown : null,
    email: at(profile, 'email'),
    bot: at(one, 'is_bot') === true,
  };
}

/** Whether every word is somewhere in the text, in any order and whatever the capitals. */
function carries(text, terms) {
  const haystack = String(text ?? '').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Whether a failure was the connection being gone rather than Slack saying no.
 *
 * The event a workflow carries holds the connection it came in on, and every
 * function here tells the caller to pass it - so when that connection has
 * since been deleted, what fails is the caller doing exactly as it was told.
 */
function connectionGone(error) {
  return typeof error === 'string' && error.includes('has been deleted');
}

/**
 * One call, through the connection asked for, or through the configured one.
 *
 * A connection id travels inside the event payload and outlives the connection
 * itself: delete the connection and every event already in flight still names
 * it. An agent handed one of those did as it was told, was told the connection
 * is gone, and had to work out on its own that an empty string means "the
 * configured one" - a wasted turn on the way to the only other option there is.
 *
 * So the fallback happens here. It cannot reach another workspace's Slack: the
 * server checks that the caller may use the connection it names, and the
 * configured one is this workspace's own, chosen in the plugin's settings. What
 * it can do is send through a different connection of this workspace than the
 * one named, which is worth a line in the log and is better than not sending.
 *
 * @param call takes a connection id and answers what the door answered.
 */
/**
 * Which connection a type was told, as the id the server's door takes.
 *
 * A connection argument arrives as the handle a connection setting does - an
 * object with an id - and the plugin's configured Slack is the fallback where
 * the variable said nothing, for the same reason `through` falls back: it is
 * this workspace's own, and better than answering nothing.
 */
function connectionArgument(args, settings) {
  const told = args && typeof args === 'object' ? args.slack : undefined;
  const id = told && typeof told === 'object' ? told.id : told;
  if (id !== undefined && id !== null && String(id).length > 0) return String(id);
  const configured = settings && settings.slack;
  const own = configured && typeof configured === 'object' ? configured.id : configured;
  return own === undefined || own === null || String(own).length === 0 ? null : String(own);
}

function through(call, asked, configured) {
  const first = call(asked || configured);
  if (first.error === undefined || !asked || asked === configured) return first;
  if (!connectionGone(first.error)) return first;

  orknux.log.warn(
    `the connection this event came in on (${asked}) has been deleted; using the configured one instead`,
  );
  return call(configured);
}

export default class Slack extends OrknuxPlugin {

  id() {
    return 'slack';
  }

  apiVersion() {
    return 1;
  }

  parameters() {
    return [
      new OrknuxParameter({
        name: 'slack',
        description:
          'The Slack to read through when a function is not handed one. ' +
          'A workspace with two Slacks should pass the connection instead.',
        type: 'connection',
        connectionType: 'SLACK',
        required: false,
      }),
      new OrknuxParameter({
        name: 'botToken',
        description:
          'A bot token (xoxb-) for the two upload functions, with files:write - and ' +
          'remote_files:write and remote_files:share for remoteFile. Everything else here runs ' +
          'without it, and post needs it only when an attachment is a file to upload rather ' +
          'than a permalink. It must be the bot\'s own: a user token (xoxp-) works, but Slack ' +
          'then shows every uploaded file as posted by that person rather than by the bot - a ' +
          'user token for search goes in userToken instead.',
        type: 'string',
        required: false,
        secret: true,
      }),
      new OrknuxParameter({
        name: 'userToken',
        description:
          'A user token (xoxp-) for search, which is the one call Slack will not answer for a bot: ' +
          'search.messages refuses a bot token with not_allowed_token_type. Set this and search runs ' +
          'as that person; leave it empty and search uses the connection\'s own User Token field, ' +
          'which is where a workspace usually keeps one. Nothing else here uses it.',
        type: 'string',
        required: false,
        secret: true,
      }),
    ];
  }

  permissions() {
    // TextEncoder, for `upload` alone: Slack is told the file's length in
    // bytes, and the byte length of text is a fact about its UTF-8 encoding,
    // not about its character count.
    return ['TEXT_ENCODING'];
  }

  capabilities() {
    return [
      'SLACK_READ_THREAD',
      'SLACK_READ_MESSAGE',
      'SLACK_READ_USER',
      'SLACK_MENTION',
      'SLACK_POST_MESSAGE',
      'SLACK_ADD_REACTION',
      'SLACK_SEARCH',
      'SLACK_SUGGEST',
      // For the two upload functions only, which the capability vocabulary has
      // no narrower spelling for — the header says why.
      'NETWORK_REQUEST',
    ];
  }

  /*
   * The shapes these answers have.
   *
   * Most of them are the server's, not this plugin's: `readThread` hands back
   * what the SLACK_READ_THREAD capability answered, and declaring it here is
   * writing down a shape the server already guarantees rather than inventing
   * one. That is worth doing anyway — a caller should not have to read this
   * file to learn that `replies` counts the whole thread and `messages` only
   * the page that came back.
   */
  objects() {
    return [
      new OrknuxObject({
        name: 'MessageFile',
        description:
          'A file attached to a message in a thread. Narrower than Attachment on purpose: these are ' +
          'the four things reading a thread learns about a file, and a shape promising a permalink ' +
          'that never arrives is worse than one that does not mention it.',
        properties: [
          { name: 'id', kind: 'string', description: 'What readAttachment takes.' },
          { name: 'name', kind: 'string', description: 'The filename.' },
          { name: 'mimetype', kind: 'string', description: 'What decides whether readAttachment answers text or bytes.' },
          { name: 'size', kind: 'number', description: 'In bytes.' },
        ],
      }),

      new OrknuxObject({
        name: 'Message',
        description: 'One message in a thread.',
        properties: [
          { name: 'ts', kind: 'string', description: "Slack's timestamp, which is also the message's id." },
          { name: 'user', kind: 'string', description: 'Who wrote it, as an id, or null where Slack said neither.' },
          {
            name: 'userName',
            kind: 'string',
            description:
              'Who that id is, resolved - the display name, or the real name where there is no ' +
              'display name. Null where withNames was off, where the lookup was refused, or ' +
              'past the twentieth distinct author in one call.',
          },
          { name: 'text', kind: 'string', description: 'What it says, in mrkdwn.' },
          {
            name: 'parent',
            kind: 'boolean',
            description: 'Whether this is the message the thread hangs under, rather than a reply.',
          },
          {
            name: 'files',
            kind: 'array',
            of: 'MessageFile',
            description:
              'What was attached to it, empty where nothing was. Pass a file id to readAttachment for ' +
              'its content - this is how a file somebody uploaded earlier in the thread is found.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'Thread',
        description: 'The messages under one parent, oldest first.',
        properties: [
          { name: 'messages', kind: 'array', of: 'Message', description: 'The page that came back, capped by limit.' },
          {
            name: 'replies',
            kind: 'number',
            description: "Slack's own count of the whole thread, not of this page. replies === 1 is the first reply.",
          },
        ],
      }),

      new OrknuxObject({
        name: 'LinkedMessage',
        description: 'The one message a permalink points at.',
        properties: [
          { name: 'channel', kind: 'string', description: 'The channel id it lives in.' },
          { name: 'ts', kind: 'string', description: 'Its own timestamp.' },
          { name: 'user', kind: 'string', description: 'Who wrote it, or null.' },
          { name: 'text', kind: 'string', description: 'What it says.' },
          { name: 'threadTs', kind: 'string', description: "The thread's parent ts, or null outside a thread." },
        ],
      }),

      new OrknuxObject({
        name: 'User',
        description: 'Who a Slack user id belongs to.',
        properties: [
          { name: 'id', kind: 'string', description: 'The U… id itself.' },
          { name: 'name', kind: 'string', description: 'The username.' },
          { name: 'realName', kind: 'string', description: 'Their actual name, where they set one.' },
          { name: 'displayName', kind: 'string', description: 'What Slack shows in a channel.' },
          {
            name: 'email',
            kind: 'string',
            description:
              'Their address, where the token may see one - it takes the users:read.email scope, ' +
              'and is null without it. whoIs answers null here; findUsers fills it in.',
          },
          { name: 'bot', kind: 'boolean', description: 'Whether this is an app rather than a person.' },
        ],
      }),

      new OrknuxObject({
        name: 'Channel',
        description: 'One conversation in the workspace.',
        properties: [
          { name: 'id', kind: 'string', description: 'The C… id every other call takes.' },
          { name: 'name', kind: 'string', description: 'Without the hash.' },
          { name: 'private', kind: 'boolean', description: 'A private channel rather than a public one.' },
          { name: 'archived', kind: 'boolean', description: 'Kept but closed. Excluded unless withArchived asked for them.' },
          {
            name: 'member',
            kind: 'boolean',
            description:
              'The bot is in it — which decides what else can be done with this channel, because ' +
              'reading history needs an invitation and no scope substitutes for one.',
          },
          { name: 'members', kind: 'number', description: 'How many people are in it.' },
          { name: 'topic', kind: 'string', description: 'What the channel says it is about right now.' },
          { name: 'purpose', kind: 'string', description: 'What it was made for.' },
          { name: 'url', kind: 'string', description: 'The channel, for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Channels',
        description: 'What looking for channels came to.',
        properties: [
          { name: 'channels', kind: 'array', of: 'Channel', description: 'Capped by limit.' },
          { name: 'total', kind: 'number', description: 'How many matched what was read, before limit.' },
          { name: 'read', kind: 'number', description: 'How many conversations were looked at.' },
          {
            name: 'complete',
            kind: 'boolean',
            description: 'The whole list was read. False means a large workspace ran past the page cap.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'ThreadSummary',
        description: 'A thread in a channel, as the parent message and what came of it.',
        properties: [
          { name: 'ts', kind: 'string', description: "The parent's timestamp — this is the threadTs every other call takes." },
          { name: 'user', kind: 'string', description: 'Who started it, as an id.' },
          { name: 'userName', kind: 'string', description: 'Who that is, resolved, unless withNames was off.' },
          { name: 'text', kind: 'string', description: 'What the parent says, which is what the thread is about.' },
          { name: 'replies', kind: 'number', description: "Slack's own count of the replies under it." },
          { name: 'repliers', kind: 'number', description: 'How many different people answered.' },
          { name: 'started', kind: 'string', description: 'When the parent was posted, as ISO 8601.' },
          { name: 'lastReply', kind: 'string', description: 'When it was last answered, as ISO 8601.' },
          { name: 'permalink', kind: 'string', description: 'The way into it — readThread takes the channel and ts.' },
        ],
      }),

      new OrknuxObject({
        name: 'Threads',
        description: 'The threads found in one channel, newest activity first.',
        properties: [
          { name: 'channel', kind: 'string', description: 'The channel they are in, as an id.' },
          { name: 'threads', kind: 'array', of: 'ThreadSummary', description: 'Capped by limit.' },
          { name: 'total', kind: 'number', description: 'How many threads the window held, before limit.' },
          { name: 'messages', kind: 'number', description: 'How many messages were read to find them.' },
          { name: 'since', kind: 'string', description: 'The oldest moment read, as ISO 8601.' },
          {
            name: 'complete',
            kind: 'boolean',
            description: 'The window was read whole. False means older messages in it went unread.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'FoundUsers',
        description: 'What looking for people came to.',
        properties: [
          { name: 'users', kind: 'array', of: 'User', description: 'Capped by limit.' },
          { name: 'total', kind: 'number', description: 'How many matched what was read, before limit.' },
          { name: 'read', kind: 'number', description: 'How many accounts were looked at to find them.' },
          {
            name: 'complete',
            kind: 'boolean',
            description:
              'The whole directory was read. False means a big workspace ran past the page cap ' +
              'and somebody further down may match - narrow the query, or use an email.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'SearchMatch',
        description: 'One message a search matched.',
        properties: [
          { name: 'channel', kind: 'string', description: 'The channel id.' },
          { name: 'channelName', kind: 'string', description: 'Its name, without the hash.' },
          { name: 'ts', kind: 'string', description: 'The message timestamp.' },
          { name: 'user', kind: 'string', description: 'Who wrote it, as Slack named them in the match.' },
          {
            name: 'userName',
            kind: 'string',
            description:
              "Their name. Free from search, which carries one in the match; looked up by " +
              'findRecent, which gets an id like everything that reads history.',
          },
          { name: 'text', kind: 'string', description: 'What it says.' },
          { name: 'permalink', kind: 'string', description: 'The way back to it — readMessage takes this.' },
        ],
      }),

      new OrknuxObject({
        name: 'SearchResult',
        description: 'What a search of Slack came to.',
        properties: [
          { name: 'matches', kind: 'array', of: 'SearchMatch', description: 'Capped by limit.' },
          { name: 'total', kind: 'number', description: 'How many the whole search holds, not how many came back.' },
        ],
      }),

      new OrknuxObject({
        name: 'RecentResult',
        description: 'What reading recent history came to — a scan, and honest about being one.',
        properties: [
          { name: 'matches', kind: 'array', of: 'SearchMatch', description: 'Newest first, capped by limit.' },
          { name: 'total', kind: 'number', description: 'How many matched in what was read, before limit.' },
          { name: 'channels', kind: 'number', description: 'How many channels were read.' },
          { name: 'messages', kind: 'number', description: 'How many messages were looked at to find them.' },
          { name: 'since', kind: 'string', description: 'The oldest moment read, as ISO 8601.' },
          {
            name: 'complete',
            kind: 'boolean',
            description:
              'Every channel asked for was read to the end of the window. False means there is ' +
              'more inside it — narrow the days, or name one channel.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'Posted',
        description: 'A message that was posted.',
        properties: [
          { name: 'channel', kind: 'string', description: 'Where it landed — resolved, if a #name was passed.' },
          {
            name: 'ts',
            kind: 'string',
            description: 'Its own timestamp: what react hangs on, and what a reply threads onto.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'HostedFile',
        description: 'A file now on Slack, however it got there.',
        properties: [
          { name: 'id', kind: 'string', description: 'The F… id; readAttachment takes it.' },
          {
            name: 'permalink',
            kind: 'string',
            description: "The link to it. Put this in a later post's attachments to show it again.",
          },
        ],
      }),

      new OrknuxObject({
        name: 'Attachment',
        description: 'A file hanging on a message, as a listing describes it.',
        properties: [
          { name: 'id', kind: 'string', description: 'What readAttachment takes.' },
          { name: 'name', kind: 'string', description: 'The filename.' },
          { name: 'title', kind: 'string', description: 'What Slack shows above it.' },
          { name: 'filetype', kind: 'string', description: "Slack's own short kind: pdf, png, csv." },
          { name: 'mimetype', kind: 'string', description: 'What decides whether readAttachment answers text or bytes.' },
          { name: 'size', kind: 'number', description: 'In bytes.' },
          { name: 'permalink', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Attachments',
        description: 'The files hanging on one message.',
        properties: [
          {
            name: 'files',
            kind: 'array',
            of: 'Attachment',
            description: 'Empty where the message carried none.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'AttachmentContent',
        description: 'One attachment read back — text as text, binary as bytes.',
        properties: [
          { name: 'name', kind: 'string', description: 'The filename.' },
          { name: 'mimetype', kind: 'string', description: 'What it claims to be.' },
          { name: 'size', kind: 'number', description: 'In bytes.' },
          {
            name: 'content',
            kind: 'string',
            description: 'The text, where it is a text file. Null for anything binary.',
          },
          {
            name: 'base64',
            kind: 'string',
            description: 'The bytes, where it is binary. Null for a text file. Exactly one of these two is set.',
          },
          {
            name: 'key',
            kind: 'string',
            description:
              'Where what was read is kept for the rest of this session. Hand it straight on - ' +
              'to upload as contentKey, text or a file alike - ' +
              'rather than copying the content out. Empty where there was no session to keep it ' +
              'in.',
          },
        ],
      }),
    ];
  }

  /*
   * What the tool descriptions cannot carry: the half-dozen small habits that
   * separate a message people read from one they scroll past. Each is cheap,
   * none is discoverable from a function signature, and getting them wrong is
   * visible to everybody in the channel rather than only in a log.
   */
  skills() {
    return [
      new OrknuxSkill({
        /*
         * The id is unchanged, and has to be: a workspace marks this one
         * Always and people type the command. What changed is its weight -
         * sixteen kilobytes of it went into one model's context in one
         * call, and the two halves that are not about writing a message are
         * their own pages now.
         */
        id: 'posting-to-slack-so-people-read-it',
        name: 'Posting to Slack so people read it',
        description: 'How a message is written, and where the reply goes.',
        content: `# Posting to Slack so people read it

A channel is somebody else's interface. Everything below is about not making
it worse.

## Markdown is not what Slack reads

Slack reads *mrkdwn*, which resembles markdown closely enough to be mistaken
for it. Write markdown and the reader sees your punctuation: \`**bold**\`
arrives with the asterisks showing, \`[text](url)\` as literal brackets,
\`# Heading\` as a hash and a space. You cannot see the message afterwards, so
nothing tells you it happened.

**Write mrkdwn** in everything you write for Slack - the answer you are
composing right now included - *unless something between you and the channel
converts for you*. Where your own instructions say a converter runs on the way
out, they are right and this page is not: write what they ask for and let it do
its job. Where nothing says so, assume nothing does, because a reply usually
reaches a channel exactly as you wrote it:

| you want | write | not |
|---|---|---|
| bold | \`*bold*\` | \`**bold**\` |
| italic | \`_italic_\` | \`*italic*\` |
| strikethrough | \`~struck~\` | \`~~struck~~\` |
| a link | \`<https://x.com|text>\` | \`[text](https://x.com)\` |
| a bullet | \`•\` then two spaces, or \`-\` | \`*\` |
| a heading | a bold line on its own | \`#\` |
| a quote | \`> quoted\` | \`>>> quoted\` |

A list of repositories, written properly:

    Here is the list:

    •  *orknux-extension*: plugins and the SDK
    •  *orknux-server*: the platform itself
    •  *orknux-ui*

and not \`*  **orknux-extension**:\`, which arrives with every asterisk showing.

There are **no headings and no tables** in mrkdwn at all. A \`#\` line is literal
text. A table on a phone-width screen is unreadable whatever the syntax - make
it a short list.

### If you are calling slack_post

It converts the shapes that are never valid mrkdwn on the way out, without
being asked - \`**bold**\`, \`~~struck~~\`, \`[text](url)\` and \`![alt](url)\`,
\`#\` headings, \`*\` and \`-\` bullets, numbered lists, tables and \`---\`
rules. Code spans and fences are left exactly as written; \`<@U0123ABCD>\`,
\`<#C0123|general>\` and \`<https://x.com|text>\` are left alone because they
are already Slack's own; and a single \`*\` or \`_\` is never touched, because
those are already mrkdwn and rewriting them would break the messages that were
right.

That is a safety net for text that reaches it, not a reason to write markdown.
Your own replies do not pass through it.

## Never write a mention by hand

\`<@U0123ABCD>\` looks guessable and is not. An id you invented either pings
nobody or pings a stranger. Call **\`slack_mention\`** with
the person's name and put its answer in the text exactly as it comes back.

The same applies in reverse: a message that arrives containing \`<@U…>\` is not
a name. \`slack_whoIs\` turns it into one before you quote it back at somebody.

## Reply in the thread

If you are answering a message, pass its \`threadTs\` to \`slack_post\`. A reply
posted to the channel instead of the thread is a new conversation in front of
everybody, and the person who asked has to work out which answer is theirs.

Post to the channel itself only when starting something genuinely new.

## Quote what you are answering, if it is not the message above you

A thread is read in the order things arrived, not in the order they were
asked. When your reply lands directly under the message it answers, the
context is one line up and a quote is noise. When two or three other messages
have come in since — or you are answering the parent from thirty replies down,
or one of several things somebody asked at once — nothing on the screen says
which of them you mean, and the reader has to work it out.

So lead with the line you are answering, as a blockquote, and then answer it:

    > can we ship charts before Friday?

    Yes — the renderer is done, the packaging is a day.

\`>\` at the start of a line is a blockquote, and it is one of the few things
mrkdwn and markdown agree about. **Never \`>>>\`**: that quotes everything
after it to the end of the message, so your own answer arrives inside the
quote. One \`>\` per quoted line.

How to tell whether you need one: \`slack_readThread\` answers oldest first. If
the message you are answering is the last one in that list, skip the quote. If
anything comes after it, quote it.

And the quote itself:

- **One line, and the clause that matters.** Cut to the question and end with
  \`…\` where you cut. A quote longer than the answer under it has restated
  the thread at the people who were in it.
- **Their words, not your paraphrase.** The whole point is that somebody
  recognises the sentence as theirs, so fix nothing in it.
- **Name them where it is not obvious who it was** — \`> *Anna:* …\`, with the
  name resolved by \`slack_whoIs\`, never a raw \`<@U…>\`. \`slack_mention\` is
  for when you mean to ping somebody, and quoting them is not that.
- **Never quote yourself**, and never quote the message immediately above you.
- **It is not a substitute for \`threadTs\`.** A quote says which message; the
  thread is still where the reply belongs.

## Before you post at all

\`slack_readThread\` first when you are joining something already in progress.
Somebody has usually answered already, and the most annoying possible message
is a confident restatement of what the previous reply said.

React rather than reply when acknowledgement is all that is needed.
\`slack_react\` with a checkmark says "done, nothing to read here" without
adding a message to anybody's unread count.`,
      }),

      new OrknuxSkill({
        id: 'slack-sending-a-file',
        name: 'Sending a file to Slack',
        description:
          'When the answer is a document, a picture or a page rather than a sentence - which call ' +
          'takes it, and what Slack shows of each.',
        content: `# Sending a file to Slack

Some answers are not sentences. A report, a page, a picture, a log - those are
objects, and an object goes into the channel as a file rather than as message
text. This page is which call, which filename, and what Slack does with each.

## The decision

**Is the thing you made a sentence, or is it an object?** A conclusion, a
number, an answer to a question is a sentence, and it goes in the message. A
report, a page, a spec, an HTML document, a transcript, a table of forty rows,
a config, a diff, somebody's whole log — those are objects, and **an object
goes up as a file** even where you could have got away with pasting it. Post
two or three lines saying what it is and what it concludes, and attach the
rest: a wall of text costs everybody in the channel a scroll, and a summary
with a file costs the two people who care a click.

**What happens instead, most of the time, is that the document is typed into
the message.** A whole HTML page, or a forty-line report, arrives as message
text — and Slack is not a document viewer. It collapses anything long behind a
*Show more*, so the reader sees the first few lines of markup and a link to the
rest of it. Every \`<tag>\` is there in full. \`_\` and \`*\` inside the text get
read as formatting, so a path turns italic halfway through and the asterisks
vanish out of the parts that needed them. Nothing about it can be fixed
afterwards, because a message cannot be edited into being a file.

It is not a close call, for two reasons. A Slack message has no scrollbar of
its own, so a long one pushes the rest of the channel off the screen for
everybody who was reading something else. And Slack *keeps* a file: it is
named, it is found by that name in search, it downloads, and somebody can open
it again next week. A pasted wall of text is findable only by whoever remembers
which thread it was in.

So the habit: write the two or three lines that say what it is and what it
concludes, and put the thing itself under them. Reach for an upload before you
reach for a longer message — anything past about fifteen lines, or with a
structure of its own (headings, a table, sections), is already a file.

### What Slack does with it depends on the extension

| what you made | send | and the reader gets |
|---|---|---|
| a log, a CSV, JSON, a query, a config, source | \`slack_upload\` with its key, extension to match | a snippet — the first lines in the message, the rest a click away |
| markdown — notes, a summary, a README | \`slack_upload\` with its key and \`.md\` | the same snippet, readable where it lands |
| something long meant to be *read* | \`pdf_fromHtml\`, then \`slack_uploadBinary\` with \`.pdf\` | a preview, page by page, in the message |
| an HTML document | read the next section first | the *markup*, as a snippet |
| a picture or a diagram | \`slack_uploadBinary\` with \`.png\` | the picture itself |

Markdown is the cheap middle and usually the right first thought: a \`.md\`
upload costs no render and reads in place. Go to the PDF when it is long enough
to want pages, or when it carries a table or a diagram.

### HTML: Slack shows the source, not the page

Upload a \`.html\` and what arrives is the markup in a snippet with a download
button under it. **No Slack client renders a page.** So the thing you meant
somebody to look at is two clicks and a browser away, and most of the channel
will never get there.

Which means deciding what you are actually sending:

- **The page is for reading** — you wrote a report and HTML is merely how it
  came out. Put it through **\`pdf_fromHtml\`** and upload the PDF by its key.
  It previews in the message, which is the entire point.
- **The page is the artefact** — something asked for as a page, to open in a
  browser or hand to another tool. Upload the \`.html\` and **say so in the
  comment**: "download it and open it in a browser" is the sentence that saves
  somebody a puzzled click.

\`pdf_fromHtml\` is a report writer rather than a browser — no CSS, no raster
images, no links, and \`i\` sets regular. So write plain HTML *for it*:
headings, paragraphs, lists, and \`<pre class="mermaid">…</pre>\` for a
diagram. Handing it a styled page and hoping is how a document arrives looking
like nothing anybody designed. It also answers **\`problems\`** — read that,
and say what is missing rather than passing the file on as though it were
whole.

And **look at it before you send it.** \`pdf_preview\` draws a page as a picture
for you: a heading stranded at the foot of a page, a table run off the side, a
diagram crowding its column. One call, and it is the difference between sending
a document and sending a surprise.

### Three things to do instead of uploading, all wrong

- **Splitting it across messages.** A document posted as four messages is
  neither readable nor findable, and it interrupted the channel four times.
- **Pasting it and offering the file afterwards.** "Let me know if you want
  this as a file" asks somebody for a decision you were there to make. The
  file was the answer.
- **Leaving it on the orknux side** for a person to go and find — the section
  after next says why that is not delivery.

## Diagrams: always the picture, never the markup

**Slack draws no SVG.** It hosts one as a file and shows a card with a filename
on it, so an SVG posted to a channel is a thing people have to download and open
before they can see it — which is to say, a thing most of them will never see.

So take the default and do not think about it. Whatever draws your diagram
answers a **png** unless you ask otherwise, and that png goes to
\`slack_uploadBinary\` with a \`.png\` filename. Ask for SVG only when the
reader is not a person: something that embeds the markup, or a file somebody is
going to edit. Posting one to a channel is never that.

Pass the **\`key\`** the render answered, not the bytes. Whatever drew the
picture answers one beside it - \`{"png": "…", "key": "picture.1k3af9"}\` - and
that key is what the upload takes:

    slack_uploadBinary {"channel": "C0BQE04E273", "filename": "flow.png",
                        "contentKey": "picture.1k3af9", "comment": "the flow",
                        "threadTs": ""}

\`slack_uploadBinary\` takes that key in place of the bytes — there is no
argument to put bytes in, and that is on purpose. The answer reaches the next
call by going through you, and a few kilobytes of base64 does not survive being
written out again: one arrived with a stray character in the middle of it and
the whole call was rejected as malformed before anything ran. The key is a
dozen characters and what it names never leaves the server.

## A file belongs in the channel, not in an artifact

**Upload it here.** \`slack_upload\` takes any file - text, a picture, a PDF,
a zip - by the \`key\` its maker answered, and the server says which it is.
Text you wrote yourself goes in a scratchpad first: \`scratchpad_keep\` answers
its key. \`slack_uploadBinary\` does the same for bytes.

\`save_artifact\` keeps a file on the orknux side. That is the right place for
something a later step of the same run reads, and the wrong place for anything
a person is meant to see: getting at it means leaving the conversation and
finding the run it belongs to, which is a thing nobody does. A report saved as
an artifact and announced in a channel has not been delivered - it has been
filed.

So when the thing you made is *for somebody*, it goes in the message. Attach
it, and say in two lines what it is.

## If you are giving a link, give one that opens

Slack makes a link out of an **absolute** url - \`https://\` and a host. A path
on its own is not one. Markdown resolves a path against the page it sits in;
a chat message sits in no page, so Slack has nothing to resolve against, makes
no link, and prints the construction instead:

    </pictures/6|A European town square with a row of traditional, colorful...>

Every character of that reached the reader, with a whole image description
standing in for link text.

**Where this comes from:** a tool answers you markdown pointing at a path -
a picture it drew, a file it wrote, a page on the server - because it is
describing something on its own host and has no reason to spell out where that
is. Pasting that into a message is what produces the line above. It is not
something the message can be repaired into being; the host is missing and
nothing downstream can invent it.

Three rules:

- **Absolute or nothing.** No host, no link. Say what the thing is in plain
  words instead.
- **Attach, do not link.** If it is a file this run produced, the section above
  applies - upload it, and the reader gets the thing rather than directions to
  it.
- **Short labels.** A link's text is a few words - \`the run\`, \`page 4\`.
  Never a sentence, and never the prompt a picture was generated from.`,
      }),

      new OrknuxSkill({
        id: 'slack-ending-the-turn',
        name: 'Ending a Slack turn',
        description: 'Your answer is already a message, so do not send the same thing twice.',
        content: `# Ending a Slack turn

## Sending is saying: do not say it twice

**Your answer is already a message.** You do not post it and there is no call
for it: the run takes what you say at the end of your turn and puts it in the
conversation. That is the one thing to understand here, because everything else
follows from it.

So a call that posts is a message *as well*. \`post\` sends \`text\`; the
uploads send \`comment\` with the file under it. A turn that uploads a picture
with "Here is the diagram you asked for" and then answers "Here is the diagram
you asked for" has sent that sentence twice, to somebody who needed it once.
Narrating what you just did is how it happens, and it happens almost every
time.

Say it once, in the call. Then **end the turn with \`finish_answer\`** - that
is what it is for. Your answer is not sent, because there is no answer: the
turn is over and the channel has exactly the one message you meant to send.

**No answer is expected of you once the message has gone out.** Not a short
one, not a confirmation, not a note saying what you posted. The work was
delivered by the call, and the turn has nothing left to produce.

\`answer\` is an optional argument, so omit it: it is not the message and
nobody in the channel ever sees it. What it is for is a later step of the same
workflow - a node that reads a value you were asked to produce - and putting
your reply there sends it to that node instead of to the person.

**Unless your own instructions say otherwise**, in which case they are right
and this is not: an agent told to report what it did, or wired to a step that
needs a value back, fills \`answer\` with what that step needs - never with
the message it has already sent.

Where \`finish_answer\` is not among your tools, the rest of this section still
holds: write an answer, and make it one worth a message.

Write an answer instead only when you have something the call did not already
say - what to look at, what you could not do, what you would do next, what you
noticed while doing it. That is a second message and it has to be worth one.

**Two things it must never be.** Not a description of the call you just made,
and not a note that you have nothing to add: "I have already posted the image,
so I have nothing further to add" is not saying nothing, it is saying nothing
at length, and the reader pays a message to learn you were finished. That is
the case \`finish_answer\` exists for.

**And never empty.** An answer of nothing is not the same as no answer - it is
read as a turn that failed, and the work is done again from the top, which is
how a thread ends up with the same picture twice. Ending the turn is a call you
make, not a message you leave blank.`,
      }),

      new OrknuxSkill({
        /*
         * Pinned rather than derived. This one is pointed at: a workflow node
         * naming skills to load writes the id down, and so does somebody
         * typing the command marker into a channel. A derived id would move
         * the day the name did, and take every graph with it.
         */
        id: 'new-thread',
        name: 'New Slack Thread',
        description:
          'How to answer in the channel as a thread of its own, rather than as a reply in the ' +
          'thread you were called from.',
        content: `# Answering in a thread of its own

Your answer goes to the **channel**, not into the thread you were called from.
That is the whole of this skill: one message in the same channel, which becomes
the top of a new thread, and then the turn ends.

Replying inside the thread you were called from is the ordinary thing to do and
is usually right. This is the exception, and it is loaded when somebody wants
it: when the answer is a topic rather than a reply — a report people will refer
back to, a run's result, something several of them will have something to say
about — because a topic buried forty replies down somebody else's thread is a
topic nobody finds twice.

## The call

    slack_post {"connection": "", "channel": "C0BQE04E273",
                "text": "the message", "threadTs": "", "attachments": []}

**\`"threadTs": ""\` is the mechanism.** An empty one puts the message in the
channel itself, where it reads
as its own topic and anything said about it hangs underneath. Pass the
\`threadTs\` you were handed and you are back inside somebody else's
conversation, which is the one thing this skill exists to prevent.

**The same channel.** The channel id you were called from — the one the thread
you read lives in. Not another channel, not a DM, and not the busiest channel
in the workspace because it seemed more visible.

Then **\`finish_answer\`**, with its \`answer\` argument left out. The post
was your message; your own reply would arrive as a second one. Where
\`finish_answer\` is not among your tools, write a short answer that says
something the message did not — never a description of the call you just made,
and never nothing at all.

## A new thread opens with nothing above it

In the thread you came from, the question was three lines up. Here there is no
question, no history and no reason for a passer-by to know what this is: they
meet the message cold, in the middle of a channel, and decide in one line
whether it is theirs.

So spend that line. Say what it is about, and quote what you are answering:

    *Charts before Friday*

    > can we ship the charts plugin before Friday?

    Yes — the renderer is done and the packaging is a day, so Thursday is
    real. What is not is the sample sheet…

One \`>\` per quoted line, never \`>>>\`, which swallows the answer into
the quote. Name whoever asked with \`slack_whoIs\` where it matters who it
was, and \`slack_mention\` only where they should be pinged — starting a
thread is not a reason to ping anybody.

## The answer's \`ts\` is the new thread's parent

\`slack_post\` answers the message it made - \`{"channel": "C0BQE04E273",
"ts": "1790517875.472569"}\`. That \`ts\` is the top of the thread you have just
started, so everything else you send takes it as its \`threadTs\`:

    slack_uploadBinary {"channel": "C0BQE04E273", "filename": "charts.png",
                        "contentKey": "pdf.1k3af9",
                        "comment": "the numbers behind it",
                        "threadTs": "1790517875.472569"}

Upload with an empty \`threadTs\` a second time and you have started a second
thread about the same thing, which is worse than the reply you were avoiding.

Where the **file is the answer**, one call does both: \`slack_upload\` or
\`slack_uploadBinary\` with an empty \`threadTs\` shares it to the channel
with the \`comment\` as its message. That is a new thread as well, with the
file at the top of it.

## Do not announce it where you came from

The temptation is a "posted this in a new thread ↑" reply in the old thread.
That is the message this skill just told you not to send, and it costs
everybody in that thread an unread to learn you went elsewhere.

Where the person who asked really has to know, **react** to their message
instead — \`slack_react\` with a checkmark. It shows on their own message and
it notifies nobody else.`,
      }),
    ];
  }

  /*
   * The agents' surface: the three lookups, fronted. A proxy rather than a
   * copy, so the params, return type and implementation - and any edit made
   * to the function on the server - stay the function's own.
   *
   * `isFirstReply` is deliberately not here. It is a workflow's gate, written
   * to be a condition; a model reading a thread has better ways to ask.
   */
  /**
   * The value types this plugin defines, for a workspace's variables to be.
   *
   * A Slack user id is a string, but it is a string only some values of are
   * real, and a variable holding one used to be a text box: a typo was found
   * by the function that failed at three in the morning. `SlackUser` gives
   * the variable the same picker the workflow editor's target box has, and a
   * check at the save.
   *
   * Told which Slack to look in. A workspace with two Slacks needs to say,
   * and a variable that says is one that keeps working when the plugin's
   * configured connection changes underneath it.
   *
   * `suggest` lists members through the server's Slack door, the same one
   * `findUsers` uses, and matches what was typed against handle, real name,
   * display name and email - so "mich" finds Michał whichever of those it is
   * in. What is offered is the id, because that is what a function wants,
   * with the name as the label so somebody can see who they picked.
   *
   * `validate` asks Slack for that one user. Deleted accounts are refused
   * too: an id that resolves to somebody who left is not somebody to notify.
   */
  types() {
    return [
      new OrknuxType({
        name: 'SlackUser',
        description: "A Slack member's id, checked against the workspace's Slack.",
        base: 'string',
        parameters: [
          {
            name: 'slack',
            description: 'Which Slack the user is in.',
            type: 'connection',
            connectionType: 'SLACK',
            required: true,
          },
        ],
        suggest: (typed, args) => {
          const connection = connectionArgument(args, this.settings);
          if (connection === null) return [];
          const wanted = String(typed ?? '').trim().replace(/^@/, '').toLowerCase();

          /*
           * Through the door the workflow editor's target box uses, so the
           * two agree about what a partial handle matches. Members only: a
           * channel is not a user, whatever was typed.
           */
          const offered = orknux.slack.suggest(connection, wanted, 'USER', 25);
          if (offered.error !== undefined) {
            orknux.log.warn(`SlackUser could not be offered: ${offered.error}`);
            return [];
          }
          return (offered.matches ?? []).map((one) => ({
            value: one.id,
            label: one.name,
            detail: one.realName ?? undefined,
          }));
        },
        validate: (value, args) => {
          const connection = connectionArgument(args, this.settings);
          if (connection === null) {
            return { ok: false, reason: 'say which Slack connection to check the user against' };
          }
          const id = String(value ?? '').trim().replace(/^<@|>$/g, '');
          if (!/^[UW][A-Z0-9]{2,}$/.test(id)) {
            return { ok: false, reason: `"${value}" is not a Slack user id - one looks like U0123ABCD` };
          }
          const found = orknux.slack.user(connection, id);
          if (found.error !== undefined) {
            return /not_found|users_not_found/.test(found.error)
              ? { ok: false, reason: `no member of this Slack has the id ${id}` }
              : { ok: false, reason: `Slack could not be asked about ${id}: ${found.error}` };
          }
          if (found.deleted === true) {
            return { ok: false, reason: `${id} belongs to a deactivated account` };
          }
          return { ok: true };
        },
      }),
    ];
  }

  /*
   * The fourth surface: blocks a workflow's Action node is pointed at, handed
   * their wired inputs as one object rather than positionally. Which is what
   * `commands` needs - the Slack trigger carries the slash commands it heard
   * as a list, and a function argument could only ever have been handed its
   * string. One action, kept small on purpose; the point is the contract.
   */
  actions() {
    return [
      {
        name: 'respond',
        label: 'Respond in Slack',
        description:
          'Posts text to a channel, in the thread when a threadTs is wired and as a new message ' +
          'otherwise. Takes the commands the trigger heard, as the list they are.',
        parameters: [
          { name: 'commands', type: 'array', description: 'The slash commands the trigger heard.' },
          { name: 'channel', type: 'string', description: 'Where to post: a channel id or a #name.' },
          { name: 'threadTs', type: 'string', required: false, description: 'The thread to answer in; leave it out to post to the channel.' },
          { name: 'text', type: 'string', description: 'What to say, as markdown.' },
        ],
        outputs: [
          { name: 'ts', type: 'string', description: "The new message's timestamp." },
          { name: 'channel', type: 'string', description: 'The channel it landed in.' },
        ],
        run: (input, context) => {
          const text = typeof input.text === 'string' ? input.text : '';
          if (text.trim().length === 0) throw new Error('there is nothing to say: text is empty');
          const channel = typeof input.channel === 'string' ? input.channel : '';
          if (channel.length === 0) throw new Error('there is nowhere to post: channel is empty');
          const threadTs = typeof input.threadTs === 'string' && input.threadTs.length > 0 ? input.threadTs : undefined;

          // The configured Slack: an action has no `connection` argument the
          // way a function does, so the workspace's own is the one it posts
          // through - which is what a workspace with one Slack wants.
          const configured = context.settings.slack;
          const use = configured && typeof configured === 'object' ? configured.id : configured;
          if (use === undefined || use === null || String(use).length === 0) {
            throw new Error("the plugin's slack parameter is not set, and responding needs a Slack to post through");
          }

          const posted = orknux.slack.post(use, channel, mrkdwn(text), threadTs);
          if (posted.error !== undefined) {
            throw new Error(`could not post the message: ${posted.error}`);
          }
          return { ts: posted.ts, channel: posted.channel };
        },
      },
    ];
  }

  tools() {
    const read = this.functions().find((one) => one.name === 'readAttachment');
    const posted = this.functions().find((one) => one.name === 'post');
    return [
      new OrknuxFunctionTool({ function: 'readMessage' }),
      new OrknuxFunctionTool({ function: 'whoIs' }),
      new OrknuxFunctionTool({ function: 'findUsers' }),
      new OrknuxFunctionTool({ function: 'findChannels' }),
      new OrknuxFunctionTool({ function: 'listThreads' }),
      new OrknuxFunctionTool({ function: 'mention' }),
      new OrknuxFunctionTool({ function: 'readThread' }),
      /*
       * The third tool here that is not its function, and the last way base64
       * could reach a model: `attachments` takes maps, and one of them could
       * carry bytes. It takes a `contentKey` instead now, and the function
       * behind this still takes bytes for the workflow node that has no
       * session and therefore never had a key.
       */
      new OrknuxTool({
        name: 'post',
        description:
          posted.description +
          ' An attachment that is not already on Slack is named, never typed: give the map a ' +
          'contentKey - the key the tool that made the bytes answered beside them, as pdf_fromHtml ' +
          'and charts_render do - ' +
          'the bytes - or a url for a file that lives at one. A map carrying base64 is refused ' +
          'here, because a few kilobytes of it written into a tool call arrives a character wrong ' +
          'and the whole call is rejected before anything runs.' +
          ' text is a message, not a document. Where what you are about to put in it is an HTML ' +
          'page, a report, a log, a table of forty rows or anything else with a structure of its ' +
          'own, that goes up as a file instead: write it in a scratchpad and slack_upload the key ' +
          'scratchpad_keep answers (.md, .csv, .json, .html, source), or pdf_fromHtml and then ' +
          'slack_upload its key for something long ' +
          'meant to be read, which is the one form Slack previews page by page. text is then the ' +
          'two lines saying what the file is and what it concludes. A document typed in here is ' +
          'collapsed behind a Show more with every tag showing and its underscores read as ' +
          'italics, and a message cannot be edited into being a file afterwards.',
        params: posted.params,
        returnType: posted.returnType,
        run: (connection, channel, text, threadTs, attachments) => {
          for (const one of Array.isArray(attachments) ? attachments : []) {
            if (one !== null && typeof one === 'object' && typeof at(one, 'base64') === 'string') {
              throw new Error(
                'an attachment cannot carry base64 here: pass contentKey instead, the key the ' +
                  'tool that made the bytes answered; pdf_fromHtml and charts_render both ' +
                  'answer one. For a file that already lives at a url, give the ' +
                  'attachment that url and it is fetched without either of us handling it.',
              );
            }
          }
          return posted.run(connection, channel, text, threadTs, attachments);
        },
      }),
      new OrknuxFunctionTool({ function: 'toSlack' }),
      new OrknuxFunctionTool({ function: 'react' }),
      new OrknuxFunctionTool({ function: 'search' }),
      new OrknuxFunctionTool({ function: 'findRecent' }),
      /*
       * The model's upload takes a key and nothing else; the function a
       * workflow calls keeps content, because a workflow has no session to
       * keep a key in. The server says what a key holds - text or bytes - so
       * one tool uploads either, and the wrong-tool mistake cannot be made.
       */
      new OrknuxTool({
        name: 'upload',
        description:
          'Uploads a file to Slack that the workspace hosts, and shares it to a channel with a message - ' +
          'any file a tool made or kept: a PDF, a picture, a zip, an SVG, a page, a CSV. Takes the file by ' +
          'its contentKey only, the key the tool that made it answered beside it; for text you wrote ' +
          'yourself, keep it in a scratchpad and pass the key scratchpad_keep answers. The server says ' +
          'whether a key holds text or bytes, so either goes up as what it is. Pass the channel id (not a ' +
          '#name), a filename whose extension says what the file is (report.pdf, data.csv), what the ' +
          'sharing message should say, and a threadTs to share inside a thread - ' +
          'empty for the channel itself. Pass an empty channel to only upload: the answered permalink ' +
          'then goes in a later post\'s attachments. Slack hosts what it is given but draws only pictures ' +
          'in a message - an SVG arrives as a file card, so upload a PNG where somebody should see it. ' +
          'This call posts a message - the comment is its text. Your own answer is posted to the same conversation as well, by the run rather than by you, so whatever you say after this call arrives as a SECOND message. Caption the file in the comment - that is your message to them, and it is sent the moment this call returns. Then END THE TURN WITH finish_answer, which stops your answer going out after it as a second message. Its own answer argument is for a later step of the workflow rather than for the reader, so leave it out unless something downstream needs it. Write a real answer instead where finish_answer is not among your tools, or where you have something the comment did not say - what to look at, what you could not do, what you would do next. Never write that you have nothing to add, and never answer with nothing at all: an empty answer is read as a failed turn and does the work again, which is how a channel ends up with the same picture twice. ' +
          'Answers the file\'s id and permalink. Needs the botToken parameter.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'filename', type: 'string' },
          { name: 'contentKey', type: 'string' },
          { name: 'comment', type: 'string' },
          { name: 'threadTs', type: 'string' },
        ],
        returnType: 'HostedFile',
        run: (channel, filename, contentKey, comment, threadTs) => {
          /*
           * A key, and nothing else. The content parameter went because a
           * tool that takes either text or a key is a tool a model uses the
           * wrong way: typed content is cut off at its output limit, and a
           * binary key sent as text reached Slack as base64. The key is a dozen
           * characters and what it names never leaves the server.
           */
          if (typeof contentKey !== 'string' || contentKey.length === 0) {
            throw new Error(
              'upload takes a contentKey: make the file with a tool and pass the key it answered, or ' +
                'write the text into a scratchpad and pass the key scratchpad_keep answers.',
            );
          }
          const held = orknux.session.store.get(contentKey);
          if (typeof held !== 'string' || held.length === 0) {
            throw new Error(
              `nothing is kept under ${contentKey} in this session: make the file again and pass ` +
                'the key that answer carried. A key is only good for the session it was made in.',
            );
          }

          /*
           * The server says what the key holds. Where it says nothing - a
           * server from before it kept kinds, or a key put without one - the
           * value is read the old way: strict base64 is bytes, unless it
           * decodes to markup, which is text.
           */
          const kind = orknux.session.store.kind(contentKey);
          if (kind !== null) {
            return kind.binary
              ? uploadedBytes(this.settings, filename, held, channel, comment, threadTs)
              : uploadedText(this.settings, filename, held, channel, comment, threadTs);
          }
          if (held.length >= 64 && STRICT_BASE64.test(held)) {
            const decoded = orknux.encoding.decodeBase64(held);
            if (typeof decoded.text === 'string' && /^\s*</.test(decoded.text)) {
              return uploadedText(this.settings, filename, decoded.text, channel, comment, threadTs);
            }
            return uploadedBytes(this.settings, filename, held, channel, comment, threadTs);
          }
          return uploadedText(this.settings, filename, held, channel, comment, threadTs);
        },
      }),
      /*
       * The one tool here that is not its function.
       *
       * `uploadBinary` the *function* takes base64, because a workflow node
       * has no session and therefore never had a key to pass - taking the
       * argument away there would close the only door it has. A model is the
       * other case entirely: everything that makes bytes answers it a key, and
       * it still wrote five thousand characters of base64 into the argument,
       * where it arrived a character wrong and the call was rejected as
       * malformed before anything ran.
       *
       * Advice did not fix that and a refusal would only have described it. An
       * argument a model should never fill is an argument that should not be
       * in front of it, so this surface does not have one. Same
       * implementation, same channel and filename and comment - one parameter
       * replaced by the name of the thing it used to carry.
       */
      new OrknuxTool({
        name: 'uploadBinary',
        description:
          'Puts bytes on Slack as a file the workspace hosts - a PDF, a rendered diagram - and ' +
          'shares them to a channel with a message. The bytes are named, never typed: pass the ' +
          'short contentKey the tool that made them answered beside them; pdf_fromHtml and ' +
          'charts_render both answer one. There is deliberately no base64 ' +
          'argument here: a few kilobytes of it written back into a tool call arrives with a ' +
          'character wrong and the whole call is rejected before anything runs, so the argument ' +
          'that invited that is gone. Also pass a filename whose extension says what the bytes ' +
          'are (report.pdf, chart.png), the channel id, what the sharing message should say, and ' +
          'This call posts a message - the comment is its text. Your own answer is posted to the same conversation as well, by the run rather than by you, so whatever you say after this call arrives as a SECOND message. Caption the file in the comment - that is your message to them, and it is sent the moment this call returns. Then END THE TURN WITH finish_answer, which stops your answer going out after it as a second message. Its own answer argument is for a later step of the workflow rather than for the reader, so leave it out unless something downstream needs it. Write a real answer instead where finish_answer is not among your tools, or where you have something the comment did not say - what to look at, what you could not do, what you would do next. Never write that you have nothing to add, and never answer with nothing at all: an empty answer is read as a failed turn and does the work again, which is how a channel ends up with the same picture twice. ' +
          'a threadTs - or an empty channel to only upload, whose permalink then goes in a later ' +
          'post\'s attachments. upload takes the same keys, text or bytes, and is the one to reach ' +
          'for. Answers the file\'s id and ' +
          'permalink. Needs the botToken parameter.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'filename', type: 'string' },
          { name: 'contentKey', type: 'string' },
          { name: 'comment', type: 'string' },
          { name: 'threadTs', type: 'string' },
        ],
        returnType: 'HostedFile',
        run: (channel, filename, contentKey, comment, threadTs) => {
          if (typeof contentKey !== 'string' || contentKey.length === 0) {
            throw new Error(
              'uploadBinary takes a contentKey, not bytes: make the file first and pass the key ' +
                'that answer carried; pdf_fromHtml and charts_render both answer ' +
                'one. For bytes that live at a url, uploadFromUrl fetches them without either of ' +
                'us handling them.',
            );
          }

          const held = orknux.session.store.get(contentKey);
          if (typeof held !== 'string' || held.length === 0) {
            throw new Error(
              `nothing is kept under ${contentKey} in this session: make the file again and pass ` +
                'the key that answer carried. A key is only good for the session it was made in.',
            );
          }

          return uploadedBytes(this.settings, filename, held, channel, comment, threadTs);
        },
      }),

      new OrknuxFunctionTool({ function: 'uploadFromUrl' }),
      new OrknuxFunctionTool({ function: 'remoteFile' }),
      new OrknuxFunctionTool({ function: 'listAttachments' }),

      /*
       * The second tool here that is not its function, for the reason the
       * first one exists: what crosses to a model should be what a model can
       * use. A workflow node reading this function gets the bytes, because it
       * has no session to read a key from.
       */
      new OrknuxTool({
        name: 'readAttachment',
        description:
          read.description +
          ' A file that is not text answers the key and an empty base64: the bytes stay on the ' +
          'server, and that key is what upload takes. To look at a picture - a screenshot somebody ' +
          'attached - pass its key to picture_view. Text still answers its content, ' +
          'because reading it is the point.',
        params: read.params,
        returnType: read.returnType,
        run: (file) => readAsKeyed(read.run(file)),
      }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'isFirstReply',
        description:
          'Whether this message is the first reply in its thread. False for a message that is not in a thread at all.',
        /*
         * `ts` as well as the thread, because the two together are the whole
         * question. A message whose own timestamp *is* the thread's is the
         * parent, not a reply - Slack gives a message outside a thread a
         * `threadTs` of its own `ts`, so without this every top-level message
         * would look like a first reply.
         */
        params: [
          { name: 'connection', type: 'map' },
          { name: 'channel', type: 'string' },
          { name: 'threadTs', type: 'string' },
          { name: 'ts', type: 'string' },
        ],
        returnType: 'boolean',
        run: (connection, channel, threadTs, ts) => {
          if (typeof threadTs !== 'string' || threadTs === '' || threadTs === ts) {
            return false;
          }

          const read = through((use) => orknux.slack.thread(use, channel, threadTs, 2), connection, this.settings.slack);
          if (read.error !== undefined) {
            /*
             * Thrown rather than answered false. A condition that cannot be
             * decided must not quietly decide: "we could not read the thread"
             * and "this is not the first reply" are different facts, and a
             * workflow that treated them alike would silently stop firing the
             * day a scope was revoked.
             */
            throw new Error(`could not read the thread: ${read.error}`);
          }

          /*
           * Slack's own count, which is of the whole thread rather than of what
           * came back. One reply, and this is it.
           */
          return read.replies === 1;
        },
      }),

      new OrknuxFunction({
        name: 'readMessage',
        description:
          'Reads the Slack message a permalink points at. Use when a message links to another message ' +
          '(https://…slack.com/archives/…) and you need what that message says. Pass the connection the ' +
          'event came in on, or an empty string to use the configured one. An empty string is always safe: a connection named by an older event may since have been deleted. ' +
          'Answers channel, ts, user and text.',
        params: [
          { name: 'connection', type: 'string' },
          { name: 'link', type: 'string' },
        ],
        returnType: 'LinkedMessage',
        run: (connection, link) => {
          const read = through((use) => orknux.slack.message(use, link), connection, this.settings.slack);
          if (read.error !== undefined) {
            throw new Error(`could not read the linked message: ${read.error}`);
          }
          return read;
        },
      }),

      new OrknuxFunction({
        name: 'whoIs',
        description:
          'Says who a Slack user id belongs to. Use when a message carries a mention like <@U0123ABCD> ' +
          'and you need the person behind it; pass the id bare or as the whole <@…> notation. Pass the ' +
          'connection the event came in on, or an empty string to use the configured one. An empty string is always safe: a connection named by an older event may since have been deleted. ' +
          'Answers id, ' +
          'name, realName, displayName and whether it is a bot.',
        params: [
          { name: 'connection', type: 'string' },
          { name: 'userId', type: 'string' },
        ],
        returnType: 'User',
        run: (connection, userId) => {
          const found = through((use) => orknux.slack.user(use, userId), connection, this.settings.slack);
          if (found.error !== undefined) {
            throw new Error(`could not look the user up: ${found.error}`);
          }
          /* The field exists whichever call answered, so nothing has to ask which did. */
          return { ...found, email: at(found, 'email') ?? null };
        },
      }),

      new OrknuxFunction({
        name: 'findChannels',
        description:
          'Finds channels by name, topic or purpose - every word of the query has to appear ' +
          'somewhere in one of the three, in any order and whatever the capitals. Leave the query ' +
          'empty to list what is there. Answers each channel\'s id, name, whether it is private, ' +
          'how many people are in it, its topic and purpose, a url, and - the field that decides ' +
          'what else you can do with it - whether the bot is a member, because reading a ' +
          'channel\'s history needs an invitation and no scope substitutes for one. Runs on the ' +
          'bot token and needs channels:read, plus groups:read for private channels. ' +
          'withArchived includes the closed ones, which are left out otherwise.',
        params: [
          { name: 'query', type: 'string', required: false, default: '' },
          { name: 'limit', type: 'number', required: false, default: 20 },
          { name: 'withArchived', type: 'boolean', required: false, default: false },
        ],
        returnType: 'Channels',
        run: (query, limit, withArchived) => {
          /* A #name is how people write a channel, and is not part of its name. */
          const asked = (typeof query === 'string' ? query : '').trim().replace(/^#/, '');
          const terms = asked
            .toLowerCase()
            .split(/\s+/)
            .filter((one) => one.length > 0);
          const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
          const site = workspaceUrl(this.settings);
          const wanted = (one) => {
            /* An empty query is a listing, which is the same search with nothing to match. */
            const haystack = `${one.name ?? ''} ${one.topic ?? ''} ${one.purpose ?? ''}`;
            return terms.length === 0 || carries(haystack, terms);
          };

          /*
           * The bot's own channels first, and not only to be quick about it.
           * A channel somebody has added the bot to is always in this list,
           * it is short where the workspace's own is not, and it is the list
           * every other call here can actually read - so a hit in it is worth
           * more than a hit in the directory, which may be a channel nothing
           * can be done with.
           */
          const mine = joined(this.settings);
          const matches = [];
          const seen = new Set();
          for (const one of mine) {
            const channel = channelOf(one, site);
            /* users.conversations answers only what the bot is in, so it is. */
            channel.member = true;
            if (wanted(channel)) {
              matches.push(channel);
              seen.add(channel.id);
            }
          }

          /*
           * An exact name among them is the answer and there is nothing to
           * gain by reading nine thousand more channels to confirm it.
           */
          const named = matches.find((one) => String(one.name).toLowerCase() === asked.toLowerCase());
          if (asked.length > 0 && named !== undefined) {
            return { channels: [named], total: 1, read: mine.length, complete: true };
          }

          const directory = pagesOf(
            this.settings,
            'conversations.list',
            {
              types: 'public_channel,private_channel',
              exclude_archived: withArchived === true ? 'false' : 'true',
              limit: '1000',
            },
            DIRECTORY,
          );
          for (const one of directory.items) {
            const channel = channelOf(one, site);
            if (!seen.has(channel.id) && wanted(channel)) {
              matches.push(channel);
              seen.add(channel.id);
            }
          }

          /* What the bot is in first: those are the ones anything else can read. */
          matches.sort((first, second) => (first.member === second.member ? 0 : first.member ? -1 : 1));

          return {
            channels: matches.slice(0, capped),
            total: matches.length,
            read: mine.length + directory.items.length,
            complete: directory.complete,
          };
        },
      }),

      new OrknuxFunction({
        name: 'listThreads',
        description:
          'The threads in one channel, newest activity first: what each is about, who started it, ' +
          'how many replied, and the ts readThread takes to read one. Slack has no call that ' +
          'lists threads, so this reads the channel\'s recent history and picks out the messages ' +
          'that have replies - which means it sees the window days asks for and not the archive ' +
          'behind it. Pass the channel as a name, a #name or an id; the bot has to be in it. days ' +
          'is how far back to read, a week if not given. Use it to find the conversation worth ' +
          'reading before reading one, rather than opening threads to see what they are.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'days', type: 'number', required: false, default: 7 },
          { name: 'limit', type: 'number', required: false, default: 20 },
          { name: 'withNames', type: 'boolean', required: false, default: true },
        ],
        returnType: 'Threads',
        run: (channel, days, limit, withNames) => {
          const asked = typeof channel === 'string' ? channel.trim().replace(/^#/, '') : '';
          if (asked.length === 0) {
            throw new Error('there is no channel to look in');
          }
          const back = Math.min(Math.max(Math.trunc(days), 1), 90);
          const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
          const oldest = Math.floor(Date.now() / 1000) - back * 86400;

          /* The bot's own memberships, which is both how a name resolves and the fence. */
          const where = joined(this.settings).find((one) => one.id === asked || one.name === asked);
          if (where === undefined) {
            throw new Error(
              `the bot is not in ${channel}, so there is nothing of it to read - invite it there first`,
            );
          }

          const history = slackApi(this.settings, 'conversations.history', {
            channel: where.id,
            oldest: String(oldest),
            limit: String(PAGE),
          });
          const messages = at(history, 'messages') ?? [];
          const site = workspaceUrl(this.settings);

          /*
           * A thread is a message that has been replied to. Slack writes the
           * count on the parent and nowhere else, so the parents in a page of
           * history are the whole of what there is to find - and a thread
           * whose parent is older than the window is not in it, however
           * recently somebody answered.
           */
          const threads = [];
          for (const one of messages) {
            const replies = at(one, 'reply_count');
            if (typeof replies !== 'number' || replies < 1) {
              continue;
            }
            const ts = at(one, 'ts');
            threads.push({
              ts: ts,
              user: at(one, 'user') ?? at(one, 'username'),
              userName: null,
              text: at(one, 'text'),
              replies: replies,
              repliers: at(one, 'reply_users_count'),
              started: whenOf(ts),
              lastReply: whenOf(at(one, 'latest_reply')),
              permalink:
                site === null || typeof ts !== 'string'
                  ? null
                  : `${site}/archives/${where.id}/p${ts.replace('.', '')}`,
            });
          }

          /*
           * Newest activity first, which is when it was last *answered* rather
           * than when it was started: a question from Monday that somebody
           * replied to an hour ago is the live conversation, and the thread
           * opened this morning and ignored is not. ISO 8601 in UTC sorts as
           * text, which is the whole reason these are answered in it.
           */
          const active = (one) => one.lastReply ?? one.started ?? '';
          threads.sort((first, second) => active(second).localeCompare(active(first)));
          const shown = threads.slice(0, capped);

          return {
            channel: where.id,
            threads: withNames === false ? shown : withAuthors('', this.settings, shown),
            total: threads.length,
            messages: messages.length,
            since: new Date(oldest * 1000).toISOString(),
            complete: at(history, 'has_more') !== true,
          };
        },
      }),

      new OrknuxFunction({
        name: 'findUsers',
        description:
          'Finds people by name or by email, for turning "the person called Ada" or an address ' +
          'into the U… id every other call here takes. An email is matched exactly, which is one ' +
          'cheap request; anything else is matched against usernames, real names, display names ' +
          'and addresses, with every word having to appear somewhere - so "ada lovelace" and ' +
          '"lovelace" both find her and "ada bob" finds nobody. Answers the people, how many ' +
          'matched, how many accounts were read to find them, and whether the whole directory ' +
          'was read - false there means a large workspace ran past the page cap and somebody ' +
          'further down may match, so narrow the query or use an address. Runs on the bot token ' +
          'and needs users:read, plus users:read.email for anything to do with addresses.',
        params: [
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 10 },
        ],
        returnType: 'FoundUsers',
        run: (query, limit) => {
          const asked = typeof query === 'string' ? query.trim() : '';
          if (asked.length === 0) {
            throw new Error('there is nobody to look for');
          }
          const capped = Math.min(Math.max(Math.trunc(limit), 1), 100);

          /*
           * An address is an exact question, and Slack has an exact answer for
           * it. Reading the whole directory to find something it can look up
           * directly would be a hundred times the work for the same person.
           */
          if (ADDRESS.test(asked)) {
            let found;
            try {
              found = slackApi(this.settings, 'users.lookupByEmail', { email: asked });
            } catch (thrown) {
              /*
               * Nobody at that address is an answer, not a failure - the
               * question was whether they are here, and they are not.
               */
              if (/users_not_found/.test(thrown.message)) {
                return { users: [], total: 0, read: 1, complete: true };
              }
              throw thrown;
            }
            const one = at(found, 'user');
            return {
              users: one === null ? [] : [userOf(one)],
              total: one === null ? 0 : 1,
              read: 1,
              complete: true,
            };
          }

          /*
           * And a name is not, because Slack has no user search for a bot at
           * all: `users.list` and a filter is the whole of what there is. It
           * is paged rather than read whole, and the answer says whether it
           * reached the end.
           */
          const terms = asked.toLowerCase().split(/\s+/).filter((one) => one.length > 0);
          const matches = [];
          let read = 0;
          let cursor = '';
          let complete = false;
          for (let page = 0; page < DIRECTORY; page += 1) {
            const listed = slackApi(this.settings, 'users.list', { limit: '200', cursor: cursor });
            const members = at(listed, 'members') ?? [];
            read += members.length;

            for (const member of members) {
              /* A deactivated account is not somebody to find. */
              if (at(member, 'deleted') === true) {
                continue;
              }
              const person = userOf(member);
              const haystack =
                `${person.name ?? ''} ${person.realName ?? ''} ` +
                `${person.displayName ?? ''} ${person.email ?? ''}`;
              if (carries(haystack, terms)) {
                matches.push(person);
              }
            }

            cursor = at(at(listed, 'response_metadata'), 'next_cursor') ?? '';
            if (typeof cursor !== 'string' || cursor.length === 0) {
              complete = true;
              break;
            }
          }

          return {
            users: matches.slice(0, capped),
            total: matches.length,
            read: read,
            complete: complete,
          };
        },
      }),

      new OrknuxFunction({
        name: 'readThread',
        description:
          'Reads a Slack thread: the messages under one parent, oldest first, what each of them has ' +
          'attached, and how many replies the whole thread holds. A message somebody uploaded a file ' +
          'to carries it under files, with the id readAttachment takes - so a question about "the ' +
          'file" is answered by reading the thread rather than by guessing a timestamp. Pass the channel id and the thread\'s ts (threadTs on an event; a message\'s ' +
          'own ts when it is the parent). Pass the connection the event came in on, or an empty string to ' +
          'use the configured one. An empty string is always safe: a connection named by an older event may since have been deleted. limit caps how many messages come back. Each message says who wrote it as a userName as well as an id, ' +
          'so a thread reads as people rather than as U0123ABCD - that costs one lookup per ' +
          'distinct author and can be turned off with withNames where the ids are all you need.',
        params: [
          { name: 'connection', type: 'string' },
          { name: 'channel', type: 'string' },
          { name: 'threadTs', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 20 },
          { name: 'withNames', type: 'boolean', required: false, default: true },
        ],
        returnType: 'Thread',
        run: (connection, channel, threadTs, limit, withNames) => {
          const read = through((use) => orknux.slack.thread(use, channel, threadTs, limit), connection, this.settings.slack);
          if (read.error !== undefined) {
            throw new Error(`could not read the thread: ${read.error}`);
          }
          const messages = at(read, 'messages') ?? [];
          /*
           * On by default, because an id is not an answer. A thread where
           * every author reads `U0123ABCD` is one a model has to look four
           * people up to understand, and it will either spend four calls
           * doing it or guess - and the same ids resolve to the same people
           * whatever asks, so doing it once here is cheaper than any of that.
           */
          return {
            ...read,
            messages:
              withNames === false
                ? messages.map((one) => ({ ...one, userName: null }))
                : withAuthors(connection, this.settings, messages),
          };
        },
      }),

      new OrknuxFunction({
        name: 'post',
        description:
          'Posts a message to a Slack channel, written as mrkdwn on the way out - markdown that ' +
          'Slack would show as punctuation is converted, so **bold** arrives bold and a ' +
          '[link](url) arrives as one, while text already written as mrkdwn is left alone and ' +
          'code is never touched. Pass the channel id (or a #name), what to say, and a ' +
          'threadTs to reply inside a thread - or an empty threadTs to post to the channel itself. ' +
          'attachments hangs files on the message, and takes either kind: a permalink string for a ' +
          'file already on Slack (as an event or readThread carries it), or a map for one that is ' +
          'not there yet - {filename, content} for text like a CSV, {filename, base64} for bytes ' +
          'like a PDF (pdf_fromHtml answers base64 ready for this), or {url} to copy a file from a ' +
          'url. The maps upload first and need the botToken parameter; permalinks need nothing. ' +
          'Pass an empty array for ' +
          'none. Pass the connection the event came in on, or an empty string to use the configured ' +
          'one. An empty string is always safe: a connection named by an older event may since have been deleted. This call posts a message - text is its words. Your own answer is posted to the same conversation as well, by the run rather than by you, so whatever you say after this call arrives as a SECOND message. Say it once, here, then end the turn with finish_answer so your answer is not sent after it as a second message - leaving its answer argument out, since that is for a later step of the workflow and not for the reader. Write a real answer instead where finish_answer is not among your tools, or where you have something this message did not say, and never answer with nothing at all - that is read as a failed turn and the work is done again. Answers the channel and the new message\'s ts.',
        params: [
          { name: 'connection', type: 'string' },
          { name: 'channel', type: 'string' },
          { name: 'text', type: 'string' },
          { name: 'threadTs', type: 'string' },
          { name: 'attachments', type: 'array' },
        ],
        returnType: 'Posted',
        run: (connection, channel, text, threadTs, attachments) => {
          /*
           * Slack attaches a hosted file to a message when the message carries
           * the file's permalink - that is Slack's own mechanism, so linking a
           * file that is already there needs nothing beyond SLACK_POST_MESSAGE.
           * A file that is *not* there yet is put there first, which is the
           * part that needs `botToken`. The `| ` label keeps the raw
           * url out of the text people read; the preview still unfurls.
           */
          /*
           * Written as mrkdwn on the way out, because this plugin is the one
           * that knows what Slack reads. Nothing else has to be installed and
           * nothing has to be called first: a message composed as markdown
           * arrives as the bold and the links it was meant to be.
           */
          let said = mrkdwn(text);
          const linked = attaching(this.settings, attachments);
          if (linked.length > 0) {
            said = `${said}${linked.map((one) => ` <${one}| >`).join('')}`;
          }

          const posted = through(
            (use) => orknux.slack.post(use, channel, said, threadTs || undefined),
            connection,
            this.settings.slack,
          );
          if (posted.error !== undefined) {
            throw new Error(`could not post the message: ${posted.error}`);
          }
          return posted;
        },
      }),

      /*
       * The conversion on its own, for text that is not going through `post`.
       *
       * `post` converts what reaches it, which covers the message being sent;
       * this covers everything else - a comment on an upload composed a step
       * earlier, a workflow node that builds text now and posts it three nodes
       * later, a Teams message a workspace wants spelled the same way, and
       * anybody who simply wants to see what their markdown becomes.
       *
       * The one function here that takes no connection, and deliberately: it
       * reaches nothing, asks nothing of Slack and cannot fail. An argument
       * that exists only to keep a shape is an argument somebody has to fill.
       */
      new OrknuxFunction({
        name: 'toSlack',
        description:
          'Turns markdown into the mrkdwn a Slack message actually reads, and answers it. **bold** ' +
          'becomes *bold*, [text](url) becomes <url|text>, headings become bold lines and tables ' +
          'become their rows - mrkdwn has neither. Code spans and fences are left exactly as they ' +
          'are, a single * or _ is never touched because that is already mrkdwn, and Slack\'s own ' +
          'markup - <@U0123ABCD>, <#C0123|general>, <https://x|text> - comes through untouched, and a ' +
          'message whose line breaks arrived as escapes is repaired. post already ' +
          'does all of this to what you give it, so reach for this only where the text is not ' +
          'going straight into a post: a comment composed earlier, a message another plugin will ' +
          'send, or seeing what your markdown becomes.',
        params: [{ name: 'markdown', type: 'string' }],
        returnType: 'string',
        run: (markdown) => (typeof markdown === 'string' ? mrkdwn(markdown) : ''),
      }),

      new OrknuxFunction({
        name: 'react',
        description:
          'Adds an emoji reaction to a Slack message. Pass the channel id, the message\'s own ts, and the ' +
          'emoji\'s short name with or without the colons. Already-reacted counts as done. Pass the ' +
          'connection the event came in on, or an empty string to use the configured one. An empty string is always safe: a connection named by an older event may since have been deleted.',
        params: [
          { name: 'connection', type: 'string' },
          { name: 'channel', type: 'string' },
          { name: 'ts', type: 'string' },
          { name: 'emoji', type: 'string' },
        ],
        returnType: 'boolean',
        run: (connection, channel, ts, emoji) => {
          const done = through((use) => orknux.slack.react(use, channel, ts, emoji), connection, this.settings.slack);
          if (done.error !== undefined) {
            throw new Error(`could not add the reaction: ${done.error}`);
          }
          return true;
        },
      }),

      new OrknuxFunction({
        name: 'search',
        description:
          'Searches Slack messages the way the search box does. Slack\'s search syntax works: in:#channel, ' +
          'from:@name, "an exact phrase". Answers the matches - channel, ts, user, text and a permalink ' +
          'back to each - and how many the whole search holds. Pass the connection the event came in on, ' +
          'or an empty string to use the configured one. An empty string is always safe: a connection named by an older event may since have been deleted. limit caps the matches. Note: ' +
          'Slack answers search only for a user token, so either the userToken parameter is set or the ' +
          'connection carries one in its User Token field.',
        params: [
          { name: 'connection', type: 'string' },
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'SearchResult',
        run: (connection, query, limit) => {
          /*
           * The plugin's own user token first, where a workspace set one, and
           * the connection's User Token field otherwise. Both end at the same
           * Slack endpoint with the same kind of credential; what differs is
           * who holds it, and a workspace that has filled in neither gets the
           * capability's own error rather than a second one invented here.
           */
          const mine = this.settings.userToken;
          const found =
            typeof mine === 'string' && mine.length > 0
              ? searchAs(mine, query, limit)
              : through((use) => orknux.slack.search(use, query, limit), connection, this.settings.slack);
          if (found.error !== undefined) {
            throw new Error(`could not search Slack: ${found.error}`);
          }
          /*
           * The field exists on every match whichever path ran. Slack's own
           * search carries the author's name beside the id, so this is free
           * here - and a caller reading `userName` should not have to know
           * which of two routes answered it.
           */
          return {
            ...found,
            matches: (at(found, 'matches') ?? []).map((one) => ({
              ...one,
              userName: at(one, 'userName') ?? at(one, 'username') ?? null,
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'findRecent',
        description:
          'Finds messages by reading recent history and filtering it, which is what a bot can do ' +
          'where search cannot: Slack answers search.messages for a user token only, so this runs ' +
          'on the bot token instead and reads the channels the bot has been invited to. Every word ' +
          'of the query has to appear somewhere in a message, in any order and whatever the ' +
          'capitals - it is not Slack search syntax, so in:#channel and from:@name do not work; ' +
          'pass the channel separately. channel takes a name, a #name or an id, and left empty ' +
          'reads every channel the bot is in, up to fifteen. days is how far back to read, a week ' +
          'if not given. Answers the matches newest first with a permalink each, how much was read ' +
          'to find them, and whether the window was read whole. This is a scan and not an index: ' +
          'it sees recent history rather than the archive, and nothing in a channel the bot was ' +
          'never invited to. Each match says who wrote it as a userName as well as an id, which costs ' +
          'one lookup per distinct author among the matches shown.',
        params: [
          { name: 'query', type: 'string' },
          { name: 'channel', type: 'string', required: false, default: '' },
          { name: 'days', type: 'number', required: false, default: 7 },
          { name: 'limit', type: 'number', required: false, default: 20 },
          { name: 'withNames', type: 'boolean', required: false, default: true },
        ],
        returnType: 'RecentResult',
        run: (query, channel, days, limit, withNames) => {
          const terms = (typeof query === 'string' ? query : '')
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter((one) => one.length > 0);
          if (terms.length === 0) {
            throw new Error('there is nothing to look for');
          }
          const back = Math.min(Math.max(Math.trunc(days), 1), 90);
          const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
          const oldest = Math.floor(Date.now() / 1000) - back * 86400;

          /*
           * What the bot is in, which is both the list to read and the fence
           * around it. A named channel still has to be one of these: asking
           * Slack for a channel the bot was never invited to answers
           * `not_in_channel`, and saying so here names the reason.
           */
          const memberships = joined(this.settings);
          const asked = typeof channel === 'string' ? channel.trim().replace(/^#/, '') : '';
          let reading = memberships;
          if (asked.length > 0) {
            reading = memberships.filter((one) => one.id === asked || one.name === asked);
            if (reading.length === 0) {
              throw new Error(
                `the bot is not in ${channel}, so there is nothing of it to read - invite it there, ` +
                  'or leave the channel empty to read the ones it is in',
              );
            }
          }

          const complete = reading.length <= SCANNED;
          reading = reading.slice(0, SCANNED);

          const base = workspaceUrl(this.settings);
          const matches = [];
          let read = 0;
          let whole = complete;
          const refusals = [];

          for (const where of reading) {
            let messages;
            try {
              messages = slackApi(this.settings, 'conversations.history', {
                channel: where.id,
                oldest: String(oldest),
                limit: String(PAGE),
              });
            } catch (thrown) {
              /*
               * One channel refusing is not the scan failing - a private
               * channel needs `groups:history` where a public one needs
               * `channels:history`, and a workspace may have granted one and
               * not the other. Every refusal is kept, and they are only
               * thrown if nothing at all could be read.
               */
              refusals.push(`${where.name ?? where.id}: ${thrown.message}`);
              whole = false;
              continue;
            }

            const held = at(messages, 'messages') ?? [];
            read += held.length;
            /* More behind this page than the window asked for. */
            if (at(messages, 'has_more') === true) {
              whole = false;
            }

            for (const one of held) {
              if (NOISE.includes(at(one, 'subtype'))) {
                continue;
              }
              const text = at(one, 'text');
              if (!carries(text, terms)) {
                continue;
              }
              const ts = at(one, 'ts');
              matches.push({
                channel: where.id,
                channelName: where.name,
                ts: ts,
                user: at(one, 'user') ?? at(one, 'username'),
                text: text,
                permalink:
                  base === null || typeof ts !== 'string'
                    ? null
                    : `${base}/archives/${where.id}/p${ts.replace('.', '')}`,
              });
            }
          }

          if (matches.length === 0 && refusals.length === reading.length && refusals.length > 0) {
            throw new Error(`nothing could be read: ${refusals[0]}`);
          }

          /* Newest first, which is the order a person asking about last week means. */
          matches.sort((first, second) => Number(second.ts) - Number(first.ts));
          /*
           * Names for the ones actually coming back, not for everything read.
           * A scan of fifteen channels turns up authors by the dozen and
           * answers twenty of them; looking up the rest would be requests
           * spent on messages nobody is going to see.
           */
          const shown = matches.slice(0, capped);
          return {
            matches: withNames === false ? shown : withAuthors('', this.settings, shown),
            total: matches.length,
            channels: reading.length - refusals.length,
            messages: read,
            since: new Date(oldest * 1000).toISOString(),
            complete: whole && matches.length <= capped,
          };
        },
      }),

      new OrknuxFunction({
        name: 'mention',
        description:
          'Turns a name into the notation Slack renders as a mention: <@U…> for a person, <!subteam^S…> ' +
          'for a user group. Use it to ping somebody in a message you are composing - put the answer in ' +
          'the message text as it is, and never write <@…> from a guessed id. Takes a display name, ' +
          'username, email, id or group handle. Pass the connection the event came in on, or an empty ' +
          'string to use the configured one. An empty string is always safe: a connection named by an older event may since have been deleted.',
        params: [
          { name: 'connection', type: 'string' },
          { name: 'name', type: 'string' },
        ],
        returnType: 'string',
        run: (connection, name) => {
          const resolved = through((use) => orknux.slack.mention(use, name), connection, this.settings.slack);
          if (resolved.error !== undefined) {
            throw new Error(`could not resolve the mention: ${resolved.error}`);
          }
          return resolved.mention;
        },
      }),

      new OrknuxFunction({
        name: 'upload',
        description:
          'Uploads text content to Slack as a file the workspace hosts - an SVG, a CSV, a log, JSON, ' +
          'markdown, source - and shares it to a channel with a message. Anything you can read is ' +
          'text and belongs here, including an SVG a renderer answered with: send it as it stands, ' +
          'never base64. Slack hosts what it is given but draws none of it - every one of these ' +
          'arrives as a file card, an SVG included - so where somebody should see a picture in ' +
          'the message, upload a PNG with uploadFromUrl instead. Pass the channel id (not a #name), a ' +
          'filename whose extension says what the content is (report.csv, diagram.mmd), the content ' +
          'itself, what the sharing message should say, and a threadTs to share inside a thread - ' +
          'This call posts a message - the comment is its text. Your own answer is posted to the same conversation as well, by the run rather than by you, so whatever you say after this call arrives as a SECOND message. Caption the file in the comment - that is your message to them, and it is sent the moment this call returns. Then END THE TURN WITH finish_answer, which stops your answer going out after it as a second message. Its own answer argument is for a later step of the workflow rather than for the reader, so leave it out unless something downstream needs it. Write a real answer instead where finish_answer is not among your tools, or where you have something the comment did not say - what to look at, what you could not do, what you would do next. Never write that you have nothing to add, and never answer with nothing at all: an empty answer is read as a failed turn and does the work again, which is how a channel ends up with the same picture twice. ' +
          'empty for the channel itself. Pass an empty channel to only upload: the answered permalink ' +
          'then goes in a later post\'s attachments. Text only - a PDF or an image cannot travel this ' +
          'way; give remoteFile its url instead. Where a tool answered a key for what it made, ' +
          'PASS THAT as contentKey and leave content empty: the bytes are taken off the server ' +
          'instead of out of what you type back, which is the one thing that stops a long file ' +
          'arriving truncated. Answers the file\'s id and permalink. Needs the botToken ' +
          'parameter.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'filename', type: 'string' },
          { name: 'content', type: 'string' },
          { name: 'comment', type: 'string' },
          { name: 'threadTs', type: 'string' },
          { name: 'contentKey', type: 'string', required: false, default: '' },
        ],
        returnType: 'HostedFile',
        run: (channel, filename, content, comment, threadTs, contentKey) => {
          /*
           * The key is preferred over the content, and that is the point of it.
           *
           * Anything a tool answered with has to be written back out by the
           * model to reach the next call, and a few kilobytes of it does not
           * survive the trip - a rendered diagram went to Slack with a stray
           * character in the middle and the whole call was rejected as
           * malformed JSON. A key is a dozen characters, and what it names
           * never leaves the server.
           *
           * Preferred rather than exclusive: a caller with the text in hand
           * passes content as before, and a workflow node has no session to
           * keep anything in, so content stays the way that always works.
           */
          let said = content;
          if (typeof contentKey === 'string' && contentKey.length > 0) {
            const held = orknux.session.store.get(contentKey);
            if (typeof held !== 'string' || held.length === 0) {
              throw new Error(
                `nothing is kept under ${contentKey} in this session: pass the content itself, ` +
                  'or render it again to get a fresh key',
              );
            }
            said = held;

            /*
             * A key holding base64, which is how the server keeps anything it
             * drew or laid out. Uploaded as it stood, a PDF reached Slack as a
             * file of base64 text - the model had picked this tool for a
             * report.pdf - and an SVG drawn by charts_render, kept as base64
             * since the server stopped answering the markup, would have gone
             * the same way. Markup is decoded and sent as text; anything else
             * is bytes, and goes up as bytes.
             */
            if (said.length >= 64 && /^[A-Za-z0-9+/=\s]+$/.test(said)) {
              const decoded = orknux.encoding.decodeBase64(said);
              if (typeof decoded.text === 'string' && /^\s*</.test(decoded.text)) {
                said = decoded.text;
              } else {
                return uploadedBytes(this.settings, filename, held, channel, comment, threadTs);
              }
            }
          }

          return uploadedText(this.settings, filename, said, channel, comment, threadTs);
        },
      }),

      new OrknuxFunction({
        name: 'uploadBinary',
        description:
          'Uploads bytes to Slack as a file the workspace hosts - a PDF, a PNG, a JPEG - and ' +
          'shares them to a channel with a message. PASS contentKey, NOT base64: pdf_fromHtml and ' +
          'charts_render each answer a short key beside the bytes, and giving ' +
          'that key here takes them off the server instead of out of what you type back. A few ' +
          'kilobytes of base64 does not survive being written into a tool call - it arrives with a ' +
          'character wrong and the whole call is rejected as malformed - so copying the bytes out ' +
          'of one answer and into the next argument is the one thing that reliably fails. Only ' +
          'This call posts a message - the comment is its text. Your own answer is posted to the same conversation as well, by the run rather than by you, so whatever you say after this call arrives as a SECOND message. Caption the file in the comment - that is your message to them, and it is sent the moment this call returns. Then END THE TURN WITH finish_answer, which stops your answer going out after it as a second message. Its own answer argument is for a later step of the workflow rather than for the reader, so leave it out unless something downstream needs it. Write a real answer instead where finish_answer is not among your tools, or where you have something the comment did not say - what to look at, what you could not do, what you would do next. Never write that you have nothing to add, and never answer with nothing at all: an empty answer is read as a failed turn and does the work again, which is how a channel ends up with the same picture twice. ' +
          'Only ' +
          'pass base64 directly when the bytes came from somewhere that answered no key. Either ' +
          'way you must pass a filename whose extension says what the bytes are (report.pdf, ' +
          'chart.png), the channel id, what the sharing message should say, and a threadTs - or an ' +
          'empty channel to only upload. upload takes the same keys, text or bytes, and is the one ' +
          'to reach for. Answers the file\'s id and ' +
          'permalink. Needs the botToken parameter.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'filename', type: 'string' },
          { name: 'base64', type: 'string' },
          { name: 'comment', type: 'string' },
          { name: 'threadTs', type: 'string' },
          { name: 'contentKey', type: 'string', required: false, default: '' },
        ],
        returnType: 'HostedFile',
        run: (channel, filename, base64, comment, threadTs, contentKey) => {
          /*
           * The key wins over the base64, for the reason upload{Q}s does: bytes
           * that reach here by being written out by a model do not survive the
           * trip. A rendered diagram is tens of kilobytes of base64, and one
           * stray character makes the whole call unparseable - which is how
           * this failed before there was a key to pass instead.
           */
          let bytes = base64;
          if (typeof contentKey === 'string' && contentKey.length > 0) {
            const held = orknux.session.store.get(contentKey);
            if (typeof held !== 'string' || held.length === 0) {
              throw new Error(
                `nothing is kept under ${contentKey} in this session: pass the base64 itself, ` +
                  'or render it again to get a fresh key',
              );
            }
            bytes = held;
          }

          return uploadedBytes(this.settings, filename, bytes, channel, comment, threadTs);
        },
      }),

      new OrknuxFunction({
        name: 'uploadFromUrl',
        description:
          'Copies a file from a url onto Slack, so the channel holds the file itself rather than a ' +
          'link: a rendered mermaid diagram\'s image, a PDF a build published. Fetches up to 5 MB; a ' +
          'bigger file wants remoteFile, which points without copying. Pass the channel id, the url, ' +
          'a filename - or empty to name it from the url and its content type - what the sharing ' +
          'message should say, and a threadTs - or an empty channel to only upload. ' +
          'This call posts a message - the comment is its text. Your own answer is posted to the same conversation as well, by the run rather than by you, so whatever you say after this call arrives as a SECOND message. Caption the file in the comment - that is your message to them, and it is sent the moment this call returns. Then END THE TURN WITH finish_answer, which stops your answer going out after it as a second message. Its own answer argument is for a later step of the workflow rather than for the reader, so leave it out unless something downstream needs it. Write a real answer instead where finish_answer is not among your tools, or where you have something the comment did not say - what to look at, what you could not do, what you would do next. Never write that you have nothing to add, and never answer with nothing at all: an empty answer is read as a failed turn and does the work again, which is how a channel ends up with the same picture twice. ' +
          'Answers the ' +
          'file\'s id and permalink. Needs the botToken parameter.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'url', type: 'string' },
          { name: 'filename', type: 'string' },
          { name: 'comment', type: 'string' },
          { name: 'threadTs', type: 'string' },
        ],
        returnType: 'HostedFile',
        run: (channel, url, filename, comment, threadTs) =>
          uploadedFromUrl(this.settings, url, filename, channel, comment, threadTs),
      }),

      new OrknuxFunction({
        name: 'remoteFile',
        description:
          'Attaches a file that already lives at a url - a PDF, a rendered diagram image, anything ' +
          'binary - to Slack as a remote file, and shares it to a channel. ' +
          'This call posts a message - the title and comment are its text. Your own answer is posted to the same conversation as well, by the run rather than by you, so whatever you say after this call arrives as a SECOND message. Caption the file in the comment - that is your message to them, and it is sent the moment this call returns. Then END THE TURN WITH finish_answer, which stops your answer going out after it as a second message. Its own answer argument is for a later step of the workflow rather than for the reader, so leave it out unless something downstream needs it. Write a real answer instead where finish_answer is not among your tools, or where you have something the comment did not say - what to look at, what you could not do, what you would do next. Never write that you have nothing to add, and never answer with nothing at all: an empty answer is read as a failed turn and does the work again, which is how a channel ends up with the same picture twice. ' +
          'Slack keeps a pointer and ' +
          'shows a preview card; the bytes stay where they are, so the url must be reachable by ' +
          'whoever clicks. Pass the file\'s url, a title people will see, the channel id to share ' +
          'into - or empty to only register - and filetype as Slack\'s own kind string (pdf, png, ' +
          'csv), empty to let Slack guess. Answers the file\'s id and permalink. Needs the botToken ' +
          'parameter, with the remote_files scopes.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'url', type: 'string' },
          { name: 'title', type: 'string' },
          { name: 'filetype', type: 'string' },
        ],
        returnType: 'HostedFile',
        run: (channel, url, title, filetype) => {
          if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
            throw new Error('a remote file needs the http(s) url it lives at');
          }

          /*
           * The url is its own external_id: registration is idempotent per id,
           * so registering the same document twice updates rather than
           * duplicates, and sharing needs no id kept anywhere.
           */
          const added = slackApi(this.settings, 'files.remote.add', {
            external_id: url,
            external_url: url,
            title: typeof title === 'string' && title.length > 0 ? title : url,
            filetype: filetype || undefined,
          });

          if (typeof channel === 'string' && channel.length > 0) {
            slackApi(this.settings, 'files.remote.share', { external_id: url, channels: channel });
          }

          const file = at(added, 'file');
          return { id: at(file, 'id'), permalink: at(file, 'permalink') };
        },
      }),

      new OrknuxFunction({
        name: 'listAttachments',
        description:
          'Lists the files attached to one Slack message: id, name, title, filetype, mimetype, size ' +
          'and permalink each - readAttachment takes the id, and post\'s attachments takes the ' +
          'permalink. Pass the channel id and the message\'s own ts (an event carries both). A message ' +
          'with no files answers an empty list. Needs the botToken parameter, with files:read and the ' +
          'conversation\'s history scope.',
        params: [
          { name: 'channel', type: 'string' },
          { name: 'ts', type: 'string' },
        ],
        returnType: 'Attachments',
        run: (channel, ts) => {
          if (typeof ts !== 'string' || ts.length === 0) {
            throw new Error('a message is named by its ts, and none was passed');
          }
          /*
           * One message, asked for by its own timestamp: latest=ts inclusive
           * with a limit of one is Slack's spelling of "exactly this one". A
           * reply is not in the channel's history, so when nothing comes back
           * the same question is asked of its thread.
           */
          let held = at(
            slackApi(this.settings, 'conversations.history', {
              channel: channel,
              latest: ts,
              inclusive: 'true',
              limit: '1',
            }),
            'messages',
          );
          if (!Array.isArray(held) || held.length === 0 || at(held[0], 'ts') !== ts) {
            const found = slackApi(this.settings, 'conversations.replies', {
              channel: channel,
              ts: ts,
              latest: ts,
              inclusive: 'true',
              limit: '1',
            });
            held = at(found, 'messages');
          }
          const message = (Array.isArray(held) ? held : []).find((one) => at(one, 'ts') === ts);
          if (message === undefined) {
            throw new Error(`no message at ${ts} in ${channel}`);
          }
          return {
            files: (at(message, 'files') ?? []).map((one) => ({
              id: at(one, 'id'),
              name: at(one, 'name'),
              title: at(one, 'title'),
              filetype: at(one, 'filetype'),
              mimetype: at(one, 'mimetype'),
              size: at(one, 'size'),
              permalink: at(one, 'permalink'),
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'readAttachment',
        description:
          'Reads one attachment by the file id listAttachments answers. A text file - a CSV, a log, ' +
          'JSON, source - comes back as content; a binary one - a PDF, an image - as base64 bytes, up ' +
          'to 5 MB. Answers the file\'s name, mimetype, size, and exactly one of content or base64, ' +
          'the other null - and a short key what was read is kept under for this session. Hand ' +
          'that key straight on rather than copying the content out: uploadBinary takes it as ' +
          'contentKey, which is the only thing it takes, and upload takes it the same way for ' +
          'text. Needs the botToken parameter, with files:read.',
        params: [{ name: 'file', type: 'string' }],
        returnType: 'AttachmentContent',
        run: (file) => {
          const token = tokenOf(this.settings);
          const described = at(slackApi(this.settings, 'files.info', { file: file }), 'file');
          const mimetype = at(described, 'mimetype');
          const source = at(described, 'url_private');
          const bearing = { authorization: `Bearer ${token}` };

          /*
           * Which door, decided by mimetype: text is read as the string it is,
           * and everything else as bytes wearing base64 — never text read as
           * bytes' worth of mojibake, and never a refusal now that bytes have
           * a shape that travels.
           */
          const named = typeof mimetype === 'string' ? mimetype : '';
          const readable =
            named.startsWith('text/') ||
            /(json|xml|csv|javascript|yaml|x-sh)\b/.test(named);

          if (readable) {
            const got = orknux.http.get(source, bearing);
            if (got.error !== undefined) {
              throw new Error(`could not fetch the file: ${got.error}`);
            }
            if (got.status >= 400) {
              throw new Error(`Slack answered ${got.status} for the file's content`);
            }
            return attachmentRead(described, mimetype, at(described, 'size'), got.body, null);
          }

          const got = orknux.http.download(source, bearing);
          if (got.error !== undefined) {
            throw new Error(`could not fetch the file: ${got.error}`);
          }
          if (got.status >= 400) {
            throw new Error(`Slack answered ${got.status} for the file's content`);
          }
          return attachmentRead(described, mimetype, got.size, null, got.base64);
        },
      }),
    ];
  }
}
