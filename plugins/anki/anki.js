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
      new OrknuxFunctionTool({ function: 'dueCards' }),
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

Tag what came from one conversation or source with one tag, so the person can
find and delete the batch if it is not what they wanted. Tell them how many
cards were added and to which deck.`,
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
        name: 'dueCards',
        description:
          'Says how many cards are due for review, in one deck or across all of them when deck is left out, and ' +
          'what the first of them ask. Leave limit out for the first 20.',
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
            })),
          };
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
