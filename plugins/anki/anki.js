/*
 * Anki, as a plugin, through AnkiConnect.
 *
 * What this exists for is turning something read in a chat, a thread or an
 * issue into flashcards, and asking what is due - from an agent's hand or a
 * workflow's step. Anki has no API of its own and AnkiWeb is closed to third
 * parties, so the way in is AnkiConnect: an add-on that has the Anki desktop
 * application answer JSON over HTTP, by default on `localhost:8765`. Every
 * request here is made by the *server* on the plugin's behalf, under the
 * NETWORK_REQUEST capability a person accepted, against the AnkiConnect each
 * call names.
 *
 * ## Setting one up
 *
 * 1. In Anki, Tools > Add-ons > Get Add-ons, code 2055492159, and restart it.
 * 2. Load this plugin and accept NETWORK_REQUEST.
 * 3. Add a connection of the kind it declares, AnkiConnect, with the add-on's
 *    address as its URL. The connection page carries the rest - see `GUIDE`.
 * 4. Test it: the test asks the address whether it is AnkiConnect, which an
 *    address merely answering cannot pass.
 *
 * ## Why the connection is an argument and not a setting
 *
 * The same reason as prometheus: a workspace may know two Ankis - a person's
 * own and a shared one on a machine in the office - and a plugin setting names
 * one. A connection is where a workspace already keeps hosts, encrypted and
 * checked, and a kind of its own keeps the picker to Ankis.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

/** The protocol version every request asks for; 6 is what AnkiConnect has spoken since 2018. */
const VERSION = 6;

/** How many notes or cards one answer carries at most, so a broad search cannot fill a model's context. */
const MOST = 200;

/**
 * The page shown beside the connection form.
 *
 * Written for the person with the form open, in the order they meet the
 * questions: what to install, what goes in the URL box, what goes in the
 * credential, and what Test will tell them.
 */
const GUIDE = `## Before you start

AnkiConnect is an Anki add-on that lets other programs talk to Anki. Install it
in Anki with **Tools › Add-ons › Get Add-ons…** and the code \`2055492159\`, then
restart Anki. **Anki has to be running** for anything here to work - a closed
Anki answers nothing.

## URL

\`http://localhost:8765\` when Anki runs on the same machine as this server.

When it runs on another machine, AnkiConnect only listens to its own machine
until told otherwise: in Anki open **Tools › Add-ons**, choose AnkiConnect,
**Config**, and set \`"webBindAddress": "0.0.0.0"\`, then restart Anki. Use that
machine's address here - \`http://192.168.1.20:8765\` - and make sure this
installation's proxy rules allow it, because every request goes through them.

## API key

Optional. If you set \`"apiKey"\` in AnkiConnect's config, choose **API key** as
this connection's authentication and paste the same key. AnkiConnect expects
the key inside each request rather than in a header, and the plugin puts it
there. Anyone who can reach the address can drive Anki without one, so set one
whenever Anki listens beyond its own machine.

## Test

Asks the address which AnkiConnect version it is, and lists the decks with the
key. A page or service that is not AnkiConnect fails, as does a wrong key -
merely answering is not enough.`;

/** A nested field, or null rather than a thrown error on the way down. */
function at(holder, name) {
  if (holder === null || typeof holder !== 'object') {
    return null;
  }
  const held = holder[name];
  return held === undefined ? null : held;
}

/**
 * The connection a call named, with its address.
 *
 * Only a connection of this plugin's own kind crosses with `url`; anything
 * else arrives as a bare handle or as the id it was written as, and saying so
 * is kinder than a request to `undefined`.
 */
function anki(connection) {
  if (connection === undefined || connection === null || connection === '') {
    throw new Error('no AnkiConnect connection was given, and every Anki call needs one');
  }
  if (typeof connection !== 'object' || typeof connection.url !== 'string' || connection.url.length === 0) {
    throw new Error(
      "the anki argument names a connection that is not an AnkiConnect connection of this plugin's kind, " +
        'so its address never reached the plugin - pass an AnkiConnect connection',
    );
  }
  return connection;
}

/**
 * The key AnkiConnect wants in the body, or nothing.
 *
 * Taken from the connection's own credential when its authentication is API
 * key - the field a person already expects a key to go in. AnkiConnect reads
 * `key` from the JSON body and ignores headers, so the header the server spells
 * for that auth kind goes along unread and the body is what counts.
 */
function keyOf(connection) {
  return connection.authType === 'API_KEY' && typeof connection.secret === 'string' && connection.secret.length > 0
    ? connection.secret
    : null;
}

/** What came back, in a few words, for a sentence saying it was not AnkiConnect. */
function described(answered) {
  const body = typeof answered.body === 'string' ? answered.body.trim() : '';
  if (/^<(!doctype|html|head|body)/i.test(body)) {
    return `an HTML page (status ${answered.status})`;
  }
  if (answered.json !== undefined && answered.json !== null) {
    const keys = typeof answered.json === 'object' && !Array.isArray(answered.json) ? Object.keys(answered.json) : [];
    return keys.length > 0
      ? `JSON with ${keys.slice(0, 5).join(', ')} (status ${answered.status})`
      : `JSON that is not an object of fields (status ${answered.status})`;
  }
  const glimpse = body.replace(/\s+/g, ' ').slice(0, 80);
  return glimpse.length === 0 ? `an empty answer (status ${answered.status})` : `"${glimpse}" (status ${answered.status})`;
}

/**
 * One AnkiConnect action, answered or thrown.
 *
 * AnkiConnect answers 200 for everything and says what went wrong in its own
 * `error` field, beside a `result` that is then null. Anything without both
 * fields is something else at that address - a login page, another service -
 * and is said as that rather than read as an empty answer.
 */
function ask(connection, action, params) {
  const held = anki(connection);
  const body = { action, version: VERSION };
  if (params !== undefined) {
    body.params = params;
  }
  const key = keyOf(held);
  if (key !== null) {
    body.key = key;
  }
  const answered = orknux.http.post(held.url, body, Object.assign({}, held.headers ?? {}));
  if (answered.error !== undefined) {
    throw new Error(`could not reach AnkiConnect at ${held.url}: ${answered.error} - is Anki running?`);
  }
  const json = answered.json;
  if (json === undefined || json === null || typeof json !== 'object' || !('result' in json) || !('error' in json)) {
    throw new Error(`${held.url} is not AnkiConnect: it answered with ${described(answered)}`);
  }
  if (json.error !== null) {
    const said = String(json.error);
    if (/api key/i.test(said)) {
      throw new Error(
        "AnkiConnect refused the API key - set the connection's authentication to API key with the apiKey from AnkiConnect's config",
      );
    }
    throw new Error(`AnkiConnect refused ${action}: ${said}`);
  }
  return json.result;
}

/** Text out of a card's or a field's HTML, for reading rather than rendering. */
function plain(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** A note as AnkiConnect's notesInfo spells one, read into this plugin's Note. */
function noteOf(info) {
  const fields = at(info, 'fields') ?? {};
  return {
    noteId: at(info, 'noteId'),
    noteType: at(info, 'modelName'),
    tags: Array.isArray(at(info, 'tags')) ? info.tags : [],
    fields: Object.entries(fields)
      .sort(([, a], [, b]) => (at(a, 'order') ?? 0) - (at(b, 'order') ?? 0))
      .map(([name, held]) => ({ name, value: String(at(held, 'value') ?? '') })),
  };
}

/** Anki's search syntax for one deck, quoted so a name with spaces or colons still means one deck. */
function deckQuery(deck) {
  return `deck:"${String(deck).replace(/"/g, '\\"')}"`;
}

/**
 * What a card shows once turned over, without the question above it.
 *
 * Anki renders the back as the front again, a rule, then the answer - the
 * `{{FrontSide}}<hr id=answer>` of every stock note type - so read whole it
 * repeats the question, and a model checking somebody's answer against it
 * reads the question as part of what was expected. Where there is no rule, a
 * note type of the person's own, the whole back is the answer.
 */
function answerOf(html) {
  const parts = String(html ?? '').split(/<hr\s+id\s*=\s*["']?answer["']?\s*\/?>/i);
  return plain(parts[parts.length - 1]);
}

/** Card ids as numbers, said as a sentence when there are none or one is not an id. */
function cardIdsOf(cardIds) {
  if (!Array.isArray(cardIds) || cardIds.length === 0) {
    throw new Error('no cardIds were given - dueCards answers the id of each card it lists');
  }
  if (cardIds.length > MOST) {
    throw new Error(`that is ${cardIds.length} cards, and one call takes at most ${MOST}`);
  }
  return cardIds.map((one) => {
    const id = Number(one);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`${JSON.stringify(one)} is not a card id - dueCards answers the id of each card it lists`);
    }
    return id;
  });
}

/**
 * cardsInfo for these ids, keyed by id, with the ones Anki does not have.
 *
 * AnkiConnect answers an empty object for an id it does not have rather than an
 * error, while `areDue` answers one in words nobody could act on ("list index
 * out of range") - so every call that changes a card asks this first and says
 * which ids were not cards.
 */
function cardsKnown(connection, ids) {
  const infos = ask(connection, 'cardsInfo', { cards: ids });
  const known = new Map();
  (Array.isArray(infos) ? infos : []).forEach((info) => {
    if (typeof at(info, 'cardId') === 'number') {
      known.set(info.cardId, info);
    }
  });
  return { known, missing: ids.filter((id) => !known.has(id)) };
}

/** A card as AnkiConnect's cardsInfo spells one, read into this plugin's Card. */
function cardOf(info) {
  const next = at(info, 'nextReviews');
  return {
    cardId: at(info, 'cardId'),
    noteId: at(info, 'note'),
    deck: at(info, 'deckName'),
    question: plain(at(info, 'question')),
    answer: answerOf(at(info, 'answer')),
    // Queue -1 is Anki's own word for suspended; buried cards are -2 and -3, and come back by themselves.
    suspended: at(info, 'queue') === -1,
    lapses: at(info, 'lapses') ?? 0,
    // Anki wraps each interval in Unicode direction isolates for its own buttons; a model reads them as noise.
    nextReviews: Array.isArray(next) ? next.map((one) => String(one).replace(/[⁦-⁩]/g, '')) : [],
  };
}

/** The four buttons, in the words Anki puts on them. */
const EASES = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

/**
 * The fields of a new note: a map where one was given, otherwise front and back
 * put into the note type's first two fields.
 *
 * By position rather than by the names "Front" and "Back", because those are
 * Basic's names: Cloze calls them Text and Back Extra, and a person's own note
 * type calls them whatever they chose. Asking the note type is one request and
 * makes `front` mean "the side you are asked" whatever it is called.
 */
function fieldsFor(connection, noteType, fields, front, back) {
  if (fields !== null && typeof fields === 'object' && Object.keys(fields).length > 0) {
    return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, String(value ?? '')]));
  }
  if (typeof front !== 'string' || front.trim().length === 0) {
    throw new Error('the note has nothing on its front - pass front, or fields by name');
  }
  const names = ask(connection, 'modelFieldNames', { modelName: noteType });
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`Anki has no note type called ${noteType} - noteTypes lists the ones it has`);
  }
  const made = { [names[0]]: front };
  if (names.length > 1 && typeof back === 'string' && back.length > 0) {
    made[names[1]] = back;
  }
  return made;
}

/** AnkiConnect's refusal of one new note, said for the person who asked for it. */
function refusedNote(deck, said) {
  if (/duplicate/i.test(said)) {
    return `Anki already has a note with this first field in ${deck} - it was not added a second time`;
  }
  if (/empty/i.test(said)) {
    return 'the note\'s first field is empty, and Anki will not add a note without one';
  }
  if (/deck was not found/i.test(said)) {
    return `Anki has no deck called ${deck} - decks lists the ones it has`;
  }
  if (/model was not found/i.test(said)) {
    return `${said} - noteTypes lists the note types Anki has`;
  }
  return said;
}

export default class Anki extends OrknuxPlugin {

  id() {
    return 'anki';
  }

  apiVersion() {
    return 1;
  }

  /*
   * The kind of host this plugin talks to. The check is what the connection
   * page's Test runs: AnkiConnect's own answer to "which version are you",
   * which a login page or another service answering at that address cannot
   * give - and a deck list with the key, so a wrong key fails here rather than
   * on the first card somebody tries to add.
   */
  connectionTypes() {
    return [
      {
        name: 'ankiconnect',
        label: 'AnkiConnect',
        description: 'An Anki desktop application with the AnkiConnect add-on, to add cards to and ask what is due.',
        urlPlaceholder: 'http://localhost:8765',
        // Where AnkiConnect listens unless told otherwise, so the URL box may be left empty.
        defaultUrl: 'http://localhost:8765',
        guide: GUIDE,
        check: (connection) => {
          const version = ask(connection, 'version');
          if (typeof version !== 'number') {
            return { ok: false, message: `${connection.url} is not AnkiConnect: its version is ${JSON.stringify(version)}` };
          }
          if (version < VERSION) {
            return {
              ok: false,
              message: `AnkiConnect ${version} is older than version ${VERSION}, which this plugin speaks - update the add-on`,
            };
          }
          const decks = ask(connection, 'deckNames');
          const count = Array.isArray(decks) ? decks.length : 0;
          return { ok: true, message: `AnkiConnect ${version}, ${count} ${count === 1 ? 'deck' : 'decks'}` };
        },
      },
    ];
  }

  permissions() {
    // None: the key is read off the connection and put into a JSON body.
    return [];
  }

  capabilities() {
    // Every request goes to the connection's url, which is an outside service.
    return ['NETWORK_REQUEST'];
  }

  objects() {
    return [
      new OrknuxObject({
        name: 'Field',
        description: 'One field of a note, by the name its note type gives it.',
        properties: [
          { name: 'name', kind: 'string', description: 'Front, Back, Text - whatever the note type calls it.' },
          { name: 'value', kind: 'string', description: 'As stored, HTML included.' },
        ],
      }),
      new OrknuxObject({
        name: 'Note',
        description: 'A note: the fields a card is made from, its note type and its tags.',
        properties: [
          { name: 'noteId', kind: 'number', description: 'Anki\'s id for it.' },
          { name: 'noteType', kind: 'string', description: 'Basic, Cloze, or a type of the person\'s own.' },
          { name: 'tags', kind: 'array', of: 'string' },
          { name: 'fields', kind: 'array', of: 'Field', description: 'In the note type\'s own order.' },
        ],
      }),
      new OrknuxObject({
        name: 'Notes',
        description: 'The notes a search found.',
        properties: [
          { name: 'notes', kind: 'array', of: 'Note', description: 'Capped by limit.' },
          { name: 'count', kind: 'number', description: 'How many matched before limit capped them.' },
        ],
      }),
      new OrknuxObject({
        name: 'Decks',
        description: 'The decks Anki has.',
        properties: [
          { name: 'decks', kind: 'array', of: 'string', description: 'Alphabetical; a sub-deck is Parent::Child.' },
        ],
      }),
      new OrknuxObject({
        name: 'NoteType',
        description: 'A note type and the fields a note of it has.',
        properties: [
          { name: 'name', kind: 'string' },
          { name: 'fields', kind: 'array', of: 'string', description: 'In order: the first is what a card asks.' },
        ],
      }),
      new OrknuxObject({
        name: 'NoteTypes',
        description: 'The note types Anki has.',
        properties: [{ name: 'noteTypes', kind: 'array', of: 'NoteType' }],
      }),
      new OrknuxObject({
        name: 'Added',
        description: 'A note that was added.',
        properties: [{ name: 'noteId', kind: 'number' }],
      }),
      new OrknuxObject({
        name: 'Skipped',
        description: 'A note that was not added, and why.',
        properties: [
          { name: 'front', kind: 'string' },
          { name: 'reason', kind: 'string', description: 'A duplicate, an empty front, a deck that is not there.' },
        ],
      }),
      new OrknuxObject({
        name: 'AddedNotes',
        description: 'What adding several notes came to.',
        properties: [
          { name: 'added', kind: 'number' },
          { name: 'noteIds', kind: 'array', of: 'number' },
          { name: 'skipped', kind: 'array', of: 'Skipped', description: 'Each one not added, with the reason.' },
        ],
      }),
      new OrknuxObject({
        name: 'DueCard',
        description: 'A card that is due.',
        properties: [
          { name: 'cardId', kind: 'number' },
          { name: 'noteId', kind: 'number' },
          { name: 'deck', kind: 'string' },
          { name: 'question', kind: 'string', description: 'What the card asks, as text.' },
          {
            name: 'answer',
            kind: 'string',
            description: 'What the back says, as text, without the question repeated. Not to be read out before the person answers.',
          },
        ],
      }),
      new OrknuxObject({
        name: 'DueCards',
        description: 'The cards due for review.',
        properties: [
          { name: 'count', kind: 'number', description: 'How many are due, before limit capped the list.' },
          { name: 'cards', kind: 'array', of: 'DueCard', description: 'Capped by limit.' },
        ],
      }),
      new OrknuxObject({
        name: 'Card',
        description: 'A card: both sides, where it lives, and what each answer would do to it.',
        properties: [
          { name: 'cardId', kind: 'number' },
          { name: 'noteId', kind: 'number', description: 'The note it is made from - updateNote changes it.' },
          { name: 'deck', kind: 'string' },
          { name: 'question', kind: 'string', description: 'What the card asks, as text.' },
          { name: 'answer', kind: 'string', description: 'What the back says, as text, without the question repeated.' },
          { name: 'suspended', kind: 'boolean', description: 'A suspended card is never due until it is unsuspended.' },
          { name: 'lapses', kind: 'number', description: 'How many times it was forgotten after being learnt.' },
          {
            name: 'nextReviews',
            kind: 'array',
            of: 'string',
            description: 'When each answer would show it next - Again, Hard, Good, Easy in that order: 10m, 2d, 1.7y.',
          },
        ],
      }),
      new OrknuxObject({
        name: 'Cards',
        description: 'The cards asked for.',
        properties: [
          { name: 'cards', kind: 'array', of: 'Card', description: 'In the order they were asked for.' },
          { name: 'missing', kind: 'array', of: 'number', description: 'Ids Anki has no card for.' },
        ],
      }),
      new OrknuxObject({
        name: 'SkippedCard',
        description: 'A card that was not answered, and why.',
        properties: [
          { name: 'cardId', kind: 'number' },
          { name: 'reason', kind: 'string', description: 'Not due, suspended, not a card, an ease that is not 1 to 4.' },
        ],
      }),
      new OrknuxObject({
        name: 'AnsweredCards',
        description: 'What answering cards came to.',
        properties: [
          { name: 'answered', kind: 'number' },
          { name: 'cardIds', kind: 'array', of: 'number', description: 'The cards answered, now scheduled again.' },
          { name: 'skipped', kind: 'array', of: 'SkippedCard', description: 'Each one not answered, with the reason.' },
        ],
      }),
      new OrknuxObject({
        name: 'SuspendedCards',
        description: 'The cards a suspend or an unsuspend acted on.',
        properties: [
          { name: 'cardIds', kind: 'array', of: 'number', description: 'The cards acted on.' },
          { name: 'missing', kind: 'array', of: 'number', description: 'Ids Anki has no card for, left alone.' },
        ],
      }),
    ];
  }

  /* The agents' surface: every call, fronted. Proxies, so everything stays the functions' own. */
  tools() {
    return [
      new OrknuxFunctionTool({ function: 'decks' }),
      new OrknuxFunctionTool({ function: 'noteTypes' }),
      new OrknuxFunctionTool({ function: 'findNotes' }),
      new OrknuxFunctionTool({ function: 'addNote' }),
      new OrknuxFunctionTool({ function: 'addBasicNotes' }),
      new OrknuxFunctionTool({ function: 'updateNote' }),
      new OrknuxFunctionTool({ function: 'dueCards' }),
      new OrknuxFunctionTool({ function: 'cards' }),
      new OrknuxFunctionTool({ function: 'answerCards' }),
      new OrknuxFunctionTool({ function: 'suspendCards' }),
      new OrknuxFunctionTool({ function: 'unsuspendCards' }),
      new OrknuxFunctionTool({ function: 'sync' }),
    ];
  }

  skills() {
    return [
      new OrknuxSkill({
        id: 'anki-cards',
        name: 'Writing Anki cards worth reviewing',
        description:
          'How to turn something read into flashcards a person will remember, and what to check before adding them.',
        content: `# Writing Anki cards worth reviewing

A card is reviewed dozens of times over years. A bad one costs the person a
little every time, so fewer good cards beat many vague ones.

## Before adding anything

Ask \`anki_decks\` which decks there are and put the cards where the person
already keeps that subject. Do not invent a deck when one fits; when none
does, say which deck you are about to create by naming it - Anki creates a
deck the first time a note names it.

## One fact per card

A card asks one thing and has one short answer. "What are the three causes of
X?" is three cards. If the answer needs a paragraph, the question is too big.

Bad: front "Photosynthesis", back a summary.
Good: front "Which gas do plants take in for photosynthesis?", back "Carbon
dioxide".

## Basic or cloze

- **Basic** - a question and its answer. Use it for definitions, translations,
  "what is", "why".
- **Cloze** - a sentence with the remembered part hidden, written
  \`{{c1::hidden part}}\` on the front of a \`Cloze\` note. Use it for facts
  that only make sense in context, and for lists, one \`c\` number per item so
  each becomes its own card.

## Make the question unambiguous

Give enough context that only one answer fits: "In Python, which keyword..."
rather than "Which keyword...". Put a source or a short example on the back
when it helps the answer stick.

## Adding them

Several basic cards at once:

\`anki_addBasicNotes\` with
\`{"anki": 3, "deck": "Biology", "notes": [{"front": "Which gas do plants take in for photosynthesis?", "back": "Carbon dioxide"}], "tags": ["photosynthesis"]}\`

One cloze card:

\`anki_addNote\` with
\`{"anki": 3, "deck": "Biology", "noteType": "Cloze", "front": "Plants take in {{c1::carbon dioxide}} for photosynthesis."}\`

A note that is a duplicate comes back refused, not added twice - report it to
the person rather than rewording it to slip past the check.

## Changing a card already made

To add to a card - a translation, an example, a correction - change it rather
than adding a second one: find it with \`anki_findNotes\` and pass its
\`noteId\` to \`anki_updateNote\` with only what changes. A field left out
keeps what it has, so to add a line to the back, pass the whole new back.

\`anki_updateNote\` with
\`{"anki": 3, "noteId": 1700000000000, "back": "made better; improved<br>PL: poprawiony, ulepszony"}\`

Tag what came from one conversation or source with one tag, so the person can
find and delete the batch if it is not what they wanted. Tell them how many
cards were added and to which deck.`,
      }),
      new OrknuxSkill({
        id: 'anki-review',
        name: 'Taking a person through their due Anki cards',
        description:
          'How to run a review with somebody - asking each card, judging the answer, and recording it in Anki so it is scheduled.',
        content: `# Taking a person through their due Anki cards

A review only counts once Anki has been told how each card went. Asking the
questions and grading them in the conversation changes nothing: the cards stay
due and come back tomorrow exactly as they were.

## Start with what is due

\`anki_dueCards\` with \`{"anki": 3, "deck": "Spanish"}\` lists the due cards,
each with its \`cardId\`, its question and its answer. Leave the deck out to
review everything due.

## One card at a time

1. Ask the question - the question only. The answer is there so you can judge
   what the person says; reading it out first spoils the card.
2. Let them answer, then compare it with the back. Be fair about wording: the
   meaning is what counts, not the exact phrase.
3. Tell them the answer, and how you graded it.

## Grading

- **1 Again** - wrong, or they could not remember.
- **2 Hard** - right, but only after a real struggle or with a hint.
- **3 Good** - right after some thought. Most correct answers are this.
- **4 Easy** - right at once, without effort.

When they grade themselves, use their grade.

## Recording it

Record the answers as you go, or a few at a time - not only at the end, where a
conversation that stops early loses the whole session:

\`anki_answerCards\` with
\`{"anki": 3, "answers": [{"cardId": 1700000000001, "ease": 3}, {"cardId": 1700000000002, "ease": 1}]}\`

Each card is answered once. A card that comes back skipped says why - not due,
suspended, not a card - and is not to be retried with another id. A card
answered Again is usually due again within minutes, so \`anki_dueCards\` lists
it once more before the session is over.

## A card that is wrong or unwanted

If the card itself is wrong, correct it with \`anki_updateNote\` using its
\`noteId\`. If the person wants to stop seeing it, \`anki_suspendCards\` with its
\`cardId\` - it keeps its history and comes back with \`anki_unsuspendCards\`.

At the end, say how many cards were reviewed and how many were forgotten.`,
      }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'decks',
        description: 'Lists the decks Anki has, alphabetically. A sub-deck is written Parent::Child.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to ask: an AnkiConnect connection, which carries its address and key.',
          },
        ],
        returnType: 'Decks',
        run: (connection) => {
          const names = ask(connection, 'deckNames');
          return { decks: (Array.isArray(names) ? names : []).slice().sort((a, b) => a.localeCompare(b)) };
        },
      }),

      new OrknuxFunction({
        name: 'noteTypes',
        description:
          'Lists the note types Anki has - Basic, Cloze and any of the person\'s own - with each one\'s fields in ' +
          'order. The first field is what a card asks.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to ask: an AnkiConnect connection, which carries its address and key.',
          },
        ],
        returnType: 'NoteTypes',
        run: (connection) => {
          const names = ask(connection, 'modelNames');
          const sorted = (Array.isArray(names) ? names : []).slice().sort((a, b) => a.localeCompare(b));
          /*
           * One request for every type's fields rather than one each: `multi`
           * answers a list in the same order, and a person with forty note
           * types should not cost forty round trips.
           */
          const answers = sorted.length === 0
            ? []
            : ask(connection, 'multi', {
              actions: sorted.map((modelName) => ({ action: 'modelFieldNames', version: VERSION, params: { modelName } })),
            });
          return {
            noteTypes: sorted.map((name, index) => {
              const answer = Array.isArray(answers) ? answers[index] : null;
              const fields = Array.isArray(answer) ? answer : Array.isArray(at(answer, 'result')) ? answer.result : [];
              return { name, fields };
            }),
          };
        },
      }),

      new OrknuxFunction({
        name: 'findNotes',
        description:
          'Finds notes with Anki\'s own search syntax, as typed in its browser: deck:"Spanish" tag:verbs, ' +
          '"front:*hola*", added:7 for the last week, is:due. Answers each note\'s type, tags and fields; leave ' +
          'limit out for the first 50.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to ask: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 50 },
        ],
        returnType: 'Notes',
        run: (connection, query, limit) => {
          if (typeof query !== 'string' || query.trim().length === 0) {
            throw new Error('there is no search to run - an empty search would answer every note Anki has');
          }
          const ids = ask(connection, 'findNotes', { query });
          const found = Array.isArray(ids) ? ids : [];
          const capped = found.slice(0, Math.max(1, Math.min(limit, MOST)));
          const infos = capped.length === 0 ? [] : ask(connection, 'notesInfo', { notes: capped });
          return { notes: (Array.isArray(infos) ? infos : []).map(noteOf), count: found.length };
        },
      }),

      new OrknuxFunction({
        name: 'addNote',
        description:
          'Adds one note to a deck. For a Basic note pass front and back; for a Cloze note pass noteType Cloze and ' +
          'the sentence as front, with the hidden part written {{c1::like this}}. For a note type of the person\'s ' +
          'own pass fields by name instead. A deck named for the first time is created. A note whose first field ' +
          'Anki already has in that deck is refused rather than added twice.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to add to: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'deck', type: 'string' },
          { name: 'front', type: 'string', required: false, default: '' },
          { name: 'back', type: 'string', required: false, default: '' },
          { name: 'noteType', type: 'string', required: false, default: 'Basic' },
          { name: 'tags', type: 'array', required: false, default: [] },
          { name: 'fields', type: 'map', required: false, default: {} },
        ],
        returnType: 'Added',
        run: (connection, deck, front, back, noteType, tags, fields) => {
          if (typeof deck !== 'string' || deck.trim().length === 0) {
            throw new Error('no deck was named - decks lists the ones Anki has');
          }
          const type = typeof noteType === 'string' && noteType.trim().length > 0 ? noteType.trim() : 'Basic';
          const note = {
            deckName: deck,
            modelName: type,
            fields: fieldsFor(connection, type, fields, front, back),
            tags: Array.isArray(tags) ? tags.map(String) : [],
            options: { allowDuplicate: false, duplicateScope: 'deck' },
          };
          /*
           * A deck that does not exist yet is created first: addNote refuses
           * one, and "add these to a new deck called X" is an ordinary thing
           * to ask. createDeck on one that exists changes nothing.
           */
          ask(connection, 'createDeck', { deck });
          let id;
          try {
            id = ask(connection, 'addNote', { note });
          } catch (refused) {
            const said = String(refused.message).replace(/^AnkiConnect refused addNote: /, '');
            throw new Error(refusedNote(deck, said));
          }
          return { noteId: id };
        },
      }),

      new OrknuxFunction({
        name: 'addBasicNotes',
        description:
          'Adds several Basic notes to one deck at once: notes is a list of {front, back}. Each is added or ' +
          'skipped on its own - a duplicate or an empty front skips that note and not the rest - and the answer ' +
          'says how many were added and why each skipped one was.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to add to: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'deck', type: 'string' },
          { name: 'notes', type: 'array' },
          { name: 'tags', type: 'array', required: false, default: [] },
        ],
        returnType: 'AddedNotes',
        run: (connection, deck, notes, tags) => {
          if (typeof deck !== 'string' || deck.trim().length === 0) {
            throw new Error('no deck was named - decks lists the ones Anki has');
          }
          if (!Array.isArray(notes) || notes.length === 0) {
            throw new Error('there are no notes to add - notes is a list of {front, back}');
          }
          if (notes.length > MOST) {
            throw new Error(`that is ${notes.length} notes, and one call adds at most ${MOST}`);
          }
          const tagged = Array.isArray(tags) ? tags.map(String) : [];
          const sides = notes.map((one) => ({ front: String(at(one, 'front') ?? ''), back: String(at(one, 'back') ?? '') }));
          ask(connection, 'createDeck', { deck });
          /*
           * `multi` rather than `addNotes`: addNotes answers a bare null for a
           * note it refused on older add-ons and throws for the whole batch on
           * newer ones, while multi answers each note's own result and error -
           * which is what "skipped, and why" needs.
           */
          const answers = ask(connection, 'multi', {
            actions: sides.map((side) => ({
              action: 'addNote',
              // Each action's own version, so each answers its own result and error rather than throwing for all.
              version: VERSION,
              params: {
                note: {
                  deckName: deck,
                  modelName: 'Basic',
                  fields: { Front: side.front, Back: side.back },
                  tags: tagged,
                  options: { allowDuplicate: false, duplicateScope: 'deck' },
                },
              },
            })),
          });
          const noteIds = [];
          const skipped = [];
          sides.forEach((side, index) => {
            const answer = Array.isArray(answers) ? answers[index] : null;
            const error = at(answer, 'error');
            const result = at(answer, 'result') ?? (typeof answer === 'number' ? answer : null);
            if (error === null && typeof result === 'number') {
              noteIds.push(result);
            } else {
              skipped.push({ front: side.front, reason: refusedNote(deck, String(error ?? 'Anki did not add it')) });
            }
          });
          return { added: noteIds.length, noteIds, skipped };
        },
      }),

      new OrknuxFunction({
        name: 'updateNote',
        description:
          'Changes a note Anki already has, by its noteId - findNotes answers it. Pass only what changes: front ' +
          'and back are the note type\'s first and second fields, fields sets others by name, and a field left ' +
          'out keeps what it has. tags are added to the note\'s own. Answers the note as it is afterwards.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to change: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'noteId', type: 'number' },
          { name: 'front', type: 'string', required: false, default: '' },
          { name: 'back', type: 'string', required: false, default: '' },
          { name: 'fields', type: 'map', required: false, default: {} },
          { name: 'tags', type: 'array', required: false, default: [] },
        ],
        returnType: 'Note',
        run: (connection, noteId, front, back, fields, tags) => {
          if (typeof noteId !== 'number' || !Number.isFinite(noteId)) {
            throw new Error('no noteId was given - findNotes answers the id of each note it finds');
          }
          const before = ask(connection, 'notesInfo', { notes: [noteId] });
          const held = Array.isArray(before) ? before[0] : null;
          // notesInfo answers an empty object, not an error, for an id it does not have.
          if (typeof at(held, 'noteId') !== 'number') {
            throw new Error(`Anki has no note ${noteId} - findNotes answers the ids of the notes it has`);
          }
          const order = noteOf(held).fields.map((field) => field.name);
          /* Only what was given: an empty front or back means "leave it", not "clear it". */
          const changed = {};
          if (typeof front === 'string' && front.length > 0 && order[0] !== undefined) changed[order[0]] = front;
          if (typeof back === 'string' && back.length > 0 && order[1] !== undefined) changed[order[1]] = back;
          if (fields !== null && typeof fields === 'object') {
            for (const [name, value] of Object.entries(fields)) {
              if (!order.includes(name)) {
                throw new Error(`a ${at(held, 'modelName')} note has no field called ${name} - it has ${order.join(', ')}`);
              }
              changed[name] = String(value ?? '');
            }
          }
          const tagged = Array.isArray(tags) ? tags.map(String).filter((tag) => tag.trim().length > 0) : [];
          if (Object.keys(changed).length === 0 && tagged.length === 0) {
            throw new Error('there is nothing to change - pass front, back, fields or tags');
          }
          if (Object.keys(changed).length > 0) {
            ask(connection, 'updateNoteFields', { note: { id: noteId, fields: changed } });
          }
          if (tagged.length > 0) {
            ask(connection, 'addTags', { notes: [noteId], tags: tagged.join(' ') });
          }
          const after = ask(connection, 'notesInfo', { notes: [noteId] });
          return noteOf(Array.isArray(after) ? after[0] : held);
        },
      }),

      new OrknuxFunction({
        name: 'dueCards',
        description:
          'Says how many cards are due for review, in one deck or across all of them when deck is left out, and ' +
          'the first of them, each with the cardId answerCards takes and both sides - the answer is for checking ' +
          'what the person says, not for reading out first. Leave limit out for the first 20.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to ask: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'deck', type: 'string', required: false, default: '' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'DueCards',
        run: (connection, deck, limit) => {
          const narrowed = typeof deck === 'string' && deck.trim().length > 0 ? ` ${deckQuery(deck.trim())}` : '';
          const ids = ask(connection, 'findCards', { query: `is:due${narrowed}` });
          const due = Array.isArray(ids) ? ids : [];
          const capped = due.slice(0, Math.max(0, Math.min(limit, MOST)));
          const infos = capped.length === 0 ? [] : ask(connection, 'cardsInfo', { cards: capped });
          return {
            count: due.length,
            cards: (Array.isArray(infos) ? infos : []).map((card) => ({
              cardId: at(card, 'cardId'),
              noteId: at(card, 'note'),
              deck: at(card, 'deckName'),
              question: plain(at(card, 'question')),
              answer: answerOf(at(card, 'answer')),
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'cards',
        description:
          'Reads cards by their cardId - dueCards answers it: both sides as text, the deck, whether it is ' +
          'suspended, and when each of the four answers would show it next. For checking what somebody said ' +
          'against the back before answering the card.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to ask: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'cardIds', type: 'array', description: 'Card ids, as numbers: [1700000000001, 1700000000002].' },
        ],
        returnType: 'Cards',
        run: (connection, cardIds) => {
          const ids = cardIdsOf(cardIds);
          const { known, missing } = cardsKnown(connection, ids);
          return { cards: ids.filter((id) => known.has(id)).map((id) => cardOf(known.get(id))), missing };
        },
      }),

      new OrknuxFunction({
        name: 'answerCards',
        description:
          'Answers cards in a review, as pressing a button under a card in Anki does, and schedules each one ' +
          'again from that answer. answers is a list of {cardId, ease}; ease is 1 Again - forgotten or wrong, ' +
          '2 Hard - recalled with real difficulty, 3 Good - recalled after some thought, 4 Easy - recalled at ' +
          'once. Only a card that is due is answered: one not due, suspended or not a card is skipped with the ' +
          'reason, and the rest are answered. An answer cannot be undone from here.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to answer in: an AnkiConnect connection, which carries its address and key.',
          },
          {
            name: 'answers',
            type: 'array',
            description: 'One {cardId, ease} per card, ease 1 to 4: [{"cardId": 1700000000001, "ease": 3}].',
          },
        ],
        returnType: 'AnsweredCards',
        run: (connection, answers) => {
          if (!Array.isArray(answers) || answers.length === 0) {
            throw new Error('there are no answers - answers is a list of {cardId, ease}, ease 1 Again to 4 Easy');
          }
          if (answers.length > MOST) {
            throw new Error(`that is ${answers.length} answers, and one call takes at most ${MOST}`);
          }
          const skipped = [];
          const wanted = [];
          const seen = new Set();
          for (const one of answers) {
            const cardId = Number(at(one, 'cardId'));
            const ease = Number(at(one, 'ease'));
            if (!Number.isInteger(cardId) || cardId <= 0) {
              skipped.push({ cardId: at(one, 'cardId'), reason: 'not a card id - dueCards answers the id of each card' });
            } else if (!Number.isInteger(ease) || !(ease in EASES)) {
              skipped.push({ cardId, reason: `ease ${JSON.stringify(at(one, 'ease'))} is not 1 Again, 2 Hard, 3 Good or 4 Easy` });
            } else if (seen.has(cardId)) {
              /* Twice in one call would be two reviews of one card, and the second is never what was meant. */
              skipped.push({ cardId, reason: 'answered earlier in the same call' });
            } else {
              seen.add(cardId);
              wanted.push({ cardId, ease });
            }
          }
          const known = wanted.length === 0 ? new Map() : cardsKnown(connection, wanted.map((one) => one.cardId)).known;
          const present = [];
          for (const one of wanted) {
            const info = known.get(one.cardId);
            if (info === undefined) {
              skipped.push({ cardId: one.cardId, reason: 'Anki has no such card' });
            } else if (at(info, 'queue') === -1) {
              skipped.push({ cardId: one.cardId, reason: 'suspended - unsuspendCards brings it back' });
            } else {
              present.push(one);
            }
          }
          /*
           * Only what is due. AnkiConnect answers any card it is handed, and a
           * card answered early is pushed out by an interval it did not earn -
           * so an id remembered from yesterday, or one misread off a list,
           * would quietly reschedule a card the person was never shown.
           */
          const due = present.length === 0 ? [] : ask(connection, 'areDue', { cards: present.map((one) => one.cardId) });
          const answering = present.filter((one, index) => {
            if (Array.isArray(due) && due[index] === true) {
              return true;
            }
            skipped.push({ cardId: one.cardId, reason: 'not due yet - dueCards lists the cards that are' });
            return false;
          });
          const done = answering.length === 0 ? [] : ask(connection, 'answerCards', { answers: answering });
          const cardIds = [];
          answering.forEach((one, index) => {
            if (Array.isArray(done) && done[index] === true) {
              cardIds.push(one.cardId);
            } else {
              skipped.push({ cardId: one.cardId, reason: 'Anki did not answer it' });
            }
          });
          return { answered: cardIds.length, cardIds, skipped };
        },
      }),

      new OrknuxFunction({
        name: 'suspendCards',
        description:
          'Suspends cards by their cardId, as Anki\'s Suspend does: a suspended card keeps its history and is ' +
          'never due until it is unsuspended. For a card the person no longer wants to study, or one that is ' +
          'wrong and should wait until it is fixed.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to change: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'cardIds', type: 'array', description: 'Card ids, as numbers: [1700000000001].' },
        ],
        returnType: 'SuspendedCards',
        run: (connection, cardIds) => {
          const ids = cardIdsOf(cardIds);
          const { known, missing } = cardsKnown(connection, ids);
          const acted = ids.filter((id) => known.has(id));
          if (acted.length > 0) {
            ask(connection, 'suspend', { cards: acted });
          }
          return { cardIds: acted, missing };
        },
      }),

      new OrknuxFunction({
        name: 'unsuspendCards',
        description:
          'Unsuspends cards by their cardId - the ids suspendCards answered - so they are scheduled again from ' +
          'where they were left.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to change: an AnkiConnect connection, which carries its address and key.',
          },
          { name: 'cardIds', type: 'array', description: 'Card ids, as numbers: [1700000000001].' },
        ],
        returnType: 'SuspendedCards',
        run: (connection, cardIds) => {
          const ids = cardIdsOf(cardIds);
          const { known, missing } = cardsKnown(connection, ids);
          const acted = ids.filter((id) => known.has(id));
          if (acted.length > 0) {
            ask(connection, 'unsuspend', { cards: acted });
          }
          return { cardIds: acted, missing };
        },
      }),

      new OrknuxFunction({
        name: 'sync',
        description:
          'Syncs Anki with AnkiWeb, as its Sync button does, so cards just added reach the person\'s phone. Needs ' +
          'Anki to be signed in to AnkiWeb.',
        params: [
          {
            name: 'anki',
            type: 'connection',
            description: 'Which Anki to sync: an AnkiConnect connection, which carries its address and key.',
          },
        ],
        returnType: 'boolean',
        run: (connection) => {
          ask(connection, 'sync');
          return true;
        },
      }),
    ];
  }
}
