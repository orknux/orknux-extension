/*
 * Confluence, as a plugin.
 *
 * What this exists for is the wiki beside the work: the answer to half the
 * questions a workflow or an agent is asked lives on a Confluence page, and a
 * plugin has no network, deliberately and permanently. So the two calls here —
 * search, and open a page — are made by the *server* on the plugin's behalf,
 * under the NETWORK_REQUEST capability a person accepted, against the
 * Confluence the workspace named.
 *
 * ## Setting one up
 *
 * 1. Load this plugin and accept NETWORK_REQUEST, which is all it asks for.
 * 2. Add a connection of the kind it declares, Confluence, with the wiki's
 *    root as its URL — `https://your-site.atlassian.net/wiki` for Cloud, or
 *    the base url of a Server/Data Center install.
 * 3. For Cloud, Basic auth with `email:token` as the secret — an API token
 *    and whose it is. For Server/Data Center, Bearer with a personal access
 *    token.
 * 4. Point the plugin's `confluence` parameter at that connection.
 *
 * Which of Atlassian's two deployments this is, is read off the connection's
 * auth kind: Basic is Cloud's way, Bearer is Server's. It used to be read off
 * whether an `email` setting was filled in, and the auth kind is the same
 * fact said where it already lives. Nothing else about the two differs for
 * reading a page, because `/rest/api/search` and `/rest/api/content` answer
 * on both.
 *
 * ## Why a connection and not three settings
 *
 * The address and the credential used to be the plugin's own parameters, so a
 * workspace had exactly one Confluence and its token was a plugin setting. A
 * connection is where a workspace already keeps hosts: encrypted, checked, one
 * row per site — and a kind of its own keeps the picker to Confluence sites
 * rather than every HTTP endpoint there is. Because the kind is this plugin's,
 * the server hands its address and headers across with the handle, the
 * credential already spelled for its auth kind — so this file encodes
 * nothing and asks for no permission to.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

/** A nested field, or null rather than a thrown error on the way down. */
function at(holder, name) {
  if (holder === null || typeof holder !== 'object') {
    return null;
  }
  const held = holder[name];
  return held === undefined ? null : held;
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
function wiki(settings) {
  const connection = settings.confluence;
  if (connection === undefined || connection === null) {
    throw new Error("the plugin's confluence parameter is not set, and every Confluence call needs it");
  }
  if (typeof connection.url !== 'string' || connection.url.length === 0) {
    throw new Error(
      "the confluence parameter names a connection that is not a Confluence connection of this plugin's " +
        'kind, so its address never reached the plugin - point it at a Confluence connection, on a server ' +
        'that hands one over',
    );
  }
  return connection;
}

/** The wiki's root, without its trailing slash. */
function root(settings) {
  const configured = wiki(settings).url;
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
}

/**
 * The headers a call goes out with: json asked for, and whatever the
 * connection says to send - its credential already spelled for its auth kind,
 * so Basic and Bearer are the connection's business, not this.
 */
function headers(settings) {
  return Object.assign({ accept: 'application/json' }, wiki(settings).headers ?? {});
}

/** One read of Confluence's API, authenticated, answered or thrown. */
function read(settings, path) {
  const answered = orknux.http.get(root(settings) + path, headers(settings));
  if (answered.error !== undefined) {
    throw new Error(`could not reach Confluence: ${answered.error}`);
  }
  if (answered.status >= 400) {
    const said = at(answered.json, 'message');
    throw new Error(
      `Confluence answered ${answered.status}${typeof said === 'string' ? ': ' + said : ''} for ${path.split('?')[0]}`,
    );
  }
  return answered.json;
}

/** A search hit's text, with the @@@hl@@@ highlight markers Confluence wraps matches in taken out. */
function plain(text) {
  return typeof text === 'string' ? text.replace(/@@@(?:end)?hl@@@/g, '') : null;
}

/**
 * Whether this is Atlassian Cloud, which is what Basic auth means: Cloud takes
 * `email:token`, and Server/Data Center a personal access token as Bearer.
 */
function isCloud(settings) {
  return wiki(settings).authType === 'BASIC';
}

/**
 * How a mention is written in a page's body.
 *
 * A mention in storage format is not a name — it is an id inside markup:
 * `<ac:link><ri:user ri:account-id="5b10ac8d…"/></ac:link>` on Cloud, and
 * `ri:userkey` or `ri:username` on Server. So a model reading a page sees who
 * was mentioned only as a string of hex, which is the whole reason `openUser`
 * exists.
 */
const MENTION = /ri:(account-id|userkey|username)="([^"]+)"/g;

/** Every person a page's body mentions, in the order the page mentions them. */
function mentionedIn(body) {
  if (typeof body !== 'string') {
    return [];
  }
  const found = [];
  for (const one of body.matchAll(MENTION)) {
    if (!found.includes(one[2])) {
      found.push(one[2]);
    }
  }
  return found;
}

/**
 * Which query names a person, from whatever was passed.
 *
 * The same idea as `pageId` below: take what somebody actually has. That is a
 * mention copied out of a page body, a profile url, or the bare id — and which
 * *kind* of id a bare string is depends on the deployment, because Cloud
 * retired usernames for account ids and Server never had one.
 */
function personQuery(settings, person) {
  const asked = typeof person === 'string' ? person.trim() : String(person ?? '');
  if (asked.length === 0) {
    throw new Error('there is nobody to look up');
  }

  /* A mention, pasted whole out of a page. */
  const mention = new RegExp(MENTION.source).exec(asked);
  if (mention !== null) {
    const held = mention[2];
    return mention[1] === 'account-id'
      ? `accountId=${encodeURIComponent(held)}`
      : mention[1] === 'userkey'
        ? `key=${encodeURIComponent(held)}`
        : `username=${encodeURIComponent(held)}`;
  }

  /* A profile url: Cloud's `/people/<accountId>`, Server's `/display/~<username>`. */
  const cloudProfile = asked.match(/\/people\/([^/?#]+)/);
  if (cloudProfile !== null) {
    return `accountId=${encodeURIComponent(decodeURIComponent(cloudProfile[1]))}`;
  }
  const serverProfile = asked.match(/\/display\/~([^/?#]+)/);
  if (serverProfile !== null) {
    return `username=${encodeURIComponent(decodeURIComponent(serverProfile[1]))}`;
  }
  const named = asked.match(/[?&](accountId|username|key)=([^&]+)/);
  if (named !== null) {
    return `${named[1]}=${encodeURIComponent(decodeURIComponent(named[2]))}`;
  }

  /*
   * A bare id. On Cloud that is an account id and there is nothing else it
   * could be; on Server a 32-character hex string is a user key and anything
   * else is a username, which is the distinction Confluence itself draws.
   */
  if (isCloud(settings)) {
    return `accountId=${encodeURIComponent(asked)}`;
  }
  return /^[0-9a-f]{32}$/i.test(asked)
    ? `key=${encodeURIComponent(asked)}`
    : `username=${encodeURIComponent(asked)}`;
}

/**
 * The scheme and host, without whatever path the wiki sits under.
 *
 * An avatar's path is absolute from the host rather than from the wiki, and on
 * Cloud it already carries the `/wiki` the configured url ends with — so
 * joining the two the obvious way asked for `/wiki/wiki/aa-avatar/…` and got a
 * 404. Everything else here hangs off the wiki root; this is the one thing
 * that hangs off the site.
 */
function originOf(url) {
  const found = String(url).match(/^(https?:\/\/[^/]+)/);
  return found === null ? null : found[1];
}

/** An avatar's address, from whatever shape Confluence wrote its path in. */
function avatarAt(settings, path) {
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  const origin = originOf(root(settings));
  return origin === null ? null : origin + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * One person as the declared `User` shape — see objects().
 *
 * Both calls that answer a person go through here, so a user found by name and
 * a user opened by id are the same shape with the same fields filled in. The
 * avatar's bytes are not among them: only `openUser` fetches those, and only
 * when asked, so they are empty here rather than absent.
 */
function personOf(settings, found) {
  const id = at(found, 'accountId') ?? at(found, 'userKey');
  const username = at(found, 'username');
  const base = at(at(found, '_links'), 'base') ?? root(settings);
  return {
    id: id,
    username: username,
    /* Cloud answers a public name where a display name is withheld. */
    name: at(found, 'displayName') ?? at(found, 'publicName'),
    email: at(found, 'email'),
    type: at(found, 'type') ?? at(found, 'accountType'),
    external: at(found, 'isExternalCollaborator') === true,
    avatarUrl: avatarAt(settings, at(at(found, 'profilePicture'), 'path')),
    avatar: null,
    avatarType: null,
    avatarKey: '',
    /*
     * The two deployments keep a profile in different places, and neither
     * answers the link in the user itself.
     */
    url:
      isCloud(settings)
        ? id === null
          ? null
          : `${base}/people/${encodeURIComponent(id)}`
        : typeof username === 'string'
          ? `${base}/display/~${encodeURIComponent(username)}`
          : null,
  };
}

/** A short name for bytes read out of Confluence, derived from the thing itself. */
function keyFor(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `confluence.${hash.toString(36)}`;
}

/**
 * The content id, from an id or from any of the urls Confluence spells a page
 * as — Cloud's `/spaces/KEY/pages/123/Title` and Server's `?pageId=123` both.
 */
function pageId(page) {
  const asked = typeof page === 'string' ? page.trim() : String(page);
  if (/^\d+$/.test(asked)) {
    return asked;
  }
  const inPath = asked.match(/\/pages\/(\d+)/);
  if (inPath !== null) {
    return inPath[1];
  }
  const inQuery = asked.match(/[?&]pageId=(\d+)/);
  if (inQuery !== null) {
    return inQuery[1];
  }
  throw new Error(`not a page id or a page url: ${asked}`);
}

export default class Confluence extends OrknuxPlugin {

  id() {
    return 'confluence';
  }

  apiVersion() {
    return 1;
  }

  parameters() {
    return [
      new OrknuxParameter({
        name: 'confluence',
        description:
          'Which Confluence to ask: a Confluence connection, which carries its address and auth - ' +
          'Basic with email:token for Cloud, Bearer with a personal access token for Server.',
        type: 'connection',
        connectionType: 'confluence',
        required: true,
      }),
    ];
  }

  /*
   * The kind of host this plugin talks to, so a workspace can hold several
   * Confluence sites by name rather than one url on the plugin's page.
   */
  connectionTypes() {
    return [
      {
        name: 'confluence',
        label: 'Confluence',
        description:
          'A Confluence wiki, Cloud or Server/Data Center: Basic with email:token for Cloud, ' +
          'Bearer with a personal access token for Server.',
        urlPlaceholder: 'https://your-site.atlassian.net/wiki',
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

  /* The two shapes this plugin answers. */
  /*
   * Two calls, and the whole skill is about the first one.
   *
   * `search` takes plain words or CQL and passes either through as written, so
   * a model that does not know CQL exists gets whatever full-text matching
   * gives it - which on a wiki of any size is the wrong page, confidently.
   */
  skills() {
    return [
      new OrknuxSkill({
        name: 'Looking something up on Confluence',
        description: 'Searching a wiki so the right page comes back, and what its body actually is.',
        content: `# Looking something up on Confluence

The answer to a great many questions is already written down on the wiki. Two
calls get at it: \`confluence_search\` finds the page, \`confluence_openPage\` reads
it.

## Search with CQL, not with hope

\`search\` passes the query through as written. Plain words search page text,
which on a wiki of any size returns the twenty pages that mention your words
and not the one that is about them. **CQL is how you ask properly:**

    space = "DOC" AND title ~ "runbook"
    title ~ "deploy" AND lastmodified > now("-12w")
    space = "ENG" AND type = page AND text ~ "rate limit"
    creator = "jsmith" AND lastmodified > now("-4w")

The fields worth knowing: \`space\`, \`title\`, \`text\`, \`type\` (\`page\`, \`blogpost\`),
\`label\`, \`creator\`, \`lastmodified\`, \`created\`. \`~\` is contains, \`=\` is exact.
\`now("-4w")\` takes \`d\`, \`w\`, \`m\`, \`y\`.

**Prefer \`title ~\` over plain text** when you know roughly what the page is
called. A runbook is titled like a runbook; its body mentions a hundred things
it is not about.

## Then open exactly one

Each match carries an \`id\` and a \`url\`, and \`openPage\` takes either - or any
Confluence link somebody pasted, Cloud's \`/spaces/KEY/pages/123/Title\` or
Server's \`?pageId=123\`.

Read the excerpts first and open the **one** page that answers the question.
Opening five to see which is right costs five page bodies in your context and
usually the first one was right.

## A mention is an id, not a name

The body does not say who was mentioned. It says this:

    <ac:link><ri:user ri:userkey="ff8080816f2b1c34016f2b1c34000001"/></ac:link>

So "who owns this runbook" reads as a string of hex, and the same is true of
any macro wrapping an \`<ri:user>\`. \`openPage\` collects those ids into
\`mentions\`, and \`confluence_openUser\` turns one into a person - pass the id or
the whole mention, whichever you have.

Resolve the one that matters rather than all of them. A page mentioning eight
people costs eight calls if you ask for eight, and the question was almost
always about the owner.

**A display name will not work here.** Confluence looks a person up by key,
not by label. \`confluence_findUsers\` is the call that takes a name - give it
"Jo Smith" or just "jo", and it answers people with the ids everything else
takes.

## The body is XHTML, not markdown

\`openPage\` answers Confluence **storage format**, which is XHTML: \`<p>\`, \`<h2>\`,
\`<ac:structured-macro>\` for panels and code blocks. Read it as HTML. Do not
quote it back to somebody as though it were prose - pull the answer out and say
it in your own words, with the page's \`url\` so they can go and read it.

## When nothing comes back

**An empty search is usually permissions, not an empty wiki.** Confluence
filters by what the credential can see, so a query that works in a browser can
answer nothing through a token with narrower access. Say that is a possibility
rather than telling somebody their wiki has no runbook.

If a query with several \`AND\` clauses finds nothing, drop the narrowest clause
and search again - a wrong space key or a stale label answers empty in exactly
the same way as a subject nobody has written about.`,
      }),

      new OrknuxSkill({
        name: 'Finding what somebody has to do with the wiki',
        description: 'Going from a name to the pages that mention them, which is two steps and not one.',
        content: `# Finding what somebody has to do with the wiki

"What has Ada written?" and "where is Ada mentioned?" look like text searches.
They are not, and searching for the name is the wrong answer to both.

## A name is not in the page; an id is

Confluence stores a mention as an identifier inside markup:

    <ac:link><ri:user ri:userkey="ff8080816f2b1c34016f2b1c34000001"/></ac:link>

The name you see is drawn from that id when the page is displayed. So
\`text ~ "Ada Lovelace"\` finds the pages that happen to **type** her name, and
misses every page that **mentions** her - which are usually the ones being
asked about.

## So it is two steps

\`\`\`
confluence_findUsers("Ada Lovelace")     → id: "5b10ac8d82e05b22cc7d4ef5"
confluence_search('mention = "5b10ac8d82e05b22cc7d4ef5"')
\`\`\`

Pass back whatever \`findUsers\` gave you. On Cloud that is an account id and on
Server a user key, and the plugin already knows which of the two this wiki
speaks - there is nothing to convert.

## The CQL fields that take one

| field | finds |
|---|---|
| \`mention = "<id>"\` | pages that mention them |
| \`creator = "<id>"\` | pages they created |
| \`contributor = "<id>"\` | pages they created **or** edited |
| \`watcher = "<id>"\` | pages they are watching |

They narrow like any other clause, and that is usually what makes the answer
useful rather than long:

\`\`\`
mention = "5b10ac8d…" AND lastmodified > now("-4w")
creator = "5b10ac8d…" AND space = "ENG" ORDER BY created DESC
contributor = "5b10ac8d…" AND title ~ "runbook"
\`\`\`

\`contributor\` is the one to reach for when somebody asks what a person has
worked on. \`creator\` answers a narrower question - who started it - and a page
somebody rewrote entirely is still not theirs by that field.

## Matching the id as text is a fallback, not the tool

\`text ~ "5b10ac8d…"\` sometimes works and should not be the first try: the
search index holds what a page *renders*, not always the markup behind it, so
this misses pages \`mention\` finds. Use it only when \`mention\` answers nothing
and you have reason to think the id is written into the page as literal text -
in a macro parameter, say.

## The other direction

\`confluence_openPage\` answers a \`mentions\` list: the ids on that page, read
straight out of the body. \`confluence_openUser\` turns one into a person. So
the pair is symmetrical - a person gives you their pages, a page gives you its
people - and neither of them starts from a name.

## What an empty answer means here

The same thing it means everywhere in this plugin: possibly permissions.
Confluence filters by what the credential can see, so a person genuinely
mentioned on forty pages answers zero if the token cannot read that space.
Check with a query that has nothing to do with people - \`space = "ENG"\` - before
reporting that somebody has never been mentioned.`,
      }),
    ];
  }

  /*
   * The second page, and it is about a question the first one answers badly.
   *
   * "What has Ada written" and "where is Ada mentioned" look like text
   * searches and are not: the wiki stores people as ids, so searching for a
   * name finds the pages that *type* it and misses every page that mentions
   * her. The two steps are obvious once somebody knows the id exists, and
   * invisible before that.
   */
  objects() {
    return [
      new OrknuxObject({
        name: 'Match',
        description: 'One page a search turned up.',
        properties: [
          { name: 'id', kind: 'string', description: 'The content id; openPage takes it.' },
          { name: 'type', kind: 'string', description: 'page, blogpost, comment.' },
          { name: 'title', kind: 'string', description: 'With the highlight markers taken out.' },
          { name: 'space', kind: 'string', description: 'Which space it lives in.' },
          { name: 'excerpt', kind: 'string', description: 'The passage around the match.' },
          { name: 'updated', kind: 'string', description: 'When it last changed.' },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Search',
        description: 'What a search of the wiki came to.',
        properties: [
          { name: 'total', kind: 'number', description: 'How many the whole search holds, not how many came back.' },
          { name: 'matches', kind: 'array', of: 'Match', description: 'Capped by limit.' },
        ],
      }),

      new OrknuxObject({
        name: 'Users',
        description: 'What a search for people came to.',
        properties: [
          { name: 'total', kind: 'number', description: 'How many the whole search holds, not how many came back.' },
          { name: 'users', kind: 'array', of: 'User', description: 'Capped by limit.' },
        ],
      }),

      new OrknuxObject({
        name: 'User',
        description: 'Who a mention or an id on a page belongs to.',
        properties: [
          {
            name: 'id',
            kind: 'string',
            description: "The account id on Cloud, the user key on Server — what Confluence calls them.",
          },
          {
            name: 'username',
            kind: 'string',
            description: 'Server only. Null on Cloud, which retired usernames for account ids.',
          },
          { name: 'name', kind: 'string', description: 'The display name — what a page shows where the mention is.' },
          {
            name: 'email',
            kind: 'string',
            description:
              'Often null, and that is an answer rather than a gap: Atlassian hides an address ' +
              'the person has not made public, whatever the token can otherwise see.',
          },
          {
            name: 'type',
            kind: 'string',
            description: 'known, app, anonymous, unknown — an app is a bot, not somebody to ask.',
          },
          { name: 'external', kind: 'boolean', description: 'A guest rather than a member of the site.' },
          {
            name: 'avatarUrl',
            kind: 'string',
            description:
              'Their avatar as a url, never the image itself - null where Confluence offers ' +
              'none. Named for what it holds because a field called picture was read as image ' +
              'content by something downstream, which then refused a url as bad base64. Behind ' +
              'the same login as the wiki, so it opens for a person and not for a service.',
          },
          {
            name: 'avatar',
            kind: 'string',
            description:
              'The picture itself as base64, and only where withAvatar asked for it - null ' +
              'otherwise, and null again where fetching it failed, because an avatar is not ' +
              'worth failing a lookup over.',
          },
          { name: 'avatarType', kind: 'string', description: 'What those bytes are: image/png, image/svg+xml.' },
          {
            name: 'avatarKey',
            kind: 'string',
            description:
              'Where the picture is kept for the rest of this session. Hand it to slack_upload ' +
              'or slack_uploadBinary as contentKey rather than copying the base64 out. Empty ' +
              'where nothing was fetched, or where there is no session to keep it in.',
          },
          { name: 'url', kind: 'string', description: 'Their profile, for a person to open.' },
        ],
      }),

      new OrknuxObject({
        name: 'Page',
        description: 'One Confluence page, whole.',
        properties: [
          { name: 'id', kind: 'string', description: 'The content id.' },
          { name: 'title', kind: 'string', description: 'The title.' },
          { name: 'space', kind: 'string', description: 'The space key.' },
          { name: 'version', kind: 'number', description: 'Which revision this is.' },
          { name: 'updated', kind: 'string', description: 'When that revision was made.' },
          { name: 'by', kind: 'string', description: 'Who made it.' },
          {
            name: 'body',
            kind: 'string',
            description: 'Confluence storage format, which is XHTML — read it as HTML.',
          },
          {
            name: 'mentions',
            kind: 'array',
            of: 'string',
            description:
              'Everybody the body mentions, as the ids the markup carries rather than as names ' +
              '— openUser turns one into a person. Empty where the page mentions nobody.',
          },
          { name: 'url', kind: 'string', description: 'The link for a person to open.' },
        ],
      }),
    ];
  }

  /* The agents' surface: both calls, fronted. Proxies, so everything stays the functions' own. */
  tools() {
    return [
      new OrknuxFunctionTool({ function: 'search' }),
      new OrknuxFunctionTool({ function: 'openPage' }),
      new OrknuxFunctionTool({ function: 'openUser' }),
      new OrknuxFunctionTool({ function: 'findUsers' }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'search',
        description:
          'Searches Confluence. Pass plain words to search page text, or CQL for anything sharper - ' +
          'space = "DOC", title ~ "runbook", type = blogpost, lastmodified > now("-4w") - which is used ' +
          'as written. Answers the total and the matches - id, type, title, space, an excerpt around ' +
          'the match and a url each; openPage takes the id or the url. limit caps the matches.',
        params: [
          { name: 'query', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 20 },
        ],
        returnType: 'Search',
        run: (query, limit) => {
          const asked = typeof query === 'string' ? query.trim() : '';
          if (asked.length === 0) {
            throw new Error('there is nothing to search for');
          }
          /*
           * Plain words become a text search; anything wearing an operator is
           * taken to be CQL already. `~` and `=` are what every CQL clause
           * carries, and neither is anything a person types into a plain
           * search on purpose.
           */
          const cql = /[~=<>]/.test(asked)
            ? asked
            : `text ~ "${asked.replace(/(["\\])/g, '\\$1')}"`;

          const capped = Math.min(Math.max(limit, 1), 100);
          const found = read(this.settings, `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${capped}`);

          /* The webui links are relative to a base the answer itself names. */
          const base = at(at(found, '_links'), 'base') ?? root(this.settings);
          return {
            total: at(found, 'totalSize'),
            matches: (at(found, 'results') ?? []).map((one) => {
              const content = at(one, 'content');
              const webui = at(at(content, '_links'), 'webui');
              return {
                id: at(content, 'id'),
                type: at(content, 'type'),
                title: plain(at(one, 'title')) ?? at(content, 'title'),
                space: at(at(one, 'resultGlobalContainer'), 'title'),
                excerpt: plain(at(one, 'excerpt')),
                updated: at(one, 'lastModified'),
                url: typeof webui === 'string' ? base + webui : null,
              };
            }),
          };
        },
      }),

      new OrknuxFunction({
        name: 'openPage',
        description:
          'Opens one Confluence page whole: title, space, version, who last changed it and when, a url, ' +
          'and the body. Pass the page\'s id, or any url that names it - a Cloud /spaces/KEY/pages/123/ ' +
          'link or a Server ?pageId=123 one. The body is Confluence storage format, which is XHTML: ' +
          'read it as HTML.',
        params: [{ name: 'page', type: 'string' }],
        returnType: 'Page',
        run: (page) => {
          const id = pageId(page);
          const opened = read(
            this.settings,
            `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,space,version`,
          );
          const links = at(opened, '_links');
          const webui = at(links, 'webui');
          const body = at(at(at(opened, 'body'), 'storage'), 'value');
          return {
            id: at(opened, 'id'),
            title: at(opened, 'title'),
            space: at(at(opened, 'space'), 'key'),
            version: at(at(opened, 'version'), 'number'),
            updated: at(at(opened, 'version'), 'when'),
            by: at(at(at(opened, 'version'), 'by'), 'displayName'),
            body: body,
            /* Read out of the markup rather than asked for: a mention is already in the body. */
            mentions: mentionedIn(body),
            url: typeof webui === 'string' ? (at(links, 'base') ?? root(this.settings)) + webui : null,
          };
        },
      }),

      new OrknuxFunction({
        name: 'openUser',
        description:
          'Who somebody on Confluence is: their display name, their email where Atlassian will ' +
          'say, whether the account is a person or an app, and a link to their profile. Takes ' +
          'whatever names them - an account id (Cloud) or username or user key (Server), a ' +
          'profile url, or a mention copied straight out of a page body, which is the usual one: ' +
          'a page carries a mention as <ri:user ri:account-id="..."/> rather than as a name, so ' +
          'openPage answers those ids in its mentions list and this turns one into a person. A ' +
          'display name is not an identifier and will not work - findUsers turns one into an id. ' +
          'withAvatar fetches their picture as base64 too, which is off by default: a name and ' +
          'an email are what this is usually for, and the avatar sits behind the same login as ' +
          'the wiki, so the url alone opens for nobody else.',
        params: [
          { name: 'person', type: 'string' },
          { name: 'withAvatar', type: 'boolean', required: false, default: false },
        ],
        returnType: 'User',
        run: (person, withAvatar) => {
          const query = personQuery(this.settings, person);
          const found = read(this.settings, `/rest/api/user?${query}`);

          const site = root(this.settings);
          const base = at(at(found, '_links'), 'base') ?? site;
          const profile = personOf(this.settings, found);
          const avatarUrl = profile.avatarUrl;

          /*
           * The picture itself, only when somebody asked for it.
           *
           * An avatar behind a login is a url nothing else can open: the
           * credential that reads it is this plugin's, so a caller holding
           * the link still cannot see the face. Fetching is therefore worth
           * offering and not worth doing on every lookup - a name and an
           * email are what openUser is usually for, and bytes nobody wanted
           * are bytes through the model.
           *
           * A refusal is not an error. An avatar is decoration, and failing a
           * whole lookup because a default picture 404ed would be the wrong
           * trade entirely.
           */
          let avatar = null;
          let avatarType = null;
          let avatarKey = '';
          if (withAvatar === true && avatarUrl !== null) {
            const fetched = orknux.http.download(avatarUrl, headers(this.settings));
            if (fetched.error === undefined && fetched.status < 400) {
              avatar = fetched.base64;
              avatarType = fetched.contentType;
              const key = keyFor(avatarUrl);
              avatarKey = orknux.session.store.put(key, fetched.base64).error === undefined ? key : '';
            }
          }

          /* The same shape a search answers, with the three the fetch filled in. */
          return { ...profile, avatar: avatar, avatarType: avatarType, avatarKey: avatarKey };
        },
      }),

      new OrknuxFunction({
        name: 'findUsers',
        description:
          'Finds people by name, which is the call for turning "Jo Smith" into somebody openUser ' +
          'can take - a display name is not an identifier anywhere else in this plugin. Matches ' +
          'on the full name the way the people directory does, so a first name or a fragment is ' +
          'enough. Answers how many the whole search holds and the people themselves, each with ' +
          'the id every other call takes, their display name, whether the account is a person or ' +
          'an app, and a link to their profile. limit caps them.',
        params: [
          { name: 'name', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 10 },
        ],
        returnType: 'Users',
        run: (name, limit) => {
          const asked = typeof name === 'string' ? name.trim() : '';
          if (asked.length === 0) {
            throw new Error('there is no name to search for');
          }
          const capped = Math.min(Math.max(Math.trunc(limit), 1), 50);
          /* A name with a quote in it is a name, not the end of the clause. */
          const quoted = asked.replace(/(["\\])/g, '\\$1');

          /*
           * The one place the two deployments differ, and the same split the
           * jira plugin makes for the same reason: Cloud has an endpoint for
           * searching people, and Server answers the same question through
           * the CQL search everything else goes through, with `type=user`
           * saying what is being looked for.
           */
          const found = isCloud(this.settings)
            ? read(
                this.settings,
                `/rest/api/search/user?cql=${encodeURIComponent(`user.fullname~"${quoted}"`)}&limit=${capped}`,
              )
            : read(
                this.settings,
                `/rest/api/search?cql=${encodeURIComponent(
                  `type=user AND user.fullname~"${quoted}"`,
                )}&limit=${capped}`,
              );

          const results = at(found, 'results') ?? [];
          return {
            total: at(found, 'totalSize') ?? results.length,
            /* A search result wraps the person; an endpoint that answers one bare still works. */
            users: results.map((one) => personOf(this.settings, at(one, 'user') ?? one)),
          };
        },
      }),
    ];
  }
}
