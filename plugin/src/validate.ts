import {
  ACTION_VALUE_TYPES,
  ARGUMENT_TYPES,
  CAPABILITIES,
  CONNECTION,
  CONNECTION_TYPES,
  IDENTIFIER,
  LIBRARY_PATH,
  MAX_ACTIONS,
  MAX_ACTION_PARAMETERS,
  MAX_CONNECTION_TYPES,
  MAX_FUNCTIONS,
  MAX_LIBRARIES,
  MAX_LIBRARY_PATH_LENGTH,
  MAX_OBJECTS,
  MAX_OPTIONS,
  MAX_PARAMETERS,
  MAX_PERMISSIONS,
  MAX_PROPERTIES,
  MAX_SKILLS,
  MAX_SKILL_CHARS,
  MAX_SKILL_ID_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  MAX_TOOLS,
  MAX_TYPES,
  MAX_TYPE_PARAMETERS,
  OBJECT_NAME,
  PARAMETER_TYPES,
  PERMISSIONS,
  PLUGIN_ID,
  PROPERTY_KINDS,
  SKILL_ID_RULE,
  SUPPORTED_API_VERSIONS,
  TYPE_BASES,
  VALUE_TYPES,
} from './limits.js';

/**
 * The server's own rules, applied here.
 *
 * A copy of what the upload does — `PluginDeclarations.validated` and
 * `validatedParameters`, the permission and capability vocabularies, and the
 * bounds `PluginRunner` reads under — wording included, so a plugin that is
 * going to be refused is refused on the machine it was written on. Two
 * deliberate differences: this collects every problem rather than stopping at
 * the first, because a list is what somebody fixing them wants, and it knows
 * nothing about a database — it is given what a plugin answered and says what is
 * wrong with it.
 */

/** One parameter, as the plugin wrote it. Whether the type is real is decided here. */
export interface DeclaredParam {
  name: string;
  type: string;
  /**
   * What this argument is, for whoever — or whatever — reads it.
   *
   * A tool's description is where a model looks first, and a name says what an
   * argument is called and nothing about what belongs in it. Absent where the
   * declaration said nothing, rather than an empty string.
   */
  description?: string | null;
  /**
   * Whether a call has to supply it; absent means it does, which is what every
   * declaration written before this meant by saying nothing.
   */
  required?: boolean;
  /**
   * What arrives when a call leaves it out, and declaring one makes the
   * parameter optional.
   *
   * `run` still receives every argument — the server puts the default in
   * before the call — so there is no `undefined` to guard against.
   */
  default?: unknown;
}

/** One function, as the plugin wrote it. */
export interface DeclaredFunction {
  name: string;
  description?: string | null;
  params: DeclaredParam[];
  returnType: string;
}

/**
 * One tool the plugin offers to agents, as the inspection resolved it.
 *
 * The same shape as a function's declaration plus `proxyOf`: set, it names the
 * plugin's own function this tool stands in front of, and the params and
 * return type here were copied from it when the plugin was questioned. Absent
 * or null for a tool with a `run` of its own.
 */
export interface DeclaredTool {
  name: string;
  description?: string | null;
  params: DeclaredParam[];
  returnType: string;
  proxyOf?: string | null;
}

/**
 * One thing the plugin says it has to be told, as it wrote it.
 *
 * `required` and `secret` are optional here because a declaration is what a
 * plugin answered, and the sandbox's own constructor already filled the
 * defaults in — true and false respectively — before anything was asked.
 */
export interface DeclaredParameter {
  name: string;
  description?: string | null;
  type: string;
  required?: boolean;
  secret?: boolean;
  connectionType?: string | null;
  /** The values it may take, where the plugin knows them all. */
  options?: readonly string[] | null;
}

/** What a plugin answered when it was loaded and asked. */
export interface Declaration {
  id: string;
  apiVersion: number;
  functions: DeclaredFunction[];
  /** Optional because a declaration written before these existed has none. */
  tools?: DeclaredTool[];
  parameters?: DeclaredParameter[];
  permissions?: string[];
  capabilities?: string[];
  /** The relative paths of the library files it ships with; optional for the same reason. */
  libraries?: string[];
  /** The instruction sets it brings; optional for the same reason. */
  skills?: DeclaredSkill[];
  /** The shapes it exports; optional for the same reason. */
  objects?: DeclaredObject[];
  types?: DeclaredType[];
  /** The workflow actions it offers; optional for the same reason. */
  actions?: DeclaredAction[];
  /** The kinds of host it talks to; optional for the same reason. */
  connectionTypes?: DeclaredConnectionType[];
}

/** One kind of host a plugin declares, as it reaches the loader. */
export interface DeclaredConnectionType {
  name: string;
  label: string;
  description?: string | null;
  urlPlaceholder?: string | null;
}

/** One instruction set a plugin brings, as it reaches the loader. */
export interface DeclaredSkill {
  name: string;
  /** What a graph and a command name it by; derived from the name where absent. */
  id?: string | null;
  description?: string | null;
  content: string;
}

/** One field of an exported object, as it reaches the loader. */
export interface DeclaredProperty {
  name: string;
  kind: string;
  /** The object it points at, or what the array holds. */
  of?: string | null;
  description?: string | null;
}

/** One shape a plugin exports, as it reaches the loader. */
export interface DeclaredObject {
  name: string;
  description?: string | null;
  properties: DeclaredProperty[];
}

/** A value type a plugin defines, as inspected: what it declared, and whether it offered the two functions. */
export interface DeclaredType {
  name: string;
  description?: string | null;
  base: string;
  parameters?: DeclaredParameter[];
  suggests?: boolean;
  validates?: boolean;
}

/** One input a workflow action takes, or one output it hands on, as the plugin wrote it. */
export interface DeclaredActionParam {
  name: string;
  type: string;
  /** Absent means required; only an input ever says otherwise. */
  required?: boolean;
  description?: string | null;
}

/**
 * One workflow action, as the plugin wrote it.
 *
 * Whether `run` was a function is the inspection's refusal, as it is for a
 * function's - a declaration without one never reaches here.
 */
export interface DeclaredAction {
  name: string;
  label: string;
  description?: string | null;
  parameters: DeclaredActionParam[];
  outputs: DeclaredActionParam[];
}

/** Something that would stop this plugin being accepted. */
export interface Problem {
  /** Which of the plugin's answers it came from, for grouping in a report. */
  part:
    | 'id'
    | 'apiVersion'
    | 'functions'
    | 'tools'
    | 'parameters'
    | 'permissions'
    | 'capabilities'
    | 'libraries'
    | 'skills'
    | 'objects'
    | 'types'
    | 'actions'
    | 'connectionTypes';
  message: string;
}

/**
 * Whether a default is of the type its parameter declared.
 *
 * Refused here rather than at the call it would apply to: a default of the
 * wrong type only shows up when somebody leaves that argument out, which may
 * be months later and in somebody else's workflow.
 */
function fitsType(type: string, value: unknown): boolean {
  if (value === null) return true;
  switch (type.trim().toLowerCase()) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'map':
      return typeof value === 'object' && !Array.isArray(value);
    case 'connection':
      // Names a row of one workspace, and a plugin belongs to every workspace
      // at once - so there is no row a default could name.
      return false;
    default:
      // A shape the plugin exports, or a type this server does not have; the
      // type itself is refused elsewhere, and guessing here would say so twice.
      return true;
  }
}

/** Everything wrong with what a plugin declared. Empty means the server would take it. */
export function validate(declared: Declaration): Problem[] {
  return [
    ...validateId(declared.id),
    ...validateApiVersion(declared.apiVersion),
    ...validateFunctions(declared.functions, declared.objects ?? []),
    ...validateTools(declared.tools ?? [], declared.functions, declared.objects ?? []),
    ...validateParameters(declared.parameters ?? [], declared.connectionTypes ?? []),
    ...validatePermissions(declared.permissions ?? []),
    ...validateCapabilities(declared.capabilities ?? []),
    ...validateLibraries(declared.libraries ?? []),
    ...validateSkills(declared.skills ?? []),
    ...validateObjects(declared.objects ?? []),
    ...validateTypes(declared.types ?? []),
    ...validateActions(declared.actions ?? []),
    ...validateConnectionTypes(declared.connectionTypes ?? []),
  ];
}

/**
 * The kinds of host a plugin declares, held to what the loader holds them to.
 *
 * The wording is the upload's, from `PluginDeclarations.validatedConnectionTypes`
 * and the bound `PluginRunner` reads under: a usable name declared once, and a
 * label. The name is half of the id a connection stores, so it has to be an
 * identifier that will not need renaming.
 */
export function validateConnectionTypes(declared: DeclaredConnectionType[]): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'connectionTypes', message });
  };

  if (declared.length > MAX_CONNECTION_TYPES) {
    refuse(`connectionTypes() declared more than ${MAX_CONNECTION_TYPES} connection types`);
    return problems;
  }

  const names = new Set<string>();
  for (const kind of declared) {
    const name = typeof kind?.name === 'string' ? kind.name.trim() : '';
    if (!IDENTIFIER.test(name)) {
      refuse(`"${String(kind?.name)}" is not a usable connection type name`);
      continue;
    }
    if (names.has(name)) refuse(`it declares the connection type ${name} more than once`);
    names.add(name);

    const label = typeof kind.label === 'string' ? kind.label.trim() : '';
    if (label.length === 0) refuse(`the connection type ${name} has no label`);
  }
  return problems;
}

/**
 * The workflow actions, held to what the loader holds them to.
 *
 * The wording is the upload's, from `PluginDeclarations.validatedActions`: a
 * usable name declared once, a label, and parameters and outputs that are
 * usable names declared once with a type off the action list - which is wider
 * than a plugin parameter's, because an action's inputs are wired from what a
 * run carries, and spells a free-form map `object`.
 */
export function validateActions(declared: DeclaredAction[]): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'actions', message });
  };

  if (declared.length > MAX_ACTIONS) {
    refuse(`actions() declared more than ${MAX_ACTIONS} actions`);
    return problems;
  }

  const names = new Set<string>();
  for (const action of declared) {
    const name = typeof action?.name === 'string' ? action.name.trim() : '';
    if (!IDENTIFIER.test(name)) {
      refuse(`"${name}" is not a usable action name`);
      continue;
    }
    if (names.has(name)) refuse(`it declares the action ${name} more than once`);
    names.add(name);

    const label = typeof action.label === 'string' ? action.label.trim() : '';
    if (label.length === 0) refuse(`the action ${name} has no label`);

    for (const [side, held] of [
      ['parameter', action.parameters ?? []],
      ['output', action.outputs ?? []],
    ] as const) {
      if (held.length > MAX_ACTION_PARAMETERS) {
        refuse(`the action ${name} declares more than ${MAX_ACTION_PARAMETERS} ${side}s`);
        continue;
      }
      const seen = new Set<string>();
      for (const param of held) {
        const field = typeof param?.name === 'string' ? param.name.trim() : '';
        if (!IDENTIFIER.test(field)) {
          refuse(`the action ${name} has ${aOrAn(side)} called "${field}", which is not a usable name`);
          continue;
        }
        if (seen.has(field)) refuse(`the action ${name} declares the ${side} ${field} twice`);
        seen.add(field);

        const written = typeof param.type === 'string' ? param.type.trim().toLowerCase() : '';
        // `map` is taken too, as the server takes it; `object` is the word offered.
        if (written !== 'map' && !(ACTION_VALUE_TYPES as readonly string[]).includes(written)) {
          refuse(
            `the action ${name}'s ${field} is a "${String(param.type)}", and ${aOrAn(side)} is one of ` +
              `${[...ACTION_VALUE_TYPES, 'map'].join(', ')}`,
          );
        }
      }
    }
  }
  return problems;
}

function aOrAn(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/**
 * The value types a plugin defines, held to what the loader holds them to.
 *
 * The wording is the upload's, from `PluginDeclarations.validatedTypes`: a
 * usable name, one of the three bases, parameters that pass the parameter
 * rules and none of them a secret.
 */
export function validateTypes(declared: DeclaredType[]): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'types', message });
  };

  if (declared.length > MAX_TYPES) {
    refuse(`types() declared more than ${MAX_TYPES} types`);
    return problems;
  }

  const names = new Set<string>();
  for (const type of declared) {
    const name = typeof type?.name === 'string' ? type.name.trim() : '';
    if (!IDENTIFIER.test(name)) {
      refuse(`"${name}" is not a usable type name`);
      continue;
    }
    if (names.has(name)) refuse(`it declares the type ${name} more than once`);
    names.add(name);

    const base = typeof type.base === 'string' ? type.base.trim().toLowerCase() : '';
    if (!(TYPE_BASES as readonly string[]).includes(base)) {
      refuse(`${name} is a "${String(type.base)}", and a type is one of ${TYPE_BASES.join(', ')} with a name on it`);
    }

    const parameters = type.parameters ?? [];
    if (parameters.length > MAX_TYPE_PARAMETERS) {
      refuse(`${name} declares more than ${MAX_TYPE_PARAMETERS} parameters`);
      continue;
    }
    const secret = parameters.find((one) => one.secret === true);
    if (secret !== undefined) {
      refuse(
        `${name} asks to be told ${secret.name} as a secret, and a type cannot be told one: ` +
          'what a variable of the type is told is kept beside it, in the clear.',
      );
    }
    for (const problem of validateParameters(parameters)) {
      refuse(`${name}: ${problem.message}`);
    }
  }
  return problems;
}

/**
 * The skills, held to what the server holds them to.
 *
 * The frontmatter is deliberately not required here, because it is not
 * required there: a plugin that wrote plain markdown and named the skill in
 * its declaration has stated both facts once, and the server writes the block
 * from them. What is checked is a block that *opens* and never closes, which
 * is a mistake rather than an omission.
 */
export function validateSkills(declared: DeclaredSkill[]): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'skills', message });
  };

  if (declared.length > MAX_SKILLS) {
    refuse(`skills() declared more than ${MAX_SKILLS} skills`);
    return problems;
  }

  const seen = new Set<string>();
  /*
   * And the ids, which are the strings anything else writes down: a graph
   * naming skills to load, a message carrying the command marker and an id,
   * `skill_load` being asked for one. The server refuses a bad one rather than
   * correcting it, so it is worth saying here, where the author is reading.
   */
  const ids = new Set<string>();
  for (const skill of declared) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (name.length === 0) {
      refuse('a skill has to have a name');
      continue;
    }
    if (name.length > MAX_SKILL_NAME_LENGTH) {
      refuse(`"${name.slice(0, 40)}…" is longer than a skill name can be (${MAX_SKILL_NAME_LENGTH})`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      refuse(`skills() declares ${name} more than once`);
    }
    seen.add(name.toLowerCase());

    const id = typeof skill.id === 'string' ? skill.id.trim() : '';
    if (id.length > 0) {
      if (!SKILL_ID_RULE.test(id) || id.length > MAX_SKILL_ID_LENGTH) {
        refuse(
          `"${id.slice(0, 40)}" cannot be the id of ${name}: letters, underscores and hyphens only, ` +
            `up to ${MAX_SKILL_ID_LENGTH} of them`,
        );
      } else if (ids.has(id.toLowerCase())) {
        refuse(`skills() declares two skills with the id ${id}`);
      } else {
        ids.add(id.toLowerCase());
      }
    }

    const content = typeof skill.content === 'string' ? skill.content : '';
    if (content.trim().length === 0) {
      refuse(`the skill ${name} has no content: a skill is the markdown an agent reads`);
      continue;
    }
    if (content.length > MAX_SKILL_CHARS) {
      refuse(`the skill ${name} is ${content.length} characters, and a skill is at most ${MAX_SKILL_CHARS}`);
      continue;
    }

    const lines = content.split('\n');
    const first = lines.findIndex((line) => line.trim().length > 0);
    if (first !== -1 && lines[first]?.trim() === '---') {
      const closes = lines.slice(first + 1).some((line) => line.trim() === '---');
      if (!closes) refuse(`the skill ${name} opens a frontmatter fence and never closes it`);
    }
  }
  return problems;
}

/**
 * The exported shapes, held to what the server holds them to.
 *
 * The part worth having locally is the last of them: an `of` naming an object
 * the plugin does not declare. Every other check fires at the line that wrote
 * it, but that one needs the whole set, so it is the one a plugin author
 * otherwise learns about from a refused upload.
 */
export function validateObjects(declared: DeclaredObject[]): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'objects', message });
  };

  if (declared.length > MAX_OBJECTS) {
    refuse(`objects() declared more than ${MAX_OBJECTS} objects`);
    return problems;
  }

  const names = new Set<string>();
  for (const object of declared) {
    const name = typeof object?.name === 'string' ? object.name.trim() : '';
    if (!OBJECT_NAME.test(name)) {
      refuse(`"${name}" is not a usable object name`);
      continue;
    }
    if (names.has(name)) refuse(`objects() declares ${name} more than once`);
    names.add(name);
  }

  for (const object of declared) {
    const name = typeof object?.name === 'string' ? object.name.trim() : '';
    const properties = Array.isArray(object?.properties) ? object.properties : [];
    if (properties.length > MAX_PROPERTIES) {
      refuse(`${name} declares more than ${MAX_PROPERTIES} properties`);
      continue;
    }

    const fields = new Set<string>();
    for (const held of properties) {
      const field = typeof held?.name === 'string' ? held.name.trim() : '';
      if (!IDENTIFIER.test(field)) {
        refuse(`${name} has a property called "${field}", which is not a usable name`);
        continue;
      }
      if (fields.has(field)) refuse(`${name} declares ${field} twice`);
      fields.add(field);

      const kind = typeof held.kind === 'string' ? held.kind.trim().toLowerCase() : '';
      if (!PROPERTY_KINDS.includes(kind)) {
        refuse(`${name}'s ${field} is a "${held.kind}", which is not one of ${PROPERTY_KINDS.join(', ')}`);
        continue;
      }

      const points = kind === 'object' || kind === 'array';
      const of = typeof held.of === 'string' ? held.of.trim() : null;
      if (points && (of === null || of.length === 0)) {
        refuse(
          `${name}'s ${field} is ${kind === 'object' ? 'an object' : 'an array'}, so it needs an "of": ` +
            (kind === 'object' ? 'the object it points at' : 'what it holds'),
        );
        continue;
      }
      if (!points && of !== null) {
        refuse(`${name}'s ${field} names an "of" but is a ${kind}`);
        continue;
      }
      if (of === null) continue;

      // An array of scalars says so with a kind; anything else names an object.
      if (kind === 'array' && PROPERTY_KINDS.includes(of.toLowerCase()) && of.toLowerCase() !== 'object') {
        if (of.toLowerCase() === 'array') {
          refuse(`${name}'s ${field} is an array of arrays, which this server has no shape for`);
        }
        continue;
      }
      if (!names.has(of)) {
        refuse(`${name}'s ${field} points at "${of}", which objects() does not declare`);
      }
    }
  }
  return problems;
}

/**
 * The library paths, held to the shape the server holds them to: relative,
 * `/`-joined, ending in `.js`, nothing that could name a file outside what
 * travels with the plugin. What this cannot check — that every relative import
 * resolves within the declared set — the server checks against the files it
 * actually receives.
 */
export function validateLibraries(declared: string[]): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'libraries', message });
  };

  if (declared.length > MAX_LIBRARIES) {
    refuse(`libraries() declared more than ${MAX_LIBRARIES} files`);
    return problems;
  }

  const seen = new Set<string>();
  for (const path of declared) {
    if (typeof path !== 'string' || path.trim().length === 0) {
      refuse('a library path has to be a non-empty string');
      continue;
    }
    const held = path.trim();
    if (held.length > MAX_LIBRARY_PATH_LENGTH) {
      refuse(`"${held.slice(0, 40)}…" is longer than a library path can be (${MAX_LIBRARY_PATH_LENGTH})`);
      continue;
    }
    if (!LIBRARY_PATH.test(held)) {
      refuse(
        `"${held}" is not a usable library path: relative, /-joined and ending in .js — ` +
          'no absolute paths, no URLs, no .., no bare specifiers',
      );
      continue;
    }
    // The same file spelled with and without './' is one file; the server
    // stores it without, so it is compared without.
    const bare = held.replace(/^\.\//, '');
    if (seen.has(bare)) {
      refuse(`libraries() declares ${bare} more than once`);
    }
    seen.add(bare);
  }
  return problems;
}

export function validateId(id: string): Problem[] {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return [{ part: 'id', message: 'id() did not answer with a name' }];
  }
  if (!PLUGIN_ID.test(id.trim())) {
    return [
      {
        part: 'id',
        message:
          `"${id}" cannot be a plugin id: it has to start with a letter and hold only ` +
          'letters, digits or underscores, up to 32 of them — it becomes the prefix on ' +
          'every function the plugin declares.',
      },
    ];
  }
  return [];
}

export function validateApiVersion(version: number): Problem[] {
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return [{ part: 'apiVersion', message: 'apiVersion() did not answer with a whole number' }];
  }
  if (!SUPPORTED_API_VERSIONS.includes(version)) {
    return [
      {
        part: 'apiVersion',
        message:
          `The plugin uses plugin API version ${version}, which this server does not know. ` +
          `It supports ${[...SUPPORTED_API_VERSIONS].sort((a, b) => a - b).join(', ')}.`,
      },
    ];
  }
  return [];
}

export function validateFunctions(
  declared: DeclaredFunction[],
  objects: DeclaredObject[] = [],
): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'functions', message });
  };

  if (declared.length > MAX_FUNCTIONS) {
    refuse(`functions() declared more than ${MAX_FUNCTIONS} functions`);
  }

  /*
   * The shapes this plugin exports, which a return type may name.
   *
   * `Issue` declared by `jira` arrives in a workspace as `jira_Issue`, but
   * inside the plugin it is spelled as it was declared — the loader rewrites
   * the reference when it stores it. Matched exactly, the way an `of` is:
   * these are identifiers, and a shape that differs only in its capitals is a
   * different shape.
   *
   * Only a *return* is allowed to name one. A parameter still may not, and the
   * refusal below says why — which is stricter than the server if the server
   * ever relaxes that too, and stricter is the safe direction for this file to
   * be wrong in.
   */
  const exported = new Set(objects.map((one) => one.name));


  const names = new Set<string>();
  for (const declaration of declared) {
    const name = declaration.name;

    if (!IDENTIFIER.test(name)) {
      refuse(`"${name}" is not a usable function name`);
    }
    if (names.has(name)) {
      refuse(`it declares ${name} more than once`);
    }
    names.add(name);

    /*
     * `none` and `object` are types the server has and a plugin may not use, so
     * they are named in the refusal rather than lumped in with a typo. A plugin's
     * functions belong to every workspace at once, and an object names one
     * workspace's definition — there is no workspace here for it to mean.
     */
    if (isReserved(declaration.returnType)) {
      refuse(
        declaration.returnType.trim().toLowerCase() === 'none'
          ? `${name} must return something, not none`
          : `${name} returns an object, which names one of a workspace's definitions. A ` +
              "plugin's functions belong to every workspace at once, so use map instead.",
      );
    } else if (!isValueType(declaration.returnType) && !exported.has(declaration.returnType.trim())) {
      /*
       * The server's own sentence, unchanged. A name that is neither a value
       * type nor a declared shape is not a type this server has — and the
       * wording is what somebody reads when their plugin is refused, so it
       * stays the server's rather than becoming a better one of ours.
       */
      refuse(`${name} returns "${declaration.returnType}", which is not a type this server has`);
    }

    const params = new Set<string>();
    // Per declaration: the optional ones come last, and this is what remembers
    // that one has been seen.
    let optionalSeen = false;
    for (const param of declaration.params) {
      if (!IDENTIFIER.test(param.name)) {
        refuse(`${name} has a parameter called "${param.name}", which is not a usable name`);
      }
      if (params.has(param.name)) {
        refuse(`${name} declares ${param.name} twice`);
      }
      /*
       * What it says about being left out. A default implies optional, and one
       * that could never apply is the trap this refuses rather than ignores.
       */
      const optional = param.default !== undefined ? param.required !== true : param.required === false;
      if (param.default !== undefined && param.required === true) {
        refuse(
          `${name}'s ${param.name} has a default and is required, so the default can never apply`,
        );
      }
      if (param.default !== undefined && !fitsType(param.type, param.default)) {
        refuse(`${name}'s ${param.name} is a ${param.type.trim().toLowerCase()} and its default is not one`);
      }
      optionalSeen = optionalSeen || optional;
      if (optionalSeen && !optional) {
        /*
         * Arguments are positional, so "may be left out" only means anything
         * at the end: nothing downstream could tell which argument was
         * missing if a required one followed an optional one.
         */
        refuse(
          `${name} takes ${param.name} after one that may be left out. ` +
            'Arguments are positional, so the optional ones come last.',
        );
      }
      params.add(param.name);

      const written = param.type.trim().toLowerCase();
      if (written === 'object') {
        refuse(
          `${name}'s ${param.name} is an object, which names one of a workspace's ` +
            "definitions. A plugin's functions belong to every workspace at once, so there is " +
            'no workspace whose objects they could name. Use map instead.',
        );
      } else if (written === 'none') {
        /*
         * Stricter than the upload, which lets this through: nothing can be passed
         * for a parameter that is declared to carry no value, so a workflow calling
         * it would have nothing to fill in. Refused here because it is a mistake
         * either way, and the types in this package cannot express it anyway.
         */
        refuse(`${name}'s ${param.name} is a "none", and a parameter has to carry something`);
      } else if (!isArgumentType(param.type)) {
        refuse(`${name}'s ${param.name} is a "${param.type}", which is not a type this server has`);
      }
    }
  }

  return problems;
}

/**
 * The rules the agents' surface is held to — `PluginDeclarations.validatedTools`,
 * in the upload's own sentences.
 *
 * Tool names are identifiers and unique among the tools; sharing a name with a
 * function is fine, and is exactly what a proxy defaults to — the two lists
 * have different readers and never answer the same call. A tool answers a
 * model, so `none` and `object` are refused as return types by name. And a
 * proxy has to front a function the plugin declares, which is the loader's
 * refusal rather than the upload's: the inspection resolves proxies before the
 * upload ever judges them, so it is applied here from [functions].
 */
export function validateTools(
  declared: DeclaredTool[],
  functions: DeclaredFunction[] = [],
  objects: DeclaredObject[] = [],
): Problem[] {
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'tools', message });
  };

  if (declared.length > MAX_TOOLS) {
    refuse(`tools() declared more than ${MAX_TOOLS} tools`);
  }

  /* The shapes a tool's return may name, as above. */
  const exported = new Set(objects.map((one) => one.name));

  const offered = new Set(functions.map((one) => one.name));
  const names = new Set<string>();
  for (const tool of declared) {
    const name = tool.name;

    if (!IDENTIFIER.test(name)) {
      refuse(`"${name}" is not a usable tool name`);
    }
    if (names.has(name)) {
      refuse(`it declares the tool ${name} more than once`);
    }
    names.add(name);

    const proxyOf = tool.proxyOf ?? null;
    if (proxyOf !== null && !offered.has(proxyOf)) {
      refuse(`tools() proxies "${proxyOf}", which functions() does not declare`);
    }

    if (isReserved(tool.returnType)) {
      refuse(
        `the tool ${name} returns ${tool.returnType.trim().toLowerCase()}; a tool answers a model, ` +
          `so it has to return one of ${VALUE_TYPES.join(', ')}`,
      );
    } else if (!isValueType(tool.returnType) && !exported.has(tool.returnType.trim())) {
      refuse(`the tool ${name} returns "${tool.returnType}", which is not a type this server has`);
    }

    const params = new Set<string>();
    // Per declaration: the optional ones come last, and this is what remembers
    // that one has been seen.
    let optionalSeen = false;
    for (const param of tool.params) {
      if (!IDENTIFIER.test(param.name)) {
        refuse(`the tool ${name} has a parameter called "${param.name}", which is not a usable name`);
      }
      if (params.has(param.name)) {
        refuse(`the tool ${name} declares ${param.name} twice`);
      }
      const optional = param.default !== undefined ? param.required !== true : param.required === false;
      if (param.default !== undefined && param.required === true) {
        refuse(
          `the tool ${name}'s ${param.name} has a default and is required, so the default can never apply`,
        );
      }
      if (param.default !== undefined && !fitsType(param.type, param.default)) {
        refuse(
          `the tool ${name}'s ${param.name} is a ${param.type.trim().toLowerCase()} and its default is not one`,
        );
      }
      optionalSeen = optionalSeen || optional;
      if (optionalSeen && !optional) {
        refuse(
          `the tool ${name} takes ${param.name} after one that may be left out. ` +
            'Arguments are positional, so the optional ones come last.',
        );
      }
      params.add(param.name);

      /*
       * Stricter than the upload, which reads a tool's params against the
       * whole type list: `none` and `object` cannot be filled in by a model
       * any more than by a workflow, the types in this package cannot express
       * them, and refusing them here can only stop something no plugin should
       * be doing.
       */
      const written = param.type.trim().toLowerCase();
      if (written === 'none') {
        refuse(`the tool ${name}'s ${param.name} is a "none", and a parameter has to carry something`);
      } else if (written === 'object') {
        refuse(
          `the tool ${name}'s ${param.name} is an object, which names one of a workspace's ` +
            "definitions. A plugin's tools belong to every workspace at once, so there is " +
            'no workspace whose objects they could name. Use map instead.',
        );
      } else if (!isArgumentType(param.type)) {
        refuse(
          `the tool ${name}'s ${param.name} is a "${param.type}", which is not a type this server has`,
        );
      }
    }
  }

  return problems;
}

/**
 * The rules a plugin's own parameters are held to — the ones a workspace
 * answers, not the ones a caller fills in.
 *
 * The wording is the upload's, from `PluginDeclarations.validatedParameters`,
 * plus the bound `PluginRunner` reads under. A connection is the one parameter
 * that is neither typed in nor read from a variable: it points at a row the
 * workspace already has, so it is checked on its own terms and never against
 * the scalar types.
 *
 * @param ownKinds the connection kinds this same plugin declares, which a
 *   `connection` parameter may name beside the core ones - by the bare name,
 *   matched exactly, as the upload matches it.
 */
export function validateParameters(
  declared: DeclaredParameter[],
  ownKinds: readonly DeclaredConnectionType[] = [],
): Problem[] {
  const own = ownKinds
    .map((kind) => (typeof kind?.name === 'string' ? kind.name.trim() : ''))
    .filter((name) => name.length > 0);
  const problems: Problem[] = [];
  const refuse = (message: string): void => {
    problems.push({ part: 'parameters', message });
  };

  if (declared.length > MAX_PARAMETERS) {
    refuse(`parameters() declared more than ${MAX_PARAMETERS} parameters`);
  }

  const names = new Set<string>();
  for (const parameter of declared) {
    const name = parameter.name;

    if (!IDENTIFIER.test(name)) {
      refuse(`"${name}" is not a usable parameter name`);
    }
    if (names.has(name)) {
      refuse(`it declares the parameter ${name} more than once`);
    }
    names.add(name);

    const connectionType = parameter.connectionType ?? null;

    if (parameter.type.trim().toLowerCase() === CONNECTION) {
      const ownKind = connectionType !== null && own.includes(connectionType.trim());
      if (!isConnectionType(connectionType) && !ownKind) {
        refuse(
          `the parameter ${name} is a connection but does not say which kind. ` +
            `It has to name one of ${[...CONNECTION_TYPES, ...own].join(', ')}.`,
        );
      }
      if (parameter.secret === true) {
        /*
         * Refused rather than ignored, as the upload refuses it: a connection
         * parameter holds no secret — it names a row, and the credential on
         * that row is kept and encrypted with the connection, crossing only
         * for a host of the plugin's own kind — so a plugin marking one secret
         * has misunderstood what it is being given.
         */
        refuse(
          `the parameter ${name} is a connection and cannot be a secret: it names a ` +
            "connection rather than holding one's credential.",
        );
      }
      /*
       * And a connection is not chosen from a list of values - it names a row
       * the workspace has, and the settings form already draws a picker of
       * those. Said inside this branch because the branch returns: leaving it
       * to the check below meant a connection carrying options passed here
       * and was refused by the sandbox, which is the wrong way round for a
       * mirror to be wrong.
       */
      if (parameter.options !== undefined && parameter.options !== null) {
        refuse(`the parameter ${name} cannot have options: it is a connection`);
      }
      continue;
    }

    if (connectionType !== null) {
      refuse(`the parameter ${name} names a connection kind but is a "${parameter.type}".`);
      continue;
    }

    if (!isParameterType(parameter.type)) {
      refuse(
        `the parameter ${name} is a "${parameter.type}". A parameter is either typed in, ` +
          "points at one of the workspace's variables, or names one of the workspace's " +
          'connections, so it has to be one of ' +
          `${[...PARAMETER_TYPES, CONNECTION].join(', ')}.`,
      );
    }

    /*
     * The values it may take, where there is a fixed set. What this buys is a
     * picker on the settings page instead of a text box - so the rules are
     * about what a picker can be: something to choose from, each row distinct,
     * and short enough to read rather than search.
     */
    const offered = parameter.options ?? null;
    if (offered !== null) {
      if (!Array.isArray(offered) || offered.length === 0) {
        refuse(`the parameter ${name} has options, which have to be a non-empty array`);
      } else if (offered.some((one) => typeof one !== 'string' || one.trim().length === 0)) {
        refuse(`the parameter ${name} has an option that is not a name`);
      } else if (new Set(offered.map((one) => one.trim())).size !== offered.length) {
        refuse(`the parameter ${name} offers the same option more than once`);
      } else if (offered.length > MAX_OPTIONS) {
        refuse(
          `the parameter ${name} offers ${offered.length} options, and a picker holds at most ${MAX_OPTIONS}`,
        );
      }
      // A secret cannot be one of a set somebody can read; the connection case
      // has already been dealt with and continued above.
      if (parameter.secret === true) {
        refuse(`the parameter ${name} cannot have options: it is a secret`);
      }
    }
  }

  return problems;
}

/**
 * The permission vocabulary, applied as the server applies it: a closed list,
 * matched exactly. Not case-folded — a plugin asking for something is making a
 * precise request, and being generous about how it is spelled is how a typo
 * becomes a grant of something adjacent.
 */
export function validatePermissions(declared: string[]): Problem[] {
  const problems: Problem[] = [];

  /*
   * The loader trims what `permissions()` answered, drops empties and reads
   * each name once before any of this is judged, so the same is done here —
   * a name asked for twice is one request, not two refusals.
   */
  const asked = [...new Set(declared.map((name) => name.trim()).filter((name) => name.length > 0))];

  if (asked.length > MAX_PERMISSIONS) {
    problems.push({
      part: 'permissions',
      message: `permissions() asked for more than ${MAX_PERMISSIONS} things`,
    });
  }

  for (const name of asked) {
    if (!(PERMISSIONS as readonly string[]).includes(name)) {
      problems.push({
        part: 'permissions',
        message:
          `This plugin asks for "${name}", which is not something this server can grant. ` +
          `It grants ${PERMISSIONS.join(', ')}.`,
      });
    }
  }

  return problems;
}

/**
 * The capability vocabulary, applied as the server applies it.
 *
 * There is no count bound here because the loader reads these under none: the
 * closed list is the bound, and a name that is not on it is refused whatever
 * the length. Matched forgivingly — trimmed, any case — because that is how
 * `PluginCapability.named` matches.
 */
export function validateCapabilities(declared: string[]): Problem[] {
  const problems: Problem[] = [];

  for (const name of declared) {
    const matched = (CAPABILITIES as readonly string[]).some(
      (capability) => capability.toLowerCase() === name.trim().toLowerCase(),
    );
    if (!matched) {
      problems.push({
        part: 'capabilities',
        message:
          `This server has no capability called "${name}". ` +
          'A plugin may only ask for the ones it has.',
      });
    }
  }

  return problems;
}

/** `teammates_isTeammate` — what a workflow will call this by once it is loaded. */
export function qualifiedName(id: string, name: string): string {
  return `${id}_${name}`;
}

/** A type the server has but a plugin may not use. Worth its own sentence. */
function isReserved(type: string): boolean {
  const written = type.trim().toLowerCase();
  return written === 'none' || written === 'object';
}

function isValueType(type: string): boolean {
  const written = type.trim().toLowerCase();
  return (VALUE_TYPES as readonly string[]).includes(written);
}

function isArgumentType(type: string): boolean {
  const written = type.trim().toLowerCase();
  return (ARGUMENT_TYPES as readonly string[]).includes(written);
}

function isParameterType(type: string): boolean {
  const written = type.trim().toLowerCase();
  return (PARAMETER_TYPES as readonly string[]).includes(written);
}

/** Matched the way the server matches a connection kind: trimmed, any case. */
function isConnectionType(named: string | null): boolean {
  if (named === null) return false;
  const written = named.trim().toLowerCase();
  return (CONNECTION_TYPES as readonly string[]).some((kind) => kind.toLowerCase() === written);
}
