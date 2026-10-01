import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { OrknuxPlugin } from './contract.js';
import { hostCrypto } from './hosted.js';
import { MAX_SOURCE_BYTES } from './limits.js';
import type {
  DeclaredAction,
  DeclaredActionParam,
  DeclaredConnectionType,
  DeclaredFunction,
  DeclaredObject,
  DeclaredParam,
  DeclaredParameter,
  DeclaredProperty,
  DeclaredSkill,
  DeclaredType,
  DeclaredTool,
  Declaration,
} from './validate.js';

/**
 * Loads a built plugin and asks it what it is.
 *
 * The same questions the server asks, in the same order, refusing on the same
 * answers — so `check` says beforehand what an upload would have said: what the
 * plugin calls itself, which API it uses, what it offers, what it has to be
 * told, which JavaScript it needs, and what it asks the server to do for it.
 * What it is *not* is the server's sandbox: this imports the bundle into this
 * Node process, with everything Node has. Run it on a plugin you wrote, not on
 * one somebody sent you.
 *
 * Importing `./contract.js` is what puts `OrknuxPlugin`, `OrknuxFunction`,
 * `OrknuxParameter` and `orknux` on the global object before the bundle is
 * evaluated, which is the order the sandbox uses and the reason a plugin written
 * against the ambient globals — with no import of this package at all — loads
 * here too.
 */

/** The bundle is not a plugin, or did not hold up its end of the contract. */
export class NotAPluginError extends Error {
  constructor(reason: string) {
    super(`That file is not a usable plugin: ${reason}`);
    this.name = 'NotAPluginError';
  }
}

/** What a plugin answered, and what the file it came from weighs. */
export interface Inspection extends Declaration {
  /** Present even when empty, unlike on a bare [Declaration]: the plugin was asked. */
  tools: DeclaredTool[];
  parameters: DeclaredParameter[];
  permissions: string[];
  capabilities: string[];
  libraries: string[];
  skills: DeclaredSkill[];
  objects: DeclaredObject[];
  types: DeclaredType[];
  actions: DeclaredAction[];
  connectionTypes: DeclaredConnectionType[];
  file: string;
  bytes: number;
  /** The digest the server will store, so the two can be compared. */
  sha256: string;
  /** Whether it is inside the size a plugin may be. */
  withinSizeLimit: boolean;
}

/*
 * Crypto is not granted and reaches nothing, so the sandbox has it always —
 * and a plugin verifying a signature would be untestable while the bundle-safe
 * fallback refuses. Installed here rather than in `contract.ts` because this
 * is the Node-only side, and the main entry has to stay free of `node:`.
 */
hostCrypto();

export async function inspect(file: string): Promise<Inspection> {
  const source = await readFile(file);
  const sha256 = createHash('sha256').update(source).digest('hex');

  /*
   * Node caches a module by URL, and `build` then `check` happens in one process
   * often enough that a second look at the same path would answer with the first
   * one's exports. The digest changes when the file does, which is exactly when
   * the cache should be missed.
   */
  const url = `${pathToFileURL(file).href}?sha256=${sha256.slice(0, 16)}`;

  let exported: unknown;
  try {
    exported = ((await import(url)) as { default?: unknown }).default;
  } catch (failure) {
    throw new NotAPluginError(failure instanceof Error ? failure.message : String(failure));
  }

  if (exported === undefined) throw new NotAPluginError('it has no default export');
  if (typeof exported !== 'function') {
    throw new NotAPluginError('the default export must be a class that extends OrknuxPlugin');
  }
  /*
   * By prototype, as the server does it, and not by looking for methods: a plain
   * object with all the right keys is not a plugin, and finding that out here is
   * the whole point of checking before uploading.
   */
  if (!(exported.prototype instanceof OrknuxPlugin)) {
    throw new NotAPluginError('the default export must extend OrknuxPlugin');
  }

  const plugin = new (exported as new () => Record<string, unknown>)();
  const answer = (method: string): unknown => {
    const asked = (plugin as unknown as Record<string, unknown>)[method];
    if (typeof asked !== 'function') throw new NotAPluginError(`it has no ${method}()`);
    return (asked as () => unknown).call(plugin);
  };

  const id = answer('id');
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new NotAPluginError('id() did not answer with a name');
  }

  const apiVersion = answer('apiVersion');
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
    throw new NotAPluginError('apiVersion() did not answer with a whole number');
  }

  const declared = answer('functions');
  if (!Array.isArray(declared)) {
    throw new NotAPluginError('functions() did not answer with an array');
  }

  const functions = declared.map((one) => read(one as Record<string, unknown>));

  /*
   * What it offers to agents, read the way the loader reads it: a tool
   * constructed as an OrknuxFunctionTool carries `proxyOf` instead of its own
   * params, return type and run, and those are resolved here against what
   * functions() just declared — so a proxy to a function the plugin does not
   * have is refused at load, not discovered by the first agent to call it.
   */
  const offered = answer('tools');
  if (!Array.isArray(offered)) {
    throw new NotAPluginError('tools() did not answer with an array');
  }
  const tools = offered.map((one) => readTool(one as Record<string, unknown>, functions));

  /*
   * What the plugin needs to be told before it can do anything, read the way
   * the loader reads it: the point of declaring parameters is that a workspace
   * can be shown what a plugin will be given before it is given anything.
   */
  const wanted = answer('parameters');
  if (!Array.isArray(wanted)) {
    throw new NotAPluginError('parameters() did not answer with an array');
  }
  const parameters = wanted.map((one) => readParameter(one as Record<string, unknown>));

  /*
   * What JavaScript it says it needs. Trimmed, emptied and read once each, as
   * the loader reads them, before validation judges the names.
   */
  const asked = answer('permissions');
  if (!Array.isArray(asked)) {
    throw new NotAPluginError('permissions() did not answer with an array');
  }
  const permissions = [
    ...new Set(
      asked
        .map((one) => {
          if (typeof one !== 'string') {
            throw new NotAPluginError('permissions() answered with something that is not a name');
          }
          return one.trim();
        })
        .filter((one) => one.length > 0),
    ),
  ];

  /*
   * What it asks the server to do for it. Guarded the way the loader guards it —
   * a plugin with no `capabilities` member asks for nothing — although every
   * plugin loaded against this contract has one, because the base class does.
   */
  const capabilityMember = (plugin as unknown as Record<string, unknown>)['capabilities'];
  const askedOf = typeof capabilityMember === 'function' ? answer('capabilities') : [];
  if (!Array.isArray(askedOf)) {
    throw new NotAPluginError('capabilities() did not answer with an array');
  }
  const capabilities = askedOf.map((one) => {
    if (typeof one !== 'string') {
      throw new NotAPluginError('capabilities() answered with something that is not a name');
    }
    return one;
  });

  /*
   * The files it says it ships with. Guarded the same way: a plugin with no
   * `libraries` member ships none. Whether each path is one the server would
   * take is validation's judgement, not a load failure — but a non-string in
   * the list is not a path at all.
   */
  const libraryMember = (plugin as unknown as Record<string, unknown>)['libraries'];
  const shipped = typeof libraryMember === 'function' ? answer('libraries') : [];
  if (!Array.isArray(shipped)) {
    throw new NotAPluginError('libraries() did not answer with an array');
  }
  const libraries = shipped.map((one) => {
    if (typeof one !== 'string') {
      throw new NotAPluginError('libraries() answered with something that is not a path');
    }
    return one;
  });

  /*
   * The two surfaces that are neither called nor run: the pages an agent
   * reads, and the shapes the plugin exports. Guarded the same way — a plugin
   * with no `skills` member brings none — and read rather than judged, because
   * whether a skill is too long or an `of` points at nothing is validation's
   * question and it needs the whole set to answer it.
   */
  const held = (plugin as unknown as Record<string, unknown>);

  const taught = typeof held['skills'] === 'function' ? answer('skills') : [];
  if (!Array.isArray(taught)) {
    throw new NotAPluginError('skills() did not answer with an array');
  }
  const skills = taught.map((one) => readSkill(one as Record<string, unknown>));

  const shapes = typeof held['objects'] === 'function' ? answer('objects') : [];
  if (!Array.isArray(shapes)) {
    throw new NotAPluginError('objects() did not answer with an array');
  }
  const objects = shapes.map((one) => readObject(one as Record<string, unknown>));

  /*
   * The value types it defines. Read as declared, plus whether each offered
   * the two functions - which is all the server keeps, since the calls go to
   * the source.
   */
  const kinds = typeof held['types'] === 'function' ? answer('types') : [];
  if (!Array.isArray(kinds)) {
    throw new NotAPluginError('types() did not answer with an array');
  }
  const types = kinds.map((one) => readType(one as Record<string, unknown>));

  /*
   * The workflow actions it offers, read the way the loader reads them: the
   * shape and nothing more, except that a `run` has to be there - a function
   * without one is refused by its constructor, and an action is a plain
   * object with no constructor to do it.
   */
  const offeredToWorkflows = typeof held['actions'] === 'function' ? answer('actions') : [];
  if (!Array.isArray(offeredToWorkflows)) {
    throw new NotAPluginError('actions() did not answer with an array');
  }
  const actions = offeredToWorkflows.map((one) => readAction(one as Record<string, unknown>));

  /*
   * The kinds of host it talks to. Asked only of a plugin that has the method,
   * as the loader asks: the sandbox's class carries no default, so a plugin
   * written before these existed is read as declaring none.
   */
  const hosts = typeof held['connectionTypes'] === 'function' ? answer('connectionTypes') : [];
  if (!Array.isArray(hosts)) {
    throw new NotAPluginError('connectionTypes() did not answer with an array');
  }
  const connectionTypes = hosts.map((one) => readConnectionType(one as Record<string, unknown>));

  return {
    id: id.trim(),
    apiVersion,
    functions,
    tools,
    parameters,
    permissions,
    capabilities,
    libraries,
    skills,
    objects,
    types,
    actions,
    connectionTypes,
    file,
    bytes: source.byteLength,
    sha256,
    withinSizeLimit: source.byteLength <= MAX_SOURCE_BYTES,
  };
}

function read(declared: Record<string, unknown>): DeclaredFunction {
  const params = Array.isArray(declared['params']) ? declared['params'] : [];

  return {
    name: text(declared, 'name') ?? refuse('a function has no name'),
    description: text(declared, 'description') ?? null,
    returnType: text(declared, 'returnType') ?? refuse('a function has no returnType'),
    params: params.map((param): DeclaredParam => {
      const one = param as Record<string, unknown>;
      return {
        name: text(one, 'name') ?? refuse('a parameter has no name'),
        type: text(one, 'type') ?? refuse('a parameter has no type'),
        ...(text(one, 'description') === undefined
          ? {}
          : { description: text(one, 'description') }),
        /*
         * Read, not judged. Whether a default is of the parameter's own type,
         * and whether an optional one sits before a required one, are
         * validation's questions — and it needs the whole list to answer the
         * second. Absent stays absent: `required` defaults to true at the
         * server, and a parameter that says nothing is one that said nothing.
         */
        ...(one['required'] === undefined ? {} : { required: one['required'] === true }),
        ...(one['default'] === undefined ? {} : { default: one['default'] }),
      };
    }),
  };
}

function readSkill(declared: Record<string, unknown>): DeclaredSkill {
  return {
    name: text(declared, 'name') ?? refuse('a skill has no name'),
    /*
     * Null where the plugin named none, which is what the server reads as
     * "derive one from the name". Dropping it here was the sixth field to go
     * missing on the way in, and it was invisible to the textual half of the
     * mirror test because `id` is already the name of a plugin's own id.
     */
    id: text(declared, 'id') ?? null,
    description: text(declared, 'description') ?? null,
    content: text(declared, 'content') ?? refuse('a skill has no content'),
  };
}

function readObject(declared: Record<string, unknown>): DeclaredObject {
  const properties = Array.isArray(declared['properties']) ? declared['properties'] : [];

  return {
    name: text(declared, 'name') ?? refuse('an object has no name'),
    description: text(declared, 'description') ?? null,
    properties: properties.map((property): DeclaredProperty => {
      const one = property as Record<string, unknown>;
      return {
        name: text(one, 'name') ?? refuse('a property has no name'),
        kind: text(one, 'kind') ?? refuse('a property has no kind'),
        /*
         * Absent and null are the same answer here — "this field points at
         * nothing" — and validation is what decides whether that was allowed
         * for the kind it is.
         */
        of: text(one, 'of') ?? null,
        description: text(one, 'description') ?? null,
      };
    }),
  };
}

function readTool(declared: Record<string, unknown>, functions: DeclaredFunction[]): DeclaredTool {
  const proxyOf = text(declared, 'proxyOf');
  if (proxyOf !== undefined) {
    const target = functions.find((one) => one.name === proxyOf);
    if (target === undefined) {
      throw new NotAPluginError(`tools() proxies "${proxyOf}", which functions() does not declare`);
    }
    return {
      name: text(declared, 'name') ?? proxyOf,
      description: text(declared, 'description') ?? target.description,
      params: target.params,
      returnType: target.returnType,
      proxyOf,
    };
  }

  const params = Array.isArray(declared['params']) ? declared['params'] : [];
  return {
    name: text(declared, 'name') ?? refuse('a tool has no name'),
    description: text(declared, 'description') ?? null,
    returnType: text(declared, 'returnType') ?? refuse('a tool has no returnType'),
    params: params.map((param): DeclaredParam => {
      const one = param as Record<string, unknown>;
      return {
        name: text(one, 'name') ?? refuse('a tool parameter has no name'),
        type: text(one, 'type') ?? refuse('a tool parameter has no type'),
        ...(text(one, 'description') === undefined
          ? {}
          : { description: text(one, 'description') }),
        /* As above: read here, judged by validation, absent left absent. */
        ...(one['required'] === undefined ? {} : { required: one['required'] === true }),
        ...(one['default'] === undefined ? {} : { default: one['default'] }),
      };
    }),
    proxyOf: null,
  };
}

function readType(declared: Record<string, unknown>): DeclaredType {
  const asked = Array.isArray(declared['parameters']) ? declared['parameters'] : [];
  return {
    name: text(declared, 'name') ?? refuse('a type has no name'),
    description: text(declared, 'description') ?? null,
    base: text(declared, 'base') ?? refuse('a type has no base'),
    parameters: asked.map((one) => readParameter(one as Record<string, unknown>)),
    suggests: typeof declared['suggest'] === 'function',
    validates: typeof declared['validate'] === 'function',
  };
}

function readConnectionType(declared: Record<string, unknown>): DeclaredConnectionType {
  return {
    name: text(declared, 'name') ?? refuse('a connection type has no name'),
    label: text(declared, 'label') ?? refuse('a connection type has no label'),
    description: text(declared, 'description') ?? null,
    urlPlaceholder: text(declared, 'urlPlaceholder') ?? null,
  };
}

function readAction(declared: Record<string, unknown>): DeclaredAction {
  const name = text(declared, 'name') ?? refuse('an action has no name');
  if (typeof declared['run'] !== 'function') {
    refuse(`the action ${name} has no run function; it is what the action does`);
  }
  const parameters = Array.isArray(declared['parameters']) ? declared['parameters'] : [];
  const outputs = Array.isArray(declared['outputs']) ? declared['outputs'] : [];
  return {
    name,
    label: text(declared, 'label') ?? refuse(`the action ${name} has no label`),
    description: text(declared, 'description') ?? null,
    parameters: parameters.map((one) => readActionParam(one as Record<string, unknown>, name, 'parameter')),
    outputs: outputs.map((one) => readActionParam(one as Record<string, unknown>, name, 'output')),
  };
}

function readActionParam(
  declared: Record<string, unknown>,
  action: string,
  side: 'parameter' | 'output',
): DeclaredActionParam {
  return {
    name: text(declared, 'name') ?? refuse(`the action ${action} has ${side === 'output' ? 'an' : 'a'} ${side} with no name`),
    type: text(declared, 'type') ?? refuse(`the action ${action} has ${side === 'output' ? 'an' : 'a'} ${side} with no type`),
    /* Read, judged nowhere: an output is never optional, and the loader reads it as required. */
    ...(declared['required'] === undefined || side === 'output' ? {} : { required: declared['required'] === true }),
    description: text(declared, 'description') ?? null,
  };
}

function readParameter(declared: Record<string, unknown>): DeclaredParameter {
  return {
    name: text(declared, 'name') ?? refuse('a parameter has no name'),
    description: text(declared, 'description') ?? null,
    type: text(declared, 'type') ?? refuse('a parameter has no type'),
    required: flag(declared, 'required', true),
    secret: flag(declared, 'secret', false),
    connectionType: text(declared, 'connectionType') ?? null,
    /*
     * Read, not judged: whether the list is a usable one — non-empty, no
     * duplicates, not on a secret — is validation's question, and it needs
     * the whole parameter to answer it.
     */
    options: Array.isArray(declared['options'])
      ? (declared['options'] as unknown[]).map((one) => String(one))
      : null,
  };
}

/** A member that has to be a string to be worth reading, trimmed, empty read as absent. */
function text(holder: Record<string, unknown>, member: string): string | undefined {
  const value = holder[member];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** A member that has to be a boolean to be worth reading, as the loader reads one. */
function flag(holder: Record<string, unknown>, member: string, fallback: boolean): boolean {
  const value = holder[member];
  return typeof value === 'boolean' ? value : fallback;
}

function refuse(reason: string): never {
  throw new NotAPluginError(reason);
}
