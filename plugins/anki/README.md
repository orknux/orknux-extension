# Anki

Flashcards from wherever the reading happened: an agent turns a chat, a Slack
thread or an issue into Anki cards, and a workflow asks what is due. It talks
to the Anki desktop application through
[AnkiConnect](https://ankiweb.net/shared/info/2055492159), the add-on that lets
other programs reach Anki - Anki has no API of its own.

It brings a connection kind of its own, **AnkiConnect**. Install the add-on in
Anki (code `2055492159`), keep Anki running, and add a connection with the
add-on's address - `http://localhost:8765` when Anki runs on the same machine as
the server. The connection page explains the rest: reaching Anki on another
machine, and the optional API key, which goes in the connection's credential
with **API key** as its authentication. **Test** on that page asks the address
whether it is AnkiConnect, so a wrong address or a wrong key fails there rather
than on the first card.

Every call takes the connection as its first argument, `anki` - picked from a
list in a workflow, passed by id from an agent:

- `decks`, `noteTypes` - what there is to add to.
- `findNotes` - Anki's own search syntax, as typed in its browser.
- `addNote` - one note, Basic or Cloze or a note type of your own; a duplicate
  is refused rather than added twice.
- `addBasicNotes` - several at once, each added or skipped with the reason.
- `dueCards` - how many cards are due, and what they ask.
- `sync` - with AnkiWeb, so new cards reach your phone.

All of them are offered to agents as tools, with a skill on writing cards worth
reviewing. Calls run through the server under `NETWORK_REQUEST`, so the
installation's proxy rules govern where they may go.
