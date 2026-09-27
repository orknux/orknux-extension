import { PROPERTY_KINDS, TYPE_BASES } from './limits.js';
import type {
  OrknuxActionDeclaration,
  OrknuxCapability,
  OrknuxFunctionDeclaration,
  OrknuxFunctionInstance,
  OrknuxFunctionToolDeclaration,
  OrknuxFunctionToolInstance,
  OrknuxHelpers,
  OrknuxObjectDeclaration,
  OrknuxObjectInstance,
  OrknuxParam,
  OrknuxParameterDeclaration,
  OrknuxParameterInstance,
  OrknuxPermission,
  OrknuxSettings,
  OrknuxSkillDeclaration,
  OrknuxSkillInstance,
  OrknuxToolDeclaration,
  OrknuxToolInstance,
  OrknuxTypeDeclaration,
  OrknuxTypeInstance,
  OrknuxValueType,
} from './types.js';

/**
 * The classes a plugin is written against, and the `orknux` object beside them.
 *
 * **These are the sandbox's, not this package's.** The server defines
 * `OrknuxPlugin`, `OrknuxFunction`, `OrknuxParameter` and `orknux` on the global
 * object before it evaluates a plugin, and then checks the default export by
 * prototype — `exported.prototype instanceof globalThis.OrknuxPlugin`. A copy
 * bundled in from here would satisfy every type in this file and fail that
 * check, because it would be a different class with the same shape. So what is
 * exported below is a binding to whatever is already there, which is what makes
 * `import` safe in a file that ends up inlined by a bundler: the import compiles
 * to a read of the global.
 *
 * The fallbacks are for everywhere that is not the sandbox — a unit test, or
 * `orknux-plugin check` — where nothing has defined them and `class extends
 * undefined` would throw before anything could be asked. They are a faithful copy
 * of the server's own contract, wording included, so a plugin that is refused
 * locally is refused with the sentence the server would have used. The `orknux`
 * fallback answers every ungranted call the way the sandbox answers one — with
 * `{ error }` as data — because outside the sandbox nothing has been granted,
 * which is exactly what those sentences say.
 */

class OrknuxPluginFallback {
  constructor() {
    /*
     * What the sandbox's own construction helper does after `new`: settings are
     * put on the instance rather than passed to the constructor, frozen so a
     * run cannot rewrite what it was given. Empty here, as they are while a
     * plugin is only being asked what it is.
     */
    Object.defineProperty(this, 'settings', {
      value: Object.freeze({}),
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }

  id(): string {
    throw new Error('a plugin must implement id(), answering what it is called');
  }

  apiVersion(): number {
    throw new Error('a plugin must implement apiVersion(), answering which plugin API it uses');
  }

  functions(): OrknuxFunctionInstance[] {
    return [];
  }

  tools(): (OrknuxToolInstance | OrknuxFunctionToolInstance)[] {
    return [];
  }

  parameters(): OrknuxParameterInstance[] {
    return [];
  }

  permissions(): OrknuxPermission[] {
    return [];
  }

  capabilities(): OrknuxCapability[] {
    return [];
  }

  libraries(): string[] {
    return [];
  }

  skills(): OrknuxSkillInstance[] {
    return [];
  }

  objects(): OrknuxObjectInstance[] {
    return [];
  }

  types(): OrknuxTypeInstance[] {
    return [];
  }

  actions(): OrknuxActionDeclaration[] {
    return [];
  }
}

/*
 * A value type the plugin defines: a name over a base type, what it needs to
 * be told, and up to two functions the server calls on the plugin's behalf.
 * The parameters go through OrknuxParameter, so a type is held to the same
 * rules a plugin's own settings are - except that none may be a secret,
 * because what a variable of the type is told rides beside it in the clear.
 * The wording mirrors `PluginRunner.CONTRACT`.
 */
class OrknuxTypeFallback {
  constructor(declared: unknown) {
    if (declared === null || typeof declared !== 'object') {
      throw new Error('an OrknuxType needs a declaration');
    }

    const source = declared as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;

    self['name'] = source['name'];
    self['description'] = source['description'] === undefined ? null : source['description'];
    self['base'] = source['base'];
    const asked = source['parameters'] === undefined ? [] : source['parameters'];

    if (typeof self['name'] !== 'string' || self['name'].length === 0) {
      throw new Error('an OrknuxType needs a name');
    }
    const base = self['base'];
    if (typeof base !== 'string' || !(TYPE_BASES as readonly string[]).includes(base)) {
      throw new Error(
        `${self['name']} is a "${String(base)}", which is not one of ${TYPE_BASES.join(', ')} - ` +
          'a type is one of those with a name on it',
      );
    }
    if (!Array.isArray(asked)) {
      throw new Error(`${self['name']} needs parameters, as an array`);
    }
    self['parameters'] = asked.map((one: unknown) => {
      const parameter = (
        one instanceof OrknuxParameterFallback ? one : new OrknuxParameterFallback(one)
      ) as unknown as Record<string, unknown>;
      if (parameter['secret'] === true) {
        throw new Error(
          `${self['name']}'s ${String(parameter['name'])} is a secret, and a type cannot be told one: ` +
            'what a variable of this type is told is kept beside it, in the clear',
        );
      }
      return parameter;
    });

    if (source['suggest'] !== undefined && typeof source['suggest'] !== 'function') {
      throw new Error(`${self['name']} has a suggest that is not a function`);
    }
    if (source['validate'] !== undefined && typeof source['validate'] !== 'function') {
      throw new Error(`${self['name']} has a validate that is not a function`);
    }
    if (source['suggest'] !== undefined) self['suggest'] = source['suggest'];
    if (source['validate'] !== undefined) self['validate'] = source['validate'];
  }
}

class OrknuxSkillFallback {
  constructor(declared: unknown) {
    if (declared === null || typeof declared !== 'object') {
      throw new Error('an OrknuxSkill needs a declaration');
    }

    const source = declared as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;

    self['name'] = source['name'];
    self['id'] = source['id'] === undefined ? null : source['id'];
    self['description'] = source['description'] === undefined ? null : source['description'];
    self['content'] = source['content'];

    if (typeof self['name'] !== 'string' || self['name'].length === 0) {
      throw new Error('an OrknuxSkill needs a name');
    }
    if (self['id'] !== null && typeof self['id'] !== 'string') {
      throw new Error(`${self['name']} has an id that is not text`);
    }
    if (typeof self['content'] !== 'string' || self['content'].trim().length === 0) {
      throw new Error(`${self['name']} needs content: the markdown an agent reads`);
    }
    if (self['description'] !== null && typeof self['description'] !== 'string') {
      throw new Error(`${self['name']} has a description that is not text`);
    }
  }
}

class OrknuxObjectFallback {
  constructor(declared: unknown) {
    if (declared === null || typeof declared !== 'object') {
      throw new Error('an OrknuxObject needs a declaration');
    }

    const source = declared as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;

    self['name'] = source['name'];
    self['description'] = source['description'] === undefined ? null : source['description'];
    self['properties'] = source['properties'] === undefined ? [] : source['properties'];

    if (typeof self['name'] !== 'string' || self['name'].length === 0) {
      throw new Error('an OrknuxObject needs a name');
    }
    if (!Array.isArray(self['properties'])) {
      throw new Error(`${self['name']} needs properties, as an array`);
    }
    /*
     * Each field checked where it was written, so a shape with a typo in it
     * fails on the line that declares it rather than on the way into a
     * database. Whether an `of` names an object this plugin actually has is
     * the loader's question - it is the one that can see the whole set.
     */
    for (const held of self['properties'] as Record<string, unknown>[]) {
      if (held === null || typeof held !== 'object') {
        throw new Error(`${self['name']} has a property that is not a declaration`);
      }
      if (typeof held['name'] !== 'string' || held['name'].length === 0) {
        throw new Error(`${self['name']} has a property with no name`);
      }
      const kind = held['kind'];
      if (typeof kind !== 'string' || !PROPERTY_KINDS.includes(kind)) {
        throw new Error(
          `${self['name']}'s ${held['name']} is a "${String(kind)}", which is not one of ` +
            PROPERTY_KINDS.join(', '),
        );
      }
      const points = kind === 'object' || kind === 'array';
      const of = held['of'] === undefined ? null : held['of'];
      if (points && (typeof of !== 'string' || of.length === 0)) {
        throw new Error(
          `${self['name']}'s ${held['name']} is ${kind === 'object' ? 'an object' : 'an array'}, ` +
            `so it needs an \`of\`: ${kind === 'object' ? 'the object it points at' : 'what it holds'}`,
        );
      }
      if (!points && of !== null) {
        throw new Error(`${self['name']}'s ${held['name']} names an \`of\` but is a ${kind}`);
      }
    }
  }
}

class OrknuxFunctionFallback {
  constructor(declared: unknown) {
    if (declared === null || typeof declared !== 'object') {
      throw new Error('an OrknuxFunction needs a declaration');
    }

    const source = declared as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;

    self['name'] = source['name'];
    self['description'] = source['description'] === undefined ? null : source['description'];
    self['params'] = source['params'] === undefined ? [] : source['params'];
    self['returnType'] = source['returnType'];
    self['run'] = source['run'];

    if (typeof self['name'] !== 'string' || self['name'].length === 0) {
      throw new Error('an OrknuxFunction needs a name');
    }
    if (typeof self['returnType'] !== 'string') {
      throw new Error(`${self['name']} needs a returnType`);
    }
    if (typeof self['run'] !== 'function') {
      throw new Error(`${self['name']} needs a run function; it is what the function does`);
    }
    if (!Array.isArray(self['params'])) {
      throw new Error(`${self['name']} declares params that are not an array`);
    }
  }
}

class OrknuxToolFallback {
  constructor(declared: unknown) {
    if (declared === null || typeof declared !== 'object') {
      throw new Error('an OrknuxTool needs a declaration');
    }

    const source = declared as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;

    self['name'] = source['name'];
    self['description'] = source['description'] === undefined ? null : source['description'];
    self['params'] = source['params'] === undefined ? [] : source['params'];
    self['returnType'] = source['returnType'];
    self['run'] = source['run'];
    self['proxyOf'] = null;

    if (typeof self['name'] !== 'string' || self['name'].length === 0) {
      throw new Error('an OrknuxTool needs a name');
    }
    if (typeof self['returnType'] !== 'string') {
      throw new Error(`${self['name']} needs a returnType`);
    }
    if (typeof self['run'] !== 'function') {
      throw new Error(`${self['name']} needs a run function; it is what the tool does`);
    }
    if (!Array.isArray(self['params'])) {
      throw new Error(`${self['name']} declares params that are not an array`);
    }
  }
}

/*
 * A tool that is one of the plugin's own functions, exposed to agents. As in
 * the sandbox, the instance carries only `proxyOf`, the name and the
 * description: the params, return type and implementation stay the function's,
 * and the loader resolves them — refusing a `function` that `functions()` does
 * not declare — when the plugin is questioned.
 */
class OrknuxFunctionToolFallback {
  constructor(declared: unknown) {
    if (declared === null || typeof declared !== 'object') {
      throw new Error('an OrknuxFunctionTool needs a declaration');
    }

    const source = declared as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;

    self['proxyOf'] = source['function'];
    self['name'] = source['name'] === undefined ? source['function'] : source['name'];
    self['description'] = source['description'] === undefined ? null : source['description'];

    if (typeof self['proxyOf'] !== 'string' || self['proxyOf'].length === 0) {
      throw new Error('an OrknuxFunctionTool needs a function to proxy, named by `function`');
    }
    if (typeof self['name'] !== 'string' || self['name'].length === 0) {
      throw new Error('an OrknuxFunctionTool needs a name');
    }
  }
}

class OrknuxParameterFallback {
  constructor(declared: unknown) {
    if (declared === null || typeof declared !== 'object') {
      throw new Error('an OrknuxParameter needs a declaration');
    }

    const source = declared as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;

    self['name'] = source['name'];
    self['description'] = source['description'] === undefined ? null : source['description'];
    self['type'] = source['type'];
    self['required'] = source['required'] === undefined ? true : source['required'];
    self['secret'] = source['secret'] === undefined ? false : source['secret'];
    self['connectionType'] = source['connectionType'] === undefined ? null : source['connectionType'];
    self['options'] = source['options'] === undefined ? null : source['options'];

    if (typeof self['name'] !== 'string' || self['name'].length === 0) {
      throw new Error('an OrknuxParameter needs a name');
    }
    if (typeof self['type'] !== 'string') {
      throw new Error(`${self['name']} needs a type`);
    }
    if (typeof self['required'] !== 'boolean') {
      throw new Error(`${self['name']} says required is neither true nor false`);
    }
    if (typeof self['secret'] !== 'boolean') {
      throw new Error(`${self['name']} says secret is neither true nor false`);
    }
    /*
     * Said here as well as at the upload, as the sandbox says it, so a plugin
     * author is told which half is wrong at the moment they write it rather
     * than at the moment somebody tries to load it.
     */
    if (self['type'] === 'connection' && typeof self['connectionType'] !== 'string') {
      throw new Error(`${self['name']} is a connection, so it needs a connectionType`);
    }
    if (self['connectionType'] !== null && self['type'] !== 'connection') {
      throw new Error(`${self['name']} names a connectionType but is not a connection`);
    }
    const offered = self['options'];
    if (offered !== null) {
      if (!Array.isArray(offered) || offered.length === 0) {
        throw new Error(`${self['name']} has options, which have to be a non-empty array`);
      }
      if (offered.some((one) => typeof one !== 'string' || one.length === 0)) {
        throw new Error(`${self['name']} has an option that is not a name`);
      }
      /*
       * Neither a connection nor a secret is chosen from a list of values: a
       * connection names a row the workspace has, and a secret cannot be one
       * of a set somebody can read.
       */
      if (self['type'] === 'connection' || self['secret'] === true) {
        throw new Error(
          `${self['name']} cannot have options: it is a ${self['secret'] === true ? 'secret' : 'connection'}`,
        );
      }
    }
  }
}

/**
 * The `orknux` object for everywhere that is not the sandbox.
 *
 * Every door answers the sentence the sandbox answers an ungranted call with,
 * because that is the truth here too: nothing has been granted, and a refusal is
 * data so a plugin under test can say something useful about it. `log` is the
 * one exception — it was never a capability, nothing is reached by it — so it
 * writes to the console where there is one, which is where a test's tracing
 * wants to go.
 */
function ungrantedHelpers(): OrknuxHelpers {
  /*
   * `{ error }` satisfies every answer type here, because every answer type has
   * a refusal arm — that is the shape of the contract, not a coincidence.
   */
  const refused = (capability: string) => (): { error: string } => ({
    error: `this plugin was not granted ${capability}`,
  });

  const refusedHere = (): { error: string } => ({
    error: 'there is no crypto here: only a call made inside the sandbox can compute one',
  });

  const say = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (...parts: unknown[]): void => {
      if (typeof console === 'undefined') return;
      const line = parts
        .map((one) => {
          if (typeof one === 'string') return one;
          try {
            return JSON.stringify(one);
          } catch {
            return String(one);
          }
        })
        .join(' ');
      console[level](line);
    };

  return {
    slack: {
      thread: refused('SLACK_READ_THREAD'),
      post: refused('SLACK_POST_MESSAGE'),
      react: refused('SLACK_ADD_REACTION'),
      message: refused('SLACK_READ_MESSAGE'),
      user: refused('SLACK_READ_USER'),
      mention: refused('SLACK_MENTION'),
      search: refused('SLACK_SEARCH'),
      suggest: refused('SLACK_SUGGEST'),
    },
    http: {
      request: refused('NETWORK_REQUEST'),
      get: refused('NETWORK_REQUEST'),
      post: refused('NETWORK_REQUEST'),
      upload: refused('NETWORK_REQUEST'),
      download: refused('NETWORK_REQUEST'),
    },
    /*
     * Crypto is not granted, so there is no "you were not granted this" to
     * say — outside the sandbox there is simply no server to compute it. The
     * refusal names that rather than a missing capability, and `orknux-plugin`
     * replaces these with real implementations before it loads a plugin, so a
     * `check` behaves the way the sandbox will. See `tooling.ts`.
     */
    crypto: {
      hash: refusedHere,
      hmac: refusedHere,
      pbkdf2: refusedHere,
      random: refusedHere,
      timingSafeEqual: (): { error: string } => ({
        error: 'there is no crypto here: only a call made inside the sandbox can compute one',
      }),
    },
    /* Not cryptography, so not beside it — and ungranted for the same reason. */
    encoding: {
      encodeBase64: refusedHere,
      decodeBase64: refusedHere,
    },
    /*
     * Outside the sandbox there is no session, and the sandbox's own answer
     * to that is the one copied here: put refuses in the sentence the server
     * uses, and get answers null the way a key nothing holds does.
     */
    session: {
      store: {
        put: (): { error: string } => ({
          error: 'there is no session store here: only a call made inside an AI session carries one',
        }),
        get: (): null => null,
        kind: (): null => null,
      },
    },
    /*
     * And no rasteriser out here either, refused in the same shape the other
     * doors use: a sentence rather than a thrown error, so a plugin can say
     * something useful about it instead of failing mid-answer.
     */
    render: {
      pngFromSvg: (): { error: string } => ({
        error: 'there is no renderer here: only a call made inside the sandbox can draw one',
      }),
      pngFromPdf: (): { error: string } => ({
        error: 'there is no renderer here: only a call made inside the sandbox can draw one',
      }),
      htmlFromPdf: (): { error: string } => ({
        error: 'there is no renderer here: only a call made inside the sandbox can read one',
      }),
    },
    log: {
      debug: say('debug'),
      info: say('info'),
      warn: say('warn'),
      error: say('error'),
    },
  };
}

/**
 * What a plugin extends.
 *
 * Ambient, so nothing is emitted for it: the value below is the sandbox's class,
 * and this only says what may be assumed about it. `id` and `apiVersion` are
 * abstract because a plugin that leaves one out is refused at load — better a
 * compile error while it is being written than a sentence from the server later.
 * Everything else defaults to none, so a plugin says only what it has to say.
 */
declare abstract class OrknuxPluginContract {
  /**
   * What this plugin calls itself. Its identity, not its filename: loading this
   * id again replaces whatever is loaded under it.
   */
  abstract id(): string;

  /** Which plugin API this was written against. */
  abstract apiVersion(): number;

  /** What this plugin offers to workflows. Defaults to none. */
  functions(): OrknuxFunctionInstance[];

  /**
   * What this plugin offers to agents, as tools a model calls. Defaults to
   * none.
   *
   * A surface of its own because it has a reader of its own: a tool's
   * description is read by a model deciding whether to call it, where a
   * function's is read by a person building a workflow. A tool that is really
   * one of the functions is declared as an `OrknuxFunctionTool`, which proxies
   * it rather than describing it twice.
   */
  tools(): (OrknuxToolInstance | OrknuxFunctionToolInstance)[];

  /** What this plugin has to be told before it can work. Defaults to none. */
  parameters(): OrknuxParameterInstance[];

  /**
   * Which JavaScript this plugin needs beyond what every plugin gets.
   *
   * Whoever loads it is shown the list and has to accept it, and only what was
   * accepted is turned on — for this plugin, in the sandbox one of its calls
   * runs in, and nowhere else. Loading is done with none of them granted, so
   * the top level of the bundle has to evaluate without them: ask for what
   * `run` needs, not for what loading needs.
   */
  permissions(): OrknuxPermission[];

  /**
   * What this plugin asks the server to do on its behalf.
   *
   * Separate from `permissions()`, which only ever turns on a language builtin.
   * These reach outside — so they are declared apart, granted apart, and shown
   * apart to whoever accepts the plugin.
   */
  capabilities(): OrknuxCapability[];

  /**
   * The library files this plugin ships with, as paths relative to its own
   * file: `lib/util.js` or `./lib/util.js`. Defaults to none.
   *
   * This is the complete list — every file that arrives beside the plugin is
   * declared here, and every relative `import` in the plugin or in one of the
   * libraries has to resolve to a declared path. Nothing else is allowed in a
   * path: no absolute paths, no URLs, no `..`, no bare specifiers — an npm
   * dependency is still bundled in, not declared.
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
   * workflow and `tools()` by a model; a skill is neither called nor run - it
   * is a page an agent reads to learn how this plugin's work is meant to be
   * done. A plugin that offers a search tool can ship the skill saying when
   * to reach for it, and the two travel together instead of the second being
   * retyped into every workspace by hand.
   *
   * They arrive as a skill catalog named after the plugin's key, and an agent
   * is granted that catalog the way it is granted any other. Nothing is
   * automatic: a plugin loaded into an installation teaches nobody until
   * somebody grants it.
   */
  skills(): OrknuxSkillInstance[];

  /**
   * The shapes this plugin exports, for its own functions and tools to pass
   * around. Defaults to none.
   *
   * A plugin's functions belong to every workspace at once, which is why they
   * may not name a workspace's own objects - there is no single workspace
   * whose definitions they could mean, and `map` has been the answer. An
   * object declared here is the better one: it belongs to the plugin, travels
   * with it, and is available wherever the plugin is, under the plugin's
   * key - `Issue` declared by `jira` arrives as `jira_Issue`.
   *
   * Inside the plugin, name them as you spelled them: a property whose `of`
   * is `User` means the `User` this plugin declares, and a function returning
   * `Issue` means this one. The loader rewrites the references when it stores
   * them, and refuses a name that points at nothing.
   */
  objects(): OrknuxObjectInstance[];

  types(): OrknuxTypeInstance[];

  /**
   * The workflow actions this plugin offers: blocks a workflow's Action node
   * can be pointed at, each `{ name, label, description, parameters, outputs,
   * run }`. Defaults to none.
   *
   * A fourth surface with a fourth reader. A function is called with
   * positional arguments by whoever wrote the call; an action is a node on a
   * canvas whose inputs somebody wired by name, so `run` is handed one object
   * keyed by parameter name - an `array` parameter arrives as an array - and
   * a `context` carrying this plugin's `settings`, which is how it reaches the
   * connection the workspace pointed it at. What `run` returns is handed to
   * the next node: an object's fields under the names `outputs` declares,
   * anything else under `result`.
   */
  actions(): OrknuxActionDeclaration[];

  /**
   * What a workspace set those parameters to, keyed by name.
   *
   * Frozen, and put there by the server for the length of one call. A parameter
   * nothing usable is set for is absent rather than null, so
   * `this.settings.token === undefined` is the question to ask. This is the
   * whole of what a plugin knows about the workspace it is running for.
   */
  readonly settings: OrknuxSettings;
}

/**
 * What each declared function is wrapped in.
 *
 * A constructor rather than a plain object because it checks as it builds: a
 * function with no name, no return type or nothing to run fails on the line that
 * declares it, which is where somebody can see what is missing.
 */
export interface OrknuxFunctionConstructor {
  new <
    const Params extends readonly OrknuxParam[] = readonly [],
    Returns extends OrknuxValueType = OrknuxValueType,
  >(
    declaration: OrknuxFunctionDeclaration<Params, Returns>,
  ): OrknuxFunctionInstance;
}

/**
 * What each tool of the plugin's own is wrapped in — the same checking as a
 * function's, at the line that declares it, because a tool is a declaration
 * with a run of its own.
 */
export interface OrknuxToolConstructor {
  new <
    const Params extends readonly OrknuxParam[] = readonly [],
    Returns extends OrknuxValueType = OrknuxValueType,
  >(
    declaration: OrknuxToolDeclaration<Params, Returns>,
  ): OrknuxToolInstance;
}

/**
 * What a proxy to one of the plugin's own functions is wrapped in. Nothing to
 * infer: the params and return type are the named function's, resolved by the
 * loader when the plugin is questioned.
 */
export interface OrknuxFunctionToolConstructor {
  new (declaration: OrknuxFunctionToolDeclaration): OrknuxFunctionToolInstance;
}

/**
 * What each declared parameter is wrapped in, checking as it builds for the
 * same reason: a connection that does not say which kind, or a secret that is
 * not asking for anything a secret could protect, fails on the line that
 * declares it.
 */
export interface OrknuxParameterConstructor {
  new (declaration: OrknuxParameterDeclaration): OrknuxParameterInstance;
}

/**
 * What each skill is wrapped in, checking as it builds for the same reason: a
 * skill with no name or an empty body fails on the line that declares it.
 */
export interface OrknuxSkillConstructor {
  new (declaration: OrknuxSkillDeclaration): OrknuxSkillInstance;
}

/**
 * What each exported object is wrapped in.
 *
 * Checks every field as it builds - a kind that is not a kind, an `of` on
 * something that cannot point at anything, an object that points at nothing.
 * Whether an `of` names an object this plugin actually declares is decided by
 * the loader, which is the one that can see the whole set.
 */
export interface OrknuxObjectConstructor {
  new (declaration: OrknuxObjectDeclaration): OrknuxObjectInstance;
}

export interface OrknuxTypeConstructor {
  new (declaration: OrknuxTypeDeclaration): OrknuxTypeInstance;
}

const scope = globalThis as unknown as {
  OrknuxPlugin?: unknown;
  OrknuxFunction?: unknown;
  OrknuxTool?: unknown;
  OrknuxFunctionTool?: unknown;
  OrknuxParameter?: unknown;
  OrknuxSkill?: unknown;
  OrknuxObject?: unknown;
  OrknuxType?: unknown;
  orknux?: unknown;
};

scope.OrknuxPlugin ??= OrknuxPluginFallback;
scope.OrknuxFunction ??= OrknuxFunctionFallback;
scope.OrknuxTool ??= OrknuxToolFallback;
scope.OrknuxFunctionTool ??= OrknuxFunctionToolFallback;
scope.OrknuxParameter ??= OrknuxParameterFallback;
scope.OrknuxSkill ??= OrknuxSkillFallback;
scope.OrknuxObject ??= OrknuxObjectFallback;
scope.OrknuxType ??= OrknuxTypeFallback;
scope.orknux ??= ungrantedHelpers();

export const OrknuxPlugin = scope.OrknuxPlugin as typeof OrknuxPluginContract;

export const OrknuxFunction = scope.OrknuxFunction as OrknuxFunctionConstructor;

export const OrknuxTool = scope.OrknuxTool as OrknuxToolConstructor;

export const OrknuxFunctionTool = scope.OrknuxFunctionTool as OrknuxFunctionToolConstructor;

export const OrknuxParameter = scope.OrknuxParameter as OrknuxParameterConstructor;

export const OrknuxSkill = scope.OrknuxSkill as OrknuxSkillConstructor;

export const OrknuxObject = scope.OrknuxObject as OrknuxObjectConstructor;

export const OrknuxType = scope.OrknuxType as OrknuxTypeConstructor;

/**
 * What the server will do on a plugin's behalf: the Slack calls, one HTTP door,
 * and a log. Each call needs the capability the plugin declared and a person
 * accepted; without it the answer is `{ error }` saying so, never a throw.
 */
export const orknux = scope.orknux as OrknuxHelpers;

/** The base class as a type, for anything that wants to name it. */
export type OrknuxPluginBase = OrknuxPluginContract;
