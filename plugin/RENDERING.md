# `orknux.render`

What the server draws for a plugin, and why it has to be the server.

## Status

| what | the server today |
|------|------------------|
| `RENDER_PNG` | **accepted** — `pngFromSvg`, mirrored |
| `RENDER_PDF` | **accepted** — `pngFromPdf` and `htmlFromPdf`, both mirrored |
| a plugin using them | the drawing and document plugins did; the server embeds those now |

Both capabilities are live and both are in `limits.ts` and
`types/globals.d.ts`, so a plugin declaring either passes `check` here exactly
as the upload accepts it.

**No plugin in this repository draws any more.** `mermaid`, `plantuml`,
`nomnoml`, `charts` and `pdf` were the ones that did, and all five are the
server's own now — same tool names, different side of the sandbox wall. What
is written below is the contract a plugin is still offered, with the pdf
plugin's two halves kept as the worked example, because the shape they settled
on is the shape anything handling bytes wants.

## Why the server draws

The sandbox has no rasteriser and cannot be given one. There is no DOM and no
canvas, no WebAssembly to carry a decoder in, and the source ceiling is 5 MB —
a PDF rasteriser is an order of magnitude past that before it does anything.

So drawing is a capability rather than a library. What crosses is bytes a
plugin just produced and what comes back is bytes computed from them: no
connection, no address, no credential.

## Two grants, not one

This document proposed `pngFromPdf` under `RENDER_PNG`, on the grounds that it
reaches exactly what `pngFromSvg` reaches, which is nothing. That argument was
answered, and the answer is better:

> Its own grant rather than `RENDER_PNG`: the reach is the same, which is
> nothing, but the parser is not — a PDF carries an embedded-file model, an
> encryption model and a font stack, and an operator may reasonably draw
> markup without handing documents to one.

Reach is not the only thing a grant is about. An SVG rasteriser and a PDF
rasteriser have the same blast radius and very different attack surfaces, and
an administrator who accepts the first has not thereby accepted the second.
The recorded reasoning is worth keeping because the mistake is easy to repeat:
*it reaches nothing* answers the question of what a capability can get at, and
says nothing about what it can be handed.

## What is there

```ts
render: {
  /** The SVG drawn as a PNG — `RENDER_PNG`. */
  pngFromSvg(svg: string, width?: number): OrknuxDrawnPng;

  /** One page of a PDF, drawn as a PNG — `RENDER_PDF`. */
  pngFromPdf(pdf: string, page?: number, width?: number): OrknuxDrawnPdfPage;

  /** What a PDF says, as HTML — `RENDER_PDF`. */
  htmlFromPdf(pdf: string, from?: number, to?: number): OrknuxPdfHtml;
}
```

`pdf` is the document as base64, which is the shape a plugin that made one
already holds it in. `page` counts from one and defaults to the first; a page
past the end is refused by name rather than rounded into the first. `width` is
the picture's width in pixels, left out for 96 dpi.

```ts
type OrknuxDrawnPdfPage =
  | { base64: string; bytes: number; width: number; height: number; pages: number; error?: undefined }
  | { error: string; base64?: undefined; /* …and the rest undefined */ };
```

The three fields beyond the picture are the reason this is worth having over a
bare image. `pages` is the **document's** page count rather than this page's
number, so one call establishes both that the page exists and how many more
there are — a caller checking a document does not have to probe for the end.
`width` and `height` are the drawn picture's, which is what tells you whether
a page came out portrait when it should not have.

`pngFromSvg` answers the same way, minus the page count:

```ts
type OrknuxDrawnPng =
  | { base64: string; bytes: number; width: number; height: number; error?: undefined }
  | { error: string; base64?: undefined; /* …and the rest undefined */ };
```

The size is read off the file rather than echoed back from the request. A
`width` is what was asked for; the drawing's own proportions decide the other
side and the server's ceilings can bring both down - so a plugin that gets
back a blank and one that gets back a giant have something to tell them apart
with. It answered only `base64` and `bytes` until then, which left a bad
drawing indistinguishable from a good one.

`htmlFromPdf` answers the other question about a document: not *how does it
look* but *what does it say*.

```ts
type OrknuxPdfHtml =
  | { html: string; pages: number; from: number; to: number; characters: number; error?: undefined }
  | { error: string; html?: undefined; /* …and the rest undefined */ };
```

It shares `RENDER_PDF` with `pngFromPdf` because it shares the thing that grant
is about: handing an untrusted document to PDFBox. A second capability would
ask an administrator to weigh a distinction that is not there.

What comes back is the document's text in reading order — a `<section
data-page="N">` per page, a `<p>` per block — with the document's own text
escaped, never passed through as markup. It is **not** the page's design:
columns, tables and anything positioned rather than written are flattened into
the order they are read in. Where the layout is the question, draw the page and
look at it.

`from` and `to` count from one and both may be left out; what comes back says
which range was read and how many pages the document has, so a caller that
asked for the beginning knows where the beginning ended. A document with more
text than the server hands over at once is refused with the number in the
sentence, and a range is the answer to that.

A refusal is data rather than a throw, the way every door here answers, and
outside the sandbox the fallback says so in a sentence:

    there is no renderer here: only a call made inside the sandbox can draw one

## What it is for

Looking at what was actually produced, which nothing could do before.

`pdf_fromHtml` reports what it *knows* went wrong — a diagram that refused, a
character the bundled face cannot set — in its `problems` field. It cannot
report what went wrong silently, and layout goes wrong silently by nature: a
heading stranded at the foot of a page, a diagram crowding its column, a table
that ran off the side. The contract puts it plainly:

> a model that can see reads pictures, so without this an agent reports that
> the report is ready because that is what it did, rather than because that is
> what came out.

## The plugin half, as the pdf plugin wrote it

A function and a tool, and the split is the one the slack uploads use. The
plugin has since become the server's, and the pair is kept here because it is
the pattern rather than the plugin that matters:

```
function (workflows)  pdf_preview(base64, page, width)      -> Preview
tool     (agents)     pdf_preview(contentKey, page, width)  -> Preview
```

The **tool takes a key and has nowhere to put bytes**. A model always has one —
`pdf_fromHtml` answers a key beside the document — and a few hundred thousand
characters of base64 typed into a tool call arrives a character wrong and is
rejected before anything runs. The **function keeps taking base64**, because a
workflow node has no session and so never had a key, and refusing there would
close its only door.

**What it answers is not stripped**, and that is where this parts company with
every other tool here. The renderers and `fromHtml` answer a model a key and
keep the bytes, because nobody reads base64 and retyping it is what fails. A
preview is the exception: the picture *is* the answer, and a preview whose
picture you cannot see is not one. The key comes back too, so
`slack_uploadBinary` can show somebody the page.

`Preview` carries `pages` as the **document's** count rather than this page's
number, so one call says both that the page exists and how many more there are.

## And the same split again, for reading

`htmlFromPdf` got the same pair, and the interesting part is where they differ:

```
function (workflows)  pdf_read(base64, from, to)      -> Reading
tool     (agents)     pdf_read(contentKey, from, to)  -> Reading
```

The argument splits for the reason it always does — a workflow node has no
session, an agent cannot retype a megabyte. **What comes back does not split**,
and that is the point worth recording: `preview` strips its picture from the
agent's answer because nobody reads base64, and `read` strips nothing, because
the text *is* the answer. Slack's `readAttachment` settled this first — the key
for bytes, the text for text — and a reader whose text you have to fetch
separately is not a reader.

The key still comes back, holding the text rather than the document, because
`slack_upload` takes a `contentKey` for text.

The server's refusals are passed through rather than tidied. "that document has
3 pages" and "this call would return 431,905 characters and 200,000 is the
most; ask for a range of pages" both carry the only number that tells a caller
what to do next, and a friendlier sentence of the plugin's own would throw
exactly that away.

And the consequence that was flagged before it happened, happened: `pdf` asked
for **no capability at all** and came to ask for `RENDER_PDF`. That was a real
change to what an administrator accepts, and it is why `preview` was a separate
call rather than something `fromHtml` did on the way out - a workspace that
only writes documents never draws one and could weigh the grant on its own.
Embedded in the server none of that is asked, for the reason the server's own
notes give: a capability the product itself needs is not a thing to put to an
administrator. The lesson survives for anything written out here, where it is
still somebody else's code.
