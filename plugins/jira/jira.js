/*
 * Jira, as a plugin.
 *
 * The other half of the sentence the github plugin starts. A pull request
 * merging is only half of "the work is done"; the other half is a ticket
 * moving, and a workflow that can read one and not write the other is a
 * workflow somebody finishes by hand. So: find issues by JQL, open one whole,
 * comment on it, move it, and raise a new one.
 *
 * A plugin has no network, deliberately and permanently, so every call is made
 * by the *server* on the plugin's behalf, under the NETWORK_REQUEST capability
 * a person accepted, against the Jira the workspace named.
 *
 * ## Cloud or Server, decided by the connection's auth kind
 *
 * The same rule the confluence plugin uses, because it is the same company's
 * two products: a connection authenticating with Basic is Atlassian Cloud, its
 * secret `email:token`; one sending a Bearer token is Server or Data Center,
 * its secret a personal access token. That one choice is also what picks the
 * search endpoint below, which is the one place the two genuinely differ.
 *
 * ## Why v2 everywhere except search
 *
 * Jira's v3 API speaks Atlassian Document Format: a description or a comment
 * is not a string but a tree of nodes, and posting a one-line comment would
 * mean building one. v2 takes and answers plain text, so v2 is what this file
 * uses for reading an issue, commenting, transitioning and creating.
 *
 * Search is the exception, and not by choice. Atlassian **removed**
 * `/rest/api/2/search` and `/rest/api/3/search` from Cloud through the second
 * half of 2025 — they answer 410 now — leaving `POST /rest/api/3/search/jql`,
 * which is bounded: it wants an explicit field list, it pages by a cursor
 * rather than an offset, and it does not answer a total at all. Server and
 * Data Center still have v2 search and still answer a total. So `search` picks
 * its endpoint by the same auth kind, and `total` comes back null on Cloud
 * rather than invented.
 *
 * ## The fields a project adds
 *
 * A project can make fields of its own mandatory on a new issue — "Occurs on:
 * PROD, UAT or DEV", "Kind of work: one of six" — and Jira refuses a create
 * that leaves one out. Those fields are `customfield_10123` on the wire, with
 * a shape per kind: a choice is `{ id }`, a user is `{ accountId }` or
 * `{ name }` by deployment, a list is a list of those. Nobody calling from a
 * workflow, and no model calling from an agent, should have to know any of
 * that.
 *
 * So `form` reads the create metadata for a project and issue type — every
 * field, by name, with the values a choice takes — and `createIssue` takes a
 * `fields` map keyed by those names, resolves each against the same
 * metadata, and builds Jira's shape itself. "Occurs on": "DEV" becomes
 * `customfield_10123: { id: "10201" }`, and a value that is not one of the
 * choices is refused here, with the choices, rather than by Jira with an id.
 *
 * ## Setting one up
 *
 * 1. Load this plugin and accept NETWORK_REQUEST.
 * 2. Add a connection of the kind it declares, Jira, with the site root as its
 *    URL — `https://your-site.atlassian.net` for Cloud, or the base url of a
 *    Server install.
 * 3. For Cloud, authenticate with Basic and `email:token` as the secret — an
 *    API token and whose it is. For Server, a Bearer personal access token.
 * 4. Point the plugin's `jira` parameter at that connection.
 * 5. Set `project` to the key new issues belong to unless a call says
 *    otherwise — optional, and one fewer thing to wire.
 *
 * ## Why a connection and not three settings
 *
 * The address and the credential used to be the plugin's own parameters, so a
 * workspace had exactly one Jira and its token sat on the plugin's page. A
 * connection is where a workspace already keeps hosts: encrypted, checked, one
 * row per site — and a kind of its own keeps the picker to Jira sites rather
 * than every HTTP endpoint there is. Because the kind is this plugin's, the
 * server hands its address and headers across with the handle; nothing but
 * this plugin knows how to speak to it.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

/** The fields a search asks for, because the Cloud endpoint insists on a list. */
const SEARCH_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'updated',
  'created',
];

/** A nested field, or null rather than a thrown error on the way down. */
function at(holder, name) {
  if (holder === null || typeof holder !== 'object') {
    return null;
  }
  const held = holder[name];
  return held === undefined ? null : held;
}

/**
 * A field as readable text.
 *
 * v2 answers a description as a string, which is the whole reason this file
 * uses it. Should an instance ever hand back Atlassian Document Format
 * instead, the tree is walked for its text rather than answered as the
 * `[object Object]` a caller would otherwise be shown.
 */
function plainOf(value) {
  if (typeof value === 'string' || value === null || value === undefined) {
    return value ?? null;
  }
  const said = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (typeof node.text === 'string') {
      said.push(node.text);
    }
    if (node.type === 'paragraph' || node.type === 'heading') {
      said.push('\n');
    }
    walk(node.content);
  };
  walk(value);
  return said.join('').trim();
}

/**
 * The connection the workspace pointed this plugin at, with its address.
 *
 * Only a connection of this plugin's own kind crosses with `url` and
 * `headers`; anything else arrives as a bare handle. So a handle without a url
 * is a connection this plugin cannot use - a plain HTTP one, or a server old
 * enough to hand every connection over as a name only - and saying which is
 * kinder than a request to `undefined/rest/api/...`.
 */
function site(settings) {
  const connection = settings.jira;
  if (connection === undefined || connection === null) {
    throw new Error("the plugin's jira parameter is not set, and every Jira call needs it");
  }
  if (typeof connection.url !== 'string' || connection.url.length === 0) {
    throw new Error(
      "the jira parameter names a connection that is not a Jira connection of this plugin's " +
        'kind, so its address never reached the plugin - point it at a Jira connection, on a server ' +
        'that hands one over',
    );
  }
  return connection;
}

/** The site root, without its trailing slash. */
function root(settings) {
  const url = site(settings).url;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Whether this is Atlassian Cloud, which is what a connection authenticating with Basic means. */
function isCloud(settings) {
  return site(settings).authType === 'BASIC';
}

/**
 * The headers a call goes out with: json asked for, and whatever the
 * connection says to send - its credential already spelled for its auth kind,
 * so Basic and Bearer are the connection's business, not this.
 */
function headers(settings) {
  return Object.assign({ accept: 'application/json' }, site(settings).headers ?? {});
}

/** One call to Jira, authenticated, answered or thrown. */
function call(settings, asked) {
  const answered = orknux.http.request({
    url: root(settings) + asked.path,
    method: asked.method === undefined ? 'GET' : asked.method,
    headers: headers(settings),
    body: asked.body,
  });
  if (answered.error !== undefined) {
    throw new Error(`could not reach Jira: ${answered.error}`);
  }
  if (answered.status >= 400) {
    /*
     * Jira says why in `errorMessages` for the whole request and in `errors`
     * per field — a rejected create names the field, which is the useful half.
     */
    const messages = at(answered.json, 'errorMessages');
    const fields = at(answered.json, 'errors');
    /*
     * All of them, not the first: a project that insists on two fields says
     * so in one answer, and reporting one of them is a second round trip
     * to learn the other.
     */
    const said = [
      ...(Array.isArray(messages) ? messages : []),
      ...(fields !== null && typeof fields === 'object'
        ? Object.entries(fields).map(([field, why]) => `${field}: ${why}`)
        : []),
    ].filter((one) => typeof one === 'string' && one.length > 0);
    throw new Error(
      `Jira answered ${answered.status}${said.length > 0 ? ': ' + said.join('; ') : ''} for ${asked.path.split('?')[0]}`,
    );
  }
  return answered.json;
}

/** What one of a field's allowed values is called, whichever of Jira's spellings it carries. */
function labelOf(allowed) {
  const said = at(allowed, 'value') ?? at(allowed, 'name') ?? at(allowed, 'key') ?? at(allowed, 'id');
  return said === null ? null : String(said);
}

/** The allowed value a caller meant, by its label or its id, whatever the capitals. */
function allowedNamed(allowedValues, wanted) {
  const asked = String(wanted).trim().toLowerCase();
  return (
    allowedValues.find((one) => (labelOf(one) ?? '').toLowerCase() === asked) ??
    allowedValues.find((one) => String(at(one, 'id') ?? '').toLowerCase() === asked) ??
    null
  );
}

/**
 * The create form for one issue type in one project, read from Jira's create
 * metadata: what the plugin's `form` answers, and what `createIssue` resolves
 * a `fields` map against.
 *
 * Two calls, because that is how the endpoint is shaped: the issue types a
 * project offers, then the fields one of them takes. The type is matched by
 * name whatever the capitals, or by its id for a caller that has one. Cloud
 * answers `issueTypes` and `fields`; Data Center answers `values` for both,
 * so both spellings are read.
 *
 * Each entry keeps Jira's own `schema` and `allowedValues` beside the
 * declared `Field`, because resolving "DEV" to `{ id: "10201" }` needs the
 * ids the shape deliberately leaves out.
 */
function formOf(settings, project, type) {
  const base = `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`;
  const listed = call(settings, { path: `${base}?maxResults=200` });
  const types = at(listed, 'issueTypes') ?? at(listed, 'values') ?? [];
  const wanted = String(type).trim().toLowerCase();
  const found =
    types.find((one) => String(at(one, 'name') ?? '').toLowerCase() === wanted) ??
    types.find((one) => String(at(one, 'id') ?? '') === wanted) ??
    null;
  if (found === null) {
    const offered = types.map((one) => at(one, 'name')).filter((name) => typeof name === 'string');
    throw new Error(
      `${project} has no issue type "${type}"` + (offered.length > 0 ? `; it has ${offered.join(', ')}` : ''),
    );
  }

  const read = call(settings, {
    path: `${base}/${encodeURIComponent(String(at(found, 'id')))}?maxResults=200`,
  });
  const entries = (at(read, 'fields') ?? at(read, 'values') ?? []).map((one) =>
    entryOf(one, at(one, 'fieldId') ?? at(one, 'key')),
  );
  return { project: project, type: at(found, 'name'), entries: entries };
}

/** One form entry from one of Jira's field metadata objects, under the id it is keyed by. */
function entryOf(one, id) {
  const schema = at(one, 'schema');
  const allowedValues = Array.isArray(at(one, 'allowedValues')) ? at(one, 'allowedValues') : [];
  return {
    schema: schema,
    allowedValues: allowedValues,
    field: {
      id: id,
      name: at(one, 'name'),
      required: at(one, 'required') === true,
      kind: at(schema, 'type'),
      of: at(schema, 'items'),
      allowed: allowedValues.map(labelOf).filter((label) => label !== null),
      hasDefault: at(one, 'hasDefaultValue') === true,
    },
  };
}

/**
 * The edit form of one existing issue: what `updateIssue` resolves its
 * `fields` map against. Jira's edit metadata is a map keyed by field id
 * rather than the list the create metadata is, and it already reflects what
 * this issue, in this status, under this token, can be changed — which is
 * why it is read per issue rather than per project.
 */
function editFormOf(settings, key) {
  const read = call(settings, { path: `/rest/api/2/issue/${encodeURIComponent(key)}/editmeta` });
  const held = at(read, 'fields');
  const entries =
    held !== null && typeof held === 'object' ? Object.entries(held).map(([id, one]) => entryOf(one, id)) : [];
  return { entries: entries };
}

/** A `fields` map resolved against a form: Jira's shape for each, under the field's id. */
function resolved(settings, form, extra, missing) {
  const fields = {};
  const asked = extra !== null && typeof extra === 'object' ? Object.entries(extra) : [];
  for (const [name, value] of asked) {
    const entry = entryNamed(form, name);
    if (entry === null) {
      throw new Error(missing(name));
    }
    fields[entry.field.id] = valueFor(settings, entry, value);
  }
  return fields;
}

/** The project a call is about: what was passed, or the configured one. */
function projectOr(settings, project) {
  if (typeof project === 'string' && project.trim().length > 0) {
    return project.trim();
  }
  const fallback = settings.project;
  if (typeof fallback === 'string' && fallback.trim().length > 0) {
    return fallback.trim();
  }
  throw new Error('no project was passed and no default project is configured');
}

/** The issue type a call is about: what was passed, or a Task. */
function typeOr(type) {
  return typeof type === 'string' && type.trim().length > 0 ? type.trim() : 'Task';
}

/** The form entry a `fields` key names: a field id as Jira spells it, or a name whatever the capitals. */
function entryNamed(form, key) {
  const asked = String(key).trim().toLowerCase();
  return (
    form.entries.find((one) => String(one.field.id ?? '').toLowerCase() === asked) ??
    form.entries.find((one) => String(one.field.name ?? '').toLowerCase() === asked) ??
    null
  );
}

/** A calendar date as `YYYY-MM-DD`, from a Date read in UTC. */
function dayOf(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The week before this one, Monday to Sunday: what "last week" means when
 * a timesheet is being checked, and the range `timeLogged` takes when it is
 * given none.
 */
function previousWeek(now) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  const monday = new Date(today.getTime() - (sinceMonday + 7) * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return { from: dayOf(monday), to: dayOf(sunday) };
}

/** A date argument checked to be one, or the fallback where it was left empty. */
function dateOr(given, fallback, what) {
  const said = typeof given === 'string' ? given.trim() : '';
  if (said.length === 0) {
    return fallback;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(said) || Number.isNaN(Date.parse(`${said}T00:00:00Z`))) {
    throw new Error(`${what} should be a date as YYYY-MM-DD, not "${given}"`);
  }
  return said;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Every issue a JQL query finds, walked page by page.
 *
 * `search` answers one page because that is what a caller browsing wants;
 * a timesheet wants all of them, and there are rarely many. Cloud pages by
 * a token and Server by an offset, and both stop at a cap that no one
 * person's week comes near.
 */
function everyIssue(settings, jql, fields) {
  const found = [];
  let token = null;
  for (let page = 0; page < 10; page++) {
    const answered = isCloud(settings)
      ? call(settings, {
          method: 'POST',
          path: '/rest/api/3/search/jql',
          body: { jql: jql, maxResults: 100, fields: fields, ...(token !== null ? { nextPageToken: token } : {}) },
        })
      : call(settings, {
          path: `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100&startAt=${found.length}&fields=${fields.join(',')}`,
        });
    const held = at(answered, 'issues') ?? [];
    found.push(...held);
    if (isCloud(settings)) {
      token = at(answered, 'nextPageToken');
      if (typeof token !== 'string' || held.length === 0) {
        break;
      }
    } else if (held.length === 0 || found.length >= (at(answered, 'total') ?? 0)) {
      break;
    }
  }
  return found;
}

/** Whether a worklog's author is the user asked about, by whichever id this deployment names users by. */
function loggedBy(settings, worklog, user) {
  const author = at(worklog, 'author');
  return isCloud(settings)
    ? at(author, 'accountId') === user.accountId
    : at(author, 'name') === user.name || at(author, 'key') === user.name;
}

/** A user as Jira wants one on the wire: by account id on Cloud, by username on Server. */
function userNamed(settings, one) {
  return isCloud(settings) ? { accountId: at(one, 'accountId') } : { name: at(one, 'name') };
}

/**
 * A user as Jira wants one, from what a person said.
 *
 * "me" is whoever the token is — asked of Jira, because an agent does not
 * know its own account id and should not have to. Anything else is looked
 * up the way the site's own picker does it: a display name, a username or
 * an email, matched by Jira's user search. One hit is the answer; several
 * are refused with their names unless one of them is exactly what was
 * said; none falls through to the value as given, for a caller who passed
 * an id. An object goes through untouched.
 */
function userOf(settings, given) {
  if (given !== null && typeof given === 'object') {
    return given;
  }
  const said = String(given).trim();
  if (/^(me|myself)$/i.test(said)) {
    return userNamed(settings, call(settings, { path: '/rest/api/2/myself' }));
  }

  /* Cloud searches by `query`; Server by `username`, which matches name and email too. */
  const by = isCloud(settings) ? 'query' : 'username';
  const found = call(settings, { path: `/rest/api/2/user/search?${by}=${encodeURIComponent(said)}&maxResults=10` });
  const hits = Array.isArray(found) ? found : [];
  if (hits.length === 1) {
    return userNamed(settings, hits[0]);
  }
  if (hits.length > 1) {
    const wanted = said.toLowerCase();
    const exact = hits.filter((one) =>
      [at(one, 'displayName'), at(one, 'name'), at(one, 'emailAddress')].some(
        (spelling) => typeof spelling === 'string' && spelling.toLowerCase() === wanted,
      ),
    );
    if (exact.length === 1) {
      return userNamed(settings, exact[0]);
    }
    throw new Error(
      `"${said}" names ${hits.length} users: ${hits.map((one) => at(one, 'displayName')).join(', ')}`,
    );
  }
  return isCloud(settings) ? { accountId: said } : { name: said };
}

/**
 * One field's value as Jira takes it, built from what a caller said.
 *
 * The rule is the field's own schema. A choice — an option, a priority, a
 * component, anything the form lists values for — is matched by label and
 * sent as `{ id }`, and a label that matches nothing is refused with the
 * labels that would have. A list takes a list, or one string with commas in
 * it, and resolves each item the same way. A number is checked to be one.
 * A user is named the way this deployment names users. Everything else —
 * text, dates — goes as it was said.
 *
 * An object goes through untouched whatever the field, so a caller who
 * knows Jira's shape for something this does not cover can still say it.
 */
function valueFor(settings, entry, given) {
  const { schema, allowedValues, field } = entry;
  if (given !== null && typeof given === 'object' && !Array.isArray(given)) {
    return given;
  }
  const choice = (one) => {
    if (one !== null && typeof one === 'object') {
      return one;
    }
    const matched = allowedNamed(allowedValues, one);
    if (matched === null) {
      throw new Error(`"${one}" is not one of ${field.name}'s values: ${field.allowed.join(', ')}`);
    }
    return { id: String(at(matched, 'id')) };
  };

  const kind = at(schema, 'type');
  if (kind === 'array') {
    const items = Array.isArray(given)
      ? given
      : String(given).split(',').map((one) => one.trim()).filter((one) => one.length > 0);
    const of = at(schema, 'items');
    if (of === 'user') {
      return items.map((one) => userOf(settings, one));
    }
    if (allowedValues.length > 0) {
      return items.map(choice);
    }
    return of === 'string' ? items.map(String) : items;
  }
  if (kind === 'number') {
    const number = Number(given);
    if (Number.isNaN(number)) {
      throw new Error(`${field.name} takes a number, and "${given}" is not one`);
    }
    return number;
  }
  if (kind === 'user') {
    return userOf(settings, given);
  }
  if (allowedValues.length > 0) {
    return choice(given);
  }
  return given;
}

/** One issue as the declared `Issue` shape — see objects(). */
function listed(issue, site) {
  const fields = at(issue, 'fields');
  return {
    key: at(issue, 'key'),
    summary: at(fields, 'summary'),
    status: at(at(fields, 'status'), 'name'),
    type: at(at(fields, 'issuetype'), 'name'),
    priority: at(at(fields, 'priority'), 'name'),
    assignee: at(at(fields, 'assignee'), 'displayName'),
    reporter: at(at(fields, 'reporter'), 'displayName'),
    created: at(fields, 'created'),
    updated: at(fields, 'updated'),
    url: `${site}/browse/${at(issue, 'key')}`,
    /*
     * The three a search does not ask Jira for, present and empty rather than
     * missing: `Issue` is one shape, and a caller reading `labels` should get
     * a list either way instead of finding out which call it came from.
     */
    description: plainOf(at(fields, 'description')),
    labels: at(fields, 'labels') ?? [],
    resolution: at(at(fields, 'resolution'), 'name'),
    links: (at(fields, 'issuelinks') ?? []).map(linked).filter((one) => one !== null),
  };
}

/**
 * One issue link, read from this issue's side of it.
 *
 * Jira stores a link once and shows it from both ends: on the issue it goes
 * out from, the other end is `outwardIssue` and the verb is the type's
 * `outward` ("blocks"); on the issue it comes in to, the other end is
 * `inwardIssue` and the verb is `inward` ("is blocked by"). So the sentence
 * `this <relation> <other>` reads right from whichever issue was opened.
 */
function linked(one) {
  const type = at(one, 'type');
  const outward = at(one, 'outwardIssue');
  const other = outward ?? at(one, 'inwardIssue');
  if (other === null) {
    return null;
  }
  return {
    type: at(type, 'name'),
    relation: outward !== null ? at(type, 'outward') : at(type, 'inward'),
    key: at(other, 'key'),
    summary: at(at(other, 'fields'), 'summary'),
    status: at(at(at(other, 'fields'), 'status'), 'name'),
  };
}

export default class Jira extends OrknuxPlugin {

  id() {
    return 'jira';
  }

  apiVersion() {
    return 1;
  }

  parameters() {
    return [
      new OrknuxParameter({
        name: 'jira',
        description:
          'Which Jira to ask: a Jira connection, which carries its address and auth - ' +
          'Basic with email:token for Cloud, a Bearer personal access token for Server.',
        type: 'connection',
        connectionType: 'jira',
        required: true,
      }),
      new OrknuxParameter({
        name: 'project',
        description:
          'The project key a new issue belongs to when a call does not name one — PROJ. ' +
          'Optional, and one fewer thing to wire.',
        type: 'string',
        required: false,
      }),
    ];
  }

  /*
   * The kind of host this plugin talks to, so a workspace can hold several
   * Jira sites by name rather than one url on the plugin's page.
   */
  connectionTypes() {
    return [
      {
        name: 'jira',
        label: 'Jira',
        description:
          'A Jira site - Cloud with Basic auth and email:token as the secret, or Server and Data Center ' +
          'with a Bearer personal access token.',
        urlPlaceholder: 'https://your-site.atlassian.net',
      },
    ];
  }

  permissions() {
    // None. The credential arrives already spelled as a header, so there is
    // nothing left here to encode.
    return [];
  }

  capabilities() {
    // The widest capability there is, asked for because this plugin is about
    // exactly one outside service: every request goes to the connection's url.
    return ['NETWORK_REQUEST'];
  }

  /*
   * The shapes this plugin's answers actually have.
   *
   * `map` was the old answer and it is a weak one: it says a structure came
   * back and nothing about what is in it, so every caller reads the code — or
   * guesses — to find out that `status` is a string and `labels` is a list.
   * Declared here, the shape travels with the plugin and arrives in a
   * workspace as `jira_Issue`, and a workflow can be built against it.
   *
   * `Issue` carries the fields `search` answers for each hit; `openIssue`
   * answers the same shape with `description`, `labels` and `resolution`
   * filled in, which are null in a search rather than absent. One shape for
   * both, because two that differ by three fields is two things to keep right.
   */
  objects() {
    return [
      new OrknuxObject({
        name: 'Search',
        description: 'What a JQL search came to.',
        properties: [
          {
            name: 'total',
            kind: 'number',
            description: 'How many the whole search holds. Null on Cloud, which no longer says.',
          },
          { name: 'issues', kind: 'array', of: 'Issue', description: 'Capped by limit.' },
        ],
      }),

      new OrknuxObject({
        name: 'Comment',
        description: 'A comment that was added to an issue.',
        properties: [
          { name: 'id', kind: 'string', description: 'What Jira calls it.' },
          { name: 'url', kind: 'string', description: 'A link that opens the issue at this comment.' },
        ],
      }),

      new OrknuxObject({
        name: 'Moved',
        description: 'An issue after it was transitioned.',
        properties: [
          { name: 'key', kind: 'string', description: 'The issue that moved.' },
          { name: 'status', kind: 'string', description: 'Where it ended up.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Raised',
        description: 'An issue that was just created.',
        properties: [
          { name: 'key', kind: 'string', description: 'PROJ-123, which every other call takes.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Link',
        description: 'One issue linked to this one, read from this one\'s side.',
        properties: [
          { name: 'type', kind: 'string', description: 'The link type\'s name: Blocks, Dependency, Relates…' },
          {
            name: 'relation',
            kind: 'string',
            description: 'The verb from this issue\'s side, so "this <relation> <key>" reads right: blocks, is blocked by, depends on.',
          },
          { name: 'key', kind: 'string', description: 'The issue at the other end.' },
          { name: 'summary', kind: 'string', description: 'Its title.' },
          { name: 'status', kind: 'string', description: 'Where it sits in its workflow.' },
        ],
      }),

      new OrknuxObject({
        name: 'Worklog',
        description: 'One entry of time logged on an issue.',
        properties: [
          { name: 'key', kind: 'string', description: 'The issue it was logged on.' },
          { name: 'summary', kind: 'string', description: 'That issue\'s title.' },
          { name: 'hours', kind: 'number', description: 'How long, in hours, to two decimals.' },
          { name: 'started', kind: 'string', description: 'When the work started, as Jira gives it.' },
          { name: 'comment', kind: 'string', description: 'What was said about it, or null.' },
        ],
      }),

      new OrknuxObject({
        name: 'LoggedDay',
        description: 'One calendar day of somebody\'s time, present even when nothing was logged.',
        properties: [
          { name: 'date', kind: 'string', description: 'YYYY-MM-DD.' },
          { name: 'weekday', kind: 'string', description: 'Monday… Sunday, so a weekend is not read as a gap.' },
          { name: 'hours', kind: 'number', description: 'Everything logged that day, in hours. 0 where nothing was.' },
          { name: 'entries', kind: 'array', of: 'Worklog', description: 'What made up those hours.' },
        ],
      }),

      new OrknuxObject({
        name: 'TimeLogged',
        description: 'What one person logged over a range of days, day by day.',
        properties: [
          { name: 'user', kind: 'string', description: 'Who, as they were asked about.' },
          { name: 'from', kind: 'string', description: 'The first day, YYYY-MM-DD.' },
          { name: 'to', kind: 'string', description: 'The last day, inclusive.' },
          { name: 'hours', kind: 'number', description: 'The whole range, in hours.' },
          {
            name: 'days',
            kind: 'array',
            of: 'LoggedDay',
            description: 'Every day from first to last, in order, weekends included - a day with nothing says 0.',
          },
        ],
      }),

      new OrknuxObject({
        name: 'Person',
        description: 'One Jira user, as a group lists them.',
        properties: [
          { name: 'id', kind: 'string', description: 'What timeLogged and a user field take: the account id on Cloud, the username on Server.' },
          { name: 'name', kind: 'string', description: 'Their display name.' },
          { name: 'email', kind: 'string', description: 'Their email, where Jira shows it.' },
          { name: 'active', kind: 'boolean', description: 'Whether the account is still active.' },
        ],
      }),

      new OrknuxObject({
        name: 'Members',
        description: 'Who is in a Jira group.',
        properties: [
          { name: 'group', kind: 'string', description: 'The group asked about.' },
          { name: 'people', kind: 'array', of: 'Person', description: 'Its members.' },
        ],
      }),

      new OrknuxObject({
        name: 'Linked',
        description: 'Two issues after a link was made between them.',
        properties: [
          { name: 'from', kind: 'string', description: 'The issue the link goes out from.' },
          { name: 'relation', kind: 'string', description: 'The verb, as Jira spells it: "depends on", "blocks".' },
          { name: 'to', kind: 'string', description: 'The issue it points at.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open, on the from side.' },
        ],
      }),

      new OrknuxObject({
        name: 'Updated',
        description: 'An issue after some of its fields were changed.',
        properties: [
          { name: 'key', kind: 'string', description: 'The issue that changed.' },
          { name: 'changed', kind: 'array', of: 'string', description: 'The fields that were set, by name.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Field',
        description: 'One field on the form a new issue in a project fills in.',
        properties: [
          { name: 'id', kind: 'string', description: 'What Jira calls it on the wire: summary, or customfield_10123.' },
          { name: 'name', kind: 'string', description: 'What people call it, and what createIssue\'s fields map takes.' },
          { name: 'required', kind: 'boolean', description: 'Whether a create without it is refused.' },
          {
            name: 'kind',
            kind: 'string',
            description: 'Jira\'s type: string, number, option, array, user, date, datetime, priority…',
          },
          { name: 'of', kind: 'string', description: 'What an array holds - option, string, user, component. Null otherwise.' },
          {
            name: 'allowed',
            kind: 'array',
            of: 'string',
            description: 'The values a choice takes, by label. Empty where the field is free text.',
          },
          { name: 'hasDefault', kind: 'boolean', description: 'Whether Jira fills it in when nobody does.' },
        ],
      }),

      new OrknuxObject({
        name: 'Form',
        description: 'What a new issue of one type in one project has to say, and may say.',
        properties: [
          { name: 'project', kind: 'string', description: 'The project key asked about.' },
          { name: 'type', kind: 'string', description: 'The issue type, as Jira spells it.' },
          {
            name: 'required',
            kind: 'array',
            of: 'string',
            description: 'The names of the fields a create must fill in - the short answer.',
          },
          { name: 'fields', kind: 'array', of: 'Field', description: 'Every field on the form, required or not.' },
        ],
      }),

      new OrknuxObject({
        name: 'Issue',
        description: 'One Jira issue, as this plugin answers it.',
        properties: [
          { name: 'key', kind: 'string', description: 'PROJ-123, which every other call takes.' },
          { name: 'summary', kind: 'string', description: 'The one-line title.' },
          { name: 'description', kind: 'string', description: 'The body, as text. Null from a search.' },
          { name: 'status', kind: 'string', description: 'Where it sits in its workflow — "In Progress".' },
          { name: 'type', kind: 'string', description: 'Task, Bug, Story.' },
          { name: 'priority', kind: 'string', description: 'Null where the project does not use them.' },
          { name: 'assignee', kind: 'string', description: 'Display name, or null where nobody holds it.' },
          { name: 'reporter', kind: 'string', description: 'Display name of whoever raised it.' },
          { name: 'labels', kind: 'array', of: 'string', description: 'Empty from a search.' },
          { name: 'resolution', kind: 'string', description: 'Why it closed, or null while it is open.' },
          {
            name: 'links',
            kind: 'array',
            of: 'Link',
            description: 'What this issue is linked to - blocks, depends on, relates to. Empty from a search.',
          },
          { name: 'created', kind: 'string', description: 'ISO 8601, as Jira gives it.' },
          { name: 'updated', kind: 'string', description: 'ISO 8601. What "recently touched" is read off.' },
          { name: 'url', kind: 'string', description: 'The browse link, for a person to open.' },
        ],
      }),
    ];
  }

  /*
   * JQL is the part a model gets wrong, and it gets it wrong silently: a
   * query with a mistaken field name does not fail, it returns nothing, and
   * "there are no issues" reads exactly like "I searched badly". So the page
   * an agent reads is mostly a query cookbook, plus the two moves that change
   * somebody else's board and deserve a moment's thought first.
   */
  skills() {
    return [
      new OrknuxSkill({
        name: 'Finding and moving Jira issues',
        description:
          'How to write JQL that finds what you meant, and what to check before changing a ticket.',
        content: `# Finding and moving Jira issues

## An empty result is usually a bad query

JQL does not fail on a query that means nothing useful — it returns nothing.
So "no issues found" and "I asked the wrong question" look identical from
here, and the difference matters.

Before believing an empty answer, widen it: drop the narrowest clause and
search again. If \`project = PROJ AND status = "In Review" AND assignee = x\`
is empty, try it without the assignee. If that is empty too, try
\`project = PROJ ORDER BY updated DESC\` and see what the statuses are actually
called on this board. They are rarely what you assumed.

## Queries worth knowing

\`\`\`
project = PROJ AND status != Done ORDER BY updated DESC
assignee = currentUser() AND status != Done
project = PROJ AND created >= -7d
text ~ "connection timeout" AND project = PROJ
labels = urgent AND status = "In Progress"
project = PROJ AND status CHANGED TO Done AFTER -1w
"Epic Link" = PROJ-100
\`\`\`

Things that catch people out:

- **Quote anything with a space.** \`status = In Review\` is a syntax error;
  \`status = "In Review"\` is not.
- **\`~\` is text search, \`=\` is exact.** \`summary ~ "timeout"\` finds it in a
  sentence; \`summary = "timeout"\` wants the whole summary to be that word.
- **Relative dates are \`-7d\`, \`-2w\`, \`-1M\`** — capital M is months, lowercase
  m is minutes, and that one bites.
- **\`ORDER BY\` goes last**, always, after every clause.
- **Status names are per-workflow.** "Done" on one board is "Closed" on the
  next. Look before you assume.

## Read before you write

\`jira_openIssue(key)\` before commenting on or moving anything. The summary is
not the ticket: the description says what was actually asked for, the comments
say what has been tried, and the status says whether somebody is already on it.
Acting on the summary alone is how a duplicate comment gets added to a ticket
that was closed last week.

## Moving an issue

\`jira_transition(key, to)\` takes a **name**, not an id, and which names are
available depends on where the issue is right now — a board can forbid going
straight from "To Do" to "Done". If the name you want is refused, the refusal
lists what *is* possible from here; pick from that list rather than trying
synonyms.

Say why in a comment when you move something. A status change with no comment
is a mystery to whoever sees it in their morning filter.

## Raising one

Search first. \`jira_createIssue\` will happily make a second copy of a bug that
is already open, and a duplicate is worse than no ticket: it splits the
discussion and somebody has to close it by hand.

Write the description as plain text. Jira renders its own wiki markup, not
markdown, so asterisks and backticks arrive as asterisks and backticks. Put
what happened, what was expected, and how to see it — in that order.

## When a project insists on more

A project can make fields of its own mandatory — "Occurs on: PROD, UAT or
DEV", "Kind of work: one of six" — and a create that leaves one out is
refused, naming the field. Do not give up there, and do not guess at values.

\`jira_form(project, type)\` answers the whole form: every field by name, which
ones are required, and the values each choice takes. Then pass them to
\`jira_createIssue\` in \`fields\`, keyed by name, valued by label:

\`\`\`
fields: { "Occurs on": "DEV", "Kind of work": "Maintenance" }
\`\`\`

A list takes a list, or one string with commas in it. A value that is not one
of the choices is refused here, with the choices — so if the person said
"dev", the answer is the label spelled as the form spells it.

## Fixing a field on an issue that exists

\`jira_updateIssue(key, fields)\` takes the same map — names for keys, labels
for values — and sets those fields on an existing issue. "You forgot the
team" is \`fields: { "Team": "OKO Cyklonu" }\` on the ticket, not a new
ticket. A field it does not know is refused with the names the issue does
have, and a label that is not a choice is refused with the choices, so one
wrong guess costs one call.

A user field — Assignee, Reporter — takes a person the way you would say
them: a display name, a username or an email, and Jira's own search finds
the account. \`"Assignee": "me"\` is whoever the token is, so "assign it to
yourself" needs no id.

## Linking two issues

\`jira_link(from, relation, to)\` makes a link, and the relation is the verb
as a person says it — "depends on", "blocks", "relates to", "duplicates" —
matched against the link types this Jira has. Direction matters and the
verb carries it: \`link("OKO-4219", "depends on", "OKO-4124")\` and
\`link("OKO-4124", "is depended on by", "OKO-4219")\` make the same link.
A verb this Jira does not have is refused with the ones it does, so pick
from that list rather than trying synonyms.

\`jira_openIssue\` answers \`links\` — what the issue already blocks, depends
on or relates to, each with the verb from this issue's side — so read it
before adding one that is already there.

## Checking a team's timesheets

\`jira_timeLogged(user, from, to)\` answers one person's logged time day by
day. Left empty, \`from\` and \`to\` are last week, Monday to Sunday, which
is what "did everyone log last week" means. \`jira_groupMembers(group)\`
lists who is in a Jira group, so a team is one call and a check is a loop:

1. \`groupMembers\` for the team, then \`timeLogged(person.id)\` for each.
2. Read \`days\`: every date is there, weekends included, and \`weekday\`
   says which is which. A weekday with fewer hours than the team expects
   is a gap; a Saturday with 0 is not.
3. Say who is short and on which days, with the hours they did log. Do not
   list the people who are fine one by one - "everyone else is complete"
   is the sentence.

Time is read from Jira's own work log. Where Tempo or another timesheet app
is in use, its entries appear here too, but its approval state does not.`,
      }),
    ];
  }

  /* The agents' surface: all of it. Reading a ticket and moving it are the same job. */
  tools() {
    return [
      new OrknuxFunctionTool({ function: 'search' }),
      new OrknuxFunctionTool({ function: 'openIssue' }),
      new OrknuxFunctionTool({ function: 'comment' }),
      new OrknuxFunctionTool({ function: 'transition' }),
      new OrknuxFunctionTool({ function: 'form' }),
      new OrknuxFunctionTool({ function: 'createIssue' }),
      new OrknuxFunctionTool({ function: 'updateIssue' }),
      new OrknuxFunctionTool({ function: 'link' }),
      new OrknuxFunctionTool({ function: 'groupMembers' }),
      new OrknuxFunctionTool({ function: 'timeLogged' }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'search',
        description:
          'Finds issues by JQL, which is Jira\'s own query language: project = PROJ AND status = ' +
          '"In Progress", assignee = currentUser() ORDER BY updated DESC, labels = urgent AND ' +
          'created >= -7d. Answers the issues - key, summary, status, type, priority, assignee, ' +
          'reporter, updated and a url each - and how many the whole search holds, which Jira Cloud ' +
          'no longer tells anybody and so comes back null there. limit caps the issues, 25 if not given.',
        params: [
          { name: 'jql', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 25 },
        ],
        returnType: 'Search',
        run: (jql, limit) => {
          const asked = typeof jql === 'string' ? jql.trim() : '';
          if (asked.length === 0) {
            throw new Error('there is no JQL to search with');
          }
          const capped = Math.min(Math.max(limit, 1), 100);
          const site = root(this.settings);

          /*
           * The one place Cloud and Server genuinely part. The Cloud endpoint
           * is a POST, wants the fields named, and answers no total; the
           * Server one is the GET that has always been there.
           */
          const found = isCloud(this.settings)
            ? call(this.settings, {
                method: 'POST',
                path: '/rest/api/3/search/jql',
                body: { jql: asked, maxResults: capped, fields: SEARCH_FIELDS },
              })
            : call(this.settings, {
                path:
                  `/rest/api/2/search?jql=${encodeURIComponent(asked)}` +
                  `&maxResults=${capped}&fields=${SEARCH_FIELDS.join(',')}`,
              });

          return {
            total: at(found, 'total'),
            issues: (at(found, 'issues') ?? []).map((one) => listed(one, site)),
          };
        },
      }),

      new OrknuxFunction({
        name: 'openIssue',
        description:
          'Opens one issue whole by its key (PROJ-123): summary, description, status, type, ' +
          'priority, assignee, reporter, labels, resolution, created, updated and a url. The ' +
          'description comes back as text. Read this before commenting on or moving an issue, ' +
          'rather than acting on the summary alone.',
        params: [{ name: 'key', type: 'string' }],
        /* The shape declared above, not a map — see objects(). */
        returnType: 'Issue',
        run: (key) => {
          const named = typeof key === 'string' ? key.trim() : '';
          if (named.length === 0) {
            throw new Error('there is no issue key to open');
          }
          const site = root(this.settings);
          const issue = call(this.settings, {
            path: `/rest/api/2/issue/${encodeURIComponent(named)}`,
          });
          const fields = at(issue, 'fields');
          /*
           * The same shape a search answers — `listed` already reads the three
           * fields a search leaves empty, and here they are actually there.
           */
          return listed(issue, site);
        },
      }),

      new OrknuxFunction({
        name: 'comment',
        description:
          'Adds a comment to an issue. Pass the key (PROJ-123) and what to say, as plain text - ' +
          'Jira renders its own wiki markup, not markdown, so write plainly rather than in ' +
          'asterisks. Answers the comment\'s id and a url to it.',
        params: [
          { name: 'key', type: 'string' },
          { name: 'text', type: 'string' },
        ],
        returnType: 'Comment',
        run: (key, text) => {
          const named = typeof key === 'string' ? key.trim() : '';
          const said = typeof text === 'string' ? text.trim() : '';
          if (named.length === 0) {
            throw new Error('there is no issue key to comment on');
          }
          if (said.length === 0) {
            throw new Error('there is no comment to add');
          }
          const made = call(this.settings, {
            method: 'POST',
            path: `/rest/api/2/issue/${encodeURIComponent(named)}/comment`,
            body: { body: said },
          });
          return {
            id: at(made, 'id'),
            url: `${root(this.settings)}/browse/${named}?focusedCommentId=${at(made, 'id')}`,
          };
        },
      }),

      new OrknuxFunction({
        name: 'transition',
        description:
          'Moves an issue to another status - what dragging its card to a new column does. Pass the ' +
          'key (PROJ-123) and the status or transition by name ("In Progress", "Done"), matched ' +
          'whatever the capitals. Which moves are possible depends on where the issue is in its ' +
          'workflow, so a name that is not available now is refused with the list of the ones that ' +
          'are. Answers the status it ended in.',
        params: [
          { name: 'key', type: 'string' },
          { name: 'to', type: 'string' },
        ],
        returnType: 'Moved',
        run: (key, to) => {
          const named = typeof key === 'string' ? key.trim() : '';
          const wanted = typeof to === 'string' ? to.trim().toLowerCase() : '';
          if (named.length === 0) {
            throw new Error('there is no issue key to move');
          }
          if (wanted.length === 0) {
            throw new Error('there is no status to move the issue to');
          }

          /*
           * Asked for by name rather than by id, because an id is a number out
           * of somebody's workflow configuration that nobody knows — and the
           * available moves depend on where the issue currently is, so the
           * list has to be read now rather than assumed.
           */
          const offered = at(
            call(this.settings, { path: `/rest/api/2/issue/${encodeURIComponent(named)}/transitions` }),
            'transitions',
          ) ?? [];
          const found = offered.find((one) => {
            const move = String(at(one, 'name') ?? '').toLowerCase();
            const lands = String(at(at(one, 'to'), 'name') ?? '').toLowerCase();
            return move === wanted || lands === wanted;
          });
          if (found === undefined) {
            const names = offered.map((one) => at(one, 'name')).filter((one) => typeof one === 'string');
            throw new Error(
              names.length === 0
                ? `${named} cannot be moved anywhere from where it is`
                : `${named} cannot be moved to ${to} from where it is: it takes ${names.join(', ')}`,
            );
          }

          call(this.settings, {
            method: 'POST',
            path: `/rest/api/2/issue/${encodeURIComponent(named)}/transitions`,
            body: { transition: { id: at(found, 'id') } },
          });
          return {
            key: named,
            status: at(at(found, 'to'), 'name') ?? at(found, 'name'),
            url: `${root(this.settings)}/browse/${named}`,
          };
        },
      }),

      new OrknuxFunction({
        name: 'form',
        description:
          'What a new issue in a project has to say: every field on its create form by name, which ' +
          'are required, and the values each choice takes. Pass the project key (PROJ) - or an empty ' +
          'project for the configured one - and the issue type by name ("Task", "Bug", "Story"). Read ' +
          'it when a create was refused for a missing field, or before creating in a project you do ' +
          'not know; createIssue takes the answers in its fields map, keyed by these names.',
        params: [
          { name: 'project', type: 'string' },
          { name: 'type', type: 'string' },
        ],
        returnType: 'Form',
        run: (project, type) => {
          const read = formOf(this.settings, projectOr(this.settings, project), typeOr(type));
          const fields = read.entries.map((one) => one.field);
          return {
            project: read.project,
            type: read.type,
            required: fields.filter((one) => one.required).map((one) => one.name),
            fields: fields,
          };
        },
      }),

      new OrknuxFunction({
        name: 'createIssue',
        description:
          'Raises a new issue. Pass the project key (PROJ) - or an empty project for the configured ' +
          'one - the issue type by name ("Task", "Bug", "Story"), a one-line summary, and the ' +
          'description as plain text. fields carries anything else the project asks for, keyed by ' +
          'field name as form lists it and valued by label - {"Occurs on": "DEV", "Priority": "High"}; ' +
          'a list takes a list or a comma-separated string. Answers the new issue\'s key and a url. ' +
          'Search first: raising a duplicate of something already open is worse than not raising it.',
        params: [
          { name: 'project', type: 'string' },
          { name: 'type', type: 'string' },
          { name: 'summary', type: 'string' },
          { name: 'description', type: 'string' },
          { name: 'fields', type: 'map', required: false, default: {} },
        ],
        returnType: 'Raised',
        run: (project, type, summary, description, extra) => {
          const said = typeof summary === 'string' ? summary.trim() : '';
          if (said.length === 0) {
            throw new Error('a new issue needs a summary');
          }
          const where = projectOr(this.settings, project);
          const kind = typeOr(type);

          /*
           * The project's own fields first, resolved against its form, so
           * that "Occurs on": "DEV" leaves here as customfield_10123: { id }.
           * The form is only read when there is something to resolve: a
           * create that says nothing extra stays one request.
           */
          const asked = extra !== null && typeof extra === 'object' && Object.keys(extra).length > 0;
          const fields = asked
            ? resolved(this.settings, formOf(this.settings, where, kind), extra, (name) =>
                `the ${where} ${kind} form has no field "${name}"; form("${where}", "${kind}") lists what it has`,
              )
            : {};

          fields.project = { key: where };
          fields.issuetype = { name: kind };
          fields.summary = said;
          if (typeof description === 'string' && description.trim().length > 0) {
            fields.description = description;
          }

          const made = call(this.settings, {
            method: 'POST',
            path: '/rest/api/2/issue',
            body: { fields: fields },
          });
          return {
            key: at(made, 'key'),
            url: `${root(this.settings)}/browse/${at(made, 'key')}`,
          };
        },
      }),

      new OrknuxFunction({
        name: 'updateIssue',
        description:
          'Sets fields on an existing issue. Pass the key (PROJ-123) and a map of what to set, keyed ' +
          'by field name and valued by label, the way createIssue\'s fields is - {"Team": "Checkout", ' +
          '"Priority": "High", "Labels": "a, b"}; a list takes a list or a comma-separated string. ' +
          'Answers the key, the names that were set, and a url. For moving an issue between statuses ' +
          'use transition; for adding to the conversation use comment.',
        params: [
          { name: 'key', type: 'string' },
          { name: 'fields', type: 'map' },
        ],
        returnType: 'Updated',
        run: (key, extra) => {
          const which = typeof key === 'string' ? key.trim() : '';
          if (which.length === 0) {
            throw new Error('no issue key to update');
          }
          if (extra === null || typeof extra !== 'object' || Object.keys(extra).length === 0) {
            throw new Error('nothing to set: fields is empty');
          }

          /*
           * Resolved against this issue's own edit form rather than the
           * project's create form, because what can be edited depends on
           * the issue, its status and the token — and the names the
           * refusal offers are then the ones that would actually work.
           */
          const form = editFormOf(this.settings, which);
          const fields = resolved(this.settings, form, extra, (name) => {
            const offered = form.entries.map((one) => one.field.name).filter((one) => typeof one === 'string');
            return `${which} has no editable field "${name}"; it has ${offered.join(', ')}`;
          });
          call(this.settings, {
            method: 'PUT',
            path: `/rest/api/2/issue/${encodeURIComponent(which)}`,
            body: { fields: fields },
          });
          return {
            key: which,
            changed: Object.keys(fields).map((id) => form.entries.find((one) => one.field.id === id).field.name),
            url: `${root(this.settings)}/browse/${which}`,
          };
        },
      }),

      new OrknuxFunction({
        name: 'link',
        description:
          'Links two issues. Pass the issue the link goes out from (PROJ-123), the relation as a ' +
          'person says it - "depends on", "blocks", "relates to", "duplicates", "is blocked by" - ' +
          'and the issue it points at. The relation is matched against this Jira\'s link types ' +
          'whatever the capitals, and a verb it does not have is refused with the ones it does. ' +
          'Direction is the verb\'s: link(A, "depends on", B) and link(B, "is depended on by", A) ' +
          'make the same link. Answers from, relation and to as Jira spells them.',
        params: [
          { name: 'from', type: 'string' },
          { name: 'relation', type: 'string' },
          { name: 'to', type: 'string' },
        ],
        returnType: 'Linked',
        run: (from, relation, to) => {
          const source = typeof from === 'string' ? from.trim() : '';
          const target = typeof to === 'string' ? to.trim() : '';
          const wanted = typeof relation === 'string' ? relation.trim().toLowerCase() : '';
          if (source.length === 0 || target.length === 0) {
            throw new Error('a link needs two issue keys');
          }
          if (wanted.length === 0) {
            throw new Error('a link needs a relation: "depends on", "blocks", "relates to"');
          }
          if (source.toLowerCase() === target.toLowerCase()) {
            throw new Error(`${source} cannot be linked to itself`);
          }

          /*
           * A link type is a name and two verbs, one per direction: Blocks is
           * "blocks" outward and "is blocked by" inward. The verb the caller
           * said picks both the type and which end `from` is, so the body
           * below is built from Jira's own vocabulary rather than the
           * caller's. Read now rather than assumed, because every Jira has
           * its own set and the names are somebody's configuration.
           */
          const types = at(call(this.settings, { path: '/rest/api/2/issueLinkType' }), 'issueLinkTypes') ?? [];
          const spelled = (one, side) => String(at(one, side) ?? '').toLowerCase();
          let found = types.find((one) => spelled(one, 'outward') === wanted);
          let outward = true;
          if (found === undefined) {
            found = types.find((one) => spelled(one, 'inward') === wanted);
            outward = false;
          }
          if (found === undefined) {
            found = types.find((one) => spelled(one, 'name') === wanted);
            outward = true;
          }
          if (found === undefined) {
            const verbs = types.flatMap((one) => [at(one, 'outward'), at(one, 'inward')]).filter((one) => typeof one === 'string');
            throw new Error(
              verbs.length === 0
                ? 'this Jira has no issue link types'
                : `this Jira has no "${relation}" link; it has ${verbs.join(', ')}`,
            );
          }

          /* Jira's body names the ends by the type's own directions, so the caller's verb decides which is which. */
          const [outwardKey, inwardKey] = outward ? [source, target] : [target, source];
          call(this.settings, {
            method: 'POST',
            path: '/rest/api/2/issueLink',
            body: {
              type: { name: at(found, 'name') },
              outwardIssue: { key: outwardKey },
              inwardIssue: { key: inwardKey },
            },
          });
          return {
            from: source,
            relation: outward ? at(found, 'outward') : at(found, 'inward'),
            to: target,
            url: `${root(this.settings)}/browse/${source}`,
          };
        },
      }),

      new OrknuxFunction({
        name: 'groupMembers',
        description:
          'Who is in a Jira group, by the group\'s name - the way a team is usually kept in Jira. ' +
          'Answers each member\'s id (what timeLogged and a user field take), display name, email ' +
          'and whether the account is active.',
        params: [{ name: 'group', type: 'string' }],
        returnType: 'Members',
        run: (group) => {
          const named = typeof group === 'string' ? group.trim() : '';
          if (named.length === 0) {
            throw new Error('no group to list');
          }
          /* Both deployments still take the name here; Cloud also takes a groupId, which nobody knows. */
          const answered = call(this.settings, {
            path: `/rest/api/2/group/member?groupname=${encodeURIComponent(named)}&maxResults=200&includeInactiveUsers=false`,
          });
          return {
            group: named,
            people: (at(answered, 'values') ?? []).map((one) => ({
              id: isCloud(this.settings) ? at(one, 'accountId') : at(one, 'name'),
              name: at(one, 'displayName'),
              email: at(one, 'emailAddress'),
              active: at(one, 'active') !== false,
            })),
          };
        },
      }),

      new OrknuxFunction({
        name: 'timeLogged',
        description:
          'What one person logged in Jira\'s work log, day by day. Pass the user - "me", a display ' +
          'name, a username, an email or an id - and a first and last date as YYYY-MM-DD, inclusive; ' +
          'both empty means last week, Monday to Sunday. Answers the total hours and every day in ' +
          'the range, weekends included, each with its weekday, its hours (0 where nothing was ' +
          'logged) and the entries behind them. For "did they log all their hours", compare each ' +
          'weekday\'s hours against what the team expects.',
        params: [
          { name: 'user', type: 'string' },
          { name: 'from', type: 'string', required: false, default: '' },
          { name: 'to', type: 'string', required: false, default: '' },
        ],
        returnType: 'TimeLogged',
        run: (user, from, to) => {
          const who = typeof user === 'string' ? user.trim() : '';
          if (who.length === 0) {
            throw new Error('no user to read time for');
          }
          const week = previousWeek(new Date());
          const first = dateOr(from, week.from, 'from');
          const last = dateOr(to, week.to, 'to');
          if (first > last) {
            throw new Error(`from (${first}) is after to (${last})`);
          }

          /*
           * Two steps, because that is how Jira keeps it: JQL finds the
           * issues somebody logged on in the range, then each issue's work
           * log is read and only their entries in the range are kept -
           * other people log on the same issues, and the JQL match is by
           * issue, not by entry.
           */
          const resolved = userOf(this.settings, who);
          const id = isCloud(this.settings) ? resolved.accountId : resolved.name;
          const jql =
            `worklogAuthor = "${String(id).replace(/"/g, '\\"')}" AND worklogDate >= "${first}" AND worklogDate <= "${last}"`;
          const issues = everyIssue(this.settings, jql, ['summary']);

          const byDay = new Map();
          for (const issue of issues) {
            const key = at(issue, 'key');
            const logged = call(this.settings, {
              path: `/rest/api/2/issue/${encodeURIComponent(key)}/worklog?startAt=0&maxResults=5000`,
            });
            for (const one of at(logged, 'worklogs') ?? []) {
              const started = at(one, 'started');
              /* The date is the first ten characters: Jira spells started with the logger's own offset. */
              const day = typeof started === 'string' ? started.slice(0, 10) : null;
              if (day === null || day < first || day > last || !loggedBy(this.settings, one, resolved)) {
                continue;
              }
              const seconds = at(one, 'timeSpentSeconds') ?? 0;
              const entries = byDay.get(day) ?? [];
              entries.push({
                key: key,
                summary: at(at(issue, 'fields'), 'summary'),
                hours: Math.round((seconds / 3600) * 100) / 100,
                started: started,
                comment: plainOf(at(one, 'comment')) || null,
                seconds: seconds,
              });
              byDay.set(day, entries);
            }
          }

          /* Every day in the range, in order, so a gap is a day with 0 rather than a day that is missing. */
          const days = [];
          let total = 0;
          for (let at_ = new Date(`${first}T00:00:00Z`); dayOf(at_) <= last; at_ = new Date(at_.getTime() + 86400000)) {
            const date = dayOf(at_);
            const entries = (byDay.get(date) ?? []).sort((a, b) => (a.started < b.started ? -1 : 1));
            const seconds = entries.reduce((sum, one) => sum + one.seconds, 0);
            total += seconds;
            days.push({
              date: date,
              weekday: WEEKDAYS[at_.getUTCDay()],
              hours: Math.round((seconds / 3600) * 100) / 100,
              entries: entries.map(({ seconds: _, ...entry }) => entry),
            });
          }
          return { user: who, from: first, to: last, hours: Math.round((total / 3600) * 100) / 100, days: days };
        },
      }),
    ];
  }
}
