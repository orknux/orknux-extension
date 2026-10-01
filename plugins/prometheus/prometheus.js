/*
 * Prometheus, as a plugin.
 *
 * What this exists for is the question "what is the system doing", asked from a
 * workflow's condition or an agent's hand: is the error rate above the line, is
 * this job up, what metrics are there to ask about at all. Prometheus answers
 * over HTTP, and a plugin has no network, deliberately and permanently — so
 * both calls here are made by the *server* on the plugin's behalf, under the
 * NETWORK_REQUEST capability a person accepted, against the Prometheus the
 * workspace named.
 *
 * ## Setting one up
 *
 * 1. Load this plugin and accept NETWORK_REQUEST.
 * 2. Add a connection of the kind it declares, Prometheus, with the server's
 *    root as its URL — `http://prometheus:9090`, or wherever the
 *    installation's proxy rules allow the server to reach.
 * 3. A bare Prometheus needs no auth. One behind a token takes Bearer; a
 *    Grafana Cloud endpoint takes Basic with `instanceId:token` as the secret.
 * 4. Point the plugin's `prometheus` parameter at that connection.
 *
 * ## Why a connection and not three settings
 *
 * The address and the credential used to be the plugin's own parameters, so a
 * workspace had exactly one Prometheus and its token sat on the plugin's page.
 * A connection is where a workspace already keeps hosts: encrypted, checked,
 * one row per server — and a kind of its own keeps the picker to Prometheus
 * servers rather than every HTTP endpoint there is. Because the kind is this
 * plugin's, the server hands its address and headers across with the handle;
 * nothing but this plugin knows how to speak to it.
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
 * kinder than a request to `undefined/api/v1/...`.
 */
function server(settings) {
  const connection = settings.prometheus;
  if (connection === undefined || connection === null) {
    throw new Error("the plugin's prometheus parameter is not set, and every Prometheus call needs it");
  }
  if (typeof connection.url !== 'string' || connection.url.length === 0) {
    throw new Error(
      "the prometheus parameter names a connection that is not a Prometheus connection of this plugin's " +
        'kind, so its address never reached the plugin - point it at a Prometheus connection, on a server ' +
        'that hands one over',
    );
  }
  return connection;
}

/** The server's root, without its trailing slash. */
function root(connection) {
  return connection.url.endsWith('/') ? connection.url.slice(0, -1) : connection.url;
}

/**
 * The headers a call goes out with: json asked for, and whatever the
 * connection says to send - its credential already spelled for its auth kind,
 * so Basic, Bearer and an API key are the connection's business, not this.
 */
function headers(connection) {
  return Object.assign({ accept: 'application/json' }, connection.headers ?? {});
}

/**
 * One read of Prometheus's API, answered or thrown.
 *
 * Prometheus wraps every answer in `{status, data}` and says why not in its
 * own `error` field — often beside a 4xx, but checked on its own because a
 * proxy in front can turn anything into a 200.
 */
function read(settings, path) {
  const connection = server(settings);
  const answered = orknux.http.get(root(connection) + path, headers(connection));
  if (answered.error !== undefined) {
    throw new Error(`could not reach Prometheus: ${answered.error}`);
  }
  const said = at(answered.json, 'error');
  if (answered.status >= 400 || at(answered.json, 'status') === 'error') {
    throw new Error(
      `Prometheus answered ${answered.status}${typeof said === 'string' ? ': ' + said : ''} for ${path.split('?')[0]}`,
    );
  }
  return at(answered.json, 'data');
}

export default class Prometheus extends OrknuxPlugin {

  id() {
    return 'prometheus';
  }

  apiVersion() {
    return 1;
  }

  /*
   * The kind of host this plugin talks to, so a workspace can hold several
   * Prometheus servers by name rather than one url on the plugin's page.
   */
  connectionTypes() {
    return [
      {
        name: 'prometheus',
        label: 'Prometheus',
        description:
          'A Prometheus server to query - or anything speaking its HTTP API, such as Grafana Cloud or Thanos.',
        urlPlaceholder: 'http://prometheus:9090',
      },
    ];
  }

  parameters() {
    return [
      new OrknuxParameter({
        name: 'prometheus',
        description: 'Which Prometheus to ask: a Prometheus connection, which carries its address and auth.',
        type: 'connection',
        connectionType: 'prometheus',
        required: true,
      }),
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
   * One shape, and one deliberate absence.
   *
   * `query` keeps answering a map because its result genuinely has no fixed
   * form: a vector element carries `metric` keyed by whatever labels the
   * series happens to have, and an array here needs an `of` that nothing
   * could supply. Prometheus's own shape, passed through, is the honest
   * answer — and it is the one every PromQL reader already knows.
   */
  objects() {
    return [
      new OrknuxObject({
        name: 'Metrics',
        description: 'The metric names a server knows — the vocabulary a query is written in.',
        properties: [
          { name: 'metrics', kind: 'array', of: 'string', description: 'Alphabetical, capped by limit.' },
          { name: 'count', kind: 'number', description: 'How many there were before limit capped them.' },
        ],
      }),
    ];
  }

  /* The agents' surface: both calls, fronted. Proxies, so everything stays the functions' own. */
  tools() {
    return [
      new OrknuxFunctionTool({ function: 'listMetrics' }),
      new OrknuxFunctionTool({ function: 'query' }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'listMetrics',
        description:
          'Lists the metric names the server knows, alphabetically - the vocabulary a query is written ' +
          'in. match narrows the list to the series a selector matches, like {job="api"} - or pass an ' +
          'empty match for everything. Answers the names and how many there were before limit capped ' +
          'them; leave limit out for no cap.',
        params: [
          { name: 'match', type: 'string' },
          { name: 'limit', type: 'number', required: false, default: 0 },
        ],
        returnType: 'Metrics',
        run: (match, limit) => {
          let path = '/api/v1/label/__name__/values';
          if (typeof match === 'string' && match.length > 0) {
            path += `?match[]=${encodeURIComponent(match)}`;
          }
          const names = read(this.settings, path);
          const metrics = Array.isArray(names) ? names : [];
          /* Zero is this one's real answer rather than a sentinel: no cap. */
          const capped = limit > 0 ? metrics.slice(0, limit) : metrics;
          return { metrics: capped, count: metrics.length };
        },
      }),

      new OrknuxFunction({
        name: 'query',
        description:
          'Executes a PromQL expression as an instant query: rate(http_requests_total[5m]), ' +
          'up{job="api"}, histogram_quantile(0.99, ...) - anything the expression browser takes. ' +
          'Evaluated now, or at `time` when one is given (RFC 3339 or a unix timestamp). Answers Prometheus\'s own result: resultType (vector, matrix, scalar or string) and ' +
          'result, where each vector element is {metric: {labels}, value: [time, "value"]}.',
        params: [
          { name: 'promql', type: 'string' },
          { name: 'time', type: 'string', required: false, default: '' },
        ],
        returnType: 'map',
        run: (promql, time) => {
          if (typeof promql !== 'string' || promql.trim().length === 0) {
            throw new Error('there is no expression to execute');
          }
          let path = `/api/v1/query?query=${encodeURIComponent(promql)}`;
          if (typeof time === 'string' && time.length > 0) {
            path += `&time=${encodeURIComponent(time)}`;
          }
          const data = read(this.settings, path);
          /*
           * The result is Prometheus's own shape, passed through: a value like
           * `[1726000000, "0.95"]` is what every PromQL reader already knows
           * how to read, and flattening it would only invent a second dialect.
           */
          return { resultType: at(data, 'resultType'), result: at(data, 'result') };
        },
      }),
    ];
  }
}
