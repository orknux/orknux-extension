import type {
  ACTION_VALUE_TYPES,
  CAPABILITIES,
  CONNECTION,
  CONNECTION_TYPES,
  PARAMETER_TYPES,
  PERMISSIONS,
  VALUE_TYPES,
} from './limits.js';

/**
 * The shape of a value crossing between a workflow and a plugin.
 *
 * Derived from the list the server accepts rather than written out again, so the
 * two cannot disagree about what a plugin may declare.
 */
export type OrknuxValueType = (typeof VALUE_TYPES)[number];

/** A permission a plugin may ask for. The server's own list; nothing else exists. */
export type OrknuxPermission = (typeof PERMISSIONS)[number];

/** Something a plugin may ask the server to do on its behalf. */
export type OrknuxCapability = (typeof CAPABILITIES)[number];

/** The kinds of connection a workspace can hold. */
export type OrknuxConnectionType = (typeof CONNECTION_TYPES)[number];

/**
 * What a plugin's parameter may be: exactly what a workspace variable can hold,
 * plus a reference to one of the workspace's connections.
 */
export type OrknuxParameterType = (typeof PARAMETER_TYPES)[number] | typeof CONNECTION;

/**
 * A connection the workspace configured, as it arrives in `settings`.
 *
 * For a connection the server speaks to on the plugin's behalf — Slack, mail —
 * an id and a type and nothing else: a name for something the server will use,
 * never the connection itself and never its credential.
 *
 * A host of one of the plugin's own kinds — one `connectionTypes()` declares —
 * crosses with what reaching it takes: `url`, `authType`, `secret` and the
 * `headers` to send. Nothing but the plugin knows how to talk to a Prometheus,
 * and it does so over `orknux.http` under `NETWORK_REQUEST`, so the connection
 * is where that credential is kept — encrypted, chosen per workspace — and
 * this is where it is handed over. A connection wearing another plugin's kind
 * stays a handle.
 *
 * The type parameter is what makes "a Slack connection" mean something: it
 * appears as a member, so a mismatched kind is caught where it is written rather
 * than at the first call.
 */
export interface OrknuxConnectionHandle<
  Type extends OrknuxConnectionType = OrknuxConnectionType,
> {
  readonly id: number;
  readonly type: Type;
  /** Which of a plugin's declared kinds this is, as `key/name`. */
  readonly pluginType?: string;
  /** Where the host is. Only on a host of the plugin's own kind. */
  readonly url?: string;
  /** How it authenticates. Only on a host of the plugin's own kind. */
  readonly authType?: OrknuxConnectionAuthType;
  /** The credential as stored; absent where there is none. Only on a host of the plugin's own kind. */
  readonly secret?: string;
  /**
   * Every header to send, the credential's `Authorization` among them — so a
   * plugin need not know how each auth kind is spelled. Only on a host of the
   * plugin's own kind.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/** How a connection authenticates. `AuthType` in orknux-server. */
export type OrknuxConnectionAuthType = 'NONE' | 'API_KEY' | 'BEARER_TOKEN' | 'BASIC';

/**
 * A kind of host a plugin declares, so a workspace can hold several of it by
 * name — two Prometheus servers, two wikis — rather than every one reading as
 * "HTTP".
 *
 * Only the name and how to present it: the connection keeps the generic HTTP
 * shape — a URL, an auth kind, a secret, headers — which is what a host needs.
 * A plain object rather than a constructor, like an action: the server judges
 * the shape when the plugin is loaded.
 */
export interface OrknuxConnectionTypeDeclaration {
  /**
   * An identifier, stable: joined to the plugin's key it is what a connection
   * stores — `prometheus/prometheus` — so renaming it orphans every one.
   */
  name: string;
  /** What a person reads on the type menu and the connection list. */
  label: string;
  description?: string;
  /** What the URL box shows before anything is typed, e.g. `https://prometheus.example.com`. */
  urlPlaceholder?: string;
}

/**
 * What a workspace set the plugin's parameters to, keyed by name.
 *
 * Frozen, and put there by the server for the length of one call. A parameter
 * nothing usable is set for is absent rather than null — `undefined` is in the
 * type so that `settings.token === undefined` is a question the compiler lets
 * you ask, because it is the question to ask.
 */
export type OrknuxSettings = Readonly<
  Record<string, string | number | boolean | OrknuxConnectionHandle | undefined>
>;

/**
 * What `run` reaches through `this`.
 *
 * The sandbox calls `run` with the plugin as `this`, so a `run` written as a
 * method — or as a `function` inside `fn` — sees the settings. An arrow function
 * does not, and that is JavaScript rather than this package: an arrow closes
 * over the `this` of wherever it was written, which inside a `functions()` body
 * is the plugin and inside a `definePlugin` spec is nothing.
 */
export interface OrknuxRunContext {
  readonly settings: OrknuxSettings;
}

/**
 * What each of those is in TypeScript.
 *
 * A map is `Record<string, unknown>` and an array `unknown[]`, not `object` and
 * `any[]`: everything crossing into the sandbox arrived as JSON, so what is
 * inside is genuinely unknown until the code looks. `unknown` makes it look.
 */
export interface OrknuxValues {
  string: string;
  number: number;
  boolean: boolean;
  map: Record<string, unknown>;
  array: unknown[];
}

/** One of a function's parameters, as it is declared. */
export interface OrknuxParam<
  Name extends string = string,
  Type extends OrknuxValueType = OrknuxValueType,
> {
  readonly name: Name;
  readonly type: Type;

  /**
   * What this argument is, for whoever — or whatever — reads it.
   *
   * A tool's description is where a model looks first, and a name says what an
   * argument is called and nothing about what belongs in it.
   */
  readonly description?: string | null;

  /**
   * Whether a call has to supply it. True unless a `default` says otherwise.
   *
   * Arguments are positional, so the ones that may be left out come last: a
   * required parameter after an optional one is refused at load, because
   * nothing downstream could tell which argument was missing.
   */
  readonly required?: boolean;

  /**
   * What arrives when a call leaves it out — and declaring one makes the
   * parameter optional.
   *
   * This is what a sentinel was standing in for: `limit: 0` meaning "the
   * default", explained in a sentence a model read on every call and sometimes
   * got wrong. Say the value instead.
   *
   * Note what does *not* change: `run` still receives every argument, because
   * the server puts the default in before the call. There is no `undefined` to
   * guard against and no `limit || 20` left to write.
   */
  readonly default?: unknown;
}

/**
 * The arguments `run` is handed, read off the parameters it declared.
 *
 * This is the whole reason for declaring parameters as a tuple: `params` and the
 * signature of `run` are one statement rather than two that can drift, so
 * renaming a type in the declaration is a compile error in the body.
 */
export type OrknuxArgs<Params extends readonly OrknuxParam[]> = {
  -readonly [Index in keyof Params]: OrknuxValues[Params[Index]['type']];
};

/** A function, as it is written. */
export interface OrknuxFunctionDeclaration<
  Params extends readonly OrknuxParam[] = readonly OrknuxParam[],
  Returns extends OrknuxValueType = OrknuxValueType,
> {
  /** An identifier. Offered to a workflow prefixed with the plugin's id. */
  name: string;

  /** Optional; shown beside it in the interface. */
  description?: string;

  /** In the order `run` receives them. */
  params?: Params;

  /** What it answers with. A function has to answer something. */
  returnType: Returns;

  /**
   * What it does.
   *
   * Synchronous, and not by omission: the sandbox has no host access, no IO and
   * no way to hand a promise back across the boundary, so there is nothing a
   * plugin could usefully await. Everything it works with was passed to it — or
   * sits in `this.settings`, which the sandbox puts on the plugin `run` is
   * called on.
   */
  run: (this: OrknuxRunContext, ...args: OrknuxArgs<Params>) => OrknuxValues[Returns];
}

/**
 * A function after `OrknuxFunction` has checked it.
 *
 * The declaration as the sandbox stores it, which is not quite what was written:
 * an absent description became null and absent parameters became an empty array.
 */
export interface OrknuxFunctionInstance {
  readonly name: string;
  readonly description: string | null;
  readonly params: readonly OrknuxParam[];
  readonly returnType: string;
  readonly run: (...args: never[]) => unknown;
}

/**
 * A tool of the plugin's own, as it is written: a declaration with a run,
 * offered to agents.
 *
 * The same shape as a function's declaration, and typed the same way — the
 * parameters are a tuple and `run` is read off them. What differs is the
 * reader: a tool's description is read by a model deciding whether to call it,
 * so it says when to call this and with what, where a function's is read by a
 * person building a workflow.
 */
export interface OrknuxToolDeclaration<
  Params extends readonly OrknuxParam[] = readonly OrknuxParam[],
  Returns extends OrknuxValueType = OrknuxValueType,
> {
  /** An identifier. Granted to an agent prefixed with the plugin's id. */
  name: string;

  /** Written for the model that reads it: when to call this, and with what. */
  description?: string;

  /** In the order `run` receives them. */
  params?: Params;

  /** What it answers with. A tool answers a model, so it has to answer something. */
  returnType: Returns;

  /** What it does. Synchronous, for the reasons a function's `run` is. */
  run: (this: OrknuxRunContext, ...args: OrknuxArgs<Params>) => OrknuxValues[Returns];
}

/**
 * A tool after `OrknuxTool` has checked it.
 *
 * As the sandbox stores it, defaults filled in the way a function's are —
 * plus `proxyOf`, null here because this tool has a run of its own rather
 * than fronting one of the plugin's functions.
 */
export interface OrknuxToolInstance {
  readonly name: string;
  readonly description: string | null;
  readonly params: readonly OrknuxParam[];
  readonly returnType: string;
  readonly run: (...args: never[]) => unknown;
  readonly proxyOf: null;
}

/**
 * A tool that is one of the plugin's own functions, exposed to agents, as it
 * is written.
 *
 * The utility that says so rather than a copy: the params, return type and
 * implementation are the function's — including any edit somebody makes to it
 * on the server later — and only the name and the model-facing description may
 * be this tool's own. A `function` that `functions()` does not declare is
 * refused at load.
 */
export interface OrknuxFunctionToolDeclaration {
  /** The name of one of this plugin's functions, as `functions()` declares it. */
  function: string;

  /** What agents call it. Defaults to the function's own name. */
  name?: string;

  /** Written for the model. Defaults to the function's description. */
  description?: string;
}

/**
 * A proxy after `OrknuxFunctionTool` has checked it.
 *
 * `proxyOf` is what marks it: the loader reads it, resolves the params and
 * return type from the named function, and refuses a name `functions()` does
 * not declare.
 */
export interface OrknuxFunctionToolInstance {
  readonly proxyOf: string;
  readonly name: string;
  readonly description: string | null;
}

/**
 * One thing a plugin has to be told before it can work, as it is written.
 *
 * Not a function's parameter: a function's is filled in by whoever calls it,
 * node by node, while this is answered once by each workspace and arrives as
 * `this.settings`. Declaring them is also how a workspace can see what a plugin
 * is able to reach — nothing gets in that is not on the list.
 */
export interface OrknuxParameterDeclaration {
  /**
   * The values this may take, where the plugin knows them all.
   *
   * Leave it out where anything typed will do. A set makes the settings field
   * a picker, which deletes the check a plugin otherwise writes by hand and
   * the sentence that lists the choices — and a value that is not on the list
   * cannot be typed rather than being found at the first call.
   *
   * Not on a `secret`, which cannot be one of a set somebody can read, and not
   * on a `connection`, which names a row the workspace has and has its own
   * picker already. At most `MAX_OPTIONS`, no duplicates.
   */
  options?: readonly string[];
  /** An identifier: letters, digits and underscores. */
  name: string;

  /** Optional; shown under it on the form somebody fills in. */
  description?: string;

  type: OrknuxParameterType;

  /**
   * Whether the plugin can work without it. Defaults to true, because a
   * parameter nobody needs is one nobody should be asked for.
   */
  required?: boolean;

  /**
   * Whether this is asking for something that should not be typed into a form.
   * Defaults to false. Saying true refuses a typed-in value: the only way to
   * answer it is to point at one of the workspace's variables, which is where
   * an installation keeps things it encrypts.
   */
  secret?: boolean;

  /**
   * Which kind of connection, and required when `type` is `'connection'`.
   *
   * It narrows the picker to the connections the plugin can actually use. A
   * core kind arrives in `settings` as a handle — an id and a type, never the
   * connection's credential; one of the plugin's own `connectionTypes()`, named
   * by its bare name, arrives with its address and credential too.
   */
  connectionType?: OrknuxConnectionType | (string & {});
}

/**
 * A parameter after `OrknuxParameter` has checked it.
 *
 * As the sandbox stores it: an absent description became null, an absent
 * `required` became true, an absent `secret` false, and an absent
 * `connectionType` null.
 */
export interface OrknuxParameterInstance {
  /** The values it may take, or null where anything typed will do. */
  readonly options: readonly string[] | null;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly connectionType: string | null;
}

/**
 * One instruction set a plugin brings.
 *
 * Neither called nor run: `content` is markdown an agent reads before doing
 * something, so the knowledge of how this plugin's work is meant to be done
 * travels with the code that does it.
 */
export interface OrknuxSkillDeclaration {
  /**
   * What the skill is called, and what an agent asks for by name.
   *
   * Prose rather than an identifier — nothing calls a skill, an agent reads
   * it — so `Rolling back a deploy` is a better name than `rolling_back`.
   * At most `MAX_SKILL_NAME_LENGTH` characters.
   */
  name: string;

  /**
   * What a graph and a person name it by, where you want to choose.
   *
   * A skill's id is the one string anything else writes down: a workflow node
   * naming skills to load holds it, `skill_load` is asked for it, and a person
   * writes the command marker and this id in a message to have an agent load
   * the skill. Letters, underscores and hyphens, at most
   * `MAX_SKILL_ID_LENGTH` of them, and unique among this plugin's skills.
   *
   * Left out, the server derives it from the `name`, which is right until the
   * name changes and every graph and every command pointing at the old id
   * stops meaning anything. So a skill anything points at should say its own.
   */
  id?: string | null;

  /**
   * One line on what it is for. This is what an agent chooses from before
   * loading anything, so it earns its place: "What to do when a release is
   * bad" tells a model when to reach for the page; "Deploy skill" does not.
   */
  description?: string | null;

  /**
   * The markdown itself, at most `MAX_SKILL_CHARS` characters.
   *
   * A skill opens with a `---` frontmatter block naming and describing it.
   * Leave the block out and the server writes one from the `name` and
   * `description` above — they are the same two facts, and stating them twice
   * is a trap. A block that opens and never closes is your mistake, and is
   * refused as one.
   */
  content: string;
}

/** What a skill is once the sandbox has checked it. */
export interface OrknuxSkillInstance {
  readonly name: string;
  /** What it said, or null where the server derives it from the name. */
  readonly id: string | null;
  readonly description: string | null;
  readonly content: string;
}

/** What one field of an exported object may be. */
export type OrknuxPropertyKind = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * One field of an object a plugin exports.
 *
 * `of` is where a shape stops being flat: required for an `object` (it names
 * another of this plugin's objects) and for an `array` (a scalar kind, or
 * another object's name). Left off anything else, because there would be
 * nothing for it to say.
 */
export interface OrknuxProperty {
  name: string;
  kind: OrknuxPropertyKind;
  /** The object this points at, or what the array holds. */
  of?: string | null;
  /**
   * What this field means, for whoever — or whatever — reads it. A name says
   * what a field is called and nothing about what belongs in it.
   */
  description?: string | null;
}

/**
 * A named shape a plugin exports, for its functions to pass around.
 *
 * A plugin's functions belong to every workspace at once, which is why they
 * may not name a workspace's own objects — there is no single workspace whose
 * definitions they could mean. An object declared here is the answer: it
 * belongs to the plugin, travels with it, and is available wherever the
 * plugin is, under the plugin's key — `Issue` declared by `jira` arrives as
 * `jira_Issue`.
 *
 * Within the plugin, refer to them by the plugin's own spelling: a property
 * whose `of` is `User` means the `User` this plugin declares, and the server
 * rewrites the reference when it stores it.
 */
export interface OrknuxObjectDeclaration {
  /**
   * What the shape is called, unprefixed. An identifier, conventionally
   * PascalCase — it reads as a type, because that is what it is.
   */
  name: string;
  description?: string | null;
  properties: readonly OrknuxProperty[];
}

/** What an object is once the sandbox has checked it. */
export interface OrknuxObjectInstance {
  readonly name: string;
  readonly description: string | null;
  readonly properties: readonly OrknuxProperty[];
}

/** What a type a plugin defines is underneath: one of the three a variable can hold. */
export type OrknuxTypeBase = 'string' | 'number' | 'boolean';

/** One thing a type offers for what was typed into a variable of it. */
export interface OrknuxTypeSuggestion {
  /** What the variable is set to when this is taken. */
  value: string | number | boolean;
  /** What the row says; the value itself when absent. */
  label?: string;
  /** A second line - a real name beside a handle. */
  detail?: string;
}

/** Whether a type accepts a value, and if not, why - in a sentence somebody will read on the form. */
export type OrknuxTypeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A value type the plugin defines.
 *
 * A Slack user id is a string, but it is a string only some values of are
 * real, and the plugin is the one thing that can say which. So a plugin names
 * a type over a base type, says what it needs to be told to check one (a
 * connection, usually), and offers `suggest` for the picker and `validate`
 * for the save. Neither is required: a type with neither is a name on a
 * string, which still says what a variable is for.
 *
 * Both functions run with `this` as the plugin, its settings on it, and are
 * handed what the variable was told as `args` - a connection argument arrives
 * as the same handle a connection setting does. A parameter may not be a
 * secret: what a variable is told is kept beside it, in the clear.
 */
export interface OrknuxTypeDeclaration {
  /** An identifier, conventionally PascalCase. A workspace points at it as `<plugin>:<name>`. */
  name: string;
  description?: string | null;
  base: OrknuxTypeBase;
  parameters?: readonly (OrknuxParameterDeclaration | OrknuxParameterInstance)[];
  suggest?: (
    typed: string,
    args: Readonly<Record<string, unknown>>,
  ) => OrknuxTypeSuggestion[] | Promise<OrknuxTypeSuggestion[]>;
  validate?: (
    value: string,
    args: Readonly<Record<string, unknown>>,
  ) => OrknuxTypeVerdict | Promise<OrknuxTypeVerdict>;
}

/** What a type is once the sandbox has checked it. */
export interface OrknuxTypeInstance {
  readonly name: string;
  readonly description: string | null;
  readonly base: OrknuxTypeBase;
  readonly parameters: readonly OrknuxParameterInstance[];
  readonly suggest?: OrknuxTypeDeclaration['suggest'];
  readonly validate?: OrknuxTypeDeclaration['validate'];
}

/**
 * What an action's input or output may be. `object` is a free-form map; see
 * `ACTION_VALUE_TYPES` for why a plugin cannot name a workspace's shape here.
 */
export type OrknuxActionValueType = (typeof ACTION_VALUE_TYPES)[number];

/**
 * One input a workflow action takes.
 *
 * Wired by name on the node rather than passed positionally, which is the
 * whole difference between an action and a function: the editor seeds each
 * one to read the field of its own name from what the run carries, so a
 * trigger's `commands` reaches a `commands` parameter without anybody wiring
 * it, and arrives as the array it is.
 */
export interface OrknuxActionParameter {
  /** An identifier: letters, digits and underscores. */
  name: string;
  type: OrknuxActionValueType;
  /**
   * Whether a node has to wire it. Defaults to true. An optional one nobody
   * wired is absent from `input` rather than null, so `input.note ===
   * undefined` is the question to ask.
   */
  required?: boolean;
  /** Shown beside the port. */
  description?: string;
}

/**
 * One output a workflow action hands on.
 *
 * A name the next node reads: when `run` answers an object, its fields go
 * beside what reached the step under exactly these names, so a later node
 * reading `ts` finds `ts`. Declare none and the whole answer goes under
 * `result` instead, as a function's does.
 */
export interface OrknuxActionOutput {
  name: string;
  type: OrknuxActionValueType;
  description?: string;
}

/**
 * What an action's `run` is told about where it is running.
 *
 * `settings` is the same frozen object `this.settings` is, put here as well
 * so a `run` written as an arrow function - which has no `this` of its own -
 * still reaches the connection the workspace pointed the plugin at.
 */
export interface OrknuxActionContext {
  readonly settings: OrknuxSettings;
  readonly workspaceId: number;
  /** The Action's name in the workspace's catalogue. */
  readonly action: string;
  /** When the step started, ISO-8601. */
  readonly now: string;
  readonly timestamp: number;
}

/**
 * A workflow action, as it is written: a block a workflow's Action node can be
 * pointed at, listed in the editor under `label` beside "Send Message" and
 * "HTTP Request".
 *
 * A fourth surface with a fourth reader. A function is called with positional
 * arguments by whoever wrote the call; an action is a node on a canvas whose
 * inputs somebody wired by name. So `run` is handed one object keyed by
 * parameter name - an `array` parameter arrives as an array, a parameter
 * nobody wired is absent - and a context carrying the plugin's settings. Throw
 * to fail the step; the message is what the run shows.
 *
 * A plain object rather than a constructor, like `connectionTypes()`: there is
 * no inference to buy, and the server judges the shape when the plugin is
 * loaded.
 */
export interface OrknuxActionDeclaration {
  /** An identifier, stable: an Action row stores it beside the plugin's key. */
  name: string;
  /** What the node picker shows - 'Reply in the thread' rather than 'respond'. */
  label: string;
  description?: string;
  parameters?: readonly OrknuxActionParameter[];
  outputs?: readonly OrknuxActionOutput[];
  /** What it does. `input` is keyed by parameter name; arrays stay arrays. */
  run: (
    this: OrknuxRunContext | void,
    input: Readonly<Record<string, unknown>>,
    context: OrknuxActionContext,
  ) => unknown;
}

/** What a plugin answers when the server asks it what it is. */
export interface OrknuxPluginInstance {
  /** What this plugin calls itself, and the prefix on everything it declares. */
  id(): string;

  /** Which plugin API it was written against. */
  apiVersion(): number;

  /** What it offers to workflows. */
  functions(): OrknuxFunctionInstance[];

  /** What it offers to agents. */
  tools(): (OrknuxToolInstance | OrknuxFunctionToolInstance)[];

  /** What it has to be told before it can work. */
  parameters(): OrknuxParameterInstance[];

  /** Which JavaScript it needs beyond what every plugin gets. */
  permissions(): OrknuxPermission[];

  /** What it asks the server to do on its behalf. */
  capabilities(): OrknuxCapability[];

  /**
   * The library files it ships with, as paths relative to its own file:
   * `lib/util.js` or `./lib/util.js`. The complete list — every shipped file
   * is declared, every relative import resolves within it, and whoever loads
   * the plugin is shown it and has to allow it. No absolute paths, no URLs,
   * no `..`, no bare specifiers.
   */
  libraries(): string[];

  /**
   * The instruction sets it brings: markdown an agent reads, never code it
   * runs. They arrive as a skill catalog named after the plugin's key and are
   * granted like any other — nothing is automatic.
   */
  skills(): OrknuxSkillInstance[];

  /**
   * The shapes it exports, for its own functions and tools to pass around.
   *
   * Available wherever the plugin is, under the plugin's key: `Issue`
   * declared by `jira` is `jira_Issue`. A function returning or taking one
   * names it by the plugin's own spelling.
   */
  objects(): OrknuxObjectInstance[];

  /** The value types it defines, for a workspace\'s variables to be. */
  types(): OrknuxTypeInstance[];

  /** The workflow actions it offers, for an Action node to be pointed at. */
  actions(): OrknuxActionDeclaration[];

  /** What the workspace answered its parameters with, for the length of a call. */
  readonly settings: OrknuxSettings;
}

/**
 * A plugin as it leaves the file: a class, exported as the default.
 *
 * The server checks the prototype rather than probing for methods, so a plain
 * object with the right keys is refused however right the keys are.
 */
export type OrknuxPluginConstructor = new () => OrknuxPluginInstance;

/** One message in a Slack thread, as much of it as anything here needs. */
export interface SlackThreadMessage {
  /** Slack's timestamp, which is also the message's id. */
  ts: string;
  /** Who wrote it, or the bot that did. Null where Slack said neither. */
  user: string | null;
  text: string;
  /** Whether this is the message the thread hangs under rather than a reply. */
  parent: boolean;
}

/** A thread that was read, or why it could not be. */
export type SlackThread =
  | {
      messages: SlackThreadMessage[];
      /**
       * Slack's own count of the replies under the parent — not
       * `messages.length - 1`: a page holds what was asked for and the count is
       * of the whole thread. `replies === 1` is the first reply.
       */
      replies: number;
      error?: undefined;
    }
  | {
      /**
       * Why not, in Slack's own words where they were Slack's. A refusal rather
       * than a thrown error, so a plugin can say something useful about it.
       */
      error: string;
      messages?: undefined;
      replies?: undefined;
    };

/** A message that was posted — its channel and its own `ts` — or why not. */
export type SlackPost =
  | { channel: string; ts: string | null; error?: undefined }
  | { error: string; channel?: undefined; ts?: undefined };

/** Whether a reaction went on. Already-reacted counts as ok. */
export type SlackReaction = { ok: true; error?: undefined } | { error: string; ok?: undefined };

/** The one message a permalink points at, or why it could not be read. */
export type SlackLinkedMessage =
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
export type SlackUserInfo =
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
export type SlackMention =
  | { mention: string; id: string; label: string; error?: undefined }
  | { error: string; mention?: undefined };

/** What a search of Slack's messages came to, or why it could not be run. */
/** What the workflow editor's target box would offer for what was typed, or why it could not be asked. */
export type SlackSuggestions =
  | {
      outcome: string;
      message: string;
      matches: { id: string; name: string; kind: 'CHANNEL' | 'USER'; realName: string | null }[];
      complete: boolean;
      error?: undefined;
    }
  | { error: string; matches?: undefined };

export type SlackSearchResult =
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
 * What came back from an HTTP request, or why nothing did.
 *
 * A refusal is data rather than a thrown error, so a plugin can say something
 * useful about it — and so a condition that could not be decided does not
 * quietly decide. `json` sits beside `body` where the reply parsed as JSON, and
 * simply is not there where it did not; `body` is always the text that arrived.
 */
export type OrknuxResponse =
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
export type OrknuxBinaryResponse =
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

/**
 * What a stored value is. `binary` says how it is kept: true, the value is a
 * string of base64 bytes; false, it is the thing itself.
 */
export type OrknuxStoredKind = { contentType: string | null; binary: boolean };

/** What `orknux.session.store.put` answered: stored, or refused in a sentence. */
export type OrknuxStorePut = { ok: true; error?: undefined } | { error: string; ok?: undefined };

/**
 * One page of a PDF, drawn — or the sentence saying why it was not.
 *
 * `pages` is the document's own page count rather than this page's number, so
 * a caller that asked for the first of six is told there are six without
 * having to ask again.
 */
export type OrknuxDrawnPdfPage =
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
 * What a PDF says, as HTML — or the sentence saying why it says nothing.
 *
 * `pages` is the document's own page count, `from` and `to` the range that was
 * actually read: a caller that asked for the beginning of a long report needs
 * to know where the beginning ended, because a document too large to hand over
 * in one piece is refused by size and a range is the way out of that.
 *
 * `characters` is how much text came back, which is what a caller deciding
 * whether to hand it to a model wants before it does.
 */
export type OrknuxPdfHtml =
  | { html: string; pages: number; from: number; to: number; characters: number; error?: undefined }
  | {
      error: string;
      html?: undefined;
      pages?: undefined;
      from?: undefined;
      to?: undefined;
      characters?: undefined;
    };

/**
 * A picture drawn from markup, or the sentence saying why none was.
 *
 * `width` and `height` are what the picture came out as, read off the file
 * rather than echoed back from the request: a width is what was *asked* for,
 * and the document's aspect ratio and the server's ceilings both have a say in
 * what arrives. Without them a plugin holding a blank and a plugin holding a
 * giant look the same, which is the difference between diagnosing a bad
 * drawing and guessing at one. [OrknuxDrawnPdfPage] has always said.
 */
export type OrknuxDrawnPng =
  | { base64: string; bytes: number; width: number; height: number; error?: undefined }
  | { error: string; base64?: undefined; bytes?: undefined; width?: undefined; height?: undefined };

/**
 * A connection argument as the Slack helpers take it: the handle out of
 * `settings`, or a bare id where that is what a trigger handed over. The helper
 * reads the id off an object and passes anything else through, so
 * `trigger.connection` and a number both work.
 */
export type SlackConnectionArgument = OrknuxConnectionHandle | number | string;

/**
 * What a crypto call is handed: bytes as base64, or text the server encodes as
 * UTF-8 for you.
 *
 * The second form is there so a plugin that only wants to hash a string need
 * not ask for `TEXT_ENCODING` to turn it into bytes first.
 */
export type OrknuxCryptoInput = { base64: string; text?: undefined } | { text: string; base64?: undefined };

/** What a digest, a derivation or a handful of random bytes came to. */
export type OrknuxDigest =
  | { base64: string; error?: undefined }
  | { error: string; base64?: undefined };

/** Whether two byte strings are the same, compared in constant time. */
export type OrknuxComparison =
  | { equal: boolean; error?: undefined }
  | { error: string; equal?: undefined };

/** What `decodeBase64` came to: the text those bytes spell, or why they spell none. */
export type OrknuxText = { text: string; error?: undefined } | { error: string; text?: undefined };

/** The digests `orknux.crypto` will compute. */
export type OrknuxDigestAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'sha1' | 'md5';

/**
 * What the server will do on a plugin's behalf — the `orknux` object the sandbox
 * defines before a plugin is evaluated.
 *
 * Every call but `log` needs its capability. Without it the call answers
 * `{ error }` saying so, rather than reaching anything: the helpers are part of
 * the contract and always there, so an ungranted call is a sentence and not
 * whatever a call on undefined throws.
 */
export interface OrknuxHelpers {
  slack: {
    /**
     * The messages in one Slack thread, oldest first. Needs `SLACK_READ_THREAD`.
     *
     * Pass the connection the trigger says its event came in on rather than
     * assuming — a workspace with two Slack connections has two Slacks.
     */
    thread(
      connection: SlackConnectionArgument,
      channel: string,
      threadTs: string,
      limit?: number,
    ): SlackThread;

    /** Post a message through a connection it was given. Needs `SLACK_POST_MESSAGE`. */
    post(
      connection: SlackConnectionArgument,
      channel: string,
      text: string,
      threadTs?: string,
    ): SlackPost;

    /** Add an emoji reaction to a message. Needs `SLACK_ADD_REACTION`. */
    react(
      connection: SlackConnectionArgument,
      channel: string,
      ts: string,
      emoji: string,
    ): SlackReaction;

    /** The one message a Slack permalink points at. Needs `SLACK_READ_MESSAGE`. */
    message(connection: SlackConnectionArgument, link: string): SlackLinkedMessage;

    /** Who a Slack user id is, bare or as `<@U…>`. Needs `SLACK_READ_USER`. */
    user(connection: SlackConnectionArgument, userId: string): SlackUserInfo;

    /** The notation that pings somebody, from their name. Needs `SLACK_MENTION`. */
    mention(connection: SlackConnectionArgument, name: string): SlackMention;

    /**
     * Search Slack's messages, the way the search box does. Needs
     * `SLACK_SEARCH` — and, from Slack's own side, a user token: the
     * connection's User Token field is what a search runs on, and one
     * without it falls back to the bot token, whose `not_allowed_token_type`
     * comes back as the error.
     */
    search(connection: SlackConnectionArgument, query: string, limit?: number): SlackSearchResult;

    /** Members and channels for what was typed, ranked as the workflow editor ranks them. Needs SLACK_SUGGEST. */
    suggest(
      connection: SlackConnectionArgument,
      typed: string,
      kind?: 'USER' | 'CHANNEL',
      limit?: number,
    ): SlackSuggestions;
  };

  http: {
    /**
     * One HTTP request, made by the server on this plugin's behalf. Needs
     * `NETWORK_REQUEST` — the widest thing a plugin can ask for, and the one an
     * administrator will think hardest about.
     *
     * An object body is sent as JSON with the content-type set, because the
     * header is the half people forget; a string body is passed through
     * untouched. Where a request may get to is the installation's proxy rules,
     * which this cannot see and cannot argue with.
     */
    request(
      what:
        | string
        | {
            url: string;
            method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
            headers?: Record<string, string>;
            body?: string | Record<string, unknown> | readonly unknown[];
            /** Base64 whose decoded bytes are the body; wins over `body`. */
            bodyBase64?: string;
            /** Bring the answer's bytes back as `base64` instead of `body`. */
            binary?: boolean;
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
     * has on this side of the sandbox. Sent as an octet stream unless
     * `contentType` or a header says what it is; POST, and capped at 10 MB of
     * decoded bytes. Needs `NETWORK_REQUEST` like every other request.
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
     * The SVG drawn as a PNG: base64, its byte count, and the size it came
     * out at.
     *
     * `width` sets the picture's width in pixels, leaving the height to
     * follow the drawing's own proportions; left out, the size the SVG
     * declares is the size that is drawn. The `width` and `height` that come
     * back are what was actually drawn, which is not always what was asked
     * for - the proportions decide one side and the server's ceilings can
     * bring both down.
     */
    pngFromSvg(svg: string, width?: number): OrknuxDrawnPng;

    /**
     * One page of a PDF, drawn as a PNG — `RENDER_PDF`.
     *
     * What something that just made a document uses to look at what it
     * actually produced. A PDF is bytes and a model that can see reads
     * pictures, so without this an agent reports that the report is ready
     * because that is what it did, rather than because that is what came out.
     *
     * `pdf` is the document as base64, which is the shape a plugin that made
     * one already holds it in. `page` counts from one and defaults to the
     * first; `width` sets the picture's width in pixels and defaults to
     * something a screen can read. The answer carries the page count as well,
     * so a caller that asked for page one of six learns there are six.
     */
    pngFromPdf(pdf: string, page?: number, width?: number): OrknuxDrawnPdfPage;

    /**
     * What a PDF says, as HTML — `RENDER_PDF`.
     *
     * The other question about a document a plugin just made. `pngFromPdf` is
     * for looking at a page - is the table cut in half, did the diagram land -
     * and this is for reading it: the text is already in the file, and reading
     * a thousand words back out of a picture costs a vision model a thousand
     * words of tokens and some guessing.
     *
     * **Text in reading order, not the page's design.** A `<section>` per page
     * and a `<p>` per block; columns, tables and anything positioned rather
     * than written are flattened into the order they are read in. Where the
     * layout is the question, draw the page and look at it.
     *
     * The document's own text is escaped, never passed through as markup.
     *
     * @param pdf the document as base64.
     * @param from the first page, counting from one; left out starts at the
     *   beginning.
     * @param to the last page; left out reads to the end. A document with more
     *   text than the server hands over at once is refused with the number in
     *   the sentence, and a range is the answer to it.
     */
    htmlFromPdf(pdf: string, from?: number, to?: number): OrknuxPdfHtml;
  };

  /**
   * Not a capability, and never needed granting — nothing is reached by it. The
   * line crosses as text and the server decides where it goes; a level below
   * the installation's threshold costs one comparison and is dropped where it
   * was written, so tracing can stay in.
   */
  log: {
    debug(...parts: unknown[]): void;
    info(...parts: unknown[]): void;
    warn(...parts: unknown[]): void;
    error(...parts: unknown[]): void;
  };
}
