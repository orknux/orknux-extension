/*
 * Orknux bridge - lets an Orknux server read and write the score open in
 * MuseScore 4, over a WebSocket.
 *
 * Put this file in MuseScore's plugins folder, enable it in
 * Plugins > Manage plugins, and run it from the Plugins menu once each time
 * MuseScore starts. It then listens on the port below until MuseScore closes.
 *
 * The protocol is one JSON object per message and one JSON reply to each:
 *
 *     {"command": "read", "args": {"from": 1, "to": 4}, "key": "..."}
 *     {"bridge": "orknux", "ok": true, "result": {...}}
 *     {"bridge": "orknux", "ok": false, "error": "..."}
 *
 * Every command that changes the score is one undoable step: Edit > Undo
 * reverts exactly one command, and a command that fails part-way is rolled
 * back rather than left half-done.
 *
 * MuseScore listens on every network interface and has no notion of who is
 * connecting, so anyone who can reach this machine on the port can edit the
 * open score. Set `key` below to a secret of your own whenever this machine is
 * reachable from others; a command without that key is then refused.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

import QtQuick
import MuseScore 3.0

MuseScore {
    id: bridge

    // ---- Settings: change these two, save, and run the plugin again. ----

    /** The port to listen on; the Orknux connection's URL ends in the same number. */
    property int port: 8084

    /** A shared secret, or empty for none. The same text goes in the Orknux connection as its API key. */
    property string key: ""

    // ---------------------------------------------------------------------

    title: "Orknux bridge"
    description: "Lets an Orknux server read and write the open score over a WebSocket, on the port set at the top of the file."
    version: "0.1.0"
    menuPath: "Plugins.Orknux bridge"
    categoryCode: "composing-arranging-tools"
    requiresScore: false

    /** What `hello` answers, so a client can tell this bridge from anything else on the port. */
    readonly property int protocol: 1

    /** Letters along the circle of fifths, the order a tonal pitch class counts in. */
    readonly property var stepNames: ["F", "C", "G", "D", "A", "E", "B"]
    readonly property var majorKeys: ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
    readonly property var minorKeys: ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"]

    onRun: {
        api.websocketserver.listen(bridge.port, function (client) {
            api.websocketserver.onMessage(client, function (text) {
                api.websocketserver.send(client, bridge.answer(text));
            });
        });
        console.log("Orknux bridge listening on port " + bridge.port + (bridge.key.length > 0 ? ", with a key" : ", without a key"));
    }

    // ===================================================================
    // The door: one message in, one reply out, whatever happens between.
    // ===================================================================

    function answer(text) {
        var asked;
        try {
            asked = JSON.parse(text);
        } catch (notJson) {
            return refuse("the message is not JSON; send {\"command\": ..., \"args\": {...}}");
        }
        if (asked === null || typeof asked !== "object" || typeof asked.command !== "string") {
            return refuse("the message names no command; send {\"command\": ..., \"args\": {...}}");
        }
        if (bridge.key.length > 0 && asked.key !== bridge.key) {
            return JSON.stringify({
                bridge: "orknux", ok: false, keyRequired: true,
                error: asked.key === undefined || asked.key === ""
                    ? "this bridge has a key set, and the command came without one"
                    : "the key does not match the one set in this bridge"
            });
        }
        var args = asked.args !== null && typeof asked.args === "object" ? asked.args : {};
        try {
            return JSON.stringify({ bridge: "orknux", ok: true, result: dispatch(asked.command, args) });
        } catch (failed) {
            return refuse(String(failed && failed.message !== undefined ? failed.message : failed));
        }
    }

    function refuse(why) {
        return JSON.stringify({ bridge: "orknux", ok: false, error: why });
    }

    function dispatch(command, a) {
        switch (command) {
        case "hello": return hello();
        case "score": return describeScore();
        case "read": return read(a);
        case "selection": return selection();
        case "write": return write(a);
        case "appendMeasures": return appendMeasures(a);
        case "setMetadata": return setMetadata(a);
        case "setTempo": return setTempo(a);
        case "setTimeSignature": return setTimeSignature(a);
        case "addLyrics": return addLyrics(a);
        case "addText": return addText(a);
        case "undo": return undo();
        case "export": return exportScore(a);
        }
        throw new Error("this bridge has no command called " + command +
            " - it knows hello, score, read, selection, write, appendMeasures, setMetadata, setTempo, " +
            "setTimeSignature, addLyrics, addText, undo and export");
    }

    /**
     * Runs a change as one undoable step, rolled back whole if it throws.
     * The name is what MuseScore shows beside Undo.
     */
    function edit(name, change) {
        var score = needScore();
        score.startCmd("Orknux: " + name);
        var result;
        try {
            result = change(score);
        } catch (failed) {
            score.endCmd(true);
            throw failed;
        }
        score.endCmd();
        return result;
    }

    // ===================================================================
    // Where things are: measures and staves counted from 1, voices 1 to 4.
    // ===================================================================

    function needScore() {
        if (!curScore) {
            throw new Error("no score is open in MuseScore - open or create one first");
        }
        return curScore;
    }

    function whole(value, name) {
        var n = Number(value);
        if (value === undefined || value === null || value === "" || !isFinite(n) || Math.floor(n) !== n) {
            throw new Error(name + " has to be a whole number, and was " + JSON.stringify(value));
        }
        return n;
    }

    /** Every measure, in order, as MuseScore holds them - not the numbers printed above them. */
    function measures() {
        var all = [];
        for (var m = needScore().firstMeasure; m; m = m.nextMeasure) {
            all.push(m);
        }
        return all;
    }

    function measureAt(all, number, name) {
        var n = whole(number, name);
        if (n < 1 || n > all.length) {
            throw new Error(name + " " + n + " is not in the score, which has measures 1 to " + all.length);
        }
        return all[n - 1];
    }

    function startOf(m) {
        return m.firstSegment.tick;
    }

    function lengthOf(m) {
        return m.ticks.ticks;
    }

    /** The measure holding a tick, as its 1-based number. */
    function numberAt(all, tick) {
        for (var i = all.length - 1; i >= 0; i--) {
            if (startOf(all[i]) <= tick) {
                return i + 1;
            }
        }
        return 1;
    }

    function staffAt(number) {
        var n = whole(number, "staff");
        var count = needScore().nstaves;
        if (n < 1 || n > count) {
            throw new Error("staff " + n + " is not in the score, which has staves 1 to " + count);
        }
        return n - 1;
    }

    function voiceAt(number) {
        var n = number === undefined || number === null ? 1 : whole(number, "voice");
        if (n < 1 || n > 4) {
            throw new Error("voice " + n + " does not exist - a staff has voices 1 to 4");
        }
        return n - 1;
    }

    /** The beat unit of a measure in ticks: a quarter in 4/4, an eighth in 6/8. */
    function beatTicks(m) {
        var sig = m.timesigActual;
        return sig && sig.denominator ? division * 4 / sig.denominator : division;
    }

    /** A 1-based beat, in the measure's own beat unit, as a tick inside it. */
    function tickOfBeat(m, beat) {
        if (beat === undefined || beat === null || beat === "" || Number(beat) === 1) {
            return startOf(m);
        }
        var b = Number(beat);
        if (!isFinite(b) || b < 1) {
            throw new Error("beat " + JSON.stringify(beat) + " is not a beat - beats count from 1");
        }
        var offset = Math.round((b - 1) * beatTicks(m));
        if (offset >= lengthOf(m)) {
            throw new Error("beat " + b + " is past the end of that measure");
        }
        return startOf(m) + offset;
    }

    function beatOf(m, tick) {
        return Math.round((1 + (tick - startOf(m)) / beatTicks(m)) * 1000) / 1000;
    }

    function signatureOf(m) {
        var sig = m.timesigNominal;
        return sig ? sig.numerator + "/" + sig.denominator : "";
    }

    function keyName(fifths) {
        if (fifths < -7 || fifths > 7) {
            return "";
        }
        return majorKeys[fifths + 7] + " major / " + minorKeys[fifths + 7] + " minor";
    }

    // ===================================================================
    // Notation: C4/4  [C4 E4 G4]/2  r/8  F#5/8.  Bb3/16..
    // ===================================================================

    /** A note's name from its concert spelling, so a written B# reads as B#3 and not C4. */
    function nameOf(note) {
        var tpc = note.tpc1;
        var step = stepNames[((tpc + 1) % 7 + 7) % 7];
        var alter = Math.floor((tpc + 1) / 7) - 2;
        var natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step];
        var octave = Math.floor((note.pitch - alter - natural) / 12) - 1;
        var accidental = alter > 0 ? "##".slice(0, alter) : alter < 0 ? "bb".slice(0, -alter) : "";
        return step + accidental + octave + (note.tieForward ? "~" : "");
    }

    /** A written duration as /4, /8. or /2.. - or as a fraction where no such spelling exists. */
    function durationOf(fraction) {
        var num = fraction.numerator;
        var den = fraction.denominator;
        if (num === 1) return "/" + den;
        if (num === 3 && den >= 2) return "/" + (den / 2) + ".";
        if (num === 7 && den >= 4) return "/" + (den / 4) + "..";
        return "/" + num + ":" + den;
    }

    function tokenOf(element) {
        var tuplet = element.tuplet ? "(" + element.tuplet.actualNotes + ":" + element.tuplet.normalNotes + ")" : "";
        if (element.type === Element.REST) {
            return element.isFullMeasureRest ? "R" : "r" + durationOf(element.duration) + tuplet;
        }
        var notes = [];
        for (var i = 0; i < element.notes.length; i++) {
            notes.push(element.notes[i]);
        }
        notes.sort(function (a, b) { return a.pitch - b.pitch; });
        var names = notes.map(nameOf);
        var pitched = names.length === 1 ? names[0] : "[" + names.join(" ") + "]";
        return pitched + durationOf(element.duration) + tuplet;
    }

    /** A pitch name as MIDI: C4 is 60, Cb4 is 59, B#3 is 60. */
    function pitchOf(name, whole) {
        var parts = /^([A-Ga-g])(##|#|bb|b)?(-?\d)$/.exec(name);
        if (!parts) {
            throw new Error("\"" + name + "\" in \"" + whole + "\" is not a pitch - write a letter, an optional # or b, and an octave: C4, F#5, Bb3");
        }
        var step = parts[1].toUpperCase();
        var alter = { "##": 2, "#": 1, "bb": -2, "b": -1 }[parts[2] || ""] || 0;
        var midi = (Number(parts[3]) + 1) * 12 + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step] + alter;
        if (midi < 0 || midi > 127) {
            throw new Error(name + " is outside what MuseScore can write");
        }
        return midi;
    }

    /**
     * Notation text as events: each a duration as a fraction, and the pitches
     * (none for a rest). Refused whole, with the token at fault, rather than
     * written up to the mistake.
     */
    function parse(text) {
        if (typeof text !== "string" || text.trim().length === 0) {
            throw new Error("there is no notation to write - write tokens like C4/4 [C4 E4 G4]/2 r/8 F#5/8.");
        }
        var tokens = text.replace(/\|/g, " ").trim().match(/\[[^\]]*\][^\s]*|[^\s]+/g);
        var events = [];
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (token.indexOf("~") >= 0) {
                throw new Error("\"" + token + "\" asks for a tie, which this bridge cannot write - MuseScore ties a note that crosses a barline by itself, so write the whole length instead");
            }
            if (/^\(\d+:\d+\)$/.test(token) || /\(\d+:\d+\)$/.test(token)) {
                throw new Error("\"" + token + "\" is part of a tuplet, which this bridge reads but cannot write");
            }
            var shaped = /^(.*)\/(1|2|4|8|16|32|64)(\.{0,2})$/.exec(token);
            if (!shaped) {
                throw new Error("\"" + token + "\" has no duration this bridge can write - end it in /1 /2 /4 /8 /16 /32 or /64, with . or .. for dots");
            }
            var den = Number(shaped[2]);
            var dots = shaped[3].length;
            var num = dots === 0 ? 1 : dots === 1 ? 3 : 7;
            den = den * (dots === 0 ? 1 : dots === 1 ? 2 : 4);
            var head = shaped[1];
            var pitches;
            if (head === "r" || head === "R") {
                pitches = [];
            } else if (head.charAt(0) === "[") {
                var inner = head.slice(1, -1).trim();
                if (head.charAt(head.length - 1) !== "]" || inner.length === 0) {
                    throw new Error("\"" + token + "\" is not a chord - write the pitches inside brackets: [C4 E4 G4]/2");
                }
                pitches = inner.split(/\s+/).map(function (one) { return pitchOf(one, token); });
            } else {
                pitches = [pitchOf(head, token)];
            }
            events.push({ num: num, den: den, ticks: division * 4 * num / den, pitches: pitches });
        }
        return events;
    }

    /** One staff's voice through a stretch of measures, as notation, a measure at a time. */
    function voiceText(m, track) {
        var end = startOf(m) + lengthOf(m);
        var tokens = [];
        for (var seg = m.firstSegment; seg && seg.tick < end; seg = seg.nextInMeasure) {
            var element = seg.elementAt(track);
            if (element && (element.type === Element.CHORD || element.type === Element.REST)) {
                tokens.push(tokenOf(element));
            }
        }
        return tokens.join(" ");
    }

    function plain(text) {
        return String(text || "")
            .replace(/<sym>metNoteQuarterUp<\/sym>/g, "♩")
            .replace(/<sym>metNote8thUp<\/sym>/g, "♪")
            .replace(/<sym>metNoteHalfUp<\/sym>/g, "𝅗𝅥")
            .replace(/<sym>metAugmentationDot<\/sym>/g, ".")
            // A dynamic is drawn from symbols: dynamicMezzo dynamicForte is mf.
            .replace(/<sym>dynamic(\w)\w*<\/sym>/g, function (all, letter) { return letter.toLowerCase(); })
            .replace(/<sym>[^<]*<\/sym>/g, "")
            .replace(/<[^>]*>/g, "")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
            .trim();
    }

    /** The annotations worth reading, by the word a person would use for each. */
    function markingKind(element) {
        switch (element.type) {
        case Element.STAFF_TEXT: return "staff text";
        case Element.SYSTEM_TEXT: return "system text";
        case Element.EXPRESSION: return "expression";
        case Element.TEMPO_TEXT: return "tempo";
        case Element.DYNAMIC: return "dynamic";
        case Element.REHEARSAL_MARK: return "rehearsal mark";
        case Element.HARMONY: return "chord symbol";
        }
        return null;
    }

    function markingText(element) {
        var said = plain(element.text);
        return said.length > 0 || element.type !== Element.DYNAMIC ? said : element.subtypeName();
    }

    // ===================================================================
    // The commands.
    // ===================================================================

    function hello() {
        return {
            protocol: bridge.protocol,
            bridgeVersion: bridge.version,
            musescore: mscoreMajorVersion + "." + mscoreMinorVersion + "." + mscoreUpdateVersion,
            scoreOpen: curScore ? true : false,
            title: curScore ? (curScore.title || curScore.scoreName || "") : ""
        };
    }

    function describeScore() {
        var score = needScore();
        var all = measures();
        var parts = [];
        for (var p = 0; p < score.parts.length; p++) {
            var part = score.parts[p];
            var staves = [];
            for (var t = part.startTrack; t < part.endTrack; t += 4) {
                staves.push(t / 4 + 1);
            }
            parts.push({
                name: part.longName || part.partName || "",
                instrument: part.instrumentId || "",
                staves: staves
            });
        }
        var signatures = [];
        var previous = "";
        for (var i = 0; i < all.length; i++) {
            var sig = signatureOf(all[i]);
            if (sig !== previous) {
                signatures.push({ measure: i + 1, signature: sig });
                previous = sig;
            }
        }
        var tempos = [];
        for (var seg = score.firstSegment(); seg; seg = seg.next) {
            var notes = seg.annotations;
            for (var a = 0; a < notes.length; a++) {
                if (notes[a].type === Element.TEMPO_TEXT) {
                    var m = numberAt(all, seg.tick);
                    tempos.push({
                        measure: m,
                        beat: beatOf(all[m - 1], seg.tick),
                        bpm: Math.round(notes[a].tempo * 60 * 100) / 100,
                        text: plain(notes[a].text)
                    });
                }
            }
        }
        return {
            title: score.title || "",
            subtitle: score.metaTag("subtitle") || "",
            composer: score.composer || "",
            lyricist: score.lyricist || "",
            parts: parts,
            staves: score.nstaves,
            measures: all.length,
            key: keyName(score.keysig),
            keyFifths: score.keysig,
            timeSignatures: signatures,
            tempos: tempos,
            hasLyrics: score.hasLyrics ? true : false,
            durationSeconds: score.duration
        };
    }

    /** Measures from..to of some staves (all when none are named), as notation, lyrics and markings. */
    function read(a) {
        var all = measures();
        var from = a.from === undefined || a.from === null ? 1 : whole(a.from, "from");
        measureAt(all, from, "from");
        var to = a.to === undefined || a.to === null ? from + 7 : whole(a.to, "to");
        if (to < from) {
            throw new Error("to (" + to + ") is before from (" + from + ")");
        }
        // Past the end, or past 64 at a time, is cut short rather than refused; `to` says where it stopped.
        to = Math.min(to, all.length, from + 63);
        var staves = [];
        if (Array.isArray(a.staves) && a.staves.length > 0) {
            for (var s = 0; s < a.staves.length; s++) staves.push(staffAt(a.staves[s]));
        } else {
            for (var all_s = 0; all_s < curScore.nstaves; all_s++) staves.push(all_s);
        }
        return passage(all, from, to, staves);
    }

    function passage(all, from, to, staves) {
        var voices = [];
        var lyrics = [];
        var markings = [];
        var signatures = [];
        for (var n = from; n <= to; n++) {
            var m = all[n - 1];
            var sig = signatureOf(m);
            if (n === from || sig !== signatureOf(all[n - 2])) {
                signatures.push({ measure: n, signature: sig });
            }
            var end = startOf(m) + lengthOf(m);
            for (var i = 0; i < staves.length; i++) {
                var staff = staves[i];
                for (var v = 0; v < 4; v++) {
                    var text = voiceText(m, staff * 4 + v);
                    // Voice 1 always, so an empty measure still says it is empty; the others only where used.
                    if (v === 0 || text.length > 0) {
                        voices.push({ measure: n, staff: staff + 1, voice: v + 1, notation: text });
                    }
                }
                var verses = {};
                for (var seg = m.firstSegment; seg && seg.tick < end; seg = seg.nextInMeasure) {
                    for (var vv = 0; vv < 4; vv++) {
                        var cr = seg.elementAt(staff * 4 + vv);
                        if (cr && cr.type === Element.CHORD && cr.lyrics) {
                            for (var l = 0; l < cr.lyrics.length; l++) {
                                var lyric = cr.lyrics[l];
                                var verse = lyric.verse + 1;
                                // 1 and 3 begin or continue a hyphenated word; the hyphen is the reader's cue.
                                var joined = lyric.syllabic === 1 || lyric.syllabic === 3 ? "-" : "";
                                (verses[verse] = verses[verse] || []).push(plain(lyric.text) + joined);
                            }
                        }
                    }
                }
                for (var verseNo in verses) {
                    lyrics.push({ measure: n, staff: staff + 1, verse: Number(verseNo), text: verses[verseNo].join(" ") });
                }
            }
            for (var at = m.firstSegment; at && at.tick < end; at = at.nextInMeasure) {
                var annotations = at.annotations;
                for (var k = 0; k < annotations.length; k++) {
                    var kind = markingKind(annotations[k]);
                    var on = Math.floor(annotations[k].track / 4);
                    var said = kind === null ? "" : markingText(annotations[k]);
                    // A chord symbol imported from MusicXML keeps no text a plugin can read; one with nothing to say is left out.
                    if (said.length > 0 && (staves.indexOf(on) >= 0 || kind === "tempo" || kind === "system text" || kind === "rehearsal mark")) {
                        markings.push({ measure: n, beat: beatOf(m, at.tick), staff: on + 1, kind: kind, text: said });
                    }
                }
            }
        }
        return { from: from, to: to, measures: all.length, timeSignatures: signatures, voices: voices, lyrics: lyrics, markings: markings };
    }

    function selection() {
        var score = needScore();
        var chosen = score.selection;
        var all = measures();
        if (chosen.isRange && chosen.startSegment) {
            var first = numberAt(all, chosen.startSegment.tick);
            var last = chosen.endSegment ? numberAt(all, chosen.endSegment.tick - 1) : all.length;
            var staves = [];
            for (var s = chosen.startStaff; s < chosen.endStaff; s++) staves.push(s);
            var read = passage(all, first, Math.min(last, first + 63), staves);
            read.kind = "range";
            read.staves = staves.map(function (one) { return one + 1; });
            read.items = [];
            return read;
        }
        var items = [];
        for (var i = 0; i < chosen.elements.length && items.length < 200; i++) {
            var element = chosen.elements[i];
            var target = element.type === Element.NOTE ? element.parent : element;
            var where = target.parent && target.parent.type === Element.SEGMENT ? target.parent.tick : null;
            var described = { kind: element.name, staff: Math.floor(element.track / 4) + 1, voice: element.track % 4 + 1 };
            if (where !== null) {
                var n = numberAt(all, where);
                described.measure = n;
                described.beat = beatOf(all[n - 1], where);
            }
            if (element.type === Element.NOTE) {
                described.text = nameOf(element) + durationOf(target.duration);
            } else if (element.type === Element.CHORD || element.type === Element.REST) {
                described.text = tokenOf(element);
            } else if (element.text !== undefined) {
                described.text = plain(element.text);
            }
            items.push(described);
        }
        return {
            kind: items.length === 0 ? "nothing" : "list", from: null, to: null, staves: [], measures: all.length,
            items: items, timeSignatures: [], voices: [], lyrics: [], markings: []
        };
    }

    /**
     * Notation into one staff's voice from a measure (and beat) on, over what
     * was there, adding measures at the end of the score when it runs past it.
     */
    function write(a) {
        var events = parse(a.notation);
        var staff = staffAt(a.staff);
        var voice = voiceAt(a.voice);
        return edit("write", function (score) {
            var all = measures();
            var m = measureAt(all, a.measure, "measure");
            var start = tickOfBeat(m, a.beat);
            var total = 0;
            for (var i = 0; i < events.length; i++) total += events[i].ticks;
            var last = all[all.length - 1];
            var end = startOf(last) + lengthOf(last);
            var appended = 0;
            if (start + total > end) {
                appended = Math.ceil((start + total - end) / lengthOf(last));
                score.appendMeasures(appended);
                all = measures();
            }
            var cursor = score.newCursor();
            cursor.track = staff * 4 + voice;
            cursor.rewindToFraction(fractionFromTicks(start));
            if (!cursor.segment) {
                throw new Error("nothing starts at that beat in any voice of the score - write from a beat where a note or rest begins");
            }
            for (var e = 0; e < events.length; e++) {
                var event = events[e];
                cursor.setDuration(event.num, event.den);
                if (event.pitches.length === 0) {
                    cursor.addRest();
                } else {
                    cursor.addNote(event.pitches[0], false);
                    for (var p = 1; p < event.pitches.length; p++) {
                        cursor.addNote(event.pitches[p], true);
                    }
                }
            }
            var first = numberAt(all, start);
            var through = numberAt(all, start + total - 1);
            var back = passage(all, first, through, [staff]);
            return {
                staff: staff + 1,
                voice: voice + 1,
                from: first,
                to: through,
                written: events.length,
                appendedMeasures: appended,
                measures: all.length,
                readBack: back.voices.filter(function (one) { return one.voice === voice + 1; })
            };
        });
    }

    function appendMeasures(a) {
        var count = whole(a.count, "count");
        if (count < 1 || count > 500) {
            throw new Error("count is how many measures to add, 1 to 500");
        }
        return edit("add measures", function (score) {
            score.appendMeasures(count);
            return { appended: count, measures: score.nmeasures };
        });
    }

    readonly property var frameStyles: ({ title: "TITLE", subtitle: "SUBTITLE", composer: "COMPOSER", lyricist: "LYRICIST" })
    readonly property var metaTags: ({ title: "workTitle", subtitle: "subtitle", composer: "composer", lyricist: "lyricist" })

    /** Title, subtitle, composer and lyricist: the score's properties, and the text in its title frame. */
    function setMetadata(a) {
        var given = [];
        for (var field in frameStyles) {
            if (typeof a[field] === "string") given.push(field);
        }
        if (given.length === 0) {
            throw new Error("there is nothing to set - pass title, subtitle, composer or lyricist");
        }
        return edit("set score details", function (score) {
            // The frame first: it is what can fail, and a property set before a failure would not be rolled back.
            for (var i = 0; i < given.length; i++) {
                var field = given[i];
                var existing = frameText(score, frameStyles[field]);
                if (existing) {
                    if (a[field].length === 0) {
                        removeElement(existing);
                    } else {
                        existing.text = a[field];
                    }
                } else if (a[field].length > 0) {
                    score.addText(frameStyles[field], a[field]);
                }
            }
            for (var j = 0; j < given.length; j++) {
                score.setMetaTag(metaTags[given[j]], a[given[j]]);
            }
            return {
                title: score.metaTag("workTitle") || "",
                subtitle: score.metaTag("subtitle") || "",
                composer: score.metaTag("composer") || "",
                lyricist: score.metaTag("lyricist") || ""
            };
        });
    }

    /** The text of one style in the frame above the first measure, if there is that frame and that text. */
    function frameText(score, style) {
        var first = score.firstMeasure;
        var box = first ? first.prev : null;
        while (box && box.prev) box = box.prev;
        for (; box && box.type !== Element.MEASURE; box = box.next) {
            if (box.type !== Element.VBOX) continue;
            var inside = box.elements;
            for (var i = 0; i < inside.length; i++) {
                var item = inside[i];
                if (item.type === Element.TEXT && Number(item.subStyle) === Number(Tid[style])) {
                    return item;
                }
            }
        }
        return null;
    }

    function setTempo(a) {
        var bpm = Number(a.bpm);
        if (!isFinite(bpm) || bpm < 5 || bpm > 999) {
            throw new Error("bpm is quarter notes per minute, 5 to 999");
        }
        return edit("set tempo", function (score) {
            var all = measures();
            var m = measureAt(all, a.measure === undefined ? 1 : a.measure, "measure");
            var at = tickOfBeat(m, a.beat);
            var cursor = score.newCursor();
            cursor.track = 0;
            cursor.rewindToFraction(fractionFromTicks(at));
            if (!cursor.segment) {
                throw new Error("nothing starts at that beat - put the tempo on a beat where a note or rest begins");
            }
            // A second marking on the same beat would leave two numbers and one tempo; the new one replaces it.
            var replaced = 0;
            var here = cursor.segment.annotations;
            for (var i = here.length - 1; i >= 0; i--) {
                if (here[i].type === Element.TEMPO_TEXT) {
                    removeElement(here[i]);
                    replaced++;
                }
            }
            var marking = newElement(Element.TEMPO_TEXT);
            var said = typeof a.text === "string" && a.text.trim().length > 0 ? a.text.trim() + " " : "";
            marking.text = said + "<sym>metNoteQuarterUp</sym> = " + Math.round(bpm);
            cursor.add(marking);
            marking.tempo = bpm / 60;
            marking.tempoFollowText = false;
            return { measure: all.indexOf(m) + 1, beat: beatOf(m, at), bpm: bpm, replaced: replaced };
        });
    }

    function setTimeSignature(a) {
        var top = whole(a.numerator, "numerator");
        var bottom = whole(a.denominator, "denominator");
        if (top < 1 || top > 63 || [1, 2, 4, 8, 16, 32, 64].indexOf(bottom) < 0) {
            throw new Error(top + "/" + bottom + " is not a time signature MuseScore writes - the top is 1 to 63, the bottom 1, 2, 4, 8, 16, 32 or 64");
        }
        return edit("set time signature", function (score) {
            var all = measures();
            var m = measureAt(all, a.measure === undefined ? 1 : a.measure, "measure");
            var cursor = score.newCursor();
            cursor.track = 0;
            cursor.rewindToFraction(fractionFromTicks(startOf(m)));
            var sig = newElement(Element.TIMESIG);
            sig.timesig = fraction(top, bottom);
            cursor.add(sig);
            var after = measures();
            return { measure: all.indexOf(m) + 1, signature: top + "/" + bottom, measures: after.length };
        });
    }

    /**
     * Syllables onto successive notes of a staff's voice, from a measure on,
     * skipping rests. A syllable ending in - is joined to the next by a hyphen.
     */
    function addLyrics(a) {
        var syllables = Array.isArray(a.syllables) ? a.syllables.map(String) :
            typeof a.text === "string" ? a.text.trim().split(/\s+/) : [];
        syllables = syllables.filter(function (one) { return one.length > 0; });
        if (syllables.length === 0) {
            throw new Error("there are no syllables - pass the words, a syllable per note, with a trailing - inside a word: Twin- kle twin- kle");
        }
        var staff = staffAt(a.staff);
        var voice = voiceAt(a.voice);
        var verse = a.verse === undefined || a.verse === null ? 0 : whole(a.verse, "verse") - 1;
        if (verse < 0 || verse > 49) {
            throw new Error("verse counts from 1");
        }
        return edit("add lyrics", function (score) {
            var all = measures();
            var m = measureAt(all, a.measure === undefined ? 1 : a.measure, "measure");
            var cursor = score.newCursor();
            cursor.track = staff * 4 + voice;
            cursor.rewindToFraction(fractionFromTicks(tickOfBeat(m, a.beat)));
            var placed = 0;
            var replaced = 0;
            var joining = false;
            var lastTick = null;
            while (cursor.segment && placed < syllables.length) {
                var element = cursor.element;
                if (element && element.type === Element.CHORD) {
                    var raw = syllables[placed];
                    var hyphen = raw.length > 1 && raw.charAt(raw.length - 1) === "-";
                    var word = hyphen ? raw.slice(0, -1) : raw;
                    for (var l = element.lyrics.length - 1; l >= 0; l--) {
                        if (element.lyrics[l].verse === verse) {
                            removeElement(element.lyrics[l]);
                            replaced++;
                        }
                    }
                    var lyric = newElement(Element.LYRICS);
                    lyric.text = word;
                    lyric.verse = verse;
                    // 0 a word on its own, 1 begins one, 3 is inside one, 2 ends one.
                    lyric.syllabic = hyphen ? (joining ? 3 : 1) : (joining ? 2 : 0);
                    cursor.add(lyric);
                    joining = hyphen;
                    placed++;
                    lastTick = cursor.tick;
                }
                if (!cursor.next()) break;
            }
            return {
                placed: placed,
                left: syllables.slice(placed),
                replaced: replaced,
                through: lastTick === null ? null : numberAt(all, lastTick)
            };
        });
    }

    readonly property var textKinds: ({ staff: "STAFF_TEXT", system: "SYSTEM_TEXT", expression: "EXPRESSION", rehearsal: "REHEARSAL_MARK" })

    function addText(a) {
        var kind = a.kind === undefined || a.kind === null || a.kind === "" ? "staff" : String(a.kind);
        if (!textKinds[kind]) {
            throw new Error("kind " + kind + " is not one this bridge adds - staff, system, expression or rehearsal");
        }
        if (typeof a.text !== "string" || a.text.trim().length === 0) {
            throw new Error("there is no text to add");
        }
        var staff = staffAt(a.staff === undefined || a.staff === null ? 1 : a.staff);
        return edit("add text", function (score) {
            var all = measures();
            var m = measureAt(all, a.measure === undefined ? 1 : a.measure, "measure");
            var at = tickOfBeat(m, a.beat);
            var cursor = score.newCursor();
            cursor.track = staff * 4;
            cursor.rewindToFraction(fractionFromTicks(at));
            if (!cursor.segment) {
                throw new Error("nothing starts at that beat - put the text on a beat where a note or rest begins");
            }
            var item = newElement(Element[textKinds[kind]]);
            item.text = a.text;
            cursor.add(item);
            return { measure: all.indexOf(m) + 1, beat: beatOf(m, at), staff: staff + 1, kind: kind, text: a.text };
        });
    }

    function undo() {
        needScore();
        // Not inside startCmd: undo is MuseScore's own command, and wrapping it would make it a step of its own.
        cmd("action://notation/undo");
        return { undone: true, measures: curScore.nmeasures };
    }

    readonly property var exportFormats: ["pdf", "png", "svg", "mid", "midi", "musicxml", "mxl", "xml", "mp3", "wav", "ogg", "flac"]

    /** The open score, written to a file on the machine MuseScore runs on, in a format named by the extension. */
    function exportScore(a) {
        var score = needScore();
        var path = typeof a.path === "string" ? a.path.trim() : "";
        var dot = path.lastIndexOf(".");
        if (path.length === 0 || dot <= 0) {
            throw new Error("path has to name a file, ending in its format: /home/me/song.pdf");
        }
        var ext = path.slice(dot + 1).toLowerCase();
        if (ext === "mscz" || ext === "mscx") {
            throw new Error("MuseScore does not let a plugin save its own format - export musicxml or mxl, or save with File > Save");
        }
        if (exportFormats.indexOf(ext) < 0) {
            throw new Error("." + ext + " is not a format MuseScore exports - use one of " + exportFormats.join(", "));
        }
        if (!writeScore(score, path, ext)) {
            throw new Error("MuseScore could not write " + path + " - check that the folder exists and can be written to");
        }
        return { path: path, format: ext };
    }
}
