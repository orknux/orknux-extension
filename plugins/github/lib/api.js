/*
 * How the github plugin speaks to GitHub's REST API — the door, the errors,
 * and the little readers every answer is picked apart with.
 *
 * A library file the plugin ships and declares. Everything here takes the
 * plugin's `settings` as an argument rather than holding any state of its
 * own, and the one thing it reaches — `orknux.http` — is the sandbox's,
 * present wherever the plugin itself runs.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

/** A header by name, from a map whose keys the server has already lower-cased. */
export function header(headers, name) {
  if (headers === null || typeof headers !== 'object') {
    return null;
  }
  const held = headers[name];
  return typeof held === 'string' ? held : null;
}

/** A nested field, or null rather than a thrown error on the way down. */
export function at(holder, name) {
  if (holder === null || typeof holder !== 'object') {
    return null;
  }
  const held = holder[name];
  return held === undefined ? null : held;
}

/** The API root, without its trailing slash: api.github.com unless `apiUrl` says a GHES. */
function apiRoot(settings) {
  const configured = settings.apiUrl;
  const chosen =
    typeof configured === 'string' && configured.length > 0 ? configured : 'https://api.github.com';
  return chosen.endsWith('/') ? chosen.slice(0, -1) : chosen;
}

/**
 * One call to GitHub's API, authenticated, with the transport checked.
 *
 * The status is *not* checked here: `read` below insists on an answer, and the
 * one caller that wants to see a 404 for itself — `listRepos`, deciding whether
 * an owner is an organization or a user — calls this directly.
 *
 * Authenticated with the plugin's `token` unless `asked.token` names another
 * one, which is how `readOrClassic` below asks again with the classic token.
 */
export function call(settings, asked) {
  const token = asked.token === undefined ? settings.token : asked.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error("the plugin's token parameter is not set, and every GitHub API call needs it");
  }

  const answered = orknux.http.request({
    url: asked.url === undefined ? apiRoot(settings) + asked.path : asked.url,
    method: asked.method === undefined ? 'GET' : asked.method,
    headers: {
      accept: asked.accept === undefined ? 'application/vnd.github+json' : asked.accept,
      authorization: 'Bearer ' + token,
      'x-github-api-version': '2022-11-28',
    },
    body: asked.body,
  });
  if (answered.error !== undefined) {
    throw new Error(`could not reach GitHub: ${answered.error}`);
  }
  return answered;
}

/**
 * Where GraphQL answers: beside the REST root on github.com, and at
 * `/api/graphql` on an Enterprise Server, whose REST root is `/api/v3`.
 */
function graphqlUrl(settings) {
  const rest = apiRoot(settings);
  return rest.endsWith('/v3') ? rest.slice(0, -'/v3'.length) + '/graphql' : rest + '/graphql';
}

/**
 * One GraphQL operation, answered with its `data` or thrown.
 *
 * Only for what REST cannot do - taking a pull request out of draft is the
 * case that brought it here. GraphQL says no with a 200 and an `errors` list
 * as often as with a status, so both are read as a refusal.
 */
export function graphql(settings, query, variables) {
  const answered = call(settings, {
    url: graphqlUrl(settings),
    path: '/graphql',
    method: 'POST',
    body: { query: query, variables: variables },
  });
  const errors = at(answered.json, 'errors');
  if (answered.status >= 400 || (Array.isArray(errors) && errors.length > 0)) {
    const said = (Array.isArray(errors) ? errors : [])
      .map((one) => at(one, 'message'))
      .filter((one) => typeof one === 'string');
    if (said.length === 0) {
      throw statusError(answered, '/graphql');
    }
    throw new Error(`GitHub answered ${answered.status}: ${said.join('; ')} for /graphql`);
  }
  return at(answered.json, 'data');
}

/** The sentence a 4xx or 5xx becomes, carrying GitHub's own words where it said any. */
export function statusError(answered, path) {
  const said = at(answered.json, 'message');
  const where = path.split('?')[0];
  return new Error(
    `GitHub answered ${answered.status}${typeof said === 'string' ? ': ' + said : ''} for ${where}`,
  );
}

/** The same call, insisting on an answer: a 4xx or 5xx is thrown, not returned. */
export function read(settings, asked) {
  const answered = call(settings, asked);
  if (answered.status >= 400) {
    throw statusError(answered, asked.path);
  }
  return answered;
}

/**
 * The same read, asked again with the classic token where the first one was
 * refused.
 *
 * A fine-grained token is refused on the commit status endpoints in setups a
 * classic token still reads, and GitHub refuses it two ways. A token minted
 * without the commit statuses or checks permission draws a 403. A token that
 * may not see the repository at all — an organization that has not approved
 * fine-grained tokens is the usual case — draws a 404, because GitHub does not
 * admit a private repository exists to a token it will not show it to. Both
 * are asked again under `classicToken`, where one is configured; every other
 * answer, and either with nothing to fall back to, is what `read` would have
 * made of it.
 *
 * A 404 for a repository that really is not there costs one more request and
 * ends in the same sentence, which is cheaper than reading the wrong one of
 * GitHub's two refusals as the truth.
 */
export function readOrClassic(settings, asked) {
  const answered = call(settings, asked);
  const classic = settings.classicToken;
  const refused = answered.status === 403 || answered.status === 404;
  if (refused && typeof classic === 'string' && classic.length > 0) {
    return read(settings, { ...asked, token: classic });
  }
  if (answered.status >= 400) {
    throw statusError(answered, asked.path);
  }
  return answered;
}

/** The owner to ask about: what was passed, or the configured organization. */
export function ownerOr(settings, owner) {
  if (typeof owner === 'string' && owner.length > 0) {
    return owner;
  }
  const fallback = settings.organization;
  if (typeof fallback === 'string' && fallback.length > 0) {
    return fallback;
  }
  throw new Error('no owner was passed and no default organization is configured');
}

/**
 * The `/repos/{owner}/{repo}` root every repository call hangs under.
 *
 * Takes the repository as a bare name beside an owner, or as `owner/name` in
 * one — which is how models and people alike tend to say it — and falls back
 * to the configured organization when neither said an owner.
 */
export function repoPath(settings, owner, repo) {
  let named = typeof repo === 'string' ? repo : '';
  let who = owner;
  const slash = named.indexOf('/');
  if (slash > 0) {
    who = named.slice(0, slash);
    named = named.slice(slash + 1);
  }
  if (named.length === 0) {
    throw new Error('no repository was named');
  }
  return `/repos/${encodeURIComponent(ownerOr(settings, who))}/${encodeURIComponent(named)}`;
}

/**
 * A search query, scoped to the configured organization unless it already says
 * where to look — so a bare "login bug" searches the org's work, and a query
 * that names a repo or another org is left saying what it said.
 */
export function scoped(settings, query) {
  const asked = typeof query === 'string' ? query.trim() : '';
  if (/(?:^|\s)(?:repo|org|user|owner):/.test(asked)) {
    return asked;
  }
  const fallback = settings.organization;
  return typeof fallback === 'string' && fallback.length > 0 ? `${asked} org:${fallback}` : asked;
}

/** A path inside a repository, each segment escaped, the slashes kept. */
export function escapedPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

/**
 * A page size, capped where GitHub caps.
 *
 * It used to take a fallback for a limit nobody passed. Function parameters
 * carry their own defaults now — the server puts one in before the call — so
 * every limit arrives and the only work left is the ceiling.
 */
export function pageSize(limit) {
  return Math.min(Math.max(limit, 1), 100);
}

/** `owner/name`, from the api url a search result names its repository by. */
export function repoNamed(url) {
  if (typeof url !== 'string') {
    return null;
  }
  const marker = url.indexOf('/repos/');
  return marker === -1 ? url : url.slice(marker + '/repos/'.length);
}

/** One changed file, as `openPull` and `openCommit` both answer it. */
export function changedFile(one) {
  return {
    path: at(one, 'filename'),
    status: at(one, 'status'),
    additions: at(one, 'additions'),
    deletions: at(one, 'deletions'),
    patch: at(one, 'patch'),
  };
}
