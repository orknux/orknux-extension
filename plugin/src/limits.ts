/**
 * What the server enforces, written down once.
 *
 * Every number and pattern here has a counterpart in orknux-server, and the
 * comment says which — because the only thing this package is really selling is
 * that a plugin which passes locally is a plugin the server will accept. When one
 * of these drifts, the promise is broken quietly, so they are kept together and
 * named after the rule rather than after the value.
 */

/** What a plugin written today should answer from `apiVersion()`. */
export const API_VERSION = 1;

/** Every version the server this package tracks still loads. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];

/** More than a plugin has any business offering; the loader stops reading past it. */
export const MAX_FUNCTIONS = 100;

/**
 * The same bound again for the agents' surface: the loader reads `tools()`
 * under `MAX_FUNCTIONS` too, and the separate name here is only so a refusal
 * about tools can say which list overran.
 */
export const MAX_TOOLS = MAX_FUNCTIONS;

/**
 * More than a plugin has any business asking a workspace to fill in.
 *
 * Lower than the function bound on purpose: every one of these is something a
 * person has to sit down and answer, and a plugin asking for fifty pieces of
 * configuration is asking the wrong question. `MAX_PARAMETERS` in `PluginRunner`.
 */
export const MAX_PARAMETERS = 50;

/**
 * More library files than a plugin has any business shipping.
 *
 * Every one of these is a file somebody loading the plugin is shown and has
 * to allow, and a list too long to read is a list nobody reads.
 * `MAX_LIBRARIES` in `PluginLibraries` on the server.
 */
export const MAX_LIBRARIES = 50;

/**
 * The shape of one library path: relative segments joined by `/`, an optional
 * leading `./`, ending in `.js`. What it rules out is the point — nothing
 * absolute, no URL, no `..`, no backslashes, no bare specifier — so a declared
 * path can only ever name a file that travels with the plugin.
 * `LIBRARY_PATH` in `PluginLibraries` on the server.
 */
export const LIBRARY_PATH = /^(\.\/)?(?!\.)[A-Za-z0-9_\-.]+(\/(?!\.)[A-Za-z0-9_\-.]+)*\.js$/;

/** Longer than any sensible relative path; the column the server keeps it in. */
export const MAX_LIBRARY_PATH_LENGTH = 200;

/**
 * The digests `orknux.crypto` will compute. `CryptoAlgorithms` on the server.
 *
 * `sha1` and `md5` are on the list because protocols need them — Postgres's
 * older md5 authentication, S3 signatures, git object ids — and leaving them
 * off would send plugin authors to hand-written implementations that are worse
 * in every way. They are not for anything new.
 */
export const DIGEST_ALGORITHMS = ['sha256', 'sha384', 'sha512', 'sha1', 'md5'] as const;

/** What one crypto call may be handed, before base64. It is held in memory twice. */
export const MAX_CRYPTO_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * The most rounds `pbkdf2` will do.
 *
 * The one bound worth explaining. PBKDF2 is deliberately slow and the work
 * happens on the server's side of the sandbox, where the script guard's
 * wall-clock bound does not reach it — so a plugin naming a large enough
 * number is a denial of service against the whole installation rather than
 * against its own call. Postgres asks for 4096. Over the cap is a refusal
 * naming it and never a silent clamp: a plugin that believes it did ten
 * million rounds and got one million has a security bug nobody can see.
 */
export const MAX_PBKDF2_ITERATIONS = 1_000_000;

/** Longer than any key anybody derives, and the same bound for `random`. */
export const MAX_DERIVED_BYTES = 1024;

/**
 * More than there are permissions to ask for.
 *
 * A bound on the answer rather than a rule about plugins: what is actually
 * allowed is decided against [PERMISSIONS], and a name that is not on it is
 * refused whatever the length of the list. `MAX_PERMISSIONS` in `PluginRunner`.
 */
export const MAX_PERMISSIONS = 32;

/** A plugin is one bundled file, and the row it is stored in has a size. */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/**
 * What a plugin may call itself.
 *
 * Short because it is the prefix on every function it declares: `teammates` plus
 * `isTeammate` is what a workflow calls, and the name it is called by has room
 * for both.
 */
export const PLUGIN_ID = /^[A-Za-z_$][A-Za-z0-9_$]{0,31}$/;

/**
 * How many values a parameter's picker may offer.
 *
 * A list past this is not a choice anybody scans, it is a search — and a
 * parameter with two hundred answers wants a different control than this one.
 * `MOST_OPTIONS` in `PluginDeclarations` on the server.
 */
export const MAX_OPTIONS = 50;

/** A function or parameter name, held to the rule a workspace's own functions are. */
export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * More instruction sets than one plugin has to teach.
 *
 * A plugin that brings fifty skills is a workspace's skill catalog wearing a
 * plugin's clothes. `MAX_SKILLS` in `PluginRunner`.
 */
export const MAX_SKILLS = 25;

/**
 * A skill is a page, not a manual. Generous enough for a long one and bounded,
 * because it crosses out of the sandbox into a column.
 * `MOST_SKILL_CHARS` in `PluginRunner`.
 */
export const MAX_SKILL_CHARS = 64 * 1024;

/** What the `agent_skill` name column holds. `MOST_SKILL_NAME_CHARS` on the server. */
export const MAX_SKILL_NAME_LENGTH = 120;

/**
 * What a skill's id may be, where a plugin names one rather than letting the
 * server derive it: letters, underscores and hyphens, and this many of them.
 * `SkillKeys.RULE` and `SkillKeys.KEY_LENGTH` on the server.
 */
export const MAX_SKILL_ID_LENGTH = 120;

/** The letters an id is made of, and nothing else. */
export const SKILL_ID_RULE = /^[A-Za-z_-]+$/;

/**
 * More shapes than a plugin has any business exporting.
 *
 * Lower than the function bound: every one of these is a name that lands in
 * every workspace at once, and a plugin bringing a hundred types is bringing a
 * schema nobody asked for. `MAX_OBJECTS` in `PluginRunner`.
 */
export const MAX_OBJECTS = 50;

/** Fields on one exported object. `MAX_PROPERTIES` in `PluginRunner`. */
export const MAX_PROPERTIES = 100;

/**
 * Value types a plugin may define. Lower still than objects: each one is an
 * entry in the type picker of every variable in every workspace, and a plugin
 * that needs twenty kinds of string is describing an API rather than a
 * vocabulary. `MAX_TYPES` in `PluginRunner`.
 */
export const MAX_TYPES = 20;

/** What one type may ask to be told; a connection and a couple of settings. `MAX_TYPE_PARAMETERS` in `PluginRunner`. */
export const MAX_TYPE_PARAMETERS = 10;

/**
 * Kinds of host a plugin may declare. Each is a row on every workspace's
 * connection-type menu. `MAX_CONNECTION_TYPES` in `PluginRunner`.
 */
export const MAX_CONNECTION_TYPES = 20;

/**
 * Workflow actions a plugin may declare. Every one is a row in the editor's
 * action picker for every workspace, and a plugin offering more than this is a
 * menu rather than a plugin. `MAX_ACTIONS` in `PluginRunner`.
 */
export const MAX_ACTIONS = 50;

/**
 * What one action may be handed, and what it may hand on. A node panel, not a
 * form with fifty rows. `MAX_ACTION_PARAMETERS` in `PluginRunner`.
 */
export const MAX_ACTION_PARAMETERS = 30;

/**
 * What an action's input or output may be. `ACTION_TYPES` in
 * `PluginDeclarations`, with `object` spelled the way JavaScript spells it.
 *
 * Wider than [PARAMETER_TYPES], because an action's inputs are wired from what
 * a run carries rather than typed into a settings form: a trigger's list of
 * commands is an array, and there is no variable it could have come from.
 * `object` is a free-form map - the server keeps it as MAP - because a plugin
 * belongs to every workspace at once and can name none of a workspace's own
 * shapes here.
 */
export const ACTION_VALUE_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const;

/** What a type is underneath: one of the three a workspace variable can hold. `BASES` in `PluginDeclarations`. */
export const TYPE_BASES = ['string', 'number', 'boolean'] as const;

/**
 * What an exported object may be called: an identifier, conventionally
 * PascalCase, because it reads as a type. Held to the same rule a workspace's
 * own object names are, and prefixed with the plugin's key when it is stored.
 */
export const OBJECT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** What one field of an exported object may be. `PropertyKind` on the server. */
export const PROPERTY_KINDS: readonly string[] = ['string', 'number', 'boolean', 'object', 'array'];

/**
 * The types a value may have crossing between a workflow and a plugin.
 *
 * The server has two more. `none` means "answers nothing", which neither a
 * parameter nor a return may be. `object` names one of a workspace's own
 * definitions, and a plugin's functions belong to every workspace at once — so
 * there is no workspace whose objects they could be naming. A plugin that wants a
 * structure asks for a `map`.
 */
export const VALUE_TYPES = ['string', 'number', 'boolean', 'map', 'array'] as const;

/**
 * The types a *plugin's* parameter may be — narrower than [VALUE_TYPES], and the
 * narrowing is the server's: a parameter is answered either by typing a value or
 * by pointing at one of the workspace's variables, and a variable holds a
 * scalar. `PluginDeclarations.SETTABLE` in orknux-server.
 *
 * A connection is spelled beside them rather than among them because it is not a
 * value at all — see [CONNECTION].
 */
export const PARAMETER_TYPES = ['string', 'number', 'boolean'] as const;

/**
 * How a plugin spells a parameter that names one of the workspace's connections.
 *
 * Not a value type: those are what a value can be, and this is a reference to a
 * row. What crosses into the sandbox for it is a handle — an id and a type,
 * never the connection's credential. `PluginDeclarations.CONNECTION`.
 */
export const CONNECTION = 'connection';

/**
 * What a function's or a tool's argument may be: every value type, and a
 * connection. `ValueType.CONNECTION` in orknux-server.
 *
 * A connection argument is how one plugin reaches several hosts of a kind - two
 * Prometheus servers, three Jenkins controllers - where a connection *setting*
 * is one per workspace. A function is handed the same handle a setting is,
 * address and credential included for a host of the plugin's own kind; a
 * model calling a tool fronting it writes the connection's id, and the server
 * resolves it before `run` sees it.
 *
 * Not a return type, though the server would store one: a connection names a
 * row, and nothing downstream of a function could do anything with a handle
 * but pass it back. Stricter here, which can only refuse what no plugin should
 * be doing.
 */
export const ARGUMENT_TYPES = [...VALUE_TYPES, CONNECTION] as const;

/**
 * The kinds of connection a workspace can hold, and so the kinds a `connection`
 * parameter may name. `ConnectionType` in orknux-server.
 */
export const CONNECTION_TYPES = ['SLACK', 'SMTP', 'HTTP'] as const;

/**
 * Every permission a plugin may ask for, which is every one the server can
 * grant. A closed list, and that is the security property: each name turns on
 * one language builtin and nothing else, so the vocabulary itself cannot express
 * "give me a socket". `PluginPermission` in orknux-server, in the enum's order.
 */
export const PERMISSIONS = ['CONSOLE', 'INTL', 'TEXT_ENCODING', 'PERFORMANCE', 'TEMPORAL'] as const;

/**
 * Everything a plugin may ask the *server* to do on its behalf.
 *
 * Deliberately a second list rather than five more permissions: a permission
 * relaxes the sandbox and reaches nothing, while a capability is a call the
 * server makes for the plugin — so they are declared apart, accepted apart, and
 * neither can be agreed to under cover of the other. `PluginCapability` in
 * orknux-server, in the enum's order.
 */
export const CAPABILITIES = [
  'SLACK_READ_THREAD',
  'SLACK_POST_MESSAGE',
  'SLACK_ADD_REACTION',
  'SLACK_READ_MESSAGE',
  'SLACK_READ_USER',
  'SLACK_MENTION',
  'SLACK_SEARCH',
  'SLACK_SUGGEST',
  'NETWORK_REQUEST',
  'RENDER_PNG',
  'RENDER_PDF',
] as const;
