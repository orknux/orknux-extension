/**
 * The contract as the sandbox presents it: the globals, no imports.
 *
 * This is the other way to write a plugin, and the one the server's own template
 * uses. Nothing is imported, so nothing has to be bundled — the file compiles to
 * itself, and what the editor checks it against is declared here rather than
 * pulled in. The declarations mirror the template the server serves from
 * `/api/plugins/template`, which is filled in from what that build actually
 * enforces; these are the same names and fields, pinned to the server this
 * package tracks.
 *
 *     /// <reference types="@orknux/plugin/globals" />
 *
 * or, once, in tsconfig.json:
 *
 *     { "compilerOptions": { "types": ["@orknux/plugin/globals"] } }
 *
 * Use it when a plugin is a single file with no dependencies and you would
 * rather not run a bundler at all — `tsc` alone produces something the server
 * takes. Everything else wants `import { definePlugin, fn } from '@orknux/plugin'`,
 * which is the same contract with the parameter types carried into `run`.
 *
 * Do not load both in one file. They describe the same classes, and an import
 * shadows the global of the same name, which reads as a puzzle rather than as
 * the choice it is.
 */

/** The shape of a value crossing between a workflow and a plugin. */
type OrknuxValueType = 'string' | 'number' | 'boolean' | 'map' | 'array';

/** What a plugin may ask for. Exactly this list, and nothing else. */
type OrknuxPermission = 'CONSOLE' | 'INTL' | 'TEXT_ENCODING' | 'PERFORMANCE' | 'TEMPORAL';

/** What a plugin may ask the server to do for it. Exactly this list, and nothing else. */
type OrknuxCapability =
  | 'SLACK_READ_THREAD'
  | 'SLACK_POST_MESSAGE'
  | 'SLACK_ADD_REACTION'
  | 'SLACK_READ_MESSAGE'
  | 'SLACK_READ_USER'
  | 'SLACK_MENTION'
  | 'SLACK_SEARCH'
  | 'NETWORK_REQUEST'
  | 'RENDER_PNG'
  | 'RENDER_PDF';

/** The kinds of connection a workspace can hold. */
type ConnectionType = 'SLACK' | 'SMTP' | 'HTTP';

/**
 * A connection the workspace configured, handed to a plugin as a handle.
 *
 * An id and a type and nothing else. A plugin cannot open a socket — the
 * sandbox has no network and no permission can ask for one — so what crosses is
 * a name for a connection the server will use on the plugin's behalf, never the
 * connection itself and never its credential.
 *
 * The type parameter is what makes `SlackConnection` mean something: it appears
 * as a member, so a Jira connection is not assignable where a Slack one is
 * wanted and the mistake is caught where it is written rather than at the first
 * call.
 */
declare class OrknuxConnection<T extends ConnectionType> {
  readonly id: number;
  readonly type: T;
}

/** A Slack connection, which is what the Slack helpers take. */
type SlackConnection = OrknuxConnection<'SLACK'>;

/** One message in a Slack thread, as much of it as anything here needs. */
interface SlackThreadMessage {
  /** Slack's timestamp, which is also the message's id. */
  ts: string;
  /** Who wrote it, or the bot that did. Null where Slack said neither. */
  user: string | null;
  text: string;
  /** Whether this is the message the thread hangs under rather than a reply. */
  parent: boolean;
}

/** A thread that was read, or why it could not be. */
type SlackThread =
  | {
      messages: SlackThreadMessage[];
      /**
       * Slack's own count of the replies under the parent.
       *
       * Not `messages.length - 1`: a page holds what was asked for and the
       * count is of the whole thread. It is the number a filter wants —
       * `replies === 1` is the first reply.
       */
      replies: number;
      error?: undefined;
    }
  | {
      /**
       * Why not, in Slack's own words where they were Slack's:
       * `not_in_channel`, `thread_not_found`, and the rest.
       *
       * A refusal rather than a thrown error, so a plugin can say something
       * useful about it. Check for it before reading `messages`.
       */
      error: string;
      messages?: undefined;
      replies?: undefined;
    };

/** A message that was posted — its channel and its own `ts` — or why not. */
type SlackPost =
  | { channel: string; ts: string | null; error?: undefined }
  | { error: string; channel?: undefined; ts?: undefined };

/** Whether a reaction went on. Already-reacted counts as ok. */
type SlackReaction = { ok: true; error?: undefined } | { error: string; ok?: undefined };

/** The one message a permalink points at, or why it could not be read. */
type SlackLinkedMessage =
  | {
      channel: string;
      ts: string;
      user: string | null;
      text: string;
      threadTs: string | null;
      error?: undefined;
    }
  | { error: string; text?: undefined };

/** Who a user id belongs to, or why that could not be said. */
type SlackUserInfo =
  | {
      id: string;
      name: string;
      realName: string | null;
      displayName: string | null;
      bot: boolean;
      error?: undefined;
    }
  | { error: string; id?: undefined };

/** The notation Slack renders as a mention, ready to put in a message. */
type SlackMention =
  | { mention: string; id: string; label: string; error?: undefined }
  | { error: string; mention?: undefined };

/** What a search of Slack's messages came to, or why it could not be run. */
/** What the workflow editor's target box would offer for what was typed, or why it could not be asked. */
type SlackSuggestions =
  | {
      outcome: string;
      message: string;
      matches: { id: string; name: string; kind: 'CHANNEL' | 'USER'; realName: string | null }[];
      complete: boolean;
      error?: undefined;
    }
  | { error: string; matches?: undefined };

type SlackSearchResult =
  | {
      matches: {
        channel: string | null;
        channelName: string | null;
        ts: string | null;
        user: string | null;
        text: string;
        /** The way back to the message, for the thread around it. */
        permalink: string | null;
      }[];
      /** How many the whole search holds, not how many came back. */
      total: number;
      error?: undefined;
    }
  | { error: string; matches?: undefined; total?: undefined };

/**
 * What came back, or why nothing did.
 *
 * A refusal is data rather than a thrown error, so a plugin can say something
 * useful about it — and so a condition that could not be decided does not
 * quietly decide. `json` sits beside `body` where the reply parsed as JSON;
 * `body` is always the text that arrived.
 */
type OrknuxResponse =
  | {
      status: number;
      headers: Record<string, string>;
      body: string;
      json?: unknown;
      error?: undefined;
    }
  | {
      error: string;
      status?: undefined;
      headers?: undefined;
      body?: undefined;
      json?: undefined;
    };

/**
 * A binary answer: the bytes as base64, and what they claim to be. Base64 is
 * the one shape bytes have in a sandbox where everything crosses as text.
 */
type OrknuxBinaryResponse =
  | {
      status: number;
      headers: Record<string, string>;
      /** The answer's bytes, base64-encoded. */
      base64: string;
      /** How many bytes that decodes to. */
      size: number;
      /** The answer's own content-type header, or null where it sent none. */
      contentType: string | null;
      error?: undefined;
    }
  | {
      error: string;
      status?: undefined;
      headers?: undefined;
      base64?: undefined;
      size?: undefined;
      contentType?: undefined;
    };

/** A picture drawn from markup, or the sentence saying why none was. */
/**
 * One page of a PDF, drawn - or the sentence saying why it was not.
 *
 * Richer than `OrknuxDrawnPng` on purpose: the caller here is checking a
 * layout, and "how wide did it come out" and "is there a page two" are the two
 * questions it has next.
 */
type OrknuxDrawnPdfPage =
  | { base64: string; bytes: number; width: number; height: number; pages: number; error?: undefined }
  | {
      error: string;
      base64?: undefined;
      bytes?: undefined;
      width?: undefined;
      height?: undefined;
      pages?: undefined;
    };

/**
 * What a PDF says, as HTML - or the sentence saying why it says nothing.
 *
 * `pages` is the document's own page count, `from` and `to` the range that was
 * actually read: a caller that asked for the beginning of a long report needs
 * to know where the beginning ended, because a document too large to hand over
 * in one piece is refused by size and a range is the way out of that.
 *
 * `characters` is how much text came back, which is what a caller deciding
 * whether to hand it to a model wants to know before it does.
 */
type OrknuxPdfHtml =
  | { html: string; pages: number; from: number; to: number; characters: number; error?: undefined }
  | {
      error: string;
      html?: undefined;
      pages?: undefined;
      from?: undefined;
      to?: undefined;
      characters?: undefined;
    };

type OrknuxDrawnPng =
  | { base64: string; bytes: number; error?: undefined }
  | { error: string; base64?: undefined; bytes?: undefined };

/** What `orknux.session.store.put` answered: stored, or refused in a sentence. */
type OrknuxStorePut = { ok: true; error?: undefined } | { error: string; ok?: undefined };

/**
 * What a stored value is. `binary` says how it is kept: true, the value is a
 * string of base64 bytes; false, it is the thing itself.
 */
type OrknuxStoredKind = { contentType: string | null; binary: boolean };

/**
 * What a crypto call is handed: bytes as base64, or text the server encodes as
 * UTF-8 for you.
 *
 * The second form is there so a plugin that only wants to hash a string need
 * not ask for `TEXT_ENCODING` to turn it into bytes first.
 */
type OrknuxCryptoInput = { base64: string; text?: undefined } | { text: string; base64?: undefined };

/** What a digest, a derivation or a handful of random bytes came to. */
type OrknuxDigest =
  | { base64: string; error?: undefined }
  | { error: string; base64?: undefined };

/** Whether two byte strings are the same, compared in constant time. */
type OrknuxComparison =
  | { equal: boolean; error?: undefined }
  | { error: string; equal?: undefined };

/** What `decodeBase64` came to: the text those bytes spell, or why they spell none. */
type OrknuxText = { text: string; error?: undefined } | { error: string; text?: undefined };

type OrknuxDigestAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'sha1' | 'md5';

/**
 * What the server will do on a plugin's behalf.
 *
 * A plugin has no network and no way to ask for one, so the calls that have to
 * reach outside are made by the server, under a capability the plugin declares
 * and a person accepts, and what crosses is data.
 *
 * Every call but `log` needs its capability. Without it the call answers
 * `{ error }` saying so, rather than reaching anything.
 */
declare const orknux: {
  slack: {
    /**
     * The messages in one Slack thread, oldest first.
     *
     * Needs the `SLACK_READ_THREAD` capability.
     *
     * @param connection which Slack to read through. A workspace with two Slack
     *   connections has two Slacks, and a reply that arrived on one has to be
     *   read through that one — so pass the connection the trigger says its
     *   event came in on rather than assuming.
     * @param channel the channel's id, as the trigger gives it.
     * @param threadTs the parent's timestamp — Slack's `thread_ts`, which every
     *   reply in the thread carries.
     * @param limit how many to fetch; the count comes back whatever this is.
     *   Capped by the server.
     */
    thread(
      connection: SlackConnection,
      channel: string,
      threadTs: string,
      limit?: number,
    ): SlackThread;

    /**
     * Post a message through a connection the plugin was given.
     *
     * Needs the `SLACK_POST_MESSAGE` capability.
     *
     * @param connection which Slack to post through.
     * @param channel the channel id, or a `#name`/`@handle` it resolves.
     * @param text what to say.
     * @param threadTs when set, the message joins that thread. The answer's
     *   `ts` is the new message's own timestamp, which `react` hangs on and a
     *   reply threads onto.
     */
    post(
      connection: SlackConnection,
      channel: string,
      text: string,
      threadTs?: string,
    ): SlackPost;

    /**
     * Add an emoji reaction to a message.
     *
     * Needs the `SLACK_ADD_REACTION` capability.
     *
     * @param ts the message's own `ts` — `post` returns one, and every thread
     *   message carries one.
     * @param emoji the short name, with or without the colons.
     */
    react(connection: SlackConnection, channel: string, ts: string, emoji: string): SlackReaction;

    /**
     * The one message a Slack permalink points at.
     *
     * Needs the `SLACK_READ_MESSAGE` capability.
     *
     * @param link the message's permalink — what a message pasted into another
     *   message travels as.
     */
    message(connection: SlackConnection, link: string): SlackLinkedMessage;

    /**
     * Who a Slack user id is.
     *
     * Needs the `SLACK_READ_USER` capability.
     *
     * @param userId the id, bare or as the `<@U…>` notation a message carries
     *   it in.
     */
    user(connection: SlackConnection, userId: string): SlackUserInfo;

    /**
     * The notation that pings somebody, from their name.
     *
     * Needs the `SLACK_MENTION` capability.
     *
     * @param name a display name, username, email, id, or a user group's
     *   handle — with or without the `@`. The answer's `mention` goes into
     *   `post`'s text as it is.
     */
    mention(connection: SlackConnection, name: string): SlackMention;

    /**
     * Search Slack's messages, the way the search box does.
     *
     * Needs the `SLACK_SEARCH` capability — and, from Slack's own side, a
     * **user** token: `search.messages` refuses the usual bot token with
     * `not_allowed_token_type`, and that refusal comes back as the error.
     *
     * @param query in Slack's search syntax — `in:#channel`, `from:@name`
     *   and the rest work as they do in the box.
     * @param limit how many matches to bring back; capped to one page.
     */
    search(connection: SlackConnection, query: string, limit?: number): SlackSearchResult;

    /**
     * Members and channels for what somebody typed, ranked the way the
     * workflow editor's target box ranks them. Needs `SLACK_SUGGEST`.
     */
    suggest(
      connection: SlackConnection,
      typed: string,
      kind?: 'USER' | 'CHANNEL',
      limit?: number,
    ): SlackSuggestions;
  };

  http: {
    /**
     * One HTTP request, made by the server on this plugin's behalf.
     *
     * Needs the `NETWORK_REQUEST` capability, which is the widest thing a
     * plugin can ask for and the one an administrator will think hardest
     * about: it reaches anything the server can. Ask for it only if the plugin
     * is about an outside service, and say in the plugin's description which
     * one.
     *
     * Where a request may get to is the installation's proxy rules, which this
     * cannot see and cannot argue with. The body comes back as text; there are
     * no bytes here, because there is nowhere in the sandbox to put them. An
     * object body goes out as JSON with the content-type set — the header is
     * the half people forget — and a string body is passed through untouched.
     *
     * @param what the url on its own, or the whole request.
     */
    request(
      what:
        | string
        | {
            url: string;
            method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
            headers?: Record<string, string>;
            body?: string | Record<string, unknown> | readonly unknown[];
          },
    ): OrknuxResponse;

    /** The same, for the request nearly everybody wants. */
    get(url: string, headers?: Record<string, string>): OrknuxResponse;

    /** And the other one. An object body goes as JSON, with the header set. */
    post(
      url: string,
      body?: string | Record<string, unknown> | readonly unknown[],
      headers?: Record<string, string>,
    ): OrknuxResponse;

    /**
     * Sends bytes — a file — given as base64, which is the one shape binary
     * has here. Sent as an octet stream unless `contentType` or a header says
     * what it is; POST, capped at 10 MB of decoded bytes. Needs
     * `NETWORK_REQUEST` like every other request.
     */
    upload(
      url: string,
      base64: string,
      contentType?: string,
      headers?: Record<string, string>,
    ): OrknuxResponse;

    /**
     * Fetches binary content — an image, a PDF — and answers `base64`,
     * `contentType` and `size` instead of `body`, because a PNG does not
     * survive being read as a string. Capped at 5 MB of bytes.
     */
    download(url: string, headers?: Record<string, string>): OrknuxBinaryResponse;
  };

  /**
   * Arithmetic the sandbox has no instruction for.
   *
   * GraalJS has no crypto at all — not a digest, not an HMAC, not a random
   * number — so a plugin verifying a webhook signature or speaking an
   * authentication handshake could not begin. These are the smallest surface
   * that removes that wall.
   *
   * **Not granted, and deliberately so.** No permission, no capability, no
   * acceptance dialog: a digest reaches nothing, sends nothing and learns
   * nothing. It is in the same class as `JSON.parse`, and the server computes
   * it only because the sandbox has no way to. Making every plugin declare a
   * capability to compute a SHA-256 would be a dialog with no decision behind
   * it, and a dialog nobody can answer meaningfully is one they learn to click
   * through.
   *
   * Every call answers an object: `base64` on success, `error` and nothing
   * else on refusal — a refusal is data a plugin can act on, never a throw.
   */
  crypto: {
    /** The digest of some bytes. */
    hash(algorithm: OrknuxDigestAlgorithm, input: OrknuxCryptoInput): OrknuxDigest;

    /** HMAC, keyed. What a webhook signature is checked with. */
    hmac(
      algorithm: OrknuxDigestAlgorithm,
      key: OrknuxCryptoInput,
      input: OrknuxCryptoInput,
    ): OrknuxDigest;

    /**
     * A key derived from a password, the slow way on purpose.
     *
     * `length` is how many bytes are wanted. `iterations` is capped — see
     * [MAX_PBKDF2_ITERATIONS], and note that over the cap is a refusal rather
     * than a clamp.
     */
    pbkdf2(
      algorithm: OrknuxDigestAlgorithm,
      password: OrknuxCryptoInput,
      salt: OrknuxCryptoInput,
      iterations: number,
      length: number,
    ): OrknuxDigest;

    /** Bytes from the platform's secure source — a nonce, a state, an idempotency key. */
    random(bytes: number): OrknuxDigest;

    /**
     * Whether two byte strings match, in time that does not depend on where
     * they first differ.
     *
     * Comparing a signature with `===` leaks its prefix through how long the
     * comparison took, one byte at a time, which is enough to forge one. This
     * is here rather than left to the plugin because a constant-time
     * comparison written in JavaScript stops being constant-time as soon as a
     * JIT has looked at it.
     */
    timingSafeEqual(a: OrknuxCryptoInput, b: OrknuxCryptoInput): OrknuxComparison;
  };

  /**
   * Turning one representation into another. Not cryptography, and kept apart
   * from it on purpose.
   *
   * Base64 is an encoding: nothing about it is secret, keyed or one-way. Under
   * `crypto` it would teach the misconception that causes real incidents — that
   * base64 is a kind of protection — so it lives where it belongs, beside the
   * other conversions rather than beside the digests.
   *
   * Ungranted for the same reason `crypto` is: it reaches nothing, sends
   * nothing and learns nothing. That matters practically as well as tidily —
   * every `crypto` call takes bytes, and without an ungranted way to make bytes
   * from a string an ungranted API would be unreachable to a plugin that never
   * asked for `TEXT_ENCODING`.
   */
  encoding: {
    /** Text as the base64 of its UTF-8 bytes. */
    encodeBase64(text: string): OrknuxDigest;

    /**
     * Base64 back to the text it spells, or a sentence saying it spells none.
     *
     * The one conversion here that can fail. Base64 is bytes and text is
     * characters, and not every sequence of bytes is a sequence of characters
     * — a plugin decoding a digest expecting to read it gets told so, rather
     * than a string of replacement marks that looks like data.
     */
    decodeBase64(base64: string): OrknuxText;
  };

  /**
   * The AI session's own store, for a plugin that has to keep its place
   * between the calls of one conversation.
   *
   * What one tool call puts, a later one gets, for as long as the session
   * lives — and no other session ever sees it. Not a capability: nothing
   * outside the session is reached by it. The doors only exist where the call
   * was made inside an AI session; anywhere else `put` answers `{ error }`
   * saying so and `get` answers null.
   */
  session: {
    store: {
      /**
       * Stores one value under a key, replacing what was there. The value
       * makes the trip as JSON, so what comes back out is a copy — and
       * anything JSON cannot say (a function, undefined) does not survive.
       */
      put(key: string, value: unknown, kind?: OrknuxStoredKind): OrknuxStorePut;

      /** What the key holds, parsed, or null where nothing does. */
      get(key: string): unknown;

      /**
       * What the key was recorded as holding - its type, and whether the
       * value is base64 bytes - or null where nothing was said: an older
       * server, or a key put without a kind. Read it rather than guessing
       * from the value; guessing is how a PDF reached Slack as base64 text.
       */
      kind(key: string): OrknuxStoredKind | null;
    };
  };

  /**
   * Not a capability, and never needed granting — nothing is reached by it.
   * The line crosses as text and the server decides where it goes; a level
   * below the installation's threshold is dropped where it was written, so
   * tracing can stay in.
   */
  /**
   * Drawing an SVG into a picture, which is the one thing about a diagram
   * this sandbox cannot do for itself.
   *
   * A capability rather than a builtin because it is the server's work:
   * rasterising needs a rasteriser, and there is neither one here nor the
   * WebAssembly to bring one. What it reaches is nothing - markup goes out,
   * bytes computed from it come back. No connection, no address, no
   * credential - which is why `RENDER_PNG` is the narrowest thing on the
   * capability list rather than the widest.
   *
   * Wanted because Slack, and most places a diagram is read, draw no SVG at
   * all: they host one as a file and show a card. A picture is what a person
   * sees.
   */
  render: {
    /**
     * The SVG drawn as a PNG, answered as base64 and its byte count.
     *
     * `width` sets the picture's width in pixels, leaving the height to
     * follow the drawing's own proportions; left out, the size the SVG
     * declares is the size that is drawn.
     */
    pngFromSvg(svg: string, width?: number): OrknuxDrawnPng;

    /**
     * One page of a PDF, drawn as a PNG - `RENDER_PDF`.
     *
     * What something that just made a document uses to look at what it
     * actually produced. A PDF is bytes and a model that can see reads
     * pictures, so without this an agent reports that the report is ready
     * because that is what it did, rather than because that is what came out.
     *
     * Its own grant rather than `RENDER_PNG`: the reach is the same, which is
     * nothing, but the parser is not - a PDF carries an embedded-file model,
     * an encryption model and a font stack, and an operator may reasonably
     * draw markup without handing documents to one.
     *
     * `pdf` is the document as base64, which is the shape a plugin that made
     * one already holds it in. `page` counts from one and defaults to the
     * first; a page past the end is refused by name rather than rounded into
     * the first. `width` sets the picture's width in pixels, left out for
     * 96 dpi.
     */
    pngFromPdf(pdf: string, page?: number, width?: number): OrknuxDrawnPdfPage;

    /**
     * What a PDF says, as HTML - `RENDER_PDF`.
     *
     * The other question about a document. `pngFromPdf` answers *how does it
     * look*; this answers *what does it say*, which is the one a plugin can
     * act on rather than only show.
     *
     * The same grant as drawing, and deliberately: the same parser, the same
     * embedded-file and encryption and font models, the same risk surface. A
     * second capability would ask an operator to weigh a distinction that is
     * not there.
     *
     * The text comes back in reading order - a `<section data-page="N">` per
     * page and a `<p>` per block, with single newlines inside a block folded
     * to spaces, because those are where the page wrapped rather than where a
     * sentence ended. A two-column page reads as two columns.
     *
     * Not a layout answer. Columns, tables and anything positioned rather than
     * written are flattened, and text that is a `<script>` comes back escaped.
     * For a question about how the page is arranged, draw it.
     *
     * `from` and `to` count from one and are both optional. 200,000 characters
     * is the most one call returns; past that it is refused with the number in
     * the sentence, and a range is the way through.
     */
    htmlFromPdf(pdf: string, from?: number, to?: number): OrknuxPdfHtml;
  };

  log: {
    debug(...parts: unknown[]): void;
    info(...parts: unknown[]): void;
    warn(...parts: unknown[]): void;
    error(...parts: unknown[]): void;
  };
};

/**
 * One parameter of a function or a tool, as it is declared.
 *
 * Written once and referred to four times below. It used to be an inline
 * `{ name, type }` copied into each of them, which is how `required` and
 * `default` came to be accepted by the server, validated by this package, and
 * still a compile error to write.
 */
interface OrknuxParamDeclared {
  /** An identifier: letters, digits and underscores. */
  name: string;
  /** What arrives in it. */
  type: OrknuxValueType;
  /**
   * What this argument is, for whoever — or whatever — reads it.
   *
   * A tool's description is where a model looks first, and a name says what an
   * argument is called and nothing about what belongs in it.
   */
  description?: string | null;
  /**
   * Whether a call has to supply it. True unless a `default` says otherwise.
   *
   * Arguments are positional, so the ones that may be left out come last: a
   * required parameter after an optional one is refused at load.
   */
  required?: boolean;
  /**
   * What arrives when a call leaves it out — and declaring one makes the
   * parameter optional.
   *
   * `run` still receives every argument: the server puts the default in before
   * the call, so there is no `undefined` to guard against.
   */
  default?: unknown;
}

/** A function's declaration, checked as it is constructed. */
interface OrknuxFunctionDeclared {
  /** An identifier: letters, digits and underscores. */
  name: string;
  /** Optional; shown beside it in the interface. */
  description?: string;
  /** In the order `run` receives them. */
  params?: OrknuxParamDeclared[];
  /** What it answers with. A function has to answer something. */
  returnType: OrknuxValueType;
  /** What it does. Stays here; the server calls back into it. */
  run: (...args: never[]) => unknown;
}

/** A tool's declaration — a run of its own, offered to agents. */
interface OrknuxToolDeclared {
  /** An identifier: letters, digits and underscores. */
  name: string;
  /** Written for the model that reads it: when to call this, and with what. */
  description?: string;
  /** In the order `run` receives them. */
  params?: OrknuxParamDeclared[];
  /** What it answers with. A tool answers a model, so it has to answer something. */
  returnType: OrknuxValueType;
  /** What it does. Stays here; the server calls back into it. */
  run: (...args: never[]) => unknown;
}

/** A proxy's declaration — one of this plugin's own functions, fronted for agents. */
interface OrknuxFunctionToolDeclared {
  /** The name of one of this plugin's functions, as `functions()` declares it. */
  function: string;
  /** What agents call it. Defaults to the function's own name. */
  name?: string;
  /** Written for the model. Defaults to the function's description. */
  description?: string;
}

/** What a parameter may be: exactly what a workspace variable can hold. */
type OrknuxParameterType = 'string' | 'number' | 'boolean' | 'connection';

/** A parameter's declaration — one thing the plugin has to be told, per workspace. */
interface OrknuxParameterDeclared {
  /** An identifier: letters, digits and underscores. */
  name: string;
  /** Optional; shown under it on the form somebody fills in. */
  description?: string;
  type: OrknuxParameterType;
  /**
   * Whether the plugin can work without it. Defaults to true, because a
   * parameter nobody needs is one nobody should be asked for.
   *
   * A workspace that has not answered a required one is marked as such in its
   * plugin list and against the parameter itself.
   */
  required?: boolean;
  /**
   * Whether this is asking for something that should not be typed into a form.
   * Defaults to false.
   *
   * Saying true refuses a typed-in value: the only way to answer it is to
   * point at one of the workspace's variables, which is where this
   * installation keeps things it encrypts.
   */
  secret?: boolean;
  /**
   * Which kind of connection, and required when `type` is `'connection'`.
   *
   * It narrows the picker to the connections the plugin can actually use: a
   * Slack plugin handed a Jira connection has been handed a credential it
   * cannot read and fails at the first call, which is a worse answer than a
   * list that never offered it.
   *
   * What arrives in `settings` is then an `OrknuxConnection<T>` — an id and a
   * type, never the connection's credential. The sandbox has no network; the
   * server makes the call.
   */
  connectionType?: ConnectionType;
  /**
   * The values this may take, where the plugin knows them all.
   *
   * What it replaces is a plugin checking the string itself and throwing a
   * sentence that lists the choices — and a choice that cannot be typed cannot
   * be mistyped. At most `MAX_OPTIONS` of them, no duplicates, none empty.
   *
   * Not on a `secret`: a secret cannot be one of a set somebody can read. Not
   * on a `connection` either — that names a row the workspace has, and already
   * has its own picker.
   */
  options?: readonly string[];
}

/**
 * What a plugin extends. Defined by the sandbox before this file is evaluated,
 * which is why it is declared rather than imported.
 */
declare abstract class OrknuxPlugin {
  /** What this plugin calls itself, and the prefix on everything it declares. */
  abstract id(): string;

  /** Which plugin API this was written against. */
  abstract apiVersion(): number;

  /** What this plugin offers to workflows. Defaults to none. */
  functions(): OrknuxFunction[];

  /**
   * What this plugin offers to agents, as tools a model calls. Defaults to
   * none.
   *
   * A surface of its own because it has a reader of its own: a tool's
   * description is read by a model deciding whether to call it, where a
   * function's is read by a person building a workflow. A tool that is really
   * one of the functions is declared as an `OrknuxFunctionTool`, which proxies
   * it rather than describing it twice — params, return type and
   * implementation stay the function's, and only the name and description may
   * be its own.
   */
  tools(): (OrknuxTool | OrknuxFunctionTool)[];

  /** What this plugin has to be told before it can work. Defaults to none. */
  parameters(): OrknuxParameter[];

  /**
   * Which JavaScript this plugin needs. Defaults to none.
   *
   * A plugin embeds its libraries rather than importing them, and a bundle
   * written for a browser or for Node often expects language features this
   * sandbox does not switch on. Say which, and whoever loads the plugin is
   * shown the list and has to accept it. Nothing is relaxed that was not
   * accepted, and nothing is relaxed for any other plugin.
   *
   * Loading is done with none of them granted, because that is the run that
   * finds out which you want — so the top level of your bundle has to evaluate
   * without them. Ask for what `run` needs, not for what loading needs.
   */
  permissions(): OrknuxPermission[];

  /**
   * What this plugin asks the server to do on its behalf. Defaults to none.
   *
   * Separate from `permissions()`, which only ever turns on a language
   * builtin. These reach outside — so they are declared apart, granted apart,
   * and shown apart to whoever accepts the plugin.
   */
  capabilities(): OrknuxCapability[];

  /**
   * The library files this plugin ships with, as paths relative to its own
   * file: `lib/util.js` or `./lib/util.js`. Defaults to none.
   *
   * The complete list — every file that arrives beside the plugin is declared
   * here, and every relative `import` in the plugin or in a library resolves
   * to a declared path. No absolute paths, no URLs, no `..`, no bare
   * specifiers — an npm dependency is still bundled in, not declared.
   *
   * Whoever loads the plugin is shown this list and has to allow it. A zip's
   * contents are checked against it; a load from a URL fetches these files,
   * resolved against the plugin's URL, and only these.
   */
  libraries(): string[];

  /**
   * The instruction sets this plugin brings: markdown an agent reads, never
   * code it runs. Defaults to none.
   *
   * A third surface, and a third reader. `functions()` is called by a
   * workflow and `tools()` by a model; a skill is neither called nor run — it
   * is a page an agent reads to learn how this plugin's work is meant to be
   * done. A plugin that offers a search tool can ship the skill saying when
   * to reach for it, and the two travel together.
   *
   * They arrive as a skill catalog named after the plugin's key, granted the
   * way any other catalog is. Nothing is automatic.
   */
  skills(): OrknuxSkill[];

  /**
   * The shapes this plugin exports, for its functions and tools to pass
   * around. Defaults to none.
   *
   * A plugin's functions belong to every workspace at once, which is why they
   * may not name a workspace's own objects — there is no single workspace
   * whose definitions they could mean. An object declared here belongs to the
   * plugin instead: it travels with it and is available wherever the plugin
   * is, under the plugin's key, so `Issue` declared by `jira` arrives as
   * `jira_Issue`. Inside the plugin, name them as you spelled them.
   */
  objects(): OrknuxObject[];

  /**
   * The value types this plugin defines, for a workspace's variables to be.
   *
   * A name over string, number or boolean, what it needs to be told, and up
   * to two functions the server calls on the plugin's behalf: `suggest` for
   * the picker as somebody types, `validate` for the save. Neither is
   * required.
   */
  types(): OrknuxType[];

  /**
   * The workflow actions this plugin offers: blocks a workflow's Action node
   * can be pointed at, listed in the editor under your label beside "Send
   * Message" and "HTTP Request". Defaults to none.
   *
   * A fourth surface with a fourth reader. A function is called with
   * positional arguments by whoever wrote the call; an action is a node on a
   * canvas whose inputs somebody wired by name. So `run(input, context)` is
   * handed one object keyed by parameter name — an `array` parameter arrives
   * as an array, a parameter nobody wired is absent — and a context carrying
   * `settings`, the same frozen object `this.settings` is. What it returns is
   * handed to the next node: an object's fields under the names `outputs`
   * declares, anything else under `result`. Throw to fail the step.
   */
  actions(): OrknuxAction[];

  /**
   * What a workspace set those parameters to, keyed by name.
   *
   * Frozen, and put there by the server for the length of one call. A
   * parameter nothing usable is set for is absent rather than null, so
   * `this.settings.token === undefined` is the question to ask.
   *
   * This is the whole of what a plugin knows about the workspace it is running
   * for. Nothing reaches a plugin that a workspace did not point at, which is
   * what makes the parameter list a readable answer to "what can this thing
   * get at?".
   */
  readonly settings: Readonly<
    Record<string, string | number | boolean | OrknuxConnection<ConnectionType> | undefined>
  >;
}

/** What each declared function is wrapped in. */
declare class OrknuxFunction {
  constructor(declaration: OrknuxFunctionDeclared);

  readonly name: string;
  readonly description: string | null;
  readonly params: OrknuxParamDeclared[];
  readonly returnType: OrknuxValueType;
  readonly run: (...args: never[]) => unknown;
}

/** A tool of the plugin's own: a declaration with a run, offered to agents. */
declare class OrknuxTool {
  constructor(declaration: OrknuxToolDeclared);

  readonly name: string;
  readonly description: string | null;
  readonly params: OrknuxParamDeclared[];
  readonly returnType: OrknuxValueType;
  readonly run: (...args: never[]) => unknown;
  /** Null: this tool has a run of its own rather than fronting a function. */
  readonly proxyOf: null;
}

/**
 * A tool that is one of this plugin's own functions, exposed to agents.
 *
 * The utility that says so rather than a copy: params, return type and
 * implementation are the function's — including any edit somebody makes to it
 * on the server later — and only the name and the model-facing description may
 * be this tool's own. A `function` that `functions()` does not declare is
 * refused at load.
 */
declare class OrknuxFunctionTool {
  constructor(declaration: OrknuxFunctionToolDeclared);

  /** The plugin's own function this tool stands in front of. */
  readonly proxyOf: string;
  readonly name: string;
  readonly description: string | null;
}

/**
 * One instruction set this plugin brings.
 *
 * Nothing here runs. `content` is markdown an agent reads, opening with a
 * `---` frontmatter block naming and describing the skill — leave the block
 * out and the server writes one from the `name` and `description` here, which
 * are the same two facts.
 */
declare class OrknuxSkill {
  constructor(declaration: {
    /** Prose, not an identifier: nothing calls a skill, an agent reads it. */
    name: string;
    /**
     * What a graph and a command name it by: letters, underscores and hyphens,
     * unique among this plugin's skills. Left out, the server derives it from
     * the name — which stops matching the moment the name changes, so a skill
     * anything points at should say its own.
     */
    id?: string | null;
    /** One line on what it is for — this is what an agent chooses from. */
    description?: string | null;
    /** The markdown itself. */
    content: string;
  });

  readonly name: string;
  readonly id: string | null;
  readonly description: string | null;
  readonly content: string;
}

/** What one field of an exported object may be. */
type OrknuxPropertyKind = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * A named shape this plugin exports.
 *
 * `of` is where a shape stops being flat: required for an `object` (it names
 * another of this plugin's objects) and for an `array` (a scalar kind, or
 * another object's name), and refused on anything else. A name that points at
 * nothing this plugin declares is refused at load.
 */
declare class OrknuxObject {
  constructor(declaration: {
    /** An identifier, conventionally PascalCase: it reads as a type. */
    name: string;
    description?: string | null;
    properties: readonly {
      name: string;
      kind: OrknuxPropertyKind;
      /** The object it points at, or what the array holds. */
      of?: string | null;
      /** What the field means, for whoever — or whatever — reads it. */
      description?: string | null;
    }[];
  });

  readonly name: string;
  readonly description: string | null;
  readonly properties: readonly {
    name: string;
    kind: OrknuxPropertyKind;
    of: string | null;
    description: string | null;
  }[];
}

/** What each declared parameter is wrapped in. */
/** One thing a type offers for what was typed. */
interface OrknuxTypeSuggestion {
  /** What the variable is set to when this is taken. */
  value: string | number | boolean;
  label?: string;
  detail?: string;
}

/** Whether a type accepts a value, and if not, why. */
type OrknuxTypeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A value type the plugin defines - `SlackUser` over string.
 *
 * `suggest` and `validate` run with `this` as the plugin, its settings on it,
 * and are handed what the variable was told as `args`; a connection argument
 * arrives as the same handle a connection setting does. A parameter may not
 * be a secret: what a variable of the type is told is kept beside it, in the
 * clear.
 */
declare class OrknuxType {
  constructor(declaration: {
    name: string;
    description?: string | null;
    base: 'string' | 'number' | 'boolean';
    parameters?: readonly (OrknuxParameterDeclared | OrknuxParameter)[];
    suggest?: (
      typed: string,
      args: Readonly<Record<string, unknown>>,
    ) => OrknuxTypeSuggestion[] | Promise<OrknuxTypeSuggestion[]>;
    validate?: (
      value: string,
      args: Readonly<Record<string, unknown>>,
    ) => OrknuxTypeVerdict | Promise<OrknuxTypeVerdict>;
  });

  readonly name: string;
  readonly description: string | null;
  readonly base: 'string' | 'number' | 'boolean';
  readonly parameters: readonly OrknuxParameter[];
}

declare class OrknuxParameter {
  constructor(declaration: OrknuxParameterDeclared);

  readonly name: string;
  readonly description: string | null;
  readonly type: OrknuxParameterType;
  readonly required: boolean;
  readonly secret: boolean;
  readonly connectionType: ConnectionType | null;
  readonly options: readonly string[] | null;
}

/**
 * What an action's input or output may be; see `actions()`.
 *
 * `object` is a free-form map. A plugin belongs to every workspace at once, so
 * it can name none of a workspace's own shapes here.
 */
type OrknuxActionValueType = 'string' | 'number' | 'boolean' | 'array' | 'object';

/** One input a workflow action takes, wired by name on the node. */
interface OrknuxActionParameter {
  /** An identifier: letters, digits and underscores. */
  name: string;
  type: OrknuxActionValueType;
  /** Whether a node has to wire it. Defaults to true. */
  required?: boolean;
  /** Shown beside the port. */
  description?: string;
}

/** One output a workflow action hands on, read by the next node under this name. */
interface OrknuxActionOutput {
  name: string;
  type: OrknuxActionValueType;
  description?: string;
}

/** What an action's `run` is told about where it is running. */
interface OrknuxActionContext {
  /** What this workspace set the plugin's parameters to — the same object `this.settings` is. */
  settings: Readonly<
    Record<string, string | number | boolean | OrknuxConnection<ConnectionType> | undefined>
  >;
  workspaceId: number;
  /** The Action's name in the workspace's catalogue. */
  action: string;
  /** When the step started, ISO-8601. */
  now: string;
  timestamp: number;
}

/**
 * A workflow action a plugin declares; see `actions()`. A plain object, like a
 * connection type: there is no constructor, and the server judges the shape
 * when the plugin is loaded.
 */
interface OrknuxAction {
  /** An identifier, stable: an Action row stores it beside the plugin's key. */
  name: string;
  /** What the node picker shows — 'Reply in the thread' rather than 'respond'. */
  label: string;
  description?: string;
  parameters?: OrknuxActionParameter[];
  outputs?: OrknuxActionOutput[];
  /** What it does. `input` is keyed by parameter name; arrays stay arrays. */
  run: (input: Record<string, unknown>, context: OrknuxActionContext) => unknown;
}
