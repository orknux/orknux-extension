# MuseScore

An agent that reads and writes the score open in
[MuseScore 4](https://musescore.org): it looks at the parts, the key and what
is in each measure, then writes a melody, a bass line, lyrics, a tempo or the
title into it while you watch - and every change it makes is one step of
MuseScore's Undo.

MuseScore has no way in from outside except through a plugin of its own, so
this comes in two halves. The **Orknux bridge** is a small MuseScore plugin,
[`orknux-bridge.qml`](https://github.com/michjak-szymanski/orknux-extension/blob/main/plugins/musescore/bridge/orknux-bridge.qml)
([raw](https://raw.githubusercontent.com/michjak-szymanski/orknux-extension/main/plugins/musescore/bridge/orknux-bridge.qml)),
that listens on a port and answers commands about the open score. This plugin
is the other half, and talks to it over a WebSocket.

## Setting it up

1. Put `orknux-bridge.qml` in MuseScore's plugins folder -
   `Documents/MuseScore4/Plugins` in your home folder - and enable it under
   **Home › Plugins** (older versions: **Plugins › Manage plugins…**).
2. **Each time MuseScore starts**, run **Plugins › Orknux bridge**. It shows
   nothing and listens on port 8084 until MuseScore closes.
3. Load this plugin and accept `NETWORK_REQUEST`.
4. Add a connection of its kind, **MuseScore**, with the bridge's address -
   `http://localhost:8084` when MuseScore runs on the same machine as the
   server. **Test** asks the address whether it is the bridge and what score is
   open.

**The bridge listens on every network interface and has no sign-in** - that is
how MuseScore's plugin WebSocket works - so anyone who can reach the machine on
that port can edit the open score. Set `key` at the top of the bridge file to a
secret of your own, and give the connection **API key** authentication with the
same secret; a command without it is refused. The port is the other setting
there. Calls go through the server's proxy rules like any other request.

## What it does

Every call takes the connection as its first argument, `musescore`:

- `score` - title and credits, the parts and their staves, measures, key, time
  signatures, tempos.
- `read` - measures as text notation per staff and voice, with lyrics and
  markings: `C4/4 [C4 E4 G4]/2 r/8 F#5/8.`
- `selection` - what you have selected in MuseScore.
- `write` - notation into a staff and voice from a measure on, adding measures
  at the end when needed; answers the measures read back.
- `writePassages` - several passages in one call, each written or refused on
  its own.
- `appendMeasures`, `setTimeSignature`, `setTempo`.
- `addLyrics` - syllables under notes, `Twin- kle twin- kle`.
- `addText` - staff, system, expression or rehearsal text.
- `setDetails` - title, subtitle, composer, lyricist.
- `undo` - one or more steps of MuseScore's own Undo.
- `exportScore` - a PDF, MusicXML, MIDI or audio copy, written on MuseScore's
  machine.

Measures and staves count from 1 in score order, voices 1 to 4, and pitches are
concert pitch. MuseScore chooses how each written note is spelled. Ties and
tuplets are read but not written, and nothing here saves the score - that stays
your Ctrl+S.

All of them are offered to agents as tools, with two skills: writing into an
open score (read first, how things are counted, the notation, undo), and
setting lyrics and markings.
