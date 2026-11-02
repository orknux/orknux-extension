/*
 * MuseScore 4, as a plugin, through the Orknux bridge.
 *
 * What this exists for is an agent reading the score somebody has open in
 * MuseScore and writing into it - a melody, a bass line, the lyrics, a tempo -
 * while they watch it appear and can take any of it back with Undo. MuseScore
 * has no API reachable from outside; what it gives its own QML plugins is a
 * WebSocket server. So half of this lives in MuseScore: `bridge/orknux-bridge.qml`
 * beside this file, a MuseScore plugin that listens on a port and answers JSON
 * commands about the open score. This half is what an Orknux server loads, and
 * it talks to the bridge through `orknux.http.websocket` - every message of a
 * call sent over one socket, one reply to each, under the NETWORK_REQUEST
 * capability a person accepted.
 *
 * ## The protocol, which is ours
 *
 * One JSON object per message, `{command, args, key?}`, and one reply to each,
 * `{bridge: "orknux", ok: true, result}` or `{bridge: "orknux", ok: false,
 * error}`. The `bridge` field is how anything else listening on the port is
 * told apart. Measures and staves count from 1 in the order the score holds
 * them, voices 1 to 4, and notes cross as text: `C4/4 [C4 E4 G4]/2 r/8 F#5/8.`.
 *
 * ## Why the connection is an argument and not a setting
 *
 * The same reason as anki: a workspace may know two MuseScores - a person's own
 * and one on a machine in the studio - and a connection is where a workspace
 * already keeps hosts and their keys.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

/** The bridge protocol this plugin speaks; `hello` answers the bridge's. */
const PROTOCOL = 1;

/** Where the bridge's source is, for a person installing it and for an agent asked how. */
const BRIDGE_URL =
  'https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/musescore/bridge/orknux-bridge.qml';

/** How long one reply may take: a write into a long score is laid out before MuseScore answers. */
const WAIT_MS = 20000;

/** How many passages, or undo steps, one call carries - the door takes fifty messages. */
const MOST = 20;

/**
 * The page shown beside the connection form.
 *
 * Written for the person with the form open, in the order they meet the
 * questions: what to put in MuseScore, what to do each session, what goes in
 * the URL box, the key, and what Test will tell them.
 */
const GUIDE = `## Before you start

MuseScore has no way in from outside except through a plugin of its own, so
this needs the **Orknux bridge** installed in MuseScore 4 once:

1. Download [orknux-bridge.qml](${BRIDGE_URL}) and put it in MuseScore's plugins
   folder: \`Documents/MuseScore4/Plugins\` in your home folder (Windows, macOS and
   Linux alike).
2. In MuseScore open **Home › Plugins** (older versions: **Plugins › Manage
   plugins…**), choose **Orknux bridge** and **Enable** it.

**Every time MuseScore starts**, run it from **Plugins › Orknux bridge**. It
shows nothing; it listens until MuseScore closes. Only the score open in the
front tab is read and written.

## URL

\`http://localhost:8084\` when MuseScore runs on the same machine as this server.
The bridge listens on port 8084 unless \`port\` at the top of the file is
changed; the URL ends in the same number.

On another machine use its address - \`http://192.168.1.20:8084\` - and make sure
this installation's proxy rules allow it, because every call goes through them.

## API key

**MuseScore listens on every network interface and asks nobody who they are**,
so anyone who can reach that machine on the port can edit the open score. Set a
key whenever the machine is reachable from others: open the file in a text
editor, put a secret of your own in \`property string key: ""\`, save, and run the
plugin again. Then choose **API key** as this connection's authentication and
paste the same secret. Without a key set in the file, leave authentication off.

## Test

Asks the address whether it is the Orknux bridge and what score is open. Another
service on the port, MuseScore without the bridge running, or a wrong key all
fail here.`;

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
 * Only a connection of this plugin's own kind crosses with `url`; anything else
 * arrives as a bare handle or as the id it was written as.
 */
function bridgeOf(connection) {
  if (connection === undefined || connection === null || connection === '') {
    throw new Error('no MuseScore connection was given, and every MuseScore call needs one');
  }
  if (typeof connection !== 'object' || typeof connection.url !== 'string' || connection.url.length === 0) {
    throw new Error(
      "the musescore argument names a connection that is not a MuseScore connection of this plugin's kind, " +
        'so its address never reached the plugin - pass a MuseScore connection',
    );
  }
  return connection;
}

/** The key the bridge wants in each message, or nothing - taken from the connection's API key. */
function keyOf(connection) {
  return connection.authType === 'API_KEY' && typeof connection.secret === 'string' && connection.secret.length > 0
    ? connection.secret
    : null;
}

/** A reply that is not the bridge's, in a few words. */
function described(reply) {
  const glimpse = String(reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return glimpse.length === 0 ? 'an empty message' : `"${glimpse}"`;
}

/**
 * Sends several commands over one socket and answers each reply, read.
 *
 * Each answer is `{ ok: true, result }` or `{ ok: false, error }`: a command
 * the bridge refused is the caller's to word, because one refused passage out
 * of five is not a failed call. What is thrown is everything that means there
 * was no bridge to ask - nothing listening, something else listening, a key
 * the bridge would not take.
 */
function exchange(connection, commands) {
  const held = bridgeOf(connection);
  const key = keyOf(held);
  const messages = commands.map((one) => (key === null ? one : Object.assign({}, one, { key })));
  const answered = orknux.http.websocket(held.url, messages, { timeoutMs: WAIT_MS });
  const replies = Array.isArray(answered.replies) ? answered.replies : [];
  const parsed = Array.isArray(answered.json) ? answered.json : [];
  const read = [];
  for (let index = 0; index < replies.length; index += 1) {
    const json = parsed[index];
    if (at(json, 'bridge') !== 'orknux') {
      throw new Error(
        `${held.url} is not the Orknux bridge: it answered ${described(replies[index])} - ` +
          'is something else listening on that port?',
      );
    }
    if (json.keyRequired === true) {
      throw new Error(
        key === null
          ? "the Orknux bridge has a key set - choose API key as this connection's authentication and paste the key from the bridge file"
          : "the Orknux bridge refused this connection's API key - it has to be the key set at the top of the bridge file",
      );
    }
    read.push(json.ok === true ? { ok: true, result: json.result } : { ok: false, error: String(json.error ?? 'refused') });
  }
  if (answered.error !== undefined && answered.error !== null) {
    throw new Error(
      `could not reach the Orknux bridge at ${held.url}: ${answered.error} - is MuseScore running, ` +
        'with Plugins › Orknux bridge started since it opened?',
    );
  }
  if (read.length !== commands.length) {
    throw new Error(`the Orknux bridge at ${held.url} answered ${read.length} of ${commands.length} commands`);
  }
  return read;
}

/** One command, answered or thrown in MuseScore's words. */
function ask(connection, command, args) {
  const [answer] = exchange(connection, [{ command, args: args ?? {} }]);
  if (!answer.ok) {
    throw new Error(`MuseScore refused ${command}: ${answer.error}`);
  }
  return answer.result;
}

/** A whole number at least 1, or a sentence saying what it should have been. */
function counted(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} has to be a whole number from 1, and was ${JSON.stringify(value)}`);
  }
  return value;
}

/** A passage as the bridge's write command takes it. */
function passageOf(one, index) {
  const where = index === undefined ? '' : `passage ${index + 1}: `;
  const notation = at(one, 'notation');
  if (typeof notation !== 'string' || notation.trim().length === 0) {
    throw new Error(`${where}there is no notation to write - write tokens like C4/4 [C4 E4 G4]/2 r/8 F#5/8.`);
  }
  const args = {
    staff: counted(at(one, 'staff') ?? 1, `${where}staff`),
    measure: counted(at(one, 'measure'), `${where}measure`),
    voice: counted(at(one, 'voice') ?? 1, `${where}voice`),
    notation,
  };
  const beat = at(one, 'beat');
  if (beat !== null && beat !== 1) {
    args.beat = beat;
  }
  return { command: 'write', args };
}

const CONNECTION = {
  name: 'musescore',
  type: 'connection',
  description: 'Which MuseScore to use: a MuseScore connection, which carries the bridge\'s address and key.',
};

/** Notation, said once and used by every description that takes or answers it. */
const NOTATION =
  'Notation is text, one token per note, chord or rest: a pitch, a slash and a duration - C4/4 is a quarter ' +
  'middle C, F#5/8. a dotted eighth, Bb3/2.. a double-dotted half, [C4 E4 G4]/2 a half-note chord, r/8 an ' +
  'eighth rest. Durations are /1 /2 /4 /8 /16 /32 /64. Pitches are concert pitch.';

export default class MuseScore extends OrknuxPlugin {

  id() {
    return 'musescore';
  }

  apiVersion() {
    return 1;
  }

  /*
   * The kind of host this plugin talks to. The check is what the connection
   * page's Test runs: the bridge's own hello, which no other service on the
   * port can give, and the open score in the same exchange - so a person sees
   * what an agent would see.
   */
  connectionTypes() {
    return [
      {
        name: 'musescore',
        label: 'MuseScore',
        description: 'MuseScore 4 with the Orknux bridge running, to read and write the open score.',
        urlPlaceholder: 'http://localhost:8084',
        // Where the bridge listens unless its file says otherwise, so the URL box may be left empty.
        defaultUrl: 'http://localhost:8084',
        guide: GUIDE,
        check: (connection) => {
          const [hello, score] = exchange(connection, [{ command: 'hello', args: {} }, { command: 'score', args: {} }]);
          if (!hello.ok) {
            return { ok: false, message: `the Orknux bridge refused hello: ${hello.error}` };
          }
          const protocol = at(hello.result, 'protocol');
          if (protocol !== PROTOCOL) {
            return {
              ok: false,
              message:
                `the Orknux bridge speaks protocol ${JSON.stringify(protocol)} and this plugin speaks ${PROTOCOL} - ` +
                `install the bridge from ${BRIDGE_URL}`,
            };
          }
          const said = `Orknux bridge ${at(hello.result, 'bridgeVersion')} in MuseScore ${at(hello.result, 'musescore')}`;
          if (!score.ok) {
            return { ok: true, message: `${said}, no score open` };
          }
          const title = at(score.result, 'title') || 'an untitled score';
          return {
            ok: true,
            message: `${said}: ${title}, ${at(score.result, 'measures')} measures on ${at(score.result, 'staves')} staves`,
          };
        },
      },
    ];
  }

  permissions() {
    // None: the key is read off the connection and put into each message.
    return [];
  }

  capabilities() {
    // Every message goes to the connection's url, which is MuseScore on somebody's machine.
    return ['NETWORK_REQUEST'];
  }

  objects() {
    return [
      new OrknuxObject({
        name: 'Part',
        description: 'An instrument and the staves it is written on.',
        properties: [
          { name: 'name', kind: 'string', description: 'As the score names it: Violin 1, Piano.' },
          { name: 'instrument', kind: 'string', description: 'MuseScore\'s instrument id: violin, piano.' },
          { name: 'staves', kind: 'array', of: 'number', description: 'Its staff numbers - a piano has two.' },
        ],
      }),
      new OrknuxObject({
        name: 'TimeSignature',
        description: 'A time signature, from the measure it starts at.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'signature', kind: 'string', description: '4/4, 6/8.' },
        ],
      }),
      new OrknuxObject({
        name: 'Tempo',
        description: 'A tempo marking.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'beat', kind: 'number' },
          { name: 'bpm', kind: 'number', description: 'Quarter notes per minute.' },
          { name: 'text', kind: 'string', description: 'As printed.' },
        ],
      }),
      new OrknuxObject({
        name: 'Score',
        description: 'The score open in MuseScore: what it is called, who it is for, and how long it is.',
        properties: [
          { name: 'title', kind: 'string' },
          { name: 'subtitle', kind: 'string' },
          { name: 'composer', kind: 'string' },
          { name: 'lyricist', kind: 'string' },
          { name: 'parts', kind: 'array', of: 'Part', description: 'Top to bottom.' },
          { name: 'staves', kind: 'number', description: 'How many staves, numbered from 1 at the top.' },
          { name: 'measures', kind: 'number', description: 'How many measures, numbered from 1 in score order.' },
          { name: 'key', kind: 'string', description: 'The key at the start: F major / D minor.' },
          { name: 'keyFifths', kind: 'number', description: 'Sharps as positive, flats as negative.' },
          { name: 'timeSignatures', kind: 'array', of: 'TimeSignature', description: 'The first, and every change.' },
          { name: 'tempos', kind: 'array', of: 'Tempo' },
          { name: 'hasLyrics', kind: 'boolean' },
          { name: 'durationSeconds', kind: 'number', description: 'How long it plays.' },
        ],
      }),
      new OrknuxObject({
        name: 'VoiceLine',
        description: 'What one voice of one staff holds in one measure.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'staff', kind: 'number' },
          { name: 'voice', kind: 'number', description: '1 to 4; 2 to 4 appear only where used.' },
          {
            name: 'notation',
            kind: 'string',
            description:
              'C4/4 [C4 E4 G4]/2 r/8. R is a whole-measure rest; ~ after a pitch ties it into the next note; ' +
              '(3:2) marks a note of a tuplet.',
          },
        ],
      }),
      new OrknuxObject({
        name: 'LyricLine',
        description: 'The lyrics of one verse under one staff in one measure.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'staff', kind: 'number' },
          { name: 'verse', kind: 'number' },
          { name: 'text', kind: 'string', description: 'A syllable per note; one ending in - continues the word.' },
        ],
      }),
      new OrknuxObject({
        name: 'Marking',
        description: 'Text or a sign written on the score.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'beat', kind: 'number', description: 'From 1, in the time signature\'s beat unit.' },
          { name: 'staff', kind: 'number' },
          {
            name: 'kind',
            kind: 'string',
            description: 'staff text, system text, expression, tempo, dynamic, rehearsal mark or chord symbol.',
          },
          { name: 'text', kind: 'string' },
        ],
      }),
      new OrknuxObject({
        name: 'Passage',
        description: 'Measures of the score, read.',
        properties: [
          { name: 'from', kind: 'number' },
          { name: 'to', kind: 'number', description: 'The last measure read - less than asked where the score ends.' },
          { name: 'measures', kind: 'number', description: 'How many the whole score has.' },
          { name: 'timeSignatures', kind: 'array', of: 'TimeSignature', description: 'In force at from, and every change.' },
          { name: 'voices', kind: 'array', of: 'VoiceLine' },
          { name: 'lyrics', kind: 'array', of: 'LyricLine' },
          { name: 'markings', kind: 'array', of: 'Marking' },
        ],
      }),
      new OrknuxObject({
        name: 'SelectedItem',
        description: 'One thing selected in MuseScore by clicking it.',
        properties: [
          { name: 'kind', kind: 'string', description: 'Note, Chord, Rest, StaffText...' },
          { name: 'measure', kind: 'number' },
          { name: 'beat', kind: 'number' },
          { name: 'staff', kind: 'number' },
          { name: 'voice', kind: 'number' },
          { name: 'text', kind: 'string', description: 'A note or chord as notation, or a text\'s words.' },
        ],
      }),
      new OrknuxObject({
        name: 'Selection',
        description: 'What the person has selected in MuseScore.',
        properties: [
          {
            name: 'kind',
            kind: 'string',
            description: 'range for a stretch of measures, list for things clicked one by one, nothing for nothing.',
          },
          { name: 'from', kind: 'number', description: 'For a range: its first measure.' },
          { name: 'to', kind: 'number', description: 'For a range: its last measure.' },
          { name: 'staves', kind: 'array', of: 'number', description: 'For a range: the staves in it.' },
          { name: 'voices', kind: 'array', of: 'VoiceLine', description: 'For a range: what it holds.' },
          { name: 'lyrics', kind: 'array', of: 'LyricLine' },
          { name: 'markings', kind: 'array', of: 'Marking' },
          { name: 'items', kind: 'array', of: 'SelectedItem', description: 'For a list: each thing selected.' },
        ],
      }),
      new OrknuxObject({
        name: 'Written',
        description: 'A passage written into the score.',
        properties: [
          { name: 'staff', kind: 'number' },
          { name: 'voice', kind: 'number' },
          { name: 'from', kind: 'number', description: 'The first measure written into.' },
          { name: 'to', kind: 'number', description: 'The last measure written into.' },
          { name: 'written', kind: 'number', description: 'How many notes, chords and rests.' },
          { name: 'appendedMeasures', kind: 'number', description: 'Measures added at the end to make room.' },
          { name: 'measures', kind: 'number', description: 'How many the score has now.' },
          {
            name: 'readBack',
            kind: 'array',
            of: 'VoiceLine',
            description: 'The measures written, read back - where a long note crossed a barline, tied.',
          },
        ],
      }),
      new OrknuxObject({
        name: 'PassageResult',
        description: 'One passage of several: written, or why not.',
        properties: [
          { name: 'passage', kind: 'number', description: 'Its place in the list, from 1.' },
          { name: 'written', kind: 'object', of: 'Written', description: 'Absent where it was refused.' },
          { name: 'error', kind: 'string', description: 'Why it was not written; the others were.' },
        ],
      }),
      new OrknuxObject({
        name: 'Passages',
        description: 'What writing several passages came to.',
        properties: [
          { name: 'written', kind: 'number', description: 'How many were written.' },
          { name: 'results', kind: 'array', of: 'PassageResult', description: 'One per passage, in order.' },
        ],
      }),
      new OrknuxObject({
        name: 'Details',
        description: 'The score\'s title, subtitle, composer and lyricist, as they are now.',
        properties: [
          { name: 'title', kind: 'string' },
          { name: 'subtitle', kind: 'string' },
          { name: 'composer', kind: 'string' },
          { name: 'lyricist', kind: 'string' },
        ],
      }),
      new OrknuxObject({
        name: 'TempoSet',
        description: 'A tempo marking written.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'beat', kind: 'number' },
          { name: 'bpm', kind: 'number' },
          { name: 'replaced', kind: 'number', description: 'Markings that were on that beat and were replaced.' },
        ],
      }),
      new OrknuxObject({
        name: 'TimeSignatureSet',
        description: 'A time signature written.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'signature', kind: 'string' },
          { name: 'measures', kind: 'number', description: 'How many the score has now - rebarring can change it.' },
        ],
      }),
      new OrknuxObject({
        name: 'MeasuresAdded',
        description: 'Measures added at the end of the score.',
        properties: [
          { name: 'appended', kind: 'number' },
          { name: 'measures', kind: 'number', description: 'How many the score has now.' },
        ],
      }),
      new OrknuxObject({
        name: 'LyricsAdded',
        description: 'Syllables put under notes.',
        properties: [
          { name: 'placed', kind: 'number', description: 'How many syllables found a note.' },
          { name: 'left', kind: 'array', of: 'string', description: 'Syllables that ran out of notes before the score did.' },
          { name: 'replaced', kind: 'number', description: 'Syllables of the same verse that were there and were replaced.' },
          { name: 'through', kind: 'number', description: 'The measure of the last syllable placed.' },
        ],
      }),
      new OrknuxObject({
        name: 'TextAdded',
        description: 'Text written on the score.',
        properties: [
          { name: 'measure', kind: 'number' },
          { name: 'beat', kind: 'number' },
          { name: 'staff', kind: 'number' },
          { name: 'kind', kind: 'string' },
          { name: 'text', kind: 'string' },
        ],
      }),
      new OrknuxObject({
        name: 'Undone',
        description: 'What undoing came to.',
        properties: [
          { name: 'steps', kind: 'number', description: 'How many Undo steps MuseScore was asked for.' },
          { name: 'measures', kind: 'number', description: 'How many measures the score has afterwards.' },
        ],
      }),
      new OrknuxObject({
        name: 'Exported',
        description: 'A file written by MuseScore.',
        properties: [
          { name: 'path', kind: 'string', description: 'On the machine MuseScore runs on.' },
          { name: 'format', kind: 'string' },
        ],
      }),
    ];
  }

  /* The agents' surface: every call, fronted. Proxies, so everything stays the functions' own. */
  tools() {
    return [
      new OrknuxFunctionTool({ function: 'score' }),
      new OrknuxFunctionTool({ function: 'read' }),
      new OrknuxFunctionTool({ function: 'selection' }),
      new OrknuxFunctionTool({ function: 'write' }),
      new OrknuxFunctionTool({ function: 'writePassages' }),
      new OrknuxFunctionTool({ function: 'appendMeasures' }),
      new OrknuxFunctionTool({ function: 'setDetails' }),
      new OrknuxFunctionTool({ function: 'setTempo' }),
      new OrknuxFunctionTool({ function: 'setTimeSignature' }),
      new OrknuxFunctionTool({ function: 'addLyrics' }),
      new OrknuxFunctionTool({ function: 'addText' }),
      new OrknuxFunctionTool({ function: 'undo' }),
      new OrknuxFunctionTool({ function: 'exportScore' }),
    ];
  }

  skills() {
    return [
      new OrknuxSkill({
        id: 'musescore-writing',
        name: 'Writing music into somebody\'s open MuseScore score',
        description:
          'What to read before writing a note, how measures, staves and voices are counted, the notation the ' +
          'calls take, and how to take a change back.',
        content: `# Writing music into somebody's open MuseScore score

The score is the one open in the person's MuseScore, in the front tab, and they
are probably looking at it. Everything you write appears there at once.

## Read before you write

1. \`musescore_score\` first: the parts and which staves each is on, how many
   measures there are, the key, the time signatures and the tempo. Write in
   that key and that meter unless asked to change them.
2. \`musescore_read\` the measures you are about to touch, and the ones around
   them, so that what you write fits what is there - the harmony in the other
   staves, the range of the instrument, the rhythm of the bars before.
3. If the person says "this" or "here", \`musescore_selection\` says what they
   have selected.

## Counting

- **Measures** count from 1 in the order the score holds them - the first
  measure is 1 even where the printed number above it says otherwise (a pickup
  measure, a score numbered from 0).
- **Staves** count from 1 at the top. A piano has two: the right hand is the
  upper one.
- **Voices** are 1 to 4 within a staff; leave voice out for voice 1.
- **Beats** count from 1 in the time signature's beat unit: beat 3 of 4/4 is the
  third quarter, beat 4 of 6/8 is the fourth eighth. A write or a text may start
  only where a note or rest already starts in some voice.

## The notation

One token per note, chord or rest - a pitch, a slash, a duration:

- \`C4/4\` a quarter-note middle C, \`F#5/8.\` a dotted eighth, \`Bb3/2..\` a
  double-dotted half.
- \`[C4 E4 G4]/2\` a half-note chord.
- \`r/8\` an eighth rest.
- Durations are \`/1 /2 /4 /8 /16 /32 /64\`. Pitches are concert pitch, octave 4
  starting at middle C. \`|\` may be written between measures for your own
  reading; it is ignored.

Make each measure add up to its time signature. A note that runs past a barline
is fine - MuseScore splits it and ties the halves - but a passage that ends
mid-measure leaves the rest of that measure as it was.

What \`musescore_read\` answers may also hold what you cannot write: \`R\` a
whole-measure rest, \`~\` after a pitch for a tie, \`(3:2)\` on a note of a
tuplet. Write ties as one longer note, and leave tuplets to the person.

MuseScore chooses how each note is spelled: you may write \`A#4\` and see \`Bb4\`
in a flat key. The pitch is what you asked for.

## Writing

Writing replaces what was in that staff and voice from that point on, for as
long as the passage lasts, and adds measures at the end when it runs past it.

\`musescore_write\` with
\`{"musescore": 4, "staff": 1, "measure": 5, "notation": "E5/4 D5/4 C5/2 | D5/4 E5/4 E5/2"}\`

Several staves at once - a melody and its bass - as one call:

\`musescore_writePassages\` with
\`{"musescore": 4, "passages": [{"staff": 1, "measure": 1, "notation": "C5/2 G4/2"}, {"staff": 2, "measure": 1, "notation": "[C3 G3]/1"}]}\`

Each write answers \`readBack\`: the measures as they are now. Check it says
what you meant before you go on.

## Taking it back

Every call that changes the score is **one** step of MuseScore's Undo, so the
person can take back any one of your changes with Ctrl+Z. \`musescore_undo\`
does the same from here - \`{"musescore": 4, "steps": 2}\` takes back the last
two. Undo also takes back what the person did themselves, so only undo what you
just did, and say what you undid.

## Saving

Nothing here saves the score: the person saves it, with Ctrl+S. Tell them what
you changed so they can decide. \`musescore_exportScore\` writes a PDF, MusicXML
or MIDI copy on their machine without touching the score itself.`,
      }),
      new OrknuxSkill({
        id: 'musescore-lyrics',
        name: 'Putting lyrics and markings on a MuseScore score',
        description:
          'How to set words under notes a syllable at a time, and add tempo, text and the title so the score reads ' +
          'as finished.',
        content: `# Putting lyrics and markings on a MuseScore score

## Lyrics

Lyrics go under notes one syllable per note, from a measure on, skipping rests.
Split words into syllables yourself and end every syllable that continues the
word with a hyphen, so MuseScore draws the dash between them:

\`musescore_addLyrics\` with
\`{"musescore": 4, "staff": 1, "measure": 1, "text": "Twin- kle twin- kle lit- tle star"}\`

Read the melody first with \`musescore_read\` and count its notes: a word held
over several notes takes one syllable, and the notes after it then take the
next ones - so a melody with a held note needs the syllables lined up by hand,
or written in two calls from two measures. What did not fit comes back in
\`left\`. A second verse is \`"verse": 2\`; writing a verse again replaces that
verse on the notes it reaches.

## Tempo

\`musescore_setTempo\` with \`{"musescore": 4, "bpm": 96, "measure": 1, "text": "Andante"}\`
writes "Andante ♩ = 96" and makes playback follow it. A marking already on that
beat is replaced rather than doubled.

## Text

\`musescore_addText\` puts words on the score: \`staff\` text belongs to one
staff, \`system\` text to every staff (Coda, Fine), \`expression\` is an
instruction such as dolce, and \`rehearsal\` is a boxed section letter.

\`{"musescore": 4, "text": "A", "measure": 9, "kind": "rehearsal"}\`

## Title and credits

\`musescore_setDetails\` changes the title, subtitle, composer and lyricist,
both in the score's properties and in the title at the top of the first page.
Only the names given change; an empty one removes that line.

\`{"musescore": 4, "details": {"title": "Little Star", "composer": "Trad."}}\`

Each of these is one Undo step, like every change.`,
      }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'score',
        description:
          'Describes the score open in MuseScore: title and credits, the parts and which staves each is on, how ' +
          'many measures, the key, the time signatures, the tempos, and whether it has lyrics. Read this before ' +
          'anything else.',
        params: [CONNECTION],
        returnType: 'Score',
        run: (connection) => ask(connection, 'score'),
      }),

      new OrknuxFunction({
        name: 'read',
        description:
          'Reads measures of the open score: each staff\'s voices as notation, the lyrics, and the markings ' +
          '(dynamics, tempo, text). Reads count measures from from, 8 if not given and 64 at most; staves ' +
          'narrows it to some staves. ' + NOTATION,
        params: [
          CONNECTION,
          { name: 'from', type: 'number', required: false, default: 1, description: 'The first measure, from 1.' },
          { name: 'count', type: 'number', required: false, default: 8, description: 'How many measures.' },
          { name: 'staves', type: 'array', required: false, default: [], description: 'Staff numbers; all if empty.' },
        ],
        returnType: 'Passage',
        run: (connection, from, count, staves) => {
          const first = counted(from, 'from');
          const many = Math.min(counted(count, 'count'), 64);
          const args = { from: first, to: first + many - 1 };
          if (Array.isArray(staves) && staves.length > 0) {
            args.staves = staves.map((one) => counted(Number(one), 'a staff'));
          }
          return ask(connection, 'read', args);
        },
      }),

      new OrknuxFunction({
        name: 'selection',
        description:
          'Says what the person has selected in MuseScore: a range of measures with what it holds, or the notes ' +
          'and texts they clicked. For when somebody says "this passage" or "these notes".',
        params: [CONNECTION],
        returnType: 'Selection',
        run: (connection) => {
          const chosen = ask(connection, 'selection');
          return {
            kind: at(chosen, 'kind'),
            from: at(chosen, 'from'),
            to: at(chosen, 'to'),
            staves: at(chosen, 'staves') ?? [],
            voices: at(chosen, 'voices') ?? [],
            lyrics: at(chosen, 'lyrics') ?? [],
            markings: at(chosen, 'markings') ?? [],
            items: at(chosen, 'items') ?? [],
          };
        },
      }),

      new OrknuxFunction({
        name: 'write',
        description:
          'Writes notation into one staff and voice from a measure (and beat) on, replacing what was there for ' +
          'as long as it lasts, and adding measures at the end where it runs past. One Undo step. Answers the ' +
          'measures written, read back. ' + NOTATION + ' MuseScore chooses each note\'s spelling.',
        params: [
          CONNECTION,
          { name: 'staff', type: 'number', description: 'From 1 at the top.' },
          { name: 'measure', type: 'number', description: 'From 1, in score order.' },
          { name: 'notation', type: 'string', description: 'C4/4 [C4 E4 G4]/2 r/8 F#5/8.' },
          { name: 'voice', type: 'number', required: false, default: 1, description: '1 to 4.' },
          {
            name: 'beat',
            type: 'number',
            required: false,
            default: 1,
            description: 'Where in the measure to start, from 1 in the time signature\'s beat unit.',
          },
        ],
        returnType: 'Written',
        run: (connection, staff, measure, notation, voice, beat) =>
          ask(connection, 'write', passageOf({ staff, measure, notation, voice, beat }).args),
      }),

      new OrknuxFunction({
        name: 'writePassages',
        description:
          'Writes several passages in one call - a melody and its accompaniment, or a part a phrase at a time. ' +
          'passages is a list of {staff, measure, notation, voice?, beat?}, as write takes them. Each is its ' +
          'own Undo step and is written or refused on its own: a refused one says why and the rest are written.',
        params: [
          CONNECTION,
          {
            name: 'passages',
            type: 'array',
            description: '[{"staff": 1, "measure": 1, "notation": "C5/2 G4/2"}, {"staff": 2, "measure": 1, "notation": "C3/1"}]',
          },
        ],
        returnType: 'Passages',
        run: (connection, passages) => {
          if (!Array.isArray(passages) || passages.length === 0) {
            throw new Error('there are no passages - passages is a list of {staff, measure, notation}');
          }
          if (passages.length > MOST) {
            throw new Error(`that is ${passages.length} passages, and one call writes at most ${MOST}`);
          }
          const commands = passages.map((one, index) => passageOf(one, index));
          const answers = exchange(connection, commands);
          const results = answers.map((answer, index) =>
            answer.ok ? { passage: index + 1, written: answer.result } : { passage: index + 1, error: answer.error },
          );
          return { written: answers.filter((answer) => answer.ok).length, results };
        },
      }),

      new OrknuxFunction({
        name: 'appendMeasures',
        description: 'Adds empty measures at the end of the score, in the last time signature. One Undo step.',
        params: [CONNECTION, { name: 'count', type: 'number', description: '1 to 500.' }],
        returnType: 'MeasuresAdded',
        run: (connection, count) => ask(connection, 'appendMeasures', { count: counted(count, 'count') }),
      }),

      new OrknuxFunction({
        name: 'setDetails',
        description:
          'Changes the title, subtitle, composer or lyricist - in the score\'s properties and in the title on ' +
          'the first page. details holds only what changes: {"title": "Little Star", "composer": "Trad."}; an ' +
          'empty string removes that line. One Undo step.',
        params: [CONNECTION, { name: 'details', type: 'map', description: 'Any of title, subtitle, composer, lyricist.' }],
        returnType: 'Details',
        run: (connection, details) => {
          const args = {};
          for (const field of ['title', 'subtitle', 'composer', 'lyricist']) {
            const value = at(details, field);
            if (value !== null) {
              args[field] = String(value);
            }
          }
          const unknown = Object.keys(details ?? {}).filter((name) => !(name in args));
          if (unknown.length > 0) {
            throw new Error(`${unknown.join(', ')} is not something a score has - details takes title, subtitle, composer and lyricist`);
          }
          if (Object.keys(args).length === 0) {
            throw new Error('there is nothing to change - details takes title, subtitle, composer and lyricist');
          }
          return ask(connection, 'setMetadata', args);
        },
      }),

      new OrknuxFunction({
        name: 'setTempo',
        description:
          'Writes a tempo marking - "Andante ♩ = 96" - that playback follows, at a measure and beat. A marking ' +
          'already on that beat is replaced. One Undo step.',
        params: [
          CONNECTION,
          { name: 'bpm', type: 'number', description: 'Quarter notes per minute.' },
          { name: 'measure', type: 'number', required: false, default: 1 },
          { name: 'beat', type: 'number', required: false, default: 1 },
          { name: 'text', type: 'string', required: false, default: '', description: 'A word before the number: Allegro.' },
        ],
        returnType: 'TempoSet',
        run: (connection, bpm, measure, beat, text) => {
          if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 5 || bpm > 999) {
            throw new Error(`bpm is quarter notes per minute, 5 to 999, and was ${JSON.stringify(bpm)}`);
          }
          return ask(connection, 'setTempo', { bpm, measure: counted(measure, 'measure'), beat, text });
        },
      }),

      new OrknuxFunction({
        name: 'setTimeSignature',
        description:
          'Changes the time signature from a measure on, for every staff. MuseScore rebars what follows, so ' +
          'the measure count can change - the answer says what it is now. One Undo step.',
        params: [
          CONNECTION,
          { name: 'numerator', type: 'number', description: 'Beats per measure: the 3 of 3/4.' },
          { name: 'denominator', type: 'number', description: 'The beat unit: 1, 2, 4, 8, 16, 32 or 64.' },
          { name: 'measure', type: 'number', required: false, default: 1 },
        ],
        returnType: 'TimeSignatureSet',
        run: (connection, numerator, denominator, measure) =>
          ask(connection, 'setTimeSignature', { numerator, denominator, measure: counted(measure, 'measure') }),
      }),

      new OrknuxFunction({
        name: 'addLyrics',
        description:
          'Puts lyrics under successive notes of a staff from a measure on, one syllable per note, skipping ' +
          'rests: "Twin- kle twin- kle" - a syllable ending in - continues the word. Syllables already there ' +
          'in that verse are replaced. Answers any syllables that ran out of notes. One Undo step.',
        params: [
          CONNECTION,
          { name: 'staff', type: 'number' },
          { name: 'measure', type: 'number' },
          { name: 'text', type: 'string', description: 'Syllables separated by spaces.' },
          { name: 'voice', type: 'number', required: false, default: 1 },
          { name: 'verse', type: 'number', required: false, default: 1 },
          { name: 'beat', type: 'number', required: false, default: 1 },
        ],
        returnType: 'LyricsAdded',
        run: (connection, staff, measure, text, voice, verse, beat) => {
          if (typeof text !== 'string' || text.trim().length === 0) {
            throw new Error('there are no lyrics - pass the words a syllable per note: Twin- kle twin- kle');
          }
          return ask(connection, 'addLyrics', {
            staff: counted(staff, 'staff'),
            measure: counted(measure, 'measure'),
            syllables: text.trim().split(/\s+/),
            voice: counted(voice, 'voice'),
            verse: counted(verse, 'verse'),
            beat,
          });
        },
      }),

      new OrknuxFunction({
        name: 'addText',
        description:
          'Writes text on the score at a measure and beat. kind is staff (one staff\'s), system (every staff\'s: ' +
          'Coda, Fine), expression (dolce, cresc.) or rehearsal (a boxed section letter). One Undo step.',
        params: [
          CONNECTION,
          { name: 'text', type: 'string' },
          { name: 'measure', type: 'number' },
          { name: 'kind', type: 'string', required: false, default: 'staff', description: 'staff, system, expression or rehearsal.' },
          { name: 'staff', type: 'number', required: false, default: 1 },
          { name: 'beat', type: 'number', required: false, default: 1 },
        ],
        returnType: 'TextAdded',
        run: (connection, text, measure, kind, staff, beat) => {
          if (!['staff', 'system', 'expression', 'rehearsal'].includes(kind)) {
            throw new Error(`kind ${JSON.stringify(kind)} is not one of staff, system, expression or rehearsal`);
          }
          return ask(connection, 'addText', { text, measure: counted(measure, 'measure'), kind, staff: counted(staff, 'staff'), beat });
        },
      }),

      new OrknuxFunction({
        name: 'undo',
        description:
          'Takes back the last changes in MuseScore, as Ctrl+Z does - every call here that changes the score ' +
          'is one step. Undo does not know whose step it is: it also takes back what the person did.',
        params: [CONNECTION, { name: 'steps', type: 'number', required: false, default: 1, description: `1 to ${MOST}.` }],
        returnType: 'Undone',
        run: (connection, steps) => {
          const many = counted(steps, 'steps');
          if (many > MOST) {
            throw new Error(`that is ${many} steps, and one call takes back at most ${MOST}`);
          }
          const answers = exchange(connection, Array.from({ length: many }, () => ({ command: 'undo', args: {} })));
          const refused = answers.find((answer) => !answer.ok);
          if (refused !== undefined) {
            throw new Error(`MuseScore refused undo: ${refused.error}`);
          }
          return { steps: many, measures: at(answers[answers.length - 1].result, 'measures') };
        },
      }),

      new OrknuxFunction({
        name: 'exportScore',
        description:
          'Has MuseScore write the open score to a file on the machine it runs on, in the format the extension ' +
          'names: .pdf, .png, .svg, .mid, .musicxml, .mxl, .mp3, .wav, .ogg, .flac. The score itself is not ' +
          'saved - MuseScore does not let a plugin write .mscz, so saving is the person\'s Ctrl+S.',
        params: [CONNECTION, { name: 'path', type: 'string', description: 'A full path on that machine: /home/me/song.pdf' }],
        returnType: 'Exported',
        run: (connection, path) => ask(connection, 'export', { path }),
      }),
    ];
  }
}
