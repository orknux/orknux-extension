import {
  OrknuxFunction,
  OrknuxFunctionTool,
  OrknuxParameter,
  OrknuxPlugin,
  OrknuxTool,
} from './contract.js';
import { API_VERSION, PLUGIN_ID } from './limits.js';
import type {
  OrknuxActionDeclaration,
  OrknuxCapability,
  OrknuxConnectionTypeDeclaration,
  OrknuxFunctionDeclaration,
  OrknuxFunctionInstance,
  OrknuxFunctionToolDeclaration,
  OrknuxFunctionToolInstance,
  OrknuxObjectInstance,
  OrknuxParam,
  OrknuxParameterDeclaration,
  OrknuxParameterInstance,
  OrknuxPermission,
  OrknuxPluginConstructor,
  OrknuxTypeInstance,
  OrknuxSkillInstance,
  OrknuxToolDeclaration,
  OrknuxToolInstance,
  OrknuxValueType,
} from './types.js';

/**
 * Declares one function.
 *
 * Sugar over `new OrknuxFunction(...)`, and the reason to prefer it is the
 * inference: the parameters are captured as a tuple, so `run` is typed from what
 * was declared rather than annotated a second time by hand. Change a parameter's
 * type and the body stops compiling, which is the only way the two stay in step.
 */
export function fn<
  const Params extends readonly OrknuxParam[] = readonly [],
  Returns extends OrknuxValueType = OrknuxValueType,
>(declaration: OrknuxFunctionDeclaration<Params, Returns>): OrknuxFunctionInstance {
  return new OrknuxFunction<Params, Returns>(declaration);
}

/**
 * Declares one tool of the plugin's own — offered to agents, with a run of its
 * own.
 *
 * Sugar over `new OrknuxTool(...)`, with the inference `fn` has: the
 * parameters are a tuple and `run` is typed from them. The declaration is a
 * function's; what differs is the reader, so write the description for the
 * model that decides whether to call it. A tool that is really one of the
 * plugin's functions wants `functionTool` instead.
 */
export function tool<
  const Params extends readonly OrknuxParam[] = readonly [],
  Returns extends OrknuxValueType = OrknuxValueType,
>(declaration: OrknuxToolDeclaration<Params, Returns>): OrknuxToolInstance {
  return new OrknuxTool<Params, Returns>(declaration);
}

/**
 * Fronts one of the plugin's own functions for agents.
 *
 * Sugar over `new OrknuxFunctionTool(...)`. A proxy rather than a copy: the
 * params, return type and implementation stay the function's — including any
 * edit somebody makes to it on the server later — and only the name and the
 * model-facing description may be the tool's own. Naming a function
 * `functions()` does not declare is refused where it is written.
 */
export function functionTool(
  declaration: OrknuxFunctionToolDeclaration,
): OrknuxFunctionToolInstance {
  return new OrknuxFunctionTool(declaration);
}

/**
 * Declares one parameter — something the plugin has to be told, once per
 * workspace, arriving as `this.settings`.
 *
 * Sugar over `new OrknuxParameter(...)`, for symmetry with `fn`. There is no
 * inference to buy here; what it buys is the same checking at the line that
 * declares it — a connection that does not say which kind fails where it is
 * written, not on the way into an upload.
 */
export function param(declaration: OrknuxParameterDeclaration): OrknuxParameterInstance {
  return new OrknuxParameter(declaration);
}

/** A plugin, described rather than written out as a class. */
export interface OrknuxPluginSpec {
  /**
   * What this plugin calls itself, and the prefix on everything it declares.
   *
   * Its identity rather than its filename: loading the same id again replaces
   * what is loaded, whatever the file was called.
   */
  id: string;

  /** Which plugin API this was written against. Defaults to the current one. */
  apiVersion?: number;

  /** What it offers to workflows. A plugin may have none and still be worth loading. */
  functions?: readonly OrknuxFunctionInstance[];

  /**
   * What it offers to agents — tools of its own from `tool`, or its own
   * functions fronted with `functionTool`. A tool may share a name with a
   * function, and a proxy defaults to exactly that: the two lists have
   * different readers and never answer the same call.
   */
  tools?: readonly (OrknuxToolInstance | OrknuxFunctionToolInstance)[];

  /**
   * What it has to be told before it can work. Each workspace answers these
   * once, and what they come to arrives as `this.settings` — which is why a
   * `run` that reads settings is written as a method or a `function`, never an
   * arrow: the sandbox calls it with the plugin as `this`.
   */
  parameters?: readonly OrknuxParameterInstance[];

  /**
   * Which JavaScript it needs beyond what every plugin gets. Whoever loads the
   * plugin is shown this list and has to accept it; leave it out if you need
   * nothing, which is the common case.
   */
  permissions?: readonly OrknuxPermission[];

  /**
   * What it asks the server to do on its behalf — the calls behind `orknux`.
   * Shown and accepted apart from the permissions, because a capability reaches
   * outside the sandbox where a permission does not.
   */
  capabilities?: readonly OrknuxCapability[];

  /**
   * The library files it ships with, as paths relative to its own file:
   * `lib/util.js` or `./lib/util.js`. The complete list — every shipped file
   * declared, every relative import resolving within it — and whoever loads
   * the plugin is shown it and has to allow it. Leave it out for a
   * single-file plugin, which is the common case.
   */
  libraries?: readonly string[];

  /**
   * The instruction sets it brings: markdown an agent reads, never code it
   * runs. Leave it out for a plugin that teaches nothing.
   *
   * They arrive as a skill catalog named `<id>_plugin`, granted the way any
   * other catalog is.
   */
  skills?: readonly OrknuxSkillInstance[];

  /**
   * The shapes it exports, for its own functions and tools to pass around.
   * Leave it out for a plugin whose functions answer with scalars and maps.
   *
   * Available wherever the plugin is, under its key: `Issue` declared by
   * `jira` arrives as `jira_Issue`.
   */
  objects?: readonly OrknuxObjectInstance[];

  /** The value types it defines, for a workspace's variables to be. */
  types?: readonly OrknuxTypeInstance[];

  /**
   * The workflow actions it offers: blocks an Action node can be pointed at,
   * each handed its wired inputs as one object. Leave it out for a plugin
   * that offers only functions, which is every one written before this.
   */
  actions?: readonly OrknuxActionDeclaration[];

  /**
   * The kinds of host it talks to, so a workspace can hold several of each by
   * name. A `connection` parameter naming one by its bare name receives the
   * connection's address and credential with the handle. Leave it out for a
   * plugin that reaches no host of its own.
   */
  connectionTypes?: readonly OrknuxConnectionTypeDeclaration[];
}

/**
 * A plugin, as the default export.
 *
 * ```ts
 * export default definePlugin({ id: 'teammates', functions: [ … ] })
 * ```
 *
 * The class style — `class Teammates extends OrknuxPlugin` — is the same thing
 * and equally accepted; this is here because most plugins have nothing to say in
 * a method body that the object does not say already.
 *
 * What it returns really is a class extending the sandbox's `OrknuxPlugin`, not
 * something shaped like one. The server checks the prototype, so nothing else
 * would be loaded.
 */
export function definePlugin(spec: OrknuxPluginSpec): OrknuxPluginConstructor {
  const id = spec.id;
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) {
    throw new Error(
      `"${String(id)}" cannot be a plugin id: it has to start with a letter and hold only ` +
        'letters, digits or underscores, up to 32 of them — it becomes the prefix on ' +
        'every function the plugin declares.',
    );
  }

  const apiVersion = spec.apiVersion ?? API_VERSION;
  const declared = spec.functions === undefined ? [] : [...spec.functions];
  const offered = spec.tools === undefined ? [] : [...spec.tools];
  const wanted = spec.parameters === undefined ? [] : [...spec.parameters];
  const asked = spec.permissions === undefined ? [] : [...spec.permissions];
  const askedOf = spec.capabilities === undefined ? [] : [...spec.capabilities];
  const shipped = spec.libraries === undefined ? [] : [...spec.libraries];
  const taught = spec.skills === undefined ? [] : [...spec.skills];
  const exported = spec.objects === undefined ? [] : [...spec.objects];
  const defined = spec.types === undefined ? [] : [...spec.types];
  const offeredToWorkflows = spec.actions === undefined ? [] : [...spec.actions];
  const hosts = spec.connectionTypes === undefined ? [] : [...spec.connectionTypes];

  /*
   * Checked here rather than left to the upload: a plugin that declares one name
   * twice is refused by the server as a whole, and the sentence it answers with
   * is easier to act on when it arrives while the file is still open. The
   * parameters are held to the same rule for the same reason.
   */
  const seen = new Set<string>();
  for (const declaration of declared) {
    if (seen.has(declaration.name)) {
      throw new Error(`${id} declares ${declaration.name} more than once`);
    }
    seen.add(declaration.name);
  }

  /*
   * Unique among the tools, and a proxy has to name a function that is there.
   * Sharing a name with a function is fine — it is what a proxy defaults to —
   * but a proxy to a function the plugin does not declare is refused by the
   * load, so it is refused here with the load's own sentence.
   */
  const granted = new Set<string>();
  for (const one of offered) {
    if (granted.has(one.name)) {
      throw new Error(`${id} declares the tool ${one.name} more than once`);
    }
    granted.add(one.name);

    if (one.proxyOf !== null && !seen.has(one.proxyOf)) {
      throw new Error(`tools() proxies "${one.proxyOf}", which functions() does not declare`);
    }
  }

  const named = new Set<string>();
  for (const parameter of wanted) {
    if (named.has(parameter.name)) {
      throw new Error(`${id} declares the parameter ${parameter.name} more than once`);
    }
    named.add(parameter.name);
  }

  /*
   * Actions are plain objects with no constructor to refuse a missing run at
   * the line that wrote it, so the two things the load would refuse first are
   * refused here, in the load's own sentences.
   */
  const acted = new Set<string>();
  for (const action of offeredToWorkflows) {
    if (typeof action.run !== 'function') {
      throw new Error(`the action ${String(action.name)} has no run function; it is what the action does`);
    }
    if (acted.has(action.name)) {
      throw new Error(`it declares the action ${action.name} more than once`);
    }
    acted.add(action.name);
  }

  return class extends OrknuxPlugin {
    override id(): string {
      return id;
    }

    override apiVersion(): number {
      return apiVersion;
    }

    /* Copies, so nothing the server is handed can be edited from under it. */
    override functions(): OrknuxFunctionInstance[] {
      return declared.slice();
    }

    override tools(): (OrknuxToolInstance | OrknuxFunctionToolInstance)[] {
      return offered.slice();
    }

    override parameters(): OrknuxParameterInstance[] {
      return wanted.slice();
    }

    override permissions(): OrknuxPermission[] {
      return asked.slice();
    }

    override capabilities(): OrknuxCapability[] {
      return askedOf.slice();
    }

    override libraries(): string[] {
      return shipped.slice();
    }

    override skills(): OrknuxSkillInstance[] {
      return taught.slice();
    }

    override objects(): OrknuxObjectInstance[] {
      return exported.slice();
    }

    override types(): OrknuxTypeInstance[] {
      return defined.slice();
    }

    override actions(): OrknuxActionDeclaration[] {
      return offeredToWorkflows.slice();
    }

    override connectionTypes(): OrknuxConnectionTypeDeclaration[] {
      return hosts.slice();
    }
  };
}
