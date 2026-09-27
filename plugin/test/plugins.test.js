import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validate } from '../dist/index.js';
import { inspect } from '../dist/tooling.js';

/**
 * The production plugins in this repository, held to the contract this package
 * mirrors. Each is a single file already in the shape the server takes, so
 * there is nothing to bundle: it is loaded as it stands and asked what it is,
 * exactly the way an upload would ask — which is what keeps "the library
 * accepts what the server accepts" true of the plugins people actually
 * load, not only of fixtures written to pass.
 */

const shipped = (name) =>
  fileURLToPath(new URL(`../../plugins/${name}/${name}.js`, import.meta.url));

/*
 * Every plugin in the directory, read rather than remembered.
 *
 * The sweeps below used to name their plugins in a list, which worked until
 * somebody added one: nomnoml and http were both written, tested and shipped
 * while two whole-repository invariants quietly skipped them. A list of what
 * is here is a thing that stops being true; the directory does not.
 */
const everyPlugin = readdirSync(fileURLToPath(new URL('../../plugins/', import.meta.url)))
  .filter((name) => existsSync(shipped(name)))
  .sort();


/**
 * What a drawing has to say for itself before a rasteriser will scale it.
 *
 * This is the assertion that was missing twice. Batik - which is what draws
 * these - reads the document's own width and height and fits the viewBox into
 * them; a root carrying only a viewBox has no size, so Batik falls back to its
 * default document of 400 by 400, and a width of 1200 then produces 1200 by
 * 400 with the drawing letterboxed in the middle of it. A plugin once stripped
 * the intrinsic size deliberately, believing the opposite, and these tests
 * could not tell: they only ever looked at the number it asked for, never at
 * the markup it handed over.
 */
function handedOver(markup, asked) {
  const root = markup.slice(0, markup.indexOf('>'));

  const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(root);
  assert.ok(box, 'the markup handed over has no viewBox');

  const wide = /\bwidth="([\d.]+)"/.exec(root);
  const tall = /\bheight="([\d.]+)"/.exec(root);
  assert.ok(wide, 'the markup handed over declares no width, so it will be letterboxed');
  assert.ok(tall, 'the markup handed over declares no height, so it will be letterboxed');

  const width = Number(wide[1]);
  const height = Number(tall[1]);
  assert.equal(width, asked, 'the markup says a different width than was asked for');

  /* And the same shape as the viewBox, so there is nothing to letterbox against. */
  const drawn = Number(box[1]) / Number(box[2]);
  assert.ok(
    Math.abs(width / height - drawn) < 0.02,
    `the markup is ${(width / height).toFixed(3)} where its viewBox is ${drawn.toFixed(3)}`,
  );

  /*
   * `transparent` is a CSS colour and SVG 1.1 has none, so a strict renderer
   * falls back to the initial value - black for `fill`. nomnoml marks its
   * background rect that way, and what came back was a solid black slab behind
   * the diagram: invisible on a dark chat theme, obvious anywhere else.
   */
  assert.ok(
    !/(?:fill|stroke|stop-color|flood-color)="transparent"/.test(markup),
    'a paint is left as transparent, which a strict renderer draws black',
  );

  /*
   * And no paint left as a CSS variable, for the same reason and with the same
   * result. Batik implements SVG 1.1 and CSS 2: `var()` and `color-mix()` are
   * not values it has, so an attribute using one is invalid and falls back to
   * the initial value - black. A four-node flowchart carried forty-eight of
   * them, and came back as black boxes and black letters on white.
   */
  const unresolved = [...markup.matchAll(/(?:fill|stroke|stop-color|flood-color)="([^"]*)"/g)]
    .map((found) => found[1])
    .filter((value) => value.includes('var(') || value.includes('color-mix('));
  assert.deepEqual(unresolved, [], 'a paint is still a CSS variable, which draws black');

  return { width, height };
}

test('the github plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('github'));

  assert.equal(inspected.id, 'github');
  assert.equal(inspected.apiVersion, 1);
  assert.deepEqual(validate(inspected), []);

  /*
   * All three credentials are secrets: a typed-in value is refused by the
   * server. None is required, because the plugin has two halves — a
   * webhook-only workspace never sets a token, an API-only one never sets the
   * secret — and the classic token is only for a build status the
   * fine-grained one was refused.
   */
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['webhookSecret', 'token', 'classicToken', 'organization', 'apiUrl'],
  );
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.secret),
    [true, true, true, false, false],
  );
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.required),
    [false, false, false, false, false],
  );

  assert.deepEqual(inspected.permissions, ['TEXT_ENCODING']);
  assert.deepEqual(inspected.capabilities, ['NETWORK_REQUEST']);

  const surface = [
    'searchPulls',
    'listRepos',
    'listFiles',
    'openPull',
    'searchCode',
    'searchCommits',
    'openCommit',
    'reviews',
    'buildStatus',
    'openFile',
    'fileHistory',
    'createAgentTask',
    'agentTask',
    'agentTaskLogs',
    'messageAgentTask',
    'comment',
    'reviewComment',
    'replyToComment',
  ];
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['verify', 'describe', ...surface],
  );

  /*
   * The agents' surface is the API half, each an OrknuxFunctionTool the
   * inspection resolved — and never the webhook machinery, which a model has
   * no delivery to call with.
   */
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    surface,
  );
  for (const declared of inspected.tools) {
    assert.equal(declared.proxyOf, declared.name);
    const fronted = inspected.functions.find((one) => one.name === declared.proxyOf);
    assert.deepEqual(declared.params, fronted.params);
    assert.equal(declared.returnType, fronted.returnType);
    assert.equal(declared.description, fronted.description);
  }
});

test('github reviews answer where each person stands, not what they last did', async () => {
  const url = new URL(`../../plugins/github/github.js`, import.meta.url);
  const { default: Github } = await import(url.href);

  const plugin = Object.create(Github.prototype);
  Object.defineProperty(plugin, 'settings', {
    value: Object.freeze({ token: 'ghp_x', organization: 'acme' }),
  });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  /*
   * The history GitHub actually keeps, which is every event rather than a
   * tally. Ada asked for changes and approved after lunch; Bob commented
   * twice and never took a position; Cora approved and had it dismissed when
   * the branch moved.
   */
  const events = [
    { user: { login: 'ada' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-01T09:00:00Z', body: 'no' },
    { user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-09-01T10:00:00Z', body: 'a thought' },
    { user: { login: 'cora' }, state: 'APPROVED', submitted_at: '2026-09-01T11:00:00Z', body: '' },
    { user: { login: 'ada' }, state: 'APPROVED', submitted_at: '2026-09-01T13:00:00Z', body: 'better' },
    { user: { login: 'cora' }, state: 'DISMISSED', submitted_at: '2026-09-01T14:00:00Z', body: '' },
    { user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-09-01T15:00:00Z', body: 'another' },
  ];

  const asked = [];
  const door = globalThis.orknux.http.request;
  let stood;
  let blocked;
  try {
    globalThis.orknux.http.request = (what) => {
      asked.push(what.url);
      if (what.url.endsWith('/requested_reviewers')) {
        return {
          status: 200,
          headers: {},
          body: '{}',
          json: { users: [{ login: 'dee' }], teams: [{ slug: 'platform' }] },
        };
      }
      return { status: 200, headers: {}, body: '{}', json: events };
    };
    stood = call('reviews').run('', 'api', 7);

    /* And the same pull request with somebody still standing on changes. */
    globalThis.orknux.http.request = (what) => {
      if (what.url.endsWith('/requested_reviewers')) {
        return { status: 200, headers: {}, body: '{}', json: { users: [], teams: [] } };
      }
      return {
        status: 200,
        headers: {},
        body: '{}',
        json: [...events, { user: { login: 'eve' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-01T16:00:00Z' }],
      };
    };
    /* And the repo as owner/name in one, which is how people say it. */
    blocked = call('reviews').run('', 'acme/api', 7);
  } finally {
    globalThis.orknux.http.request = door;
  }

  /* The configured organization fills in the owner nobody passed. */
  assert.equal(asked[0], 'https://api.github.com/repos/acme/api/pulls/7/reviews?per_page=100');
  assert.equal(asked[1], 'https://api.github.com/repos/acme/api/pulls/7/requested_reviewers');

  /*
   * Ada approved after asking for changes, so she counts once and as an
   * approval. Counting events would have called this blocked.
   */
  assert.deepEqual(stood.approvers, ['ada']);
  assert.deepEqual(stood.blockers, []);
  assert.equal(stood.approvals, 1);
  assert.equal(stood.approved, true);
  assert.equal(stood.state, 'approved');

  /* A dismissal clears an approval rather than leaving it standing. */
  assert.ok(!stood.approvers.includes('cora'));

  /* And commenting is not a position: Bob is in neither list. */
  assert.ok(!stood.approvers.includes('bob') && !stood.blockers.includes('bob'));

  /* The history is all of it, in order, one entry per event. */
  assert.equal(stood.reviews.length, 6);
  assert.equal(stood.reviews[0].state, 'CHANGES_REQUESTED');
  assert.equal(stood.reviews[0].user, 'ada');

  /* Who has been asked and has not answered — people and teams apart. */
  assert.deepEqual(stood.requested, ['dee']);
  assert.deepEqual(stood.requestedTeams, ['platform']);

  /* One blocker outweighs any number of approvals. */
  assert.equal(blocked.approved, false);
  assert.equal(blocked.state, 'changes requested');
  assert.deepEqual(blocked.blockers, ['eve']);
  assert.equal(blocked.approvals, 1, 'ada still approved; she is just outvoted by a block');
});

test('github buildStatus asks again with the classic token where the fine-grained one drew a 403', async () => {
  const url = new URL(`../../plugins/github/github.js`, import.meta.url);
  const { default: Github } = await import(url.href);

  const withSettings = (settings) => {
    const plugin = Object.create(Github.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    return plugin.functions().find((one) => one.name === 'buildStatus');
  };

  const green = { status: 200, headers: {}, body: '{}', json: { state: 'success', sha: 'abc', statuses: [{ context: 'ci', state: 'success' }] } };
  const runs = { status: 200, headers: {}, body: '{}', json: { check_runs: [] } };
  const refused = { status: 403, headers: {}, body: '{}', json: { message: 'Resource not accessible by personal access token' } };

  /* Which token each request carried, in the order they were made. */
  const carried = () => asked.map((one) => `${one.headers.authorization} ${one.url.split('/').slice(-1)[0]}`);
  let asked = [];
  const door = globalThis.orknux.http.request;
  try {
    /*
     * The status endpoint refuses the fine-grained token and the check runs
     * do not: only the refused read is asked again, and under the classic
     * token.
     */
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      if (what.url.endsWith('/status')) {
        return what.headers.authorization === 'Bearer ghp_classic' ? green : refused;
      }
      return runs;
    };
    const built = withSettings({ token: 'github_pat_fine', classicToken: 'ghp_classic', organization: 'acme' }).run(
      '',
      'api',
      'abc',
    );
    assert.equal(built.overall, 'success');
    assert.equal(built.sha, 'abc');
    assert.deepEqual(carried(), [
      'Bearer github_pat_fine status',
      'Bearer ghp_classic status',
      'Bearer github_pat_fine check-runs?per_page=100',
    ]);

    /* Without a classic token, the 403 is the error it always was — and no second request. */
    asked = [];
    assert.throws(
      () => withSettings({ token: 'github_pat_fine', organization: 'acme' }).run('', 'api', 'abc'),
      /GitHub answered 403: Resource not accessible by personal access token for \/repos\/acme\/api\/commits\/abc\/status/,
    );
    assert.deepEqual(carried(), ['Bearer github_pat_fine status']);

    /* A classic token refused too is a 403 reported once, from the second try. */
    asked = [];
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      return what.url.endsWith('/status') ? refused : runs;
    };
    assert.throws(
      () => withSettings({ token: 'github_pat_fine', classicToken: 'ghp_classic', organization: 'acme' }).run('', 'api', 'abc'),
      /GitHub answered 403/,
    );
    assert.deepEqual(carried(), ['Bearer github_pat_fine status', 'Bearer ghp_classic status']);

    /*
     * A 404 falls back too: GitHub answers it, not a 403, to a fine-grained
     * token an organization has not approved, which is the setup the classic
     * token exists for. Here the classic token reads the status, and the
     * check runs were never refused.
     */
    asked = [];
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      if (what.url.endsWith('/status')) {
        return what.headers.authorization === 'Bearer ghp_classic'
          ? green
          : { status: 404, headers: {}, body: '{}', json: { message: 'Not Found' } };
      }
      return runs;
    };
    const unseen = withSettings({ token: 'github_pat_fine', classicToken: 'ghp_classic', organization: 'acme' }).run('', 'api', 'abc');
    assert.equal(unseen.overall, 'success');
    assert.deepEqual(carried(), [
      'Bearer github_pat_fine status',
      'Bearer ghp_classic status',
      'Bearer github_pat_fine check-runs?per_page=100',
    ]);

    /* A repository that is really not there is a 404 from both, reported once. */
    asked = [];
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      return { status: 404, headers: {}, body: '{}', json: { message: 'Not Found' } };
    };
    assert.throws(
      () => withSettings({ token: 'github_pat_fine', classicToken: 'ghp_classic', organization: 'acme' }).run('', 'api', 'abc'),
      /GitHub answered 404: Not Found for \/repos\/acme\/api\/commits\/abc\/status/,
    );
    assert.deepEqual(carried(), ['Bearer github_pat_fine status', 'Bearer ghp_classic status']);

    /* And a fine-grained token that reads builds fine never sends the classic one at all. */
    asked = [];
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      return what.url.endsWith('/status') ? green : runs;
    };
    withSettings({ token: 'github_pat_fine', classicToken: 'ghp_classic', organization: 'acme' }).run('', 'api', 'abc');
    assert.ok(asked.every((one) => one.headers.authorization === 'Bearer github_pat_fine'));
  } finally {
    globalThis.orknux.http.request = door;
  }
});

test('a github api call without a token is a thrown sentence, not a request', async () => {
  /*
   * The token is optional at load so the webhook half can stand alone — which
   * makes "unset but called" a case every API function has to answer well:
   * with the parameter's name, before anything reaches for the network.
   */
  const url = new URL(`../../plugins/github/github.js`, import.meta.url);
  const { default: Github } = await import(url.href);
  const declared = new Github().functions().find((one) => one.name === 'searchPulls');

  assert.throws(() => declared.run('anything', 0), /token parameter is not set/);
});

test('the slack plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('slack'));

  assert.equal(inspected.id, 'slack');
  assert.deepEqual(validate(inspected), []);

  /* A connection parameter: answered by pointing at a row, never typed in. */
  assert.equal(inspected.parameters.length, 3);
  assert.equal(inspected.parameters[0].name, 'slack');
  assert.equal(inspected.parameters[0].type, 'connection');
  assert.equal(inspected.parameters[0].connectionType, 'SLACK');
  assert.equal(inspected.parameters[0].required, false);
  /*
   * Two tokens, because Slack needs two: a bot token uploads files as the bot,
   * and search will not answer to one at all. Both secret, both optional — a
   * workspace that only reads and posts sets neither.
   */
  assert.equal(inspected.parameters[1].name, 'botToken');
  assert.equal(inspected.parameters[1].secret, true);
  assert.equal(inspected.parameters[1].required, false);
  assert.equal(inspected.parameters[2].name, 'userToken');
  assert.equal(inspected.parameters[2].secret, true);
  assert.equal(inspected.parameters[2].required, false);

  assert.deepEqual(inspected.permissions, ['TEXT_ENCODING']);
  assert.deepEqual(inspected.capabilities, [
    'SLACK_READ_THREAD',
    'SLACK_READ_MESSAGE',
    'SLACK_READ_USER',
    'SLACK_MENTION',
    'SLACK_POST_MESSAGE',
    'SLACK_ADD_REACTION',
    'SLACK_SEARCH',
    'SLACK_SUGGEST',
    'NETWORK_REQUEST',
  ]);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    [
      'isFirstReply',
      'readMessage',
      'whoIs',
      'findChannels',
      'listThreads',
      'findUsers',
      'readThread',
      'post',
      'react',
      'search',
      'findRecent',
      'mention',
      'upload',
      'uploadBinary',
      'uploadFromUrl',
      'remoteFile',
      'listAttachments',
      'readAttachment',
    ],
  );

  /*
   * The agents' surface: every call the plugin wraps, each an
   * OrknuxFunctionTool the inspection resolved — so every tool carries its
   * function's own params, return type and description, and `isFirstReply`
   * stays a workflow's gate.
   */
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    [
      'readMessage',
      'whoIs',
      'findUsers',
      'findChannels',
      'listThreads',
      'mention',
      'readThread',
      'post',
      'react',
      'search',
      'findRecent',
      'upload',
      'uploadBinary',
      'uploadFromUrl',
      'remoteFile',
      'listAttachments',
      'readAttachment',
    ],
  );
  for (const declared of inspected.tools) {
    /*
     * Every one is its function, with a single deliberate exception: the
     * agents' uploadBinary is a tool of its own so that it can have no base64
     * argument at all. A model has a key every time — everything that makes
     * bytes answers one — and an argument it should never fill is an argument
     * that should not be in front of it. A workflow node has no session and so
     * never had a key, which is why the function this does not proxy keeps
     * taking bytes.
     */
    if (declared.name === 'uploadBinary') {
      assert.equal(declared.proxyOf, null, 'the agents\' uploadBinary is its own tool');
      assert.deepEqual(
        declared.params.map((param) => param.name),
        ['channel', 'filename', 'contentKey', 'comment', 'threadTs'],
      );
      continue;
    }
    /*
     * And the second: readAttachment answers a model the key for a file's
     * bytes rather than the base64 itself, for the same reason - what crosses
     * to a model should be what a model can use. Its arguments are the
     * function's; only the answer differs, which is why it cannot be a proxy.
     */
    /*
     * And the third: `post` takes an attachment as a map, and one of those
     * could carry base64 - the last way bytes could be typed into a call by a
     * model. Its tool refuses that and names contentKey instead; the function
     * still takes bytes, for the workflow node with no session to have kept
     * them in.
     */
    if (declared.name === 'post') {
      assert.equal(declared.proxyOf, null, "the agents' post is its own tool");
      const behind = inspected.functions.find((one) => one.name === 'post');
      assert.deepEqual(declared.params, behind.params, 'taking the same arguments');
      continue;
    }
    if (declared.name === 'readAttachment') {
      assert.equal(declared.proxyOf, null, "the agents' readAttachment is its own tool");
      const behind = inspected.functions.find((one) => one.name === 'readAttachment');
      assert.deepEqual(declared.params, behind.params, 'taking the same argument');
      assert.equal(declared.returnType, behind.returnType, 'and answering the same shape');
      continue;
    }
    assert.equal(declared.proxyOf, declared.name);
    const fronted = inspected.functions.find((one) => one.name === declared.proxyOf);
    assert.deepEqual(declared.params, fronted.params);
    assert.equal(declared.returnType, fronted.returnType);
    assert.equal(declared.description, fronted.description);
  }

  /* And the function it does not proxy still takes bytes, for the caller that has them. */
  const bytes = inspected.functions.find((one) => one.name === 'uploadBinary');
  assert.ok(
    bytes.params.some((param) => param.name === 'base64'),
    'the workflow surface keeps its base64',
  );
});

test('post writes mrkdwn, and leaves alone what already was', async () => {
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);
  const post = new Slack().functions().find((one) => one.name === 'post').run;

  /* The one call this plugin makes, stood in for, so the text can be read. */
  const slack = globalThis.orknux.slack;
  let sent = null;
  globalThis.orknux.slack = {
    post: (connection, channel, text) => {
      sent = text;
      return { channel: channel, ts: '1' };
    },
  };

  try {
    const say = (text) => {
      post('c', 'C1', text, '', []);
      return sent;
    };

    /*
     * The five shapes that are never valid mrkdwn. Slack shows each of these
     * as the punctuation it is, and whatever wrote the message cannot see it
     * afterwards - which is why this happens on the way out rather than being
     * somebody's job to remember.
     */
    assert.equal(say('**bold**'), '*bold*');
    assert.equal(say('~~gone~~'), '~gone~');
    assert.equal(say('[text](https://x.com)'), '<https://x.com|text>');
    assert.equal(say('# Heading'), '*Heading*');
    assert.equal(say('*  item'), '•  item');
    assert.equal(say('- item'), '•  item');
    assert.equal(say('***very***'), '*_very_*');

    /*
     * And the property the whole design rests on: a single asterisk is bold in
     * mrkdwn and a single underscore is italic, so text that was already right
     * has to come through untouched. Converting those would break the messages
     * that needed no fixing, which is worse than the fault being fixed.
     */
    for (const already of [
      '*bold* and _italic_ and ~struck~',
      '<https://x.com|a link>',
      'a * b * c',
      '2 * 3 = 6',
    ]) {
      assert.equal(say(already), already, `left alone: ${already}`);
    }

    /* Code says what it says: a message about **bold** still reads **bold**. */
    assert.equal(say('Write `**bold**` for bold.'), 'Write `**bold**` for bold.');
    assert.equal(say('```\n**kept**\n```'), '```\n**kept**\n```');

    /* The whole of the message from the channel that prompted this. */
    assert.equal(
      say('I found:\n*  **orknux-extension**: Plugins and SDK\n*  **orknux-ui**'),
      'I found:\n•  *orknux-extension*: Plugins and SDK\n•  *orknux-ui*',
    );

    /*
     * What came with the markdown plugin's converter when it moved in here:
     * the shapes mrkdwn has no spelling for, and the parking that keeps a URL
     * and a code span out of the emphasis pass.
     */
    assert.equal(say('![a chart](https://x.example/c.png)'), '<https://x.example/c.png|a chart>');
    assert.equal(say('1. one\n2. two'), '1.  one\n2.  two');
    assert.equal(say('| a | b |\n|---|---|\n| 1 | 2 |'), 'a  b\n1  2');
    assert.equal(say('---'), '──────────');
    assert.equal(say('**bold with `code` inside**'), '*bold with `code` inside*');
    assert.equal(say('# A **bold** heading'), '*A *bold* heading*');
    assert.equal(say('```js\nconst a = 1;\n```'), '```\nconst a = 1;\n```');

    /*
     * And what could not come with it. That converter escaped every `<` and
     * `>` it found, because nothing reaching it was ever Slack's own. Here a
     * mention is a person `mention` just answered, a channel reference is a
     * channel, and `>` at the start of a line is the blockquote the posting
     * skill tells a model to use - so Slack's own markup is parked before the
     * escaping, and `>` is not escaped at all.
     */
    assert.equal(say('ask <@U0123ABCD> in <#C0123|general>'), 'ask <@U0123ABCD> in <#C0123|general>');
    assert.equal(say('<!here> the build is red'), '<!here> the build is red');
    assert.equal(say('> why did it fail?\n\nA timeout.'), '> why did it fail?\n\nA timeout.');
    /* Text still cannot become markup: an unmatched `<` is escaped. */
    assert.equal(say('a < b & c'), 'a &lt; b &amp; c');
    assert.equal(say('already &lt;escaped&gt;'), 'already &lt;escaped&gt;');

    /*
     * The fault this was moved here to fix: a message whose line breaks
     * arrived as the two characters `\` and `n`, which lands on one line with
     * the quote and the bold showing as punctuation.
     */
    assert.equal(
      say('*Using my friend*\\n\\n> why did you not use your friend?\\n\\nI managed it alone.'),
      '*Using my friend*\n\n> why did you not use your friend?\n\nI managed it alone.',
    );
    /* One line and one escape is the same fault, so it is repaired too. */
    assert.equal(say('first\\nsecond'), 'first\nsecond');
    /* But a sentence about the escape, written in code, is left as it is. */
    assert.equal(
      say('Use `\\n` for a line break.\nThat is what it is for.'),
      'Use `\\n` for a line break.\nThat is what it is for.',
    );
  } finally {
    globalThis.orknux.slack = slack;
  }
});

test('the agents post refuses an attachment carrying bytes', async () => {
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);
  const made = new Slack();
  const tool = made.tools().find((one) => one.name === 'post' && one.run !== undefined);
  const behind = made.functions().find((one) => one.name === 'post');

  /*
   * The refusal names the fix, because a model reads it at the moment it
   * matters - which a description, read once at the top, does not manage.
   */
  assert.throws(
    () => tool.run('', 'C1', 'hi', '', [{ filename: 'a.png', base64: 'UE5H' }]),
    /cannot carry base64 here: pass contentKey/,
  );

  /*
   * A key gets past it and reaches the token check, which is as far as
   * anything gets here without a Slack to talk to. The function takes the
   * bytes it refuses, and reaches the same place.
   */
  assert.throws(
    () => tool.run('', 'C1', 'hi', '', [{ filename: 'a.png', contentKey: 'k' }]),
    /nothing is kept under k in this session/,
    'a key goes down the key path, and says so when it names nothing',
  );

  /* And the function takes the bytes its tool refuses, reaching the token check. */
  assert.throws(
    () => behind.run('', 'C1', 'hi', '', [{ filename: 'a.png', base64: 'UE5H' }]),
    /botToken parameter is not set/,
    'the workflow surface still carries bytes',
  );
});

test('the agents uploadBinary takes a key and has nowhere to put bytes', async () => {
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);
  const made = new Slack();
  const tool = made.tools().find((one) => one.name === 'uploadBinary' && one.run !== undefined);

  /* Nothing named, nothing to upload — and the sentence says what to do instead. */
  assert.throws(
    () => tool.run('C1', 'report.pdf', '', 'here', ''),
    /takes a contentKey, not bytes/,
  );

  /* A key naming nothing is a session that has moved on, not a missing argument. */
  assert.throws(
    () => tool.run('C1', 'report.pdf', 'pdf.nothing', 'here', ''),
    /nothing is kept under pdf.nothing/,
  );

  /*
   * And with something kept under it, the key resolves and the upload is
   * attempted — reaching the token check, which is as far as anything gets
   * without a Slack to talk to.
   */
  const held = new Map([['pdf.abc', 'UE5H']]);
  const store = globalThis.orknux.session.store;
  globalThis.orknux.session.store = {
    put: () => ({ ok: true }),
    get: (key) => (held.has(key) ? held.get(key) : null),
  };
  try {
    assert.throws(
      () => tool.run('C1', 'report.pdf', 'pdf.abc', 'here', ''),
      /botToken parameter is not set/,
      'the key resolved and the upload was attempted',
    );
  } finally {
    globalThis.orknux.session.store = store;
  }
});

test('readAttachment answers a key beside what it read', async () => {
  const inspected = await inspect(shipped('slack'));
  const shape = inspected.objects.find((one) => one.name === 'AttachmentContent');

  /*
   * Both halves of the answer can be handed straight on - text to `upload` as
   * its contentKey, bytes to `uploadBinary` as the only thing that one takes -
   * so reading a PDF out of one thread and putting it in another channel costs
   * nobody a retyped kilobyte.
   */
  assert.deepEqual(
    shape.properties.map((property) => property.name),
    ['name', 'mimetype', 'size', 'content', 'base64', 'key'],
  );

  /*
   * Two things here are not reachable from a test, for one reason: every path
   * past the token check needs `this.settings`, and the contract's own
   * fallback freezes those empty and non-configurable on purpose. So neither
   * how the branches fill this answer, nor how the agents' tool strips the
   * base64 out of it, can be driven from here - the tool closes over its own
   * declaration, so there is nothing to stand in for either. What a test can
   * hold is the shape above, the declaration in the loop further up, and the
   * refusal below.
   */
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);
  const read = new Slack().functions().find((one) => one.name === 'readAttachment').run;
  assert.throws(() => read('F1'), /botToken parameter is not set/);
});

test('the makers of bytes answer their agents a key, not the bytes', async () => {
  /*
   * An answer reaches a model by being read, every character of it. A rendered
   * diagram is four thousand characters and a PDF is three hundred thousand,
   * all of it read on the way to a key a dozen characters long naming the very
   * same bytes on the server — so each of these three has a tool of its own
   * that answers the key and leaves the bytes where they are.
   *
   * The function is untouched, because a workflow node has no session to read
   * a key from and the bytes in its answer are all it will ever get.
   */
  const store = globalThis.orknux.session.store;
  const render = globalThis.orknux.render;
  const held = new Map();
  let inSession = true;
  globalThis.orknux.session.store = {
    put: (key, value) => {
      if (!inSession) return { error: 'there is no session store here' };
      held.set(key, value);
      return { ok: true };
    },
    get: (key) => (held.has(key) ? held.get(key) : null),
  };
  /* The rasteriser is the server's; out here it is whatever this says it is. */
  globalThis.orknux.render = { pngFromSvg: () => ({ base64: 'UE5H'.repeat(500), bytes: 1500 }) };

  try {
    const cases = [
      { plugin: 'mermaid', call: 'render', args: ['graph TD\n  A-->B', '', 'svg', 0], payload: 'svg' },
      { plugin: 'nomnoml', call: 'render', args: ['[a] -> [b]', '', '', 'svg', 0], payload: 'svg' },
      {
        plugin: 'charts',
        call: 'render',
        args: ['{"type":"column","labels":["a","b"],"values":[1,2]}', '', 'svg', 0],
        payload: 'svg',
      },
      /*
       * Not compared across two runs: jsPDF stamps a creation date into the
       * file, so the same html twice is not the same bytes and not the same
       * key. That is a fact about PDFs rather than a fault here.
       */
      { plugin: 'pdf', call: 'fromHtml', args: ['<h1>Q3</h1>', ''], payload: 'base64', stamped: true },
    ];

    for (const { plugin, call, args, payload, stamped } of cases) {
      const url = new URL(`../../plugins/${plugin}/${plugin}.js`, import.meta.url);
      const { default: Plugin } = await import(url.href);
      const made = new Plugin();
      const declared = made.functions().find((one) => one.name === call);
      const tool = made.tools().find((one) => one.name === call && one.run !== undefined);

      assert.ok(tool, `${plugin}: ${call} is a tool of its own, not a proxy`);
      assert.deepEqual(tool.params, declared.params, `${plugin}: same arguments either way`);
      assert.equal(tool.returnType, declared.returnType, `${plugin}: same shape either way`);

      inSession = true;
      held.clear();
      const answered = declared.run(...args);
      const asked = tool.run(...args);

      assert.ok(answered[payload].length > 0, `${plugin}: the function answers the bytes`);
      assert.equal(asked[payload], '', `${plugin}: the tool does not`);
      assert.ok(asked.key.startsWith(`${plugin}.`), `${plugin}: and names them instead`);
      assert.ok(held.get(asked.key).length > 0, `${plugin}: and the store holds what it names`);
      if (stamped !== true) {
        assert.equal(
          held.get(asked.key).length,
          answered[payload].length,
          `${plugin}: what the key names is the whole of it`,
        );
      }
      /* Everything that is not the payload survives — the counts, the links. */
      assert.equal(asked.bytes, answered.bytes, `${plugin}: the size is still answered`);

      /*
       * And where there is nowhere to keep it, the bytes come back: a key that
       * names nothing plus no bytes would be an answer to nothing at all.
       */
      inSession = false;
      held.clear();
      const outside = tool.run(...args);
      assert.equal(outside.key, '', `${plugin}: no session, no key`);
      assert.ok(outside[payload].length > 0, `${plugin}: so the bytes are the answer`);
    }
  } finally {
    globalThis.orknux.session.store = store;
    globalThis.orknux.render = render;
  }
});

test('web declares searchImages beside search', async () => {
  const inspected = await inspect(shipped('web'));

  assert.deepEqual(
    inspected.functions.map((one) => one.name),
    ['searchImages', 'search'],
  );
  assert.deepEqual(
    inspected.tools.map((one) => one.name),
    ['search', 'searchImages'],
  );

  /* A picture, and where it came from, so a caller can credit it. */
  const image = inspected.objects.find((one) => one.name === 'Image');
  assert.deepEqual(
    image.properties.map((one) => one.name),
    ['url', 'title', 'source', 'thumbnail'],
  );
  const found = inspected.objects.find((one) => one.name === 'ImageSearch');
  assert.deepEqual(
    found.properties.map((one) => one.name),
    ['backend', 'query', 'images'],
  );

  const url = new URL(`../../plugins/web/web.js`, import.meta.url);
  const { default: Web } = await import(url.href);
  const images = new Web().functions().find((one) => one.name === 'searchImages').run;

  /*
   * Which backend answers, and with what key, is not reachable from here:
   * both come off `this.settings`, and the contract's own fallback freezes
   * those empty and non-extensible on purpose - a plugin being asked what it
   * is has no settings yet. So what a test can hold is the declaration above
   * and the two refusals below; how Brave's and Tavily's answers are read is
   * the sandbox's to prove.
   */
  assert.throws(() => images('   ', 1), /nothing to search for/);
  assert.throws(() => images('anything', 1), /backend parameter is not set/);
});

test('the teams plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('teams'));

  assert.equal(inspected.id, 'teams');
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['webhookSecret', 'webhookName'],
  );
  assert.equal(inspected.parameters[0].secret, true);
  /* It asks for nothing at all — the hashing is written out so that holds. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, []);
  assert.deepEqual(inspected.tools, []);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['verify', 'text', 'sender', 'message', 'channelUrl', 'replyUrl'],
  );
});

test('slack finds channels, and lists the threads inside one', async () => {
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);

  const plugin = Object.create(Slack.prototype);
  Object.defineProperty(plugin, 'settings', { value: Object.freeze({ botToken: 'xoxb-t' }) });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  const channels = [
    {
      id: 'C1',
      name: 'deploys',
      is_private: false,
      is_member: true,
      num_members: 40,
      topic: { value: 'releases and rollbacks' },
      purpose: { value: '' },
    },
    { id: 'C2', name: 'random', is_private: false, is_member: false, num_members: 120, purpose: { value: 'nonsense' } },
    {
      id: 'C3',
      name: 'platform-private',
      is_private: true,
      is_member: false,
      num_members: 8,
      purpose: { value: 'deploy policy' },
    },
  ];

  /* A channel's history: two threads, one plain message, one bot noise. */
  const history = {
    ok: true,
    has_more: false,
    messages: [
      {
        ts: '1700000100.000100',
        user: 'U1',
        text: 'rollback failed on prod',
        reply_count: 4,
        reply_users_count: 3,
        latest_reply: '1700009000.000100',
      },
      { ts: '1700000200.000100', user: 'U2', text: 'anybody around?' },
      {
        ts: '1700000300.000100',
        user: 'U2',
        text: 'release notes?',
        reply_count: 1,
        reply_users_count: 1,
        latest_reply: '1700000400.000100',
      },
      { ts: '1700000050.000100', user: 'U3', text: 'has joined the channel', subtype: 'channel_join' },
    ],
  };

  const asked = [];
  const door = globalThis.orknux.http.request;
  const user_ = globalThis.orknux.slack.user;
  let found;
  let listing;
  let threads;
  let exact;
  let before;
  let refused;
  try {
    globalThis.orknux.slack.user = (_connection, id) =>
      ({ U1: { displayName: 'Ada' }, U2: { displayName: 'Bob' } })[id] ?? { error: 'user_not_found' };
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      const method = what.url.slice('https://slack.com/api/'.length);
      if (method === 'auth.test') {
        return { status: 200, headers: {}, body: '{}', json: { ok: true, url: 'https://acme.slack.com/' } };
      }
      if (method === 'conversations.list') {
        return { status: 200, headers: {}, body: '{}', json: { ok: true, channels: channels } };
      }
      if (method === 'users.conversations') {
        /* The bot's own channels, which Slack answers as whole conversations. */
        return { status: 200, headers: {}, body: '{}', json: { ok: true, channels: [channels[0]] } };
      }
      return { status: 200, headers: {}, body: '{}', json: history };
    };

    found = call('findChannels').run('deploy', 20, false);
    listing = call('findChannels').run('', 20, false);
    before = asked.length;
    exact = call('findChannels').run('#deploys', 20, false);
    threads = call('listThreads').run('#deploys', 7, 20, true);
    try {
      call('listThreads').run('random', 7, 20, true);
    } catch (thrown) {
      refused = thrown.message;
    }
  } finally {
    globalThis.orknux.http.request = door;
    globalThis.orknux.slack.user = user_;
  }

  /*
   * Matched on name, topic and purpose alike - "deploys" by its name, the
   * private one by what it says it is for. Archived channels are left out
   * unless asked for.
   */
  assert.deepEqual(
    found.channels.map((one) => one.name),
    ['deploys', 'platform-private'],
  );
  /*
   * The bot's own channels are read first and the workspace's after, because
   * a channel somebody added the bot to is always in the first list and that
   * list is short - a workspace with nine thousand channels answers the
   * directory thirty-seven at a time.
   */
  assert.equal(asked[1].url, 'https://slack.com/api/users.conversations');
  assert.equal(asked[2].url, 'https://slack.com/api/conversations.list');
  assert.match(asked[2].body, /exclude_archived=true/);
  assert.match(asked[2].body, /limit=1000/);

  /*
   * `member` is the field that decides what else can be done with a channel:
   * findRecent and listThreads read what the bot was invited to, and nothing
   * about a scope changes that.
   */
  assert.equal(found.channels[0].member, true);
  assert.equal(found.channels[1].member, false);
  assert.equal(found.channels[1].private, true);
  assert.equal(found.channels[0].url, 'https://acme.slack.com/archives/C1');
  assert.equal(found.channels[0].members, 40);

  /* An empty query is a listing, which is the same search with nothing to match. */
  assert.equal(listing.channels.length, 3);
  assert.equal(listing.complete, true);

  /*
   * A thread is a message that has been replied to - Slack writes the count
   * on the parent and nowhere else. The plain message and the join noise are
   * not threads.
   */
  assert.equal(threads.total, 2);
  assert.equal(threads.messages, 4);

  /* Newest *activity* first: the one answered hours later leads. */
  assert.deepEqual(
    threads.threads.map((one) => one.text),
    ['rollback failed on prod', 'release notes?'],
  );
  assert.equal(threads.threads[0].replies, 4);
  assert.equal(threads.threads[0].repliers, 3);
  assert.equal(threads.threads[0].ts, '1700000100.000100', 'the ts is what readThread takes');
  assert.equal(threads.threads[0].permalink, 'https://acme.slack.com/archives/C1/p1700000100000100');
  assert.match(threads.threads[0].started, /^2023-11-/);

  /* And the authors are people, the same way a thread reads as people. */
  assert.deepEqual(
    threads.threads.map((one) => one.userName),
    ['Ada', 'Bob'],
  );

  /*
   * An exact name among the bot's own channels is the answer, and reading
   * nine thousand more to confirm it would be the whole bug again.
   */
  assert.deepEqual(
    exact.channels.map((one) => one.name),
    ['deploys'],
  );
  assert.equal(exact.complete, true);
  assert.ok(
    !asked.slice(before).some((one) => one.url.endsWith('conversations.list')),
    'an exact name among the bot own channels should not walk the directory',
  );

  /* The fence again: a channel the bot is not in is refused by name. */
  assert.match(refused, /the bot is not in random/);
  assert.throws(() => call('listThreads').run('  ', 7, 20, true), /no channel to look in/);
});

test('slack finds people by email exactly, and by name through the directory', async () => {
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);

  const plugin = Object.create(Slack.prototype);
  Object.defineProperty(plugin, 'settings', { value: Object.freeze({ botToken: 'xoxb-t' }) });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  const ada = {
    id: 'U1',
    name: 'ada',
    deleted: false,
    is_bot: false,
    profile: { real_name: 'Ada Lovelace', display_name: 'Ada', email: 'ada@acme.com' },
  };
  const pages = [
    {
      ok: true,
      members: [
        ada,
        { id: 'U2', name: 'bob', profile: { real_name: 'Bob Adams', display_name: '' } },
        { id: 'U3', name: 'gone', deleted: true, profile: { real_name: 'Ada Ghost' } },
      ],
      response_metadata: { next_cursor: 'PAGE2' },
    },
    {
      ok: true,
      members: [{ id: 'U4', name: 'lovelace2', profile: { real_name: 'Ada Lovelace', display_name: 'Ada L' } }],
      response_metadata: { next_cursor: '' },
    },
  ];

  const asked = [];
  const door = globalThis.orknux.http.request;
  let byEmail;
  let missing;
  let byName;
  let narrow;
  try {
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      const method = what.url.slice('https://slack.com/api/'.length);
      if (method === 'users.lookupByEmail') {
        return what.body.includes('ada%40acme.com')
          ? { status: 200, headers: {}, body: '{}', json: { ok: true, user: ada } }
          : { status: 200, headers: {}, body: '{}', json: { ok: false, error: 'users_not_found' } };
      }
      const page = what.body.includes('cursor=PAGE2') ? pages[1] : pages[0];
      return { status: 200, headers: {}, body: '{}', json: page };
    };

    byEmail = call('findUsers').run('ada@acme.com', 10);
    missing = call('findUsers').run('nobody@acme.com', 10);
    byName = call('findUsers').run('ada lovelace', 10);
    narrow = call('findUsers').run('ada', 1);
  } finally {
    globalThis.orknux.http.request = door;
  }

  /*
   * An address is an exact question with an exact answer - one request, not a
   * walk through everybody. Reading the directory to find what Slack can look
   * up directly would be a hundred times the work for the same person.
   */
  assert.equal(asked[0].url, 'https://slack.com/api/users.lookupByEmail');
  assert.equal(byEmail.users.length, 1);
  assert.equal(byEmail.users[0].email, 'ada@acme.com');
  assert.equal(byEmail.read, 1);
  assert.equal(byEmail.complete, true);

  /* Nobody at that address is an answer, not a failure. */
  assert.deepEqual(missing.users, []);
  assert.equal(missing.total, 0);

  /*
   * A name has no exact call behind it: Slack gives a bot no user search at
   * all, so it is users.list and a filter, paged to the end.
   */
  assert.equal(asked[2].url, 'https://slack.com/api/users.list');
  assert.match(asked[3].body, /cursor=PAGE2/);
  assert.deepEqual(
    byName.users.map((one) => one.id),
    ['U1', 'U4'],
    'both Ada Lovelaces should match across two pages',
  );
  /* Bob Adams carries "ada" inside his surname and neither of the other words. */
  assert.equal(byName.total, 2);
  assert.equal(byName.complete, true);
  assert.equal(byName.read, 4, 'every account read counts, deactivated ones included');

  /* A deactivated account is not somebody to find. */
  assert.ok(!byName.users.some((one) => one.id === 'U3'));

  /* An empty display name is null rather than the empty string Slack writes. */
  assert.equal(byName.users[0].displayName, 'Ada');
  assert.equal(byName.users[1].displayName, 'Ada L');

  /* One word matches more, and a limit says how many there were. */
  assert.equal(narrow.users.length, 1);
  assert.equal(narrow.total, 3, 'ada, Bob Adams and the second Lovelace all carry "ada"');

  assert.throws(() => call('findUsers').run('   ', 10), /nobody to look for/);
});

test('slack reads a thread as people, and looks each of them up once', async () => {
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);

  const plugin = Object.create(Slack.prototype);
  Object.defineProperty(plugin, 'settings', { value: Object.freeze({ slack: 'C-DEFAULT' }) });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  /* Four messages, three of them from the same person. */
  const thread = {
    replies: 4,
    messages: [
      { ts: '1700000000.000100', user: 'U1', text: 'the deploy is stuck', parent: true },
      { ts: '1700000100.000100', user: 'U2', text: 'looking now' },
      { ts: '1700000200.000100', user: 'U1', text: 'thanks' },
      { ts: '1700000300.000100', user: 'U1', text: 'still stuck' },
    ],
  };
  const people = {
    U1: { id: 'U1', name: 'ada', realName: 'Ada Lovelace', displayName: 'Ada', bot: false },
    U2: { id: 'U2', name: 'bot', realName: 'Deploy Bot', displayName: '', bot: true },
  };

  const looked = [];
  const thread_ = globalThis.orknux.slack.thread;
  const user_ = globalThis.orknux.slack.user;
  let read;
  let bare;
  try {
    globalThis.orknux.slack.thread = () => thread;
    globalThis.orknux.slack.user = (_connection, id) => {
      looked.push(id);
      return people[id] ?? { error: 'user_not_found' };
    };

    read = call('readThread').run('', 'C1', '1700000000.000100', 20, true);
    bare = call('readThread').run('', 'C1', '1700000000.000100', 20, false);
  } finally {
    globalThis.orknux.slack.thread = thread_;
    globalThis.orknux.slack.user = user_;
  }

  /*
   * Three messages from Ada cost one lookup, not three. Slack writes the id
   * on every message and the same id is the same person all day, so the
   * saving is the whole reason this belongs in the plugin rather than in
   * whatever is reading the thread.
   */
  assert.deepEqual(looked, ['U1', 'U2']);

  assert.deepEqual(
    read.messages.map((one) => one.userName),
    ['Ada', 'Deploy Bot', 'Ada', 'Ada'],
  );
  /* A display name where there is one, the real name where there is not. */
  assert.equal(read.messages[1].userName, 'Deploy Bot');

  /* The id is still there beside it, and everything else the thread said. */
  assert.equal(read.messages[0].user, 'U1');
  assert.equal(read.messages[0].text, 'the deploy is stuck');
  assert.equal(read.replies, 4);

  /* Off, and the field is null rather than missing - one shape either way. */
  assert.deepEqual(
    bare.messages.map((one) => one.userName),
    [null, null, null, null],
  );
  assert.equal(looked.length, 2, 'withNames: false still looked somebody up');
});

test('slack findRecent reads what the bot was invited to, and nothing else', async () => {
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);

  const plugin = Object.create(Slack.prototype);
  Object.defineProperty(plugin, 'settings', { value: Object.freeze({ botToken: 'xoxb-t' }) });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  /*
   * Two channels the bot is in, one of them carrying the join noise a channel
   * keeps and a page that says there is more behind it.
   */
  const conversations = {
    ok: true,
    channels: [
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'random' },
    ],
  };
  const histories = {
    C1: {
      ok: true,
      has_more: true,
      messages: [
        { ts: '1700000100.000100', user: 'U1', text: 'the deploy to prod failed again' },
        { ts: '1700000000.000100', user: 'U2', text: 'deploy is green', subtype: undefined },
        { ts: '1699999000.000100', user: 'U3', text: 'has joined the channel', subtype: 'channel_join' },
      ],
    },
    C2: {
      ok: true,
      has_more: false,
      messages: [
        { ts: '1700000200.000100', user: 'U4', text: 'PROD deploy notes are in the doc' },
        { ts: '1700000050.000100', user: 'U5', text: 'lunch?' },
      ],
    },
  };

  const asked = [];
  const door = globalThis.orknux.http.request;
  let found;
  let refused;
  try {
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      const method = what.url.slice('https://slack.com/api/'.length);
      if (method === 'users.conversations') {
        return { status: 200, headers: {}, body: '{}', json: conversations };
      }
      if (method === 'auth.test') {
        return { status: 200, headers: {}, body: '{}', json: { ok: true, url: 'https://acme.slack.com/' } };
      }
      if (method === 'conversations.history') {
        const channel = /channel=([^&]+)/.exec(what.body)[1];
        return { status: 200, headers: {}, body: '{}', json: histories[channel] };
      }
      throw new Error(`the test was not expecting ${method}`);
    };

    found = call('findRecent').run('deploy prod', '', 7, 20);
    try {
      call('findRecent').run('deploy', '#nowhere', 7, 20);
    } catch (thrown) {
      refused = thrown.message;
    }
  } finally {
    globalThis.orknux.http.request = door;
  }

  /* The bot token, on the bot's own memberships — no connection, no user token. */
  assert.equal(asked[0].url, 'https://slack.com/api/users.conversations');
  assert.equal(asked[0].headers.authorization, 'Bearer xoxb-t');
  assert.match(asked[0].body, /types=public_channel%2Cprivate_channel/);

  /*
   * Every word, anywhere, in any order and whatever the capitals — so "deploy
   * prod" finds the message that says "PROD deploy notes" and leaves the one
   * that only says deploy alone. It is not Slack's search syntax and does not
   * pretend to be.
   */
  assert.deepEqual(
    found.matches.map((one) => one.text),
    ['PROD deploy notes are in the doc', 'the deploy to prod failed again'],
  );
  /* Newest first, across channels rather than within one. */
  assert.deepEqual(
    found.matches.map((one) => one.channelName),
    ['random', 'deploys'],
  );

  /* A permalink built from the workspace url rather than fetched per match. */
  assert.equal(found.matches[0].permalink, 'https://acme.slack.com/archives/C2/p1700000200000100');
  assert.equal(asked.filter((one) => one.url.endsWith('auth.test')).length, 1, 'the workspace url was fetched more than once');

  /* The join noise a channel keeps is not something anybody is searching for. */
  assert.equal(found.messages, 5);
  assert.equal(found.total, 2);
  assert.equal(found.channels, 2);

  /* A window with more behind it says so rather than reading as the whole story. */
  assert.equal(found.complete, false);
  assert.match(found.since, /^\d{4}-\d{2}-\d{2}T/);

  /* The window is what was asked for, and one page of it per channel. */
  const history = asked.find((one) => one.url.endsWith('conversations.history'));
  assert.match(history.body, /oldest=\d+/);
  assert.match(history.body, /limit=200/);

  /*
   * And the fence, which is the whole point of doing it this way: a channel
   * the bot was never invited to is not searched and not silently empty.
   */
  assert.match(refused, /the bot is not in #nowhere/);
  assert.throws(() => call('findRecent').run('   ', '', 7, 20), /nothing to look for/);
});

test('the confluence plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('confluence'));

  assert.equal(inspected.id, 'confluence');
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['url', 'email', 'token'],
  );
  /* The token is the one secret; the url and the email are plain settings. */
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.secret),
    [false, false, true],
  );
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.required),
    [true, false, true],
  );

  /* None: `orknux.encoding` turns the credential into base64, and is ungranted. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, ['NETWORK_REQUEST']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['search', 'openPage', 'openUser', 'findUsers'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['search', 'openPage', 'openUser', 'findUsers'],
  );
});

test('the confluence plugin reads a page id out of either spelling of a page url', async () => {
  const url = new URL(`../../plugins/confluence/confluence.js`, import.meta.url);
  const { default: Confluence } = await import(url.href);
  const declared = new Confluence().functions().find((one) => one.name === 'openPage');

  /*
   * Neither of these reaches the network: the Cloud and Server spellings are
   * resolved to an id first, and a string that is neither is refused there —
   * before, not after, a request would have gone out.
   */
  assert.throws(() => declared.run('not a page'), /not a page id or a page url/);
  assert.throws(
    () => declared.run('https://x.atlassian.net/wiki/spaces/DOC/pages/12345/T'),
    /url parameter is not set/,
  );
  assert.throws(
    () => declared.run('https://wiki.example.com/pages/viewpage.action?pageId=99'),
    /url parameter is not set/,
  );
});

test('confluence turns the ids a page mentions into people, on either deployment', async () => {
  const url = new URL(`../../plugins/confluence/confluence.js`, import.meta.url);
  const { default: Confluence } = await import(url.href);

  const configured = (settings) => {
    const plugin = Object.create(Confluence.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };

  const cloud = { url: 'https://acme.atlassian.net/wiki', email: 'ada@acme.com', token: 't' };
  const server = { url: 'https://wiki.acme.com', token: 't' };

  /*
   * A body as Confluence actually stores one: a mention is markup carrying an
   * id, not a name. Server writes `ri:userkey`, Cloud `ri:account-id`, and the
   * profile macro wraps an `ri:user` the same way - so all three are the same
   * question, which is who that is.
   */
  const body =
    '<p>Owner: <ac:link><ri:user ri:userkey="ff8080816f2b1c34016f2b1c34000001"/></ac:link></p>' +
    '<p>Backup: <ac:link><ri:user ri:userkey="ff8080816f2b1c34016f2b1c34000002"/></ac:link></p>' +
    '<p>See <ac:link><ri:user ri:userkey="ff8080816f2b1c34016f2b1c34000001"/></ac:link> again</p>';

  const asked = [];
  const door = globalThis.orknux.http.get;
  let page;
  let person;
  let onCloud;
  try {
    globalThis.orknux.http.get = (where) => {
      asked.push(where);
      if (where.includes('/rest/api/content/')) {
        return {
          status: 200,
          headers: {},
          body: '{}',
          json: { id: '123', title: 'Runbook', body: { storage: { value: body } }, _links: { webui: '/x' } },
        };
      }
      return {
        status: 200,
        headers: {},
        body: '{}',
        json: {
          type: 'known',
          username: 'jsmith',
          userKey: 'ff8080816f2b1c34016f2b1c34000001',
          displayName: 'Jo Smith',
          profilePicture: { path: '/images/jo.png' },
          _links: { base: 'https://wiki.acme.com' },
        },
      };
    };

    page = configured(server)('openPage').run('123');
    person = configured(server)('openUser').run(
      '<ac:link><ri:user ri:userkey="ff8080816f2b1c34016f2b1c34000001"/></ac:link>',
    );
    onCloud = configured(cloud)('openUser').run('5b10ac8d82e05b22cc7d4ef5');
  } finally {
    globalThis.orknux.http.get = door;
  }

  /*
   * The ids are read out of the markup rather than asked for - they are
   * already in the body - and each is listed once however often it is used.
   */
  assert.deepEqual(page.mentions, [
    'ff8080816f2b1c34016f2b1c34000001',
    'ff8080816f2b1c34016f2b1c34000002',
  ]);

  /* A userkey is Server's, and Server looks a person up by `key`. */
  assert.equal(asked[1], 'https://wiki.acme.com/rest/api/user?key=ff8080816f2b1c34016f2b1c34000001');
  assert.equal(person.name, 'Jo Smith');
  assert.equal(person.username, 'jsmith');
  assert.equal(person.id, 'ff8080816f2b1c34016f2b1c34000001');
  /* A url, under a name that says so - the field is not image content. */
  assert.equal(person.avatarUrl, 'https://wiki.acme.com/images/jo.png');
  assert.equal(person.url, 'https://wiki.acme.com/display/~jsmith');

  /* And a bare id on Cloud is an account id, because Cloud has nothing else. */
  assert.equal(asked[2], 'https://acme.atlassian.net/wiki/rest/api/user?accountId=5b10ac8d82e05b22cc7d4ef5');
  assert.equal(onCloud.external, false);

  /*
   * An avatar hangs off the site, not off the wiki. Cloud's `_links.base`
   * ends in `/wiki` and its avatar path *begins* with `/wiki`, so joining the
   * two the obvious way asked for `/wiki/wiki/aa-avatar/…` and got a 404.
   */
  const fetched = [];
  const held = globalThis.orknux.http.get;
  const bytes = globalThis.orknux.http.download;
  const session = globalThis.orknux.session;
  let withPicture;
  let refusedPicture;
  try {
    globalThis.orknux.http.get = () => ({
      status: 200,
      headers: {},
      body: '{}',
      json: {
        type: 'known',
        accountId: '5b10ac8d82e05b22cc7d4ef5',
        displayName: 'Ada Lovelace',
        profilePicture: { path: '/wiki/aa-avatar/5b10ac8d82e05b22cc7d4ef5' },
        _links: { base: 'https://acme.atlassian.net/wiki' },
      },
    });
    globalThis.orknux.http.download = (where, headers) => {
      fetched.push({ where, headers });
      return { status: 200, headers: {}, base64: 'aVZCT1J3MEtHZ28=', size: 11, contentType: 'image/png' };
    };
    globalThis.orknux.session = { store: { put: () => ({}), get: () => null } };

    withPicture = configured(cloud)('openUser').run('5b10ac8d82e05b22cc7d4ef5', true);

    /* And a refusal, which must not take the lookup down with it. */
    globalThis.orknux.http.download = () => ({ error: 'the avatar is not there' });
    refusedPicture = configured(cloud)('openUser').run('5b10ac8d82e05b22cc7d4ef5', true);
  } finally {
    globalThis.orknux.http.get = held;
    globalThis.orknux.http.download = bytes;
    globalThis.orknux.session = session;
  }

  assert.equal(withPicture.avatarUrl, 'https://acme.atlassian.net/wiki/aa-avatar/5b10ac8d82e05b22cc7d4ef5');
  assert.doesNotMatch(withPicture.avatarUrl, /wiki\/wiki/, 'the wiki path was doubled into the avatar url');

  /* Fetched with the wiki's own credential, because the avatar is behind it. */
  assert.equal(fetched[0].where, withPicture.avatarUrl);
  assert.match(fetched[0].headers.authorization, /^Basic /);
  assert.equal(withPicture.avatar, 'aVZCT1J3MEtHZ28=');
  assert.equal(withPicture.avatarType, 'image/png');
  assert.ok(withPicture.avatarKey.startsWith('confluence.'));

  /* An avatar is decoration; a lookup is not worth failing over one. */
  assert.equal(refusedPicture.avatar, null);
  assert.equal(refusedPicture.avatarType, null);
  assert.equal(refusedPicture.avatarKey, '');
  assert.equal(refusedPicture.name, 'Ada Lovelace');

  /* And nothing is fetched unless it was asked for. */
  assert.equal(person.avatar, null);
  assert.equal(person.avatarKey, '');

  /*
   * Searching by name, which is the one question an id cannot answer - and
   * the one place these two deployments part. Cloud has an endpoint for
   * finding people; Server asks the CQL search everything else goes through,
   * with `type=user` saying what it is looking for. Watched on the way out
   * rather than assumed, the way the jira plugin's own split is.
   */
  const searches = [];
  const searching = globalThis.orknux.http.get;
  let onServer;
  let byName;
  try {
    globalThis.orknux.http.get = (where) => {
      searches.push(where);
      return {
        status: 200,
        headers: {},
        body: '{}',
        json: {
          totalSize: 2,
          results: [
            {
              user: {
                type: 'known',
                accountId: '5b10ac8d82e05b22cc7d4ef5',
                displayName: 'Jo Smith',
                profilePicture: { path: '/wiki/aa-avatar/5b10ac8d82e05b22cc7d4ef5' },
              },
            },
            { user: { type: 'known', accountId: '712020:aaa', publicName: 'Jo Other' } },
          ],
        },
      };
    };
    byName = configured(cloud)('findUsers').run('Jo Smith', 10);
    onServer = configured(server)('findUsers').run('jo', 10);
  } finally {
    globalThis.orknux.http.get = searching;
  }

  /* Cloud: the endpoint made for it, with the name quoted into the clause. */
  assert.equal(
    searches[0],
    'https://acme.atlassian.net/wiki/rest/api/search/user?cql=user.fullname~%22Jo%20Smith%22&limit=10',
  );
  /* Server: the same question through the search everything else uses. */
  assert.equal(
    searches[1],
    'https://wiki.acme.com/rest/api/search?cql=type%3Duser%20AND%20user.fullname~%22jo%22&limit=10',
  );

  /*
   * The same `User` shape openUser answers, so a person found by name is a
   * person, not a second thing shaped nearly like one - and the avatar fields
   * are empty rather than absent, because a search fetches no pictures.
   */
  assert.equal(byName.total, 2);
  assert.deepEqual(
    byName.users.map((one) => one.name),
    ['Jo Smith', 'Jo Other'],
  );
  assert.equal(byName.users[0].id, '5b10ac8d82e05b22cc7d4ef5');
  assert.equal(byName.users[0].url, 'https://acme.atlassian.net/wiki/people/5b10ac8d82e05b22cc7d4ef5');
  assert.equal(byName.users[0].avatarUrl, 'https://acme.atlassian.net/wiki/aa-avatar/5b10ac8d82e05b22cc7d4ef5');
  assert.equal(byName.users[0].avatar, null);
  assert.equal(byName.users[0].avatarKey, '');
  assert.equal(onServer.users.length, 2);

  assert.throws(() => configured(cloud)('findUsers').run('  ', 10), /no name to search for/);

  /* The other spellings of the same question, resolved before any request. */
  assert.throws(() => configured({})('openUser').run('   '), /nobody to look up/);
  for (const [named, expected] of [
    ['<ri:user ri:username="jsmith"/>', 'username=jsmith'],
    ['https://wiki.acme.com/display/~jsmith', 'username=jsmith'],
    ['https://acme.atlassian.net/wiki/people/5b10ac8d82e05b22cc7d4ef5', 'accountId=5b10ac8d82e05b22cc7d4ef5'],
    ['jsmith', 'username=jsmith'],
  ]) {
    const seen = [];
    const held = globalThis.orknux.http.get;
    try {
      globalThis.orknux.http.get = (where) => {
        seen.push(where);
        return { status: 200, headers: {}, body: '{}', json: { type: 'known' } };
      };
      configured(server)('openUser').run(named);
    } finally {
      globalThis.orknux.http.get = held;
    }
    assert.ok(seen[0].endsWith(expected), `${named} asked for ${seen[0]}`);
  }
});

test('the jira plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('jira'));

  assert.equal(inspected.id, 'jira');
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['url', 'email', 'token', 'project'],
  );
  /* The token is the one secret; the rest are plain settings. */
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.secret),
    [false, false, true, false],
  );
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.required),
    [true, false, true, false],
  );

  /* None: `orknux.encoding` turns the credential into base64, and is ungranted. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, ['NETWORK_REQUEST']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['search', 'openIssue', 'comment', 'transition', 'form', 'createIssue', 'updateIssue', 'link', 'groupMembers', 'timeLogged'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['search', 'openIssue', 'comment', 'transition', 'form', 'createIssue', 'updateIssue', 'link', 'groupMembers', 'timeLogged'],
  );
  /* The project's own fields ride in a map, optional and empty by default, last. */
  const create = inspected.functions.find((declared) => declared.name === 'createIssue');
  assert.deepEqual(create.params.at(-1), { name: 'fields', type: 'map', required: false, default: {} });

  /*
   * The first shipped plugin to export a shape, which is what objects() was
   * added for: `openIssue` answers `Issue` rather than a bare map, and the
   * tool fronting it inherits that return because a proxy carries the
   * function's own.
   */
  assert.deepEqual(
    inspected.objects.map((shape) => shape.name),
    ['Search', 'Comment', 'Moved', 'Raised', 'Link', 'Worklog', 'LoggedDay', 'TimeLogged', 'Person', 'Members', 'Linked', 'Updated', 'Field', 'Form', 'Issue'],
  );
  const issue = inspected.objects.find((shape) => shape.name === 'Issue');
  assert.equal(issue.properties.length, 14);
  /* Links are a list of a declared shape, read from this issue's side. */
  const links = issue.properties.find((property) => property.name === 'links');
  assert.equal(links.kind, 'array');
  assert.equal(links.of, 'Link');
  /* `of` is what stops a shape being flat, and labels is the one that has it. */
  const labels = issue.properties.find((property) => property.name === 'labels');
  assert.equal(labels.kind, 'array');
  assert.equal(labels.of, 'string');
  /* Every field says what belongs in it; a name alone tells a model nothing. */
  for (const property of issue.properties) {
    assert.ok(
      typeof property.description === 'string' && property.description.length > 0,
      `Issue.${property.name} has no description`,
    );
  }

  assert.deepEqual(
    inspected.functions.map((one) => one.returnType),
    ['Search', 'Issue', 'Comment', 'Moved', 'Form', 'Raised', 'Updated', 'Linked', 'Members', 'TimeLogged'],
  );
  /* A proxy carries its function's own return, so the tools agree by construction. */
  assert.deepEqual(
    inspected.tools.map((one) => one.returnType),
    ['Search', 'Issue', 'Comment', 'Moved', 'Form', 'Raised', 'Updated', 'Linked', 'Members', 'TimeLogged'],
  );
  /* `Search` holds the same shape `openIssue` answers, rather than a second one. */
  const search = inspected.objects.find((shape) => shape.name === 'Search');
  const issues = search.properties.find((property) => property.name === 'issues');
  assert.equal(issues.kind, 'array');
  assert.equal(issues.of, 'Issue');
});

test('jira createIssue resolves a project\'s own fields against its form', async () => {
  const url = new URL(`../../plugins/jira/jira.js`, import.meta.url);
  const { default: Jira } = await import(url.href);

  const configured = (settings) => {
    const plugin = Object.create(Jira.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };
  const cloud = configured({ url: 'https://x.atlassian.net', email: 'a@b.c', token: 't', project: 'OKO' });
  const server = configured({ url: 'https://jira.example.com', token: 't', project: 'OKO' });

  /*
   * The form a project like the one this was written for actually has: two
   * choices it insists on, a multi-choice, labels, a user and a number. The
   * ids are what Jira wants on the wire and what nobody calling should
   * have to know.
   */
  const fields = [
    { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
    {
      fieldId: 'customfield_10123',
      name: 'Występuje na',
      required: true,
      schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
      allowedValues: [{ id: '10201', value: 'PROD' }, { id: '10202', value: 'UAT' }, { id: '10203', value: 'DEV' }],
    },
    {
      fieldId: 'customfield_10124',
      name: 'Rodzaj prac',
      required: true,
      schema: { type: 'option' },
      allowedValues: [{ id: '10301', value: 'Drobny rozwój' }, { id: '10302', value: 'Utrzymanie' }],
    },
    {
      fieldId: 'customfield_10125',
      name: 'Zespoły',
      required: false,
      schema: { type: 'array', items: 'option' },
      allowedValues: [{ id: '10401', value: 'Checkout' }, { id: '10402', value: 'Payments' }],
    },
    { fieldId: 'labels', name: 'Labels', required: false, schema: { type: 'array', items: 'string' } },
    { fieldId: 'assignee', name: 'Assignee', required: false, schema: { type: 'user' } },
    { fieldId: 'customfield_10126', name: 'Story Points', required: false, schema: { type: 'number' } },
    {
      fieldId: 'priority',
      name: 'Priority',
      required: false,
      schema: { type: 'priority' },
      allowedValues: [{ id: '1', name: 'High' }, { id: '3', name: 'Medium' }],
    },
  ];
  const types = [{ id: '10001', name: 'Task' }, { id: '10004', name: 'Bug' }];

  const asked = [];
  const door = globalThis.orknux.http.request;
  /* Cloud spells the pages issueTypes and fields; Data Center spells both values. */
  const answering = (spelling) => (what) => {
    asked.push(what);
    if (what.url.includes('/issuetypes/10004')) {
      return { status: 200, headers: {}, body: '{}', json: spelling === 'cloud' ? { fields: fields } : { values: fields } };
    }
    if (what.url.includes('/issuetypes')) {
      return { status: 200, headers: {}, body: '{}', json: spelling === 'cloud' ? { issueTypes: types } : { values: types } };
    }
    if (what.url.includes('/user/search')) {
      /* Nobody is called by an account id, so an id given as a user falls through as one. */
      return { status: 200, headers: {}, body: '[]', json: [] };
    }
    return { status: 201, headers: {}, body: '{}', json: { key: 'OKO-4040' } };
  };
  try {
    globalThis.orknux.http.request = answering('cloud');

    /* The form, read by name whatever the capitals, answered by name. */
    const form = cloud('form').run('', 'bug');
    assert.equal(form.project, 'OKO');
    assert.equal(form.type, 'Bug');
    assert.deepEqual(form.required, ['Summary', 'Występuje na', 'Rodzaj prac']);
    const where = form.fields.find((one) => one.name === 'Występuje na');
    assert.deepEqual(where, {
      id: 'customfield_10123',
      name: 'Występuje na',
      required: true,
      kind: 'option',
      of: null,
      allowed: ['PROD', 'UAT', 'DEV'],
      hasDefault: false,
    });
    assert.equal(asked[0].url, 'https://x.atlassian.net/rest/api/2/issue/createmeta/OKO/issuetypes?maxResults=200');
    assert.equal(asked[1].url, 'https://x.atlassian.net/rest/api/2/issue/createmeta/OKO/issuetypes/10004?maxResults=200');

    /* And a create that says the values the way a person says them. */
    asked.length = 0;
    const raised = cloud('createIssue').run('', 'Bug', 'Spokojnie tylko test', 'nic', {
      'występuje na': 'dev',
      'Rodzaj prac': 'Utrzymanie',
      'Zespoły': 'Checkout, payments',
      Labels: ['a', 'b'],
      Assignee: '5b10ac8d82e05b22cc7d4ef5',
      customfield_10126: '3',
      Priority: 'High',
    });
    assert.deepEqual(raised, { key: 'OKO-4040', url: 'https://x.atlassian.net/browse/OKO-4040' });
    const sent = asked.at(-1);
    assert.equal(sent.url, 'https://x.atlassian.net/rest/api/2/issue');
    assert.deepEqual(sent.body.fields, {
      customfield_10123: { id: '10203' },
      customfield_10124: { id: '10302' },
      customfield_10125: [{ id: '10401' }, { id: '10402' }],
      labels: ['a', 'b'],
      assignee: { accountId: '5b10ac8d82e05b22cc7d4ef5' },
      customfield_10126: 3,
      priority: { id: '1' },
      project: { key: 'OKO' },
      issuetype: { name: 'Bug' },
      summary: 'Spokojnie tylko test',
      description: 'nic',
    });
    /* The form read once, the assignee looked up once, then the create: four requests. */
    assert.equal(asked.length, 4);
    assert.match(asked[2].url, /\/rest\/api\/2\/user\/search\?query=5b10ac8d82e05b22cc7d4ef5&maxResults=10$/);

    /* A create with nothing extra reads no form: one request. */
    asked.length = 0;
    cloud('createIssue').run('', 'Bug', 'Plain', '', {});
    assert.equal(asked.length, 1);

    /* A value that is not one of the choices is refused here, with the choices. */
    assert.throws(
      () => cloud('createIssue').run('', 'Bug', 'x', '', { 'Występuje na': 'STAGING' }),
      /"STAGING" is not one of Występuje na's values: PROD, UAT, DEV/,
    );
    /* A field the form does not have is refused by name, pointing at form(). */
    assert.throws(
      () => cloud('createIssue').run('', 'Bug', 'x', '', { Severity: 'high' }),
      /the OKO Bug form has no field "Severity"; form\("OKO", "Bug"\) lists what it has/,
    );
    /* A type the project does not have is refused with the ones it has. */
    assert.throws(() => cloud('form').run('', 'Epic'), /OKO has no issue type "Epic"; it has Task, Bug/);
    /* And an object goes through as said, for a shape this does not cover. */
    asked.length = 0;
    cloud('createIssue').run('', 'Bug', 'x', '', { 'Występuje na': { value: 'DEV' } });
    assert.deepEqual(asked.at(-1).body.fields.customfield_10123, { value: 'DEV' });

    /* Data Center: the other spelling of the pages, and a user named by username. */
    globalThis.orknux.http.request = answering('server');
    asked.length = 0;
    server('createIssue').run('', 'Bug', 'x', '', { 'Występuje na': 'UAT', Assignee: 'mszymanski' });
    assert.deepEqual(asked.at(-1).body.fields.customfield_10123, { id: '10202' });
    assert.deepEqual(asked.at(-1).body.fields.assignee, { name: 'mszymanski' });
    assert.match(asked[2].url, /\/user\/search\?username=mszymanski&/, 'Server searches by username');
  } finally {
    globalThis.orknux.http.request = door;
  }
});

test('jira updateIssue sets fields on an issue that exists, against its own edit form', async () => {
  const url = new URL(`../../plugins/jira/jira.js`, import.meta.url);
  const { default: Jira } = await import(url.href);
  const plugin = Object.create(Jira.prototype);
  Object.defineProperty(plugin, 'settings', {
    value: Object.freeze({ url: 'https://x.atlassian.net', email: 'a@b.c', token: 't' }),
  });
  const update = plugin.functions().find((one) => one.name === 'updateIssue');

  /* Nothing to do with is decided before any request. */
  assert.throws(() => update.run('', { Team: 'x' }), /no issue key to update/);
  assert.throws(() => update.run('OKO-4220', {}), /nothing to set/);

  /*
   * The edit metadata is a map keyed by field id, unlike the create form's
   * list, and says what this issue can have changed right now.
   */
  const editmeta = {
    fields: {
      summary: { name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
      customfield_10127: {
        name: 'Team',
        required: false,
        schema: { type: 'option' },
        allowedValues: [{ id: '10501', value: 'OKO Cyklonu' }, { id: '10502', value: 'OKO Tajfunu' }],
      },
      labels: { name: 'Labels', required: false, schema: { type: 'array', items: 'string' } },
      assignee: { name: 'Assignee', required: false, schema: { type: 'user', system: 'assignee' } },
    },
  };
  const people = [
    { accountId: 'acc-michal', displayName: 'Michał Szymański', emailAddress: 'michal@example.com' },
    { accountId: 'acc-michalina', displayName: 'Michalina Nowak', emailAddress: 'michalina@example.com' },
  ];
  const asked = [];
  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = (what) => {
    asked.push(what);
    if (what.url.endsWith('/editmeta')) {
      return { status: 200, headers: {}, body: '{}', json: editmeta };
    }
    if (what.url.endsWith('/myself')) {
      return { status: 200, headers: {}, body: '{}', json: { accountId: 'acc-agent', displayName: 'OKO Agent' } };
    }
    if (what.url.includes('/user/search')) {
      const query = decodeURIComponent(what.url.split('query=')[1].split('&')[0]).toLowerCase();
      return { status: 200, headers: {}, body: '[]', json: people.filter((one) => one.displayName.toLowerCase().includes(query)) };
    }
    return { status: 204, headers: {}, body: '', json: undefined };
  };
  try {
    const done = update.run('OKO-4220', { team: 'oko cyklonu', Labels: 'a, b', Summary: 'Better' });
    assert.deepEqual(done, {
      key: 'OKO-4220',
      changed: ['Team', 'Labels', 'Summary'],
      url: 'https://x.atlassian.net/browse/OKO-4220',
    });
    assert.equal(asked.length, 2);
    assert.equal(asked[0].url, 'https://x.atlassian.net/rest/api/2/issue/OKO-4220/editmeta');
    assert.equal(asked[1].url, 'https://x.atlassian.net/rest/api/2/issue/OKO-4220');
    assert.equal(asked[1].method, 'PUT');
    assert.deepEqual(asked[1].body, {
      fields: { customfield_10127: { id: '10501' }, labels: ['a', 'b'], summary: 'Better' },
    });

    /* A field this issue cannot have changed is refused with the ones it can. */
    assert.throws(
      () => update.run('OKO-4220', { Severity: 'high' }),
      /OKO-4220 has no editable field "Severity"; it has Summary, Team, Labels/,
    );
    /* And a team that is not one of the choices, with the choices. */
    assert.throws(
      () => update.run('OKO-4220', { Team: 'OKO' }),
      /"OKO" is not one of Team's values: OKO Cyklonu, OKO Tajfunu/,
    );

    /* "Assign it to yourself": whoever the token is, asked of Jira, no id known up front. */
    asked.length = 0;
    update.run('OKO-4220', { Assignee: 'me' });
    assert.equal(asked[1].url, 'https://x.atlassian.net/rest/api/2/myself');
    assert.deepEqual(asked.at(-1).body.fields, { assignee: { accountId: 'acc-agent' } });

    /* A person by name, found the way the site's own picker finds them. */
    asked.length = 0;
    update.run('OKO-4220', { Assignee: 'Michalina' });
    assert.deepEqual(asked.at(-1).body.fields, { assignee: { accountId: 'acc-michalina' } });

    /* Several matches: an exact one wins, and otherwise nobody is guessed between. */
    update.run('OKO-4220', { Assignee: 'Michał Szymański' });
    assert.deepEqual(asked.at(-1).body.fields, { assignee: { accountId: 'acc-michal' } });
    assert.throws(
      () => update.run('OKO-4220', { Assignee: 'Micha' }),
      /"Micha" names 2 users: Michał Szymański, Michalina Nowak/,
    );
  } finally {
    globalThis.orknux.http.request = door;
  }
});

test('jira link says the relation as a verb, and openIssue reads links from its own side', async () => {
  const url = new URL(`../../plugins/jira/jira.js`, import.meta.url);
  const { default: Jira } = await import(url.href);
  const plugin = Object.create(Jira.prototype);
  Object.defineProperty(plugin, 'settings', {
    value: Object.freeze({ url: 'https://x.atlassian.net', email: 'a@b.c', token: 't' }),
  });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  /* Nothing to do with is decided before any request. */
  assert.throws(() => call('link').run('', 'blocks', 'OKO-1'), /a link needs two issue keys/);
  assert.throws(() => call('link').run('OKO-1', '', 'OKO-2'), /a link needs a relation/);
  assert.throws(() => call('link').run('OKO-1', 'blocks', 'oko-1'), /cannot be linked to itself/);

  /* A Jira's link types: a name and a verb per direction, somebody's configuration. */
  const types = {
    issueLinkTypes: [
      { id: '10000', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
      { id: '10001', name: 'Dependency', outward: 'depends on', inward: 'is depended on by' },
      { id: '10003', name: 'Relates', outward: 'relates to', inward: 'relates to' },
    ],
  };
  const asked = [];
  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = (what) => {
    asked.push(what);
    if (what.url.endsWith('/issueLinkType')) {
      return { status: 200, headers: {}, body: '{}', json: types };
    }
    if (what.url.endsWith('/issueLink')) {
      return { status: 201, headers: {}, body: '', json: undefined };
    }
    /* openIssue: OKO-4219 depends on OKO-4124 (outward) and is blocked by OKO-1 (inward). */
    return {
      status: 200,
      headers: {},
      body: '{}',
      json: {
        key: 'OKO-4219',
        fields: {
          summary: 'Prepaid flag in the order mail',
          status: { name: 'In Progress' },
          issuetype: { name: 'Task' },
          issuelinks: [
            {
              type: { name: 'Dependency', outward: 'depends on', inward: 'is depended on by' },
              outwardIssue: { key: 'OKO-4124', fields: { summary: 'isPrepaidStoreOrder()', status: { name: 'Done' } } },
            },
            {
              type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
              inwardIssue: { key: 'OKO-1', fields: { summary: 'Something', status: { name: 'To Do' } } },
            },
          ],
        },
      },
    };
  };
  try {
    /* The verb as a person says it, whatever the capitals, picks the type and the direction. */
    const made = call('link').run('OKO-4219', 'Depends On', 'OKO-4124');
    assert.deepEqual(made, {
      from: 'OKO-4219',
      relation: 'depends on',
      to: 'OKO-4124',
      url: 'https://x.atlassian.net/browse/OKO-4219',
    });
    assert.equal(asked[0].url, 'https://x.atlassian.net/rest/api/2/issueLinkType');
    assert.equal(asked[1].url, 'https://x.atlassian.net/rest/api/2/issueLink');
    assert.equal(asked[1].method, 'POST');
    assert.deepEqual(asked[1].body, {
      type: { name: 'Dependency' },
      outwardIssue: { key: 'OKO-4219' },
      inwardIssue: { key: 'OKO-4124' },
    });

    /* The inward verb from the other issue makes the same link, ends swapped. */
    asked.length = 0;
    const same = call('link').run('OKO-4124', 'is depended on by', 'OKO-4219');
    assert.equal(same.relation, 'is depended on by');
    assert.deepEqual(asked[1].body, {
      type: { name: 'Dependency' },
      outwardIssue: { key: 'OKO-4219' },
      inwardIssue: { key: 'OKO-4124' },
    });

    /* A type's name works too, read as its outward direction. */
    asked.length = 0;
    call('link').run('OKO-1', 'blocks', 'OKO-2');
    assert.deepEqual(asked[1].body.outwardIssue, { key: 'OKO-1' });

    /* A verb this Jira does not have is refused with the ones it does. */
    assert.throws(
      () => call('link').run('OKO-1', 'is caused by', 'OKO-2'),
      /this Jira has no "is caused by" link; it has blocks, is blocked by, depends on, is depended on by, relates to, relates to/,
    );

    /* And an opened issue says what it is linked to, from its own side. */
    const opened = call('openIssue').run('OKO-4219');
    assert.deepEqual(opened.links, [
      { type: 'Dependency', relation: 'depends on', key: 'OKO-4124', summary: 'isPrepaidStoreOrder()', status: 'Done' },
      { type: 'Blocks', relation: 'is blocked by', key: 'OKO-1', summary: 'Something', status: 'To Do' },
    ]);
  } finally {
    globalThis.orknux.http.request = door;
  }
});

test('jira timeLogged answers every day of a range, and last week when given none', async () => {
  const url = new URL(`../../plugins/jira/jira.js`, import.meta.url);
  const { default: Jira } = await import(url.href);
  const configured = (settings) => {
    const plugin = Object.create(Jira.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };
  const cloud = configured({ url: 'https://x.atlassian.net', email: 'a@b.c', token: 't' });
  const server = configured({ url: 'https://jira.example.com', token: 't' });

  assert.throws(() => cloud('timeLogged').run('', '', ''), /no user to read time for/);
  assert.throws(() => cloud('timeLogged').run('me', '2026-9-1', ''), /from should be a date as YYYY-MM-DD/);
  assert.throws(() => cloud('timeLogged').run('me', '2026-09-20', '2026-09-14'), /from \(2026-09-20\) is after to/);

  /*
   * Ada logged on two issues over the week - one of them shared with Bob,
   * whose entry must not count - and nothing on Wednesday. Thursday's entry
   * carries a plain comment; Friday's is outside the range and stays out.
   */
  const worklogs = {
    'OKO-1': [
      { author: { accountId: 'acc-ada', name: 'ada' }, started: '2026-09-14T09:00:00.000+0200', timeSpentSeconds: 4 * 3600, comment: 'morning' },
      { author: { accountId: 'acc-bob', name: 'bob' }, started: '2026-09-14T10:00:00.000+0200', timeSpentSeconds: 8 * 3600 },
      { author: { accountId: 'acc-ada', name: 'ada' }, started: '2026-09-14T14:00:00.000+0200', timeSpentSeconds: 4 * 3600 },
      { author: { accountId: 'acc-ada', name: 'ada' }, started: '2026-09-21T09:00:00.000+0200', timeSpentSeconds: 8 * 3600 },
    ],
    'OKO-2': [
      { author: { accountId: 'acc-ada', name: 'ada' }, started: '2026-09-15T09:00:00.000+0200', timeSpentSeconds: 27000 },
      { author: { accountId: 'acc-ada', name: 'ada' }, started: '2026-09-17T09:00:00.000+0200', timeSpentSeconds: 8 * 3600 },
    ],
  };
  const issues = [
    { key: 'OKO-1', fields: { summary: 'First' } },
    { key: 'OKO-2', fields: { summary: 'Second' } },
  ];
  const asked = [];
  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = (what) => {
    asked.push(what);
    if (what.url.includes('/user/search')) {
      return { status: 200, headers: {}, body: '[]', json: [{ accountId: 'acc-ada', name: 'ada', displayName: 'Ada' }] };
    }
    if (what.url.endsWith('/myself')) {
      return { status: 200, headers: {}, body: '{}', json: { accountId: 'acc-ada', name: 'ada' } };
    }
    if (what.url.includes('/search')) {
      return { status: 200, headers: {}, body: '{}', json: { issues: issues, total: issues.length } };
    }
    const key = what.url.match(/\/issue\/([^/]+)\/worklog/)[1];
    return { status: 200, headers: {}, body: '{}', json: { worklogs: worklogs[key] } };
  };
  try {
    const week = cloud('timeLogged').run('Ada', '2026-09-14', '2026-09-20');
    assert.equal(week.user, 'Ada');
    assert.equal(week.from, '2026-09-14');
    assert.equal(week.to, '2026-09-20');
    assert.equal(week.hours, 23.5);

    /* Seven days, in order, weekends included, each named. */
    assert.deepEqual(
      week.days.map((one) => `${one.weekday} ${one.date} ${one.hours}`),
      [
        'Monday 2026-09-14 8',
        'Tuesday 2026-09-15 7.5',
        'Wednesday 2026-09-16 0',
        'Thursday 2026-09-17 8',
        'Friday 2026-09-18 0',
        'Saturday 2026-09-19 0',
        'Sunday 2026-09-20 0',
      ],
    );
    /* Monday is Ada's two entries and not Bob's, in the order they started. */
    assert.deepEqual(
      week.days[0].entries.map((one) => [one.key, one.hours, one.comment]),
      [['OKO-1', 4, 'morning'], ['OKO-1', 4, null]],
    );
    assert.equal(week.days[0].entries[0].summary, 'First');
    assert.deepEqual(week.days[2].entries, []);

    /* The JQL asked Jira for the issues by author and date, on Cloud by account id. */
    const searched = asked.find((one) => one.url.endsWith('/rest/api/3/search/jql'));
    assert.equal(searched.body.jql, 'worklogAuthor = "acc-ada" AND worklogDate >= "2026-09-14" AND worklogDate <= "2026-09-20"');
    assert.deepEqual(searched.body.fields, ['summary']);

    /* No dates means last week, Monday to Sunday, seven days ending before today. */
    asked.length = 0;
    const last = cloud('timeLogged').run('me', '', '');
    assert.equal(last.days.length, 7);
    assert.equal(last.days[0].weekday, 'Monday');
    assert.equal(last.days[6].weekday, 'Sunday');
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(last.to < today, 'last week ended before today');
    assert.ok(Date.parse(today) - Date.parse(last.to) <= 7 * 86400000, 'and not more than a week ago');
    assert.ok(asked.some((one) => one.url.endsWith('/myself')), '"me" is asked of Jira');

    /* Server: the author is matched by username, and the search is the v2 GET. */
    asked.length = 0;
    const onServer = server('timeLogged').run('ada', '2026-09-14', '2026-09-20');
    assert.equal(onServer.hours, 23.5);
    const searchedServer = asked.find((one) => one.url.includes('/rest/api/2/search?'));
    assert.match(searchedServer.url, /jql=worklogAuthor%20%3D%20%22ada%22/);
  } finally {
    globalThis.orknux.http.request = door;
  }
});

test('jira groupMembers lists a team by the id the other calls take', async () => {
  const url = new URL(`../../plugins/jira/jira.js`, import.meta.url);
  const { default: Jira } = await import(url.href);
  const plugin = Object.create(Jira.prototype);
  Object.defineProperty(plugin, 'settings', {
    value: Object.freeze({ url: 'https://x.atlassian.net', email: 'a@b.c', token: 't' }),
  });
  const members = plugin.functions().find((one) => one.name === 'groupMembers');
  assert.throws(() => members.run('  '), /no group to list/);

  const asked = [];
  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = (what) => {
    asked.push(what);
    return {
      status: 200,
      headers: {},
      body: '{}',
      json: {
        values: [
          { accountId: 'acc-ada', name: 'ada', displayName: 'Ada', emailAddress: 'ada@example.com', active: true },
          { accountId: 'acc-bob', name: 'bob', displayName: 'Bob', active: true },
        ],
      },
    };
  };
  try {
    const team = members.run('oko-team');
    assert.equal(asked[0].url, 'https://x.atlassian.net/rest/api/2/group/member?groupname=oko-team&maxResults=200&includeInactiveUsers=false');
    assert.deepEqual(team, {
      group: 'oko-team',
      people: [
        { id: 'acc-ada', name: 'Ada', email: 'ada@example.com', active: true },
        { id: 'acc-bob', name: 'Bob', email: null, active: true },
      ],
    });
  } finally {
    globalThis.orknux.http.request = door;
  }
});

test('a jira refusal names every field, not the first', async () => {
  const url = new URL(`../../plugins/jira/jira.js`, import.meta.url);
  const { default: Jira } = await import(url.href);
  const plugin = Object.create(Jira.prototype);
  Object.defineProperty(plugin, 'settings', {
    value: Object.freeze({ url: 'https://x.atlassian.net', email: 'a@b.c', token: 't', project: 'OKO' }),
  });
  const create = plugin.functions().find((one) => one.name === 'createIssue');

  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = () => ({
    status: 400,
    headers: {},
    body: '{}',
    json: {
      errorMessages: [],
      errors: { customfield_10123: 'Występuje na is required.', customfield_10124: 'Rodzaj prac is required.' },
    },
  });
  try {
    assert.throws(
      () => create.run('', 'Bug', 'x', '', {}),
      /Jira answered 400: customfield_10123: Występuje na is required\.; customfield_10124: Rodzaj prac is required\. for \/rest\/api\/2\/issue/,
    );
  } finally {
    globalThis.orknux.http.request = door;
  }
});

test('a jira call says what is missing, and picks its search endpoint by deployment', async () => {
  const url = new URL(`../../plugins/jira/jira.js`, import.meta.url);
  const { default: Jira } = await import(url.href);

  const configured = (settings) => {
    const plugin = Object.create(Jira.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };

  /* Nothing to do with is decided before any setting is read. */
  assert.throws(() => configured({})('search').run('   ', 0), /no JQL to search with/);
  assert.throws(() => configured({})('openIssue').run(''), /no issue key to open/);
  assert.throws(() => configured({})('comment').run('PROJ-1', '  '), /no comment to add/);
  assert.throws(() => configured({})('transition').run('PROJ-1', ''), /no status to move/);
  assert.throws(() => configured({})('createIssue').run('', 'Task', '', ''), /needs a summary/);

  /* Then the settings, each named. */
  assert.throws(() => configured({})('search').run('project = PROJ', 0), /url parameter is not set/);
  assert.throws(
    () => configured({ url: 'https://x.atlassian.net' })('search').run('project = PROJ', 0),
    /token parameter is not set/,
  );
  /* A create with no project and no default says so rather than guessing one. */
  assert.throws(
    () => configured({ url: 'https://x.atlassian.net', token: 't' })('createIssue').run('', 'Task', 'A thing', ''),
    /no project was passed and no default project is configured/,
  );

  /*
   * And the split that matters, watched rather than inferred: Cloud — which is
   * what having an email to send means — must ask the only search endpoint it
   * has left, because Atlassian removed the other one in 2025. Server still
   * has v2. The request is caught on its way out to see which was chosen, and
   * to see that the two authentication schemes differ with it.
   */
  const asked = [];
  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = (what) => {
    asked.push(what);
    return { status: 200, headers: {}, body: '{}', json: { issues: [] } };
  };
  try {
    configured({ url: 'https://x.atlassian.net', email: 'a@b.c', token: 't' })('search')
      .run('project = PROJ', 10);
    configured({ url: 'https://jira.example.com', token: 't' })('search')
      .run('project = PROJ', 10);
  } finally {
    globalThis.orknux.http.request = door;
  }

  assert.equal(asked.length, 2);
  const [onCloud, onServer] = asked;

  /* Cloud: the bounded POST, with the fields named because it insists on them. */
  assert.equal(onCloud.url, 'https://x.atlassian.net/rest/api/3/search/jql');
  assert.equal(onCloud.method, 'POST');
  assert.equal(onCloud.body.jql, 'project = PROJ');
  assert.ok(Array.isArray(onCloud.body.fields) && onCloud.body.fields.includes('summary'));
  assert.match(onCloud.headers.authorization, /^Basic /);

  /* Server: the GET that has always been there, and a bearer token. */
  assert.match(onServer.url, /^https:\/\/jira\.example\.com\/rest\/api\/2\/search\?jql=/);
  assert.match(onServer.url, /maxResults=10/);
  assert.equal(onServer.method, 'GET');
  assert.equal(onServer.headers.authorization, 'Bearer t');

  /* The Basic credential is the pair, encoded — base64 written out longhand. */
  assert.equal(
    Buffer.from(onCloud.headers.authorization.slice('Basic '.length), 'base64').toString('utf8'),
    'a@b.c:t',
  );
});

test('the jenkins plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('jenkins'));

  assert.equal(inspected.id, 'jenkins');
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['url', 'user', 'token'],
  );
  /* The token is the one secret, and the credential is optional as a pair. */
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.secret),
    [false, false, true],
  );
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.required),
    [true, false, false],
  );

  /* None: `orknux.encoding` turns the credential into base64, and is ungranted. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, ['NETWORK_REQUEST']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['jobs', 'search', 'job', 'build', 'buildLog', 'testResults', 'testCases', 'trigger', 'queueItem'],
  );
  /* All of it is fronted to agents: reading a build and running one are one job. */
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['jobs', 'search', 'job', 'build', 'buildLog', 'testResults', 'testCases', 'trigger', 'queueItem'],
  );
  assert.deepEqual(
    inspected.objects.map((declared) => declared.name),
    [
      'Parameter', 'Job', 'Jobs', 'Change', 'Build', 'Log', 'Failure', 'Tests',
      'Case', 'Cases', 'Queued',
    ],
  );
});

test('the jenkins plugin names a job however it was spelled, and takes a log by its tail', async () => {
  const url = new URL(`../../plugins/jenkins/jenkins.js`, import.meta.url);
  const { default: Jenkins } = await import(url.href);

  const configured = (settings) => {
    const plugin = Object.create(Jenkins.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };

  /* Refused before a setting is read, let alone before a request goes out. */
  assert.throws(() => configured({})('job').run('   '), /no job named/);
  assert.throws(() => configured({})('job').run('https://ci.example.com'), /not a job name or a job url/);
  assert.throws(() => configured({})('build').run('deploy', 'yesterday'), /not a build number or a permalink/);
  assert.throws(() => configured({})('queueItem').run('soon'), /not a queue item id or a queue url/);

  /* Then the settings, each named — and the credential is a pair or neither. */
  assert.throws(() => configured({})('job').run('deploy'), /url parameter is not set/);
  assert.throws(
    () => configured({ url: 'https://ci.example.com', token: 't' })('job').run('deploy'),
    /no user to send it as/,
  );
  assert.throws(
    () => configured({ url: 'https://ci.example.com', user: 'ada' })('job').run('deploy'),
    /no token to go with it/,
  );

  /*
   * Everything below is watched on its way out rather than inferred. What
   * matters about this plugin is the urls it builds — a job lives at
   * `job/a/job/b`, a folder path and a pasted link have to arrive at the same
   * one, and a log is fetched by an offset into it rather than whole.
   */
  const asked = [];
  const door = globalThis.orknux.http.request;
  const front = globalThis.orknux.http.get;

  const sent = (json, headers) => ({ status: 200, headers: headers ?? {}, body: JSON.stringify(json), json });
  const answer = (what) => {
    const where = typeof what === 'string' ? what : what.url;
    const method = (typeof what === 'string' ? 'GET' : what.method) ?? 'GET';
    /* The log's length, which is the whole point of the HEAD. */
    if (method === 'HEAD') {
      return { status: 200, headers: { 'X-Text-Size': '5000000' }, body: '' };
    }
    /* A build accepted: empty, and the queue item only in the header. */
    if (method === 'POST') {
      return { status: 201, headers: { Location: 'https://ci.example.com/queue/item/77/' }, body: '' };
    }
    if (where.includes('/queue/item/99/')) {
      return { status: 404, headers: {}, body: '<html>Not Found</html>' };
    }
    if (where.includes('/queue/item/')) {
      return sent({
        id: 77,
        why: null,
        cancelled: false,
        task: { name: 'deploy', fullName: 'platform/deploy' },
        executable: { number: 413 },
      });
    }
    if (where.includes('progressiveText')) {
      return { status: 200, headers: {}, body: 'alf a line that was cut\nnine\nten', json: undefined };
    }
    if (where.includes('consoleText')) {
      return { status: 200, headers: {}, body: 'one\ntwo\nthree', json: undefined };
    }
    if (where.includes('tree=jobs')) {
      return sent({
        jobs: [
          { _class: 'hudson.model.FreeStyleProject', name: 'deploy', fullName: 'deploy', color: 'blue' },
          { _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: 'platform', fullName: 'platform' },
          { _class: 'hudson.model.FreeStyleProject', name: 'nightly', fullName: 'nightly', color: 'red' },
        ],
      });
    }
    if (where.includes('estimatedDuration')) {
      return sent({
        number: 412,
        result: 'FAILURE',
        building: false,
        timestamp: 1700000000000,
        duration: 61000,
        actions: [{}, { causes: [{ shortDescription: 'Started by user Ada' }] }],
        changeSets: [{ items: [{ commitId: 'abc123', msg: 'Tighten the timeout', author: { fullName: 'Ada' } }] }],
      });
    }
    if (where.includes('healthReport')) {
      return sent({
        fullName: 'platform/deploy',
        color: 'red_anime',
        buildable: true,
        inQueue: false,
        healthReport: [{ score: 40 }],
        lastBuild: { number: 412, result: 'FAILURE', timestamp: 1700000000000 },
        lastSuccessfulBuild: { number: 409 },
        lastFailedBuild: { number: 412 },
        property: [
          {},
          {
            parameterDefinitions: [
              {
                name: 'BRANCH',
                type: 'StringParameterDefinition',
                description: 'Which branch to deploy',
                defaultParameterValue: { value: 'main' },
              },
            ],
          },
        ],
      });
    }
    return sent({ number: 412, result: 'FAILURE', building: false });
  };

  let opened;
  let listed;
  let built;
  let log;
  let queued;
  let started;
  try {
    globalThis.orknux.http.get = (where, headers) => {
      asked.push({ url: where, method: 'GET', headers });
      return sent({ crumb: 'c0ffee', crumbRequestField: 'Jenkins-Crumb' });
    };
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      return answer(what);
    };

    const site = { url: 'https://ci.example.com/', user: 'ada', token: 't' };
    /* A pasted link to a build, asked about as a job: the build is not the job. */
    opened = configured(site)('job').run('https://ci.example.com/job/platform/job/deploy/412/');
    listed = configured(site)('jobs').run('', 2);
    /* The same build, by its link, with `which` left at its default. */
    built = configured(site)('build').run('https://ci.example.com/job/platform/job/deploy/412/', 'lastBuild');
    log = configured(site)('buildLog').run('deploy', 'lastBuild', 200);
    started = configured(site)('trigger').run('platform/deploy', { BRANCH: 'feature/x' });
    queued = configured(site)('queueItem').run('https://ci.example.com/queue/item/77/');

    /* An instance read anonymously sends no credential at all. */
    configured({ url: 'https://ci.example.com' })('job').run('deploy');

    assert.throws(
      () => configured(site)('queueItem').run('99'),
      /queue item 99 is not in the queue any more/,
    );
  } finally {
    globalThis.orknux.http.request = door;
    globalThis.orknux.http.get = front;
  }

  /* A folder path, a url and a plain name all arrive at `job/a/job/b`. */
  assert.match(asked[0].url, /^https:\/\/ci\.example\.com\/job\/platform\/job\/deploy\/api\/json\?tree=/);
  assert.equal(asked[0].method, 'GET');
  assert.equal(
    Buffer.from(asked[0].headers.authorization.slice('Basic '.length), 'base64').toString('utf8'),
    'ada:t',
  );
  /* The colour is translated, and the parameter's class name is not its type. */
  assert.equal(opened.name, 'platform/deploy');
  assert.equal(opened.status, 'failing');
  assert.equal(opened.building, true);
  assert.equal(opened.health, 40);
  assert.equal(opened.lastStarted, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(opened.parameters, [
    { name: 'BRANCH', type: 'String', default: 'main', description: 'Which branch to deploy' },
  ]);
  assert.equal(opened.url, 'https://ci.example.com/job/platform/job/deploy/');

  /* One more than the limit is asked for, which is how `more` is known. */
  assert.match(asked[1].url, /\{0,3\}$/);
  assert.equal(listed.more, true);
  assert.deepEqual(
    listed.jobs.map((one) => [one.name, one.folder, one.status]),
    [
      ['deploy', false, 'passing'],
      ['platform', true, null],
    ],
  );

  /* A link that names a build answers that build, whatever `which` said. */
  assert.match(asked[2].url, /\/job\/platform\/job\/deploy\/412\/api\/json/);
  assert.equal(built.number, 412);
  assert.equal(built.cause, 'Started by user Ada');
  assert.deepEqual(built.changes, [{ commit: 'abc123', message: 'Tighten the timeout', author: 'Ada' }]);
  assert.equal(built.url, 'https://ci.example.com/job/platform/job/deploy/412/');

  /*
   * The log: what the build is, then a HEAD for its length, then a window off
   * the end of it — 200 lines at 240 bytes — rather than five megabytes.
   */
  assert.match(asked[3].url, /\/job\/deploy\/lastBuild\/api\/json\?tree=number,result,building$/);
  assert.equal(asked[4].method, 'HEAD');
  assert.match(asked[5].url, /\/logText\/progressiveText\?start=4952000$/);
  assert.equal(log.build, 412);
  assert.equal(log.truncated, true);
  /* The offset landed mid-line, and half a line is not a line. */
  assert.equal(log.text, 'nine\nten');
  assert.equal(log.lines, 2);

  /* A trigger fetches a crumb first, sends it, and reads the queue item off the header. */
  assert.equal(asked[6].url, 'https://ci.example.com/crumbIssuer/api/json');
  assert.equal(asked[7].method, 'POST');
  assert.equal(
    asked[7].url,
    'https://ci.example.com/job/platform/job/deploy/buildWithParameters?BRANCH=feature%2Fx',
  );
  assert.equal(asked[7].headers['Jenkins-Crumb'], 'c0ffee');
  assert.equal(started.id, '77');
  assert.equal(started.waiting, true);
  assert.equal(started.build, null);

  /* And the item, once it has a build: the url is built here, not read off Jenkins. */
  assert.match(asked[8].url, /\/queue\/item\/77\/api\/json\?tree=/);
  assert.equal(queued.waiting, false);
  assert.equal(queued.build, 413);
  assert.equal(queued.url, 'https://ci.example.com/job/platform/job/deploy/413/');

  /* Anonymous: no authorization header at all, rather than an empty one. */
  assert.equal(asked[9].headers.authorization, undefined);
});

test('jenkins searches the job tree, and reads a test report a case at a time', async () => {
  const url = new URL(`../../plugins/jenkins/jenkins.js`, import.meta.url);
  const { default: Jenkins } = await import(url.href);

  const plugin = Object.create(Jenkins.prototype);
  Object.defineProperty(plugin, 'settings', {
    value: Object.freeze({ url: 'https://ci.example.com', user: 'ada', token: 't' }),
  });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  /* A controller with folders in it, answered the way a nested tree answers. */
  const tree = {
    jobs: [
      { _class: 'hudson.model.FreeStyleProject', name: 'deploy-staging', fullName: 'deploy-staging', color: 'blue' },
      {
        _class: 'hudson.model.FreeStyleProject',
        name: 'nightly',
        fullName: 'nightly',
        color: 'red',
        description: 'Deploys PROD overnight',
      },
      {
        _class: 'com.cloudbees.hudson.plugins.folder.Folder',
        name: 'platform',
        fullName: 'platform',
        jobs: [
          {
            _class: 'com.cloudbees.hudson.plugins.folder.Folder',
            name: 'prod',
            fullName: 'platform/prod',
            jobs: [
              {
                _class: 'hudson.model.FreeStyleProject',
                name: 'deploy-api',
                fullName: 'platform/prod/deploy-api',
                color: 'blue',
                lastBuild: { number: 88, result: 'SUCCESS', timestamp: 1700000000000 },
              },
            ],
          },
        ],
      },
    ],
  };

  /* Seconds, as Jenkins times a case — and never mind that it times a build in milliseconds. */
  const report = {
    duration: 61.5,
    suites: [
      {
        name: 'CartSuite',
        cases: [
          { className: 'com.acme.CartTest', name: 'slowCheckout', status: 'PASSED', duration: 41.25, age: 0 },
          { className: 'com.acme.CartTest', name: 'emptyCart', status: 'FAILED', duration: 0.5, age: 1,
            errorDetails: 'expected <0> but was <1>' },
        ],
      },
      {
        name: 'LoginSuite',
        cases: [
          { className: 'com.acme.LoginTest', name: 'expiredToken', status: 'REGRESSION', duration: 2, age: 11,
            errorDetails: 'timed out' },
          { className: 'com.acme.LoginTest', name: 'skippedOne', status: 'SKIPPED', duration: 0, age: 0, skipped: true },
        ],
      },
    ],
  };

  const asked = [];
  const door = globalThis.orknux.http.request;
  let found;
  let narrow;
  let slowest;
  let flaky;
  let failed;
  try {
    globalThis.orknux.http.request = (what) => {
      asked.push(what);
      const sent = what.url.includes('/testReport/') ? report : tree;
      return { status: 200, headers: {}, body: JSON.stringify(sent), json: sent };
    };
    found = call('search').run('deploy prod', 25, '');
    narrow = call('search').run('deploy', 1, '');
    slowest = call('testCases').run('platform/prod/deploy-api', 'lastBuild', 'slowest', 20);
    flaky = call('testCases').run('platform/prod/deploy-api', 'lastBuild', 'flaky', 20);
    failed = call('testCases').run('platform/prod/deploy-api', 'lastBuild', 'failed', 20);
  } finally {
    globalThis.orknux.http.request = door;
  }

  /* Three levels of folders, asked for in one request rather than walked. */
  assert.equal(
    (asked[0].url.match(/jobs\[/g) ?? []).length,
    3,
    'a search asks for three levels of folders at once, or it is walking them',
  );
  assert.match(asked[0].url, /^https:\/\/ci\.example\.com\/api\/json\?tree=jobs\[/);

  /*
   * Every word, anywhere: the job nested two folders down matches on its path
   * and the top-level one matches on its description, whatever the capitals.
   * The staging job shares a word with the query and is not a hit.
   */
  assert.deepEqual(
    found.jobs.map((one) => one.name),
    ['nightly', 'platform/prod/deploy-api'],
  );
  assert.equal(found.more, false);
  assert.equal(found.jobs[1].status, 'passing');
  assert.equal(found.jobs[1].url, 'https://ci.example.com/job/platform/job/prod/job/deploy-api/');

  /* A limit says so rather than quietly being all there was. */
  assert.equal(narrow.jobs.length, 1);
  assert.equal(narrow.more, true);

  assert.throws(() => call('search').run('   ', 25, ''), /nothing to search for/);
  assert.throws(
    () => call('testCases').run('deploy', 'lastBuild', 'sideways', 20),
    /no order called sideways: it is slowest, failed, flaky, name/,
  );

  /* Slowest first, and in milliseconds — 41.25 seconds is not 41 of anything. */
  assert.deepEqual(
    slowest.cases.map((one) => [one.test, one.duration]),
    [
      ['com.acme.CartTest.slowCheckout', 41250],
      ['com.acme.LoginTest.expiredToken', 2000],
      ['com.acme.CartTest.emptyCart', 500],
      ['com.acme.LoginTest.skippedOne', 0],
    ],
  );
  assert.equal(slowest.total, 4);
  assert.equal(slowest.duration, 61500);
  assert.equal(slowest.build, null, 'a permalink names no number');
  assert.equal(slowest.cases[0].suite, 'CartSuite');

  /*
   * Failing for more than one build — which is the broken window, not what
   * this build did. The one that broke today has age 1 and is not in here.
   */
  assert.deepEqual(
    flaky.cases.map((one) => [one.test, one.age]),
    [['com.acme.LoginTest.expiredToken', 11]],
  );

  /* And the failures, slowest first, with what the assertion said. */
  assert.deepEqual(
    failed.cases.map((one) => one.test),
    ['com.acme.LoginTest.expiredToken', 'com.acme.CartTest.emptyCart'],
  );
  assert.equal(failed.cases[1].message, 'expected <0> but was <1>');
});

test('the plantuml plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('plantuml'));

  assert.equal(inspected.id, 'plantuml');
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['url'],
  );
  /* Optional: it names a server for `links` to point at, and nothing is sent there. */
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.required),
    [false],
  );

  /*
   * None. The engine expects a browser and the bundle brings its own — the
   * document, the serialiser and the canvas are in src/dom.js — rather than
   * asking for a permission to have the boundary moved.
   */
  assert.deepEqual(inspected.permissions, []);
  /* Only the rasterising, which is the one thing a sandbox cannot do for itself. */
  assert.deepEqual(inspected.capabilities, ['RENDER_PNG']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['render', 'check', 'links'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['render', 'check', 'links'],
  );
  assert.deepEqual(
    inspected.objects.map((declared) => declared.name),
    ['Drawing', 'Checked', 'Links'],
  );
});

test('the plantuml plugin draws in the sandbox, with no server and no Graphviz', async () => {
  const url = new URL(`../../plugins/plantuml/plantuml.js`, import.meta.url);
  const { default: PlantUml } = await import(url.href);

  const plugin = Object.create(PlantUml.prototype);
  Object.defineProperty(plugin, 'settings', { value: Object.freeze({}) });
  const call = (name) => plugin.functions().find((one) => one.name === name);

  const session = globalThis.orknux.session;
  let drawn;
  let laidOut;
  let bad;
  let refused;
  try {
    globalThis.orknux.session = { store: { put: () => ({}), get: () => null } };

    /*
     * A sequence diagram, which needs no graph layout — and one with an accent
     * and a tick in it, because the text is measured here rather than by a
     * browser and a character with no entry in the table still has to have a
     * width.
     */
    drawn = call('render').run('@startuml\nactor Ada\nAda -> Bob : Zażółć ✓\nactivate Bob\n@enduml', 'svg', 0);

    /*
     * And a class diagram, which does. Graphviz is WebAssembly and this
     * sandbox has none; the engine carries Smetana, PlantUML's own port of
     * dot, and falls back to it. If that ever stops being true, this is the
     * assertion that says so.
     */
    laidOut = call('render').run('@startuml\nclass Cart\nclass Item\nCart "1" *-- "0..*" Item\n@enduml', 'svg', 0);

    bad = call('check').run('@startuml\nactor Ada\nAda -> Bob : Hello\nnonsense !!! rubbish\n@enduml');
    try {
      call('render').run('@startuml\nactor Ada\nnonsense !!! rubbish\n@enduml', 'svg', 0);
    } catch (thrown) {
      refused = thrown.message;
    }
  } finally {
    globalThis.orknux.session = session;
  }

  /* Markup, with the diagram's own words in it and a size it worked out itself. */
  assert.match(drawn.svg, /^<\?xml|^<svg/);
  assert.ok(drawn.svg.includes('Zażółć ✓'), 'the label did not survive being measured and drawn');
  assert.ok(drawn.width > 0 && drawn.height > 0, 'the drawing came out with no size');
  assert.equal(drawn.png, '');
  assert.ok(drawn.key.startsWith('plantuml.'), 'the drawing was not kept under a key');

  /*
   * The face is named rather than left as `sans-serif`: the widths it was
   * measured against are Helvetica's, and a viewer setting DejaVu instead
   * would draw a tenth wider than the boxes it was given.
   */
  assert.match(drawn.svg, /font-family="Helvetica,Arial,&quot;Liberation Sans&quot;,sans-serif"/);
  assert.doesNotMatch(drawn.svg, /font-family="sans-serif"/);

  /*
   * A theme is a style block put after the @start line, so it paints the
   * drawing; left out, PlantUML draws its own, and a source without a
   * @start line is handed over untouched for PlantUML to refuse itself.
   */
  const housed = call('render').run('@startuml\nactor Ada\nAda -> Bob : hi\n@enduml', 'svg', 0, 'light');
  assert.match(housed.svg, /eef2f4/i, 'the house fill is painted');
  assert.doesNotMatch(drawn.svg, /eef2f4/i, 'and not without asking');
  assert.throws(
    () => call('render').run('@startuml\nactor Ada\n@enduml', 'svg', 0, 'sepia'),
    /no theme called sepia: it is light or dark/,
  );

  /* Laid out by Smetana: two boxes, their labels, and the association between them. */
  assert.ok(laidOut.svg.includes('Cart') && laidOut.svg.includes('Item'));
  assert.ok(laidOut.svg.includes('0..*'), 'the cardinality is not on the association');
  assert.ok(laidOut.width > 0 && laidOut.height > 0);

  /*
   * A syntax error is a picture of a syntax error, which is no use to anything
   * fixing one. Both of these read the line back out of that picture.
   */
  assert.equal(bad.ok, false);
  assert.equal(bad.line, 4);
  assert.equal(bad.source, 'nonsense !!! rubbish');
  assert.match(bad.error, /Syntax Error/);
  assert.equal(refused, 'Syntax Error? (Assumed diagram type: sequence) on line 3: nonsense !!! rubbish');

  /* And a diagram it can read says so, with nothing else in the answer. */
  assert.deepEqual(call('check').run('@startuml\nAda -> Bob : Hello\n@enduml'), {
    ok: true,
    error: null,
    line: null,
    source: null,
  });
});

test('a plantuml link really is deflate, in plantuml’s own alphabet', async () => {
  const url = new URL(`../../plugins/plantuml/plantuml.js`, import.meta.url);
  const { default: PlantUml } = await import(url.href);

  const configured = (settings) => {
    const plugin = Object.create(PlantUml.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };

  /*
   * `links` is the one call that names a server, and it reaches nothing to do
   * it: the diagram travels inside the url, deflated, in an alphabet that is
   * base64's characters in another order. The stream is written by hand —
   * stored blocks, because a sandbox has no compressor — so it is decoded here
   * with a real inflater. If `inflateRawSync` can read it, so can a PlantUML.
   */
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  const unpacked = (written) => {
    const bytes = [];
    let held = 0;
    let bits = 0;
    for (const character of written) {
      held = (held << 6) | ALPHABET.indexOf(character);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((held >> bits) & 0xff);
      }
    }
    return Buffer.from(bytes);
  };

  const source = '@startuml\nactor Ada\nAda -> Bob : Zażółć gęślą jaźń\n@enduml';
  const site = 'https://plantuml.example.com/plantuml';
  const links = configured({ url: `${site}/` })('links').run(source);

  const path = links.svg.slice(`${site}/svg/`.length);
  assert.equal(inflateRawSync(unpacked(path)).subarray(0, Buffer.byteLength(source)).toString('utf8'), source);

  assert.equal(links.png, `${site}/png/${path}`);
  assert.equal(links.txt, `${site}/txt/${path}`);
  assert.equal(links.editor, `${site}/uml/${path}`);
  assert.equal(links.markdown, `![diagram](${site}/png/${path})`);

  /* With no server named, the public one — which is the only url in this plugin. */
  assert.match(configured({})('links').run(source).png, /^https:\/\/www\.plantuml\.com\/plantuml\/png\//);

  assert.throws(() => configured({})('links').run('   '), /no diagram source to link to/);
  assert.throws(() => configured({})('render').run('@startuml\n@enduml', 'jpeg'), /no format called jpeg/);
  assert.throws(() => configured({})('render').run('  ', 'svg'), /no diagram source to draw/);
});

test('the prometheus plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('prometheus'));

  assert.equal(inspected.id, 'prometheus');
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['url', 'username', 'token'],
  );
  assert.equal(inspected.parameters[2].secret, true);
  /* None: `orknux.encoding` turns the credential into base64, and is ungranted. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, ['NETWORK_REQUEST']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['listMetrics', 'query'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['listMetrics', 'query'],
  );
});

test('the mermaid plugin declares what the server would accept, and renders offline', async () => {
  const inspected = await inspect(shipped('mermaid'));

  assert.equal(inspected.id, 'mermaid');
  assert.deepEqual(validate(inspected), []);
  assert.deepEqual(inspected.parameters, []);
  assert.deepEqual(inspected.permissions, ['TEXT_ENCODING']);
  /*
   * The layout engine is bundled in, so nothing is ever fetched — and the one
   * capability is for the one thing this sandbox cannot do for itself: turn
   * the markup into a picture. It reaches nothing; markup goes out and bytes
   * computed from it come back.
   */
  assert.deepEqual(inspected.capabilities, ['RENDER_PNG']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['render', 'links'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['render', 'links'],
  );

  const url = new URL(`../../plugins/mermaid/mermaid.js`, import.meta.url);
  const { default: Mermaid } = await import(url.href);
  const functions = new Mermaid().functions();
  const one = (name) => functions.find((declared) => declared.name === name);

  /*
   * `render` draws right here, in a Node with no DOM — the sandbox's own
   * situation — and its SVG must carry no outward reference: the library's
   * Google Fonts @import is stripped on the way out.
   */
  const drawn = one('render').run(
    'graph TD\n  A[start] --> B{ok?}\n  B -->|yes| C[done]',
    '',
    'svg',
    0,
  );
  assert.ok(drawn.svg.includes('<svg'), 'renders svg');
  assert.ok(drawn.svg.includes('start'), 'the nodes are in the drawing');
  assert.ok(!drawn.svg.includes('@import'), 'no outward reference survives');
  assert.equal(drawn.bytes, drawn.svg.length);

  const themed = one('render').run('sequenceDiagram\n  A->>B: hi', 'nord', 'svg', 0);
  assert.ok(themed.svg.includes('#2e3440'), 'the theme colors the drawing');

  /* Left out, the theme is the house light: the ink the charts plugin sets its text in, and the text face named as a stack. */
  assert.ok(drawn.svg.includes('#131a20'), 'the default is the house light palette');
  assert.ok(drawn.svg.includes("'Source Sans 3'"), 'set in the house text face');
  assert.ok(
    one('render').run('sequenceDiagram\n  A->>B: hi', 'dark', 'svg', 0).svg.includes('#141a1f'),
    'dark is the house dark palette',
  );

  assert.throws(
    () => one('render').run('graph TD\n  A-->B', 'nope', 'svg', 0),
    /no theme called nope/,
  );
  assert.throws(
    () => one('render').run('pie\n  "a" : 1', '', 'svg', 0),
    /could not render the diagram/,
  );
  assert.throws(() => one('render').run('   ', '', 'svg', 0), /no diagram source/);

  /*
   * A picture is what `render` answers when nothing says otherwise, because a
   * picture is what a person can see — and out here there is no renderer to
   * draw one, so the fallback's own sentence is what comes back rather than a
   * drawing that silently is not one.
   */
  assert.throws(
    () => one('render').run('graph TD\n  A-->B', ''),
    /could not draw the diagram: there is no renderer here/,
  );

  /* Given a renderer, the picture is the answer and the markup is not. */
  const renderer = globalThis.orknux.render;
  let drawnFrom = null;
  globalThis.orknux.render = {
    /* Stands in for the server: scales the viewBox to the width it was handed. */
    pngFromSvg: (svg, width) => {
      drawnFrom = svg;
      const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg);
      const drawn = width ?? Number(box[1]);
      return {
        base64: 'UE5H',
        bytes: 3,
        width: Math.round(drawn),
        height: Math.round((drawn / Number(box[1])) * Number(box[2])),
      };
    },
  };
  try {
    const picture = one('render').run('graph TD\n  A-->B', '', 'png', 0);
    assert.equal(picture.png, 'UE5H', 'the picture comes back as base64');
    assert.equal(picture.svg, '', 'and the markup does not come with it');
    assert.ok(drawnFrom.includes('<svg'), 'what was drawn is the markup it just rendered');
    handedOver(drawnFrom, picture.width);

    /*
     * And the size, which is the whole of what a caller has to judge a
     * drawing by. Two boxes declare about 152 by 202, and the long side is
     * brought to the floor rather than the width - a width floor would have
     * drawn this 1200 across and 1600 down for no legibility it did not
     * already have.
     */
    assert.equal(
      Math.max(picture.width, picture.height),
      1200,
      'the long side reaches the floor, whichever side that turns out to be',
    );

    /*
     * The shape this plugin got wrong. Sixteen linked nodes declare about 300
     * by 1475, and asking for 1200 wide drew that 5890 down - past any
     * sensible ceiling, so the server brought the whole thing back to
     * something nobody could read. The budget is on the area, which is the
     * only cap that sees a tall drawing and a wide one the same way.
     */
    const long = 'graph TD\n' + Array.from(
      { length: 16 },
      (_, at) => `  N${at}[A reasonably long node label ${at}] --> N${at + 1}[Another ${at + 1}]`,
    ).join('\n');
    const tall = one('render').run(long, '', 'png', 0);
    handedOver(drawnFrom, tall.width);
    assert.ok(tall.height > tall.width * 2, 'a tall diagram is still tall');
    assert.ok(
      tall.width * tall.height <= 4e6,
      `a tall diagram covered ${tall.width * tall.height} pixels`,
    );
    /* And never below the size it laid itself out at, where its text lives. */
    assert.ok(tall.width >= 300, `a tall diagram was shrunk to ${tall.width} wide`);

    /* The markup answer says what it declares, since nothing drew it. */
    const markup = one('render').run('graph TD\n  A-->B', '', 'svg', 0);
    assert.ok(markup.width > 0 && markup.height > 0, 'svg reports the size it declares');
    assert.ok(
      markup.width < 400 && markup.height < 400,
      'and it is the markup(s) own size, not a drawn one',
    );
  } finally {
    globalThis.orknux.render = renderer;
  }

  /*
   * `links` still carries the state json the mermaid sites read — decoding
   * the url back is the proof the alphabet and the padding are theirs.
   */
  const linked = one('links').run('graph TD;\n  A-->B', 'dark');
  const encoded = linked.image.slice('https://mermaid.ink/img/'.length, -'?type=png'.length);
  const state = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(state.code, 'graph TD;\n  A-->B');
  assert.equal(state.mermaid.theme, 'dark');
  assert.equal(linked.svg, `https://mermaid.ink/svg/${encoded}`);
  assert.equal(linked.editor, `https://mermaid.live/edit#base64:${encoded}`);
  assert.equal(linked.markdown, `![diagram](${linked.image})`);
});

test('the pdf plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('pdf'));

  assert.equal(inspected.id, 'pdf');
  assert.deepEqual(validate(inspected), []);
  assert.deepEqual(inspected.parameters, []);
  assert.deepEqual(inspected.permissions, ['TEXT_ENCODING']);
  /*
   * Writer, layout, fonts and the diagram renderer are all bundled in, so
   * making a document asks the server for nothing. Looking at one is the
   * opposite - rasterising needs a rasteriser - which is the single capability
   * here, and the reason this plugin stopped asking for none at all.
   */
  assert.deepEqual(inspected.capabilities, ['RENDER_PDF']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['read', 'preview', 'fromHtml'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['fromHtml', 'read', 'preview'],
  );
  /* Neither tool is its function: one strips the document, one takes a key. */
  for (const declared of inspected.tools) {
    assert.equal(declared.proxyOf, null, `${declared.name} is its own tool`);
  }
});

test('pdf preview draws a page: bytes on the function, a key on the tool', async () => {
  const url = new URL(`../../plugins/pdf/pdf.js`, import.meta.url);
  const { default: Pdf } = await import(url.href);
  const made = new Pdf();
  const fromHtml = made.functions().find((one) => one.name === 'fromHtml').run;
  const declared = made.functions().find((one) => one.name === 'preview').run;
  const tool = made.tools().find((one) => one.name === 'preview' && one.run !== undefined);

  const held = new Map();
  const store = globalThis.orknux.session.store;
  const render = globalThis.orknux.render;
  let handed = null;

  globalThis.orknux.session.store = {
    put: (key, value) => {
      held.set(key, value);
      return { ok: true };
    },
    get: (key) => (held.has(key) ? held.get(key) : null),
  };
  /*
   * The rasteriser is the server's. Here it records what it was handed and
   * refuses a page past the end the way the contract says it does - by name,
   * rather than by rounding into the first.
   */
  globalThis.orknux.render = {
    pngFromPdf: (pdf, page, width) => {
      handed = { chars: pdf.length, page: page, width: width };
      if (page > 3) return { error: `page ${page} of 3` };
      return { base64: 'iVBOR', bytes: 5, width: width ?? 595, height: 842, pages: 3 };
    },
  };

  try {
    const doc = fromHtml('<h1>Report</h1><p>Some prose.</p>', '');

    /* The tool takes the key the document came back with, and nothing else. */
    const seen = tool.run(doc.key, 1, 800);
    assert.equal(seen.picture, 'iVBOR', 'the picture comes back in full - looking at it is the point');
    assert.equal(seen.pictureType, 'image/png', 'and says what it is');
    assert.equal(seen.pages, 3, "and the document's page count, not this page's number");
    assert.equal(seen.width, 800);
    assert.equal(seen.height, 842);
    assert.equal(held.get(seen.key), 'iVBOR', 'the picture is kept under its own key');
    assert.equal(handed.chars, doc.base64.length, 'the whole document reached the renderer');

    /* The function takes the bytes the tool has nowhere to put. */
    assert.deepEqual(
      tool.params.map((one) => one.name),
      ['contentKey', 'page', 'width'],
    );
    assert.equal(
      made.functions().find((one) => one.name === 'preview').params[0].name,
      'base64',
      'the workflow surface still takes a document',
    );
    assert.equal(declared(doc.base64, 1, 800).picture, 'iVBOR');

    /* Each refusal names what to do instead, or what was actually there. */
    assert.throws(() => tool.run('', 1, 0), /takes a contentKey, not a document/);
    assert.throws(() => tool.run('pdf.nope', 1, 0), /nothing is kept under pdf.nope/);
    assert.throws(() => tool.run(doc.key, 7, 0), /could not draw the page: page 7 of 3/);
    assert.throws(() => declared('', 1, 0), /no document to draw/);
  } finally {
    globalThis.orknux.session.store = store;
    globalThis.orknux.render = render;
  }
});

test('pdf read answers what a document says: bytes on the function, a key on the tool', async () => {
  const url = new URL(`../../plugins/pdf/pdf.js`, import.meta.url);
  const { default: Pdf } = await import(url.href);
  const made = new Pdf();
  const declared = made.functions().find((one) => one.name === 'read').run;
  const tool = made.tools().find((one) => one.name === 'read' && one.run !== undefined);

  /*
   * The other half of preview, and the split is the same one: a workflow node
   * has no session and passes the document, an agent has one and passes the
   * key. The difference from preview is what comes back - a picture is
   * stripped from a model's answer because nobody reads base64, and text is
   * not, because text is the answer.
   */
  assert.deepEqual(
    tool.params.map((one) => one.name),
    ['contentKey', 'from', 'to'],
  );
  assert.equal(
    made.functions().find((one) => one.name === 'read').params[0].name,
    'base64',
    'the workflow surface still takes a document',
  );

  const held = new Map();
  const store = globalThis.orknux.session.store;
  const render = globalThis.orknux.render;
  let asked = null;
  let answering = {
    html:
      '<section data-page="1"><p>Invoice 42</p><p>Total due 1,200.00</p></section>' +
      '<section data-page="2"><p>Terms: net 30.</p></section>',
    pages: 2,
    from: 1,
    to: 2,
    characters: 108,
  };

  globalThis.orknux.session.store = {
    put: (key, value) => {
      held.set(key, value);
      return { ok: true };
    },
    get: (key) => (held.has(key) ? held.get(key) : null),
  };
  globalThis.orknux.render = {
    htmlFromPdf: (pdf, from, to) => {
      asked = { pdf, from, to };
      return answering;
    },
  };

  try {
    const said = declared('JVBE  Ri0x\nLjQK', 0, 0);

    /* Whitespace is packed out, the way it is for drawing. */
    assert.equal(asked.pdf, 'JVBERi0xLjQK', 'the document arrives without its line breaks');
    /* Zero is "the whole document", not page zero. */
    assert.equal(asked.from, undefined, 'no range asked for is no range passed on');
    assert.equal(asked.to, undefined);

    assert.equal(said.pages, 2, 'the document(s) own page count');
    assert.equal(said.from, 1);
    assert.equal(said.to, 2, 'and the range actually read');
    assert.equal(said.characters, 108);
    assert.ok(said.html.includes('Total due 1,200.00'));

    /* Kept as well as answered: slack_upload takes a contentKey for text. */
    assert.ok(said.key.startsWith('pdf.'), 'the text is kept under a key');
    assert.equal(held.get(said.key), said.html, 'and what is kept is what was answered');

    /* A range reaches the door as written. */
    declared('JVBERi0xLjQK', 2, 2);
    assert.equal(asked.from, 2);
    assert.equal(asked.to, 2);

    /*
     * Markup in a document stays text. The server escapes it and this must not
     * un-escape it on the way past: a PDF whose text is a script tag is a
     * document saying something, not a document doing something.
     */
    answering = {
      html: '<section data-page="1"><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></section>',
      pages: 1,
      from: 1,
      to: 1,
      characters: 30,
    };
    const escaped = declared('JVBERi0xLjQK', 0, 0);
    assert.ok(!/<script/i.test(escaped.html), 'a document saying <script> comes back saying it');

    /* The tool reads through the key, and keeps the text in its answer. */
    held.set('pdf.abc', 'JVBERi0xLjQK');
    answering = { html: '<section data-page="1"><p>Hello</p></section>', pages: 1, from: 1, to: 1, characters: 5 };
    const byKey = tool.run('pdf.abc', 0, 0);
    assert.equal(asked.pdf, 'JVBERi0xLjQK', 'the key named the document');
    assert.ok(byKey.html.includes('Hello'), 'text is the answer, so it is not stripped');

    assert.throws(() => tool.run('', 0, 0), /takes a contentKey, not a document/);
    assert.throws(() => tool.run('pdf.gone', 0, 0), /nothing is kept under pdf.gone/);
    assert.throws(() => declared('   ', 0, 0), /no document to read/);

    /*
     * And the server's own sentence, kept rather than replaced. It carries the
     * only numbers that tell a caller what to do next - the real page count,
     * or how many characters the document actually held - and a tidier message
     * of this plugin's own would throw exactly those away.
     */
    answering = { error: 'that document has 3 pages' };
    assert.throws(() => declared('JVBERi0xLjQK', 9, 9), /could not read the document: that document has 3 pages/);

    answering = {
      error: 'this call would return 431,905 characters and 200,000 is the most; ask for a range of pages',
    };
    assert.throws(() => declared('JVBERi0xLjQK', 0, 0), /431,905 characters/);
    assert.throws(() => declared('JVBERi0xLjQK', 0, 0), /ask for a range of pages/);
  } finally {
    globalThis.orknux.session.store = store;
    globalThis.orknux.render = render;
  }
});

test('the pdf plugin writes a pdf out of html, diagrams and all, without a DOM', async () => {
  const url = new URL(`../../plugins/pdf/pdf.js`, import.meta.url);
  const { default: Pdf } = await import(url.href);
  const declared = new Pdf().functions().find((one) => one.name === 'fromHtml');

  const made = declared.run(
    '<h1>Report</h1><p>Hello <b>world</b> &amp; more</p><hr><ul><li>one</li><li>two</li></ul>',
    'The Report',
  );

  /* The answer is binary wearing base64, and the counts agree with the bytes. */
  const bytes = Buffer.from(made.base64, 'base64');
  assert.equal(made.bytes, bytes.length);
  assert.equal(made.pages, 1);
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  const raw = bytes.toString('latin1');
  assert.ok(raw.includes('The Report'), 'the title metadata is set');

  /*
   * Nothing here is past ASCII, so nothing is embedded: the two DejaVu faces
   * are 1.4 MB of TTF that jsPDF parses and writes into every file asking for
   * them, and a page of English does not need a letter they have and
   * Helvetica lacks. It is the difference between four kilobytes and two
   * hundred and seventy-seven, and between one millisecond and a hundred —
   * which in a sandbox that interprets was the difference between a PDF and a
   * timeout.
   */
  assert.ok(!raw.includes('DejaVu'), 'an ascii document embeds no font');
  assert.ok(raw.includes('Helvetica'), 'and is set in the one jsPDF already has');
  assert.ok(made.bytes < 20000, `an ascii page should be small, got ${made.bytes}`);

  /*
   * And real diacritics still get the face that has them. Folding ż to z is
   * the thing DejaVu is carried for, so this must both embed and not throw.
   */
  const polish = declared.run('<p>Zażółć gęślą jaźń</p>', '');
  assert.ok(polish.bytes > 0);
  assert.ok(
    Buffer.from(polish.base64, 'base64').toString('latin1').includes('DejaVu'),
    'a document past ascii embeds the face that can set it',
  );

  /*
   * And the same letters written as entities - which is how a model writes a
   * letter it is unsure of - get the same face. The source is pure ASCII;
   * the page is not, and the page is what the alphabet is decided from. A
   * document written this way was set in Helvetica and came out as
   * `Za|&oacute;B g[l jazD`.
   */
  const entities = declared.run('<h1>Za&#380;&oacute;&#322;&cacute; g&eogon;&sacute;l&aogon;</h1>', '');
  assert.ok(
    Buffer.from(entities.base64, 'base64').toString('latin1').includes('DejaVu'),
    'a document past ascii only once decoded embeds the face all the same',
  );
  assert.deepEqual(entities.problems, [], 'and nothing about it is unsettable');

  /* Named entities keep their case: two letters, not one. */
  const cased = declared.run('<p>&Oacute; and &oacute;</p>', '');
  assert.ok(cased.bytes > 0);

  /* A mermaid block becomes vector drawing in the page, still offline. */
  const diagrammed = declared.run(
    '<h2>Flow</h2><pre class="mermaid">graph TD\n  A[start] --> B{ok?}\n  B -->|yes| C[done]</pre><p>After.</p>',
    '',
  );
  assert.equal(diagrammed.pages, 1);
  assert.ok(diagrammed.bytes > made.bytes, 'the drawing weighs something');
  /*
   * A diagram that will not draw costs the diagram and not the document.
   *
   * This used to throw, and what a caller did with that was call again
   * with the diagram written slightly differently, three or four times,
   * before saying PDFs were unavailable - having already been handed a
   * working document and thrown it away. The page says what happened,
   * where the drawing would have been, and the rest is written.
   */
  const refused = declared.run(
    '<h1>Report</h1><pre class="mermaid">gantt\n  title x</pre><p>The rest of it.</p>',
    '',
  );
  assert.equal(refused.pages, 1, 'the document is still written');
  const inked = Buffer.from(refused.base64, 'base64').toString('latin1');
  assert.ok(inked.includes('diagram not drawn'), 'and says where the drawing would have been');

  /*
   * And the answer says so, which is the part that matters: a note in the page
   * is for whoever reads the PDF and the log is for whoever runs the server,
   * and neither is read by the thing that called this. An answer that looks
   * like success while a diagram is missing out of the middle of the document
   * is worse than the error this replaced.
   */
  assert.equal(refused.problems.length, 1, 'the answer reports it');
  assert.match(refused.problems[0], /a diagram was not drawn/);

  /* Nothing wrong, nothing reported. */
  assert.deepEqual(declared.run('<p>All fine.</p>', '').problems, []);

  /* A letter the bundled face cannot set is the same kind of thing. */
  const cyrillic = declared.run('<p>Привет</p>', '');
  assert.equal(cyrillic.problems.length, 1, 'unsettable characters are reported too');
  assert.match(cyrillic.problems[0], /cannot be set and are blank/);
  /* Words are placed one at a time, so the prose is checked a word at a time. */
  for (const word of ['Report', 'rest']) {
    assert.ok(inked.includes(word), `${word} survived the diagram failing`);
  }

  /*
   * Every kind the plugin says it draws, drawn. Only the flowchart was
   * covered here, and `erDiagram` had been throwing the whole time: its
   * SVG writes dy="0.35em" where the others write a bare number, Number()
   * made that NaN, and jsPDF answers NaN by refusing the call and taking
   * the document down with it.
   */
  for (const [kind, source] of Object.entries({
    flowchart: 'graph TD\n  A[start] --> B{ok?}\n  B -->|yes| C[done]',
    sequence: 'sequenceDiagram\n  A->>B: hi\n  B-->>A: hello',
    state: 'stateDiagram-v2\n  [*] --> queued\n  queued --> running\n  running --> [*]',
    class: 'classDiagram\n  Plugin <|-- Slack\n  Plugin : +id()',
    er: 'erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains',
  })) {
    const drawn = declared.run(`<h2>${kind}</h2><pre class="mermaid">${source}</pre>`, '');
    assert.ok(drawn.bytes > 0, `${kind} draws into a page`);
    assert.equal(
      Buffer.from(drawn.base64, 'base64').subarray(0, 5).toString('latin1'),
      '%PDF-',
      `${kind} produces a readable file`,
    );
  }

  /* Enough paragraphs run past one A4 page. */
  const long = declared.run(`<p>${'word '.repeat(120)}</p>`.repeat(20), '');
  assert.ok(long.pages > 1, `expected more than one page, got ${long.pages}`);

  assert.throws(() => declared.run('<p>   </p>', ''), /no text to lay out/);
});

test('the markdown plugin declares what the server would accept, and strips markdown to text', async () => {
  const inspected = await inspect(shipped('markdown'));

  assert.equal(inspected.id, 'markdown');
  assert.deepEqual(validate(inspected), []);
  assert.deepEqual(inspected.parameters, []);
  /* String in, string out: there is nothing here to grant. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, []);
  /*
   * `toSlack` moved into the slack plugin, where the conversion is used: post
   * writes mrkdwn itself, and a caller that has to remember a second plugin
   * first is a caller that forgets. What is left here is the direction no
   * service owns.
   */
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['toText'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['toText'],
  );

  const url = new URL(`../../plugins/markdown/markdown.js`, import.meta.url);
  const { default: Markdown } = await import(url.href);
  const functions = new Markdown().functions();
  const one = (name) => functions.find((declared) => declared.name === name);

  const text = one('toText').run('# Title\n\n**bold** [docs](https://x.example) `code`\n\n- one');
  assert.equal(text, 'Title\n\nbold docs (https://x.example) code\n\n• one');
});

test('the date plugin declares what the server would accept, and counts the calendar correctly', async () => {
  const inspected = await inspect(shipped('date'));

  assert.equal(inspected.id, 'date');
  assert.deepEqual(validate(inspected), []);
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['timezone', 'weekend', 'holidays', 'opensAt', 'closesAt'],
  );
  /* A clock and the zone database — both language builtins, neither a door. */
  assert.deepEqual(inspected.permissions, ['TEMPORAL', 'INTL']);
  assert.deepEqual(inspected.capabilities, []);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['today', 'now', 'describe', 'shift', 'shiftBusinessDays', 'businessDaysBetween', 'between', 'isBusinessHours'],
  );
  assert.deepEqual(inspected.tools.length, 8);

  const url = new URL(`../../plugins/date/date.js`, import.meta.url);
  const { default: OrknuxDate } = await import(url.href);

  /* A workspace's answers, without running the constructor that freezes them. */
  const configured = (settings) => {
    const plugin = Object.create(OrknuxDate.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };

  const office = configured({
    timezone: 'Europe/Warsaw',
    holidays: '2026-12-25,2026-12-26',
    opensAt: '09:00',
    closesAt: '17:00',
  });

  /* The one question this plugin is asked most: what is the date. */
  const todayThere = office('today').run('');
  assert.match(todayThere, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayThere, office('now').run('').date, 'today is the date now carries');
  /* And it follows the zone it is asked about, not the configured one. */
  assert.match(office('today').run('Pacific/Auckland'), /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => office('today').run('Mars/Olympus'), /no timezone called/);

  /* 2026-09-19 is a Saturday, which is the whole of what a weekend means here. */
  const saturday = office('describe').run('2026-09-19', '');
  assert.equal(saturday.weekday, 'saturday');
  assert.equal(saturday.weekend, true);
  assert.equal(saturday.businessDay, false);
  assert.equal(saturday.quarter, 3);
  assert.equal(saturday.date, '2026-09-19');

  /* Zero lands on the next working day, which is what "due today" means on a Saturday. */
  assert.equal(office('shiftBusinessDays').run('2026-09-19', 0), '2026-09-21');
  /* Friday plus one working day is the Monday. */
  assert.equal(office('shiftBusinessDays').run('2026-09-18', 1), '2026-09-21');
  /* And the Christmas holidays are stepped over: Thu 24th + 1 skips 25th and 26th. */
  assert.equal(office('shiftBusinessDays').run('2026-12-24', 1), '2026-12-28');

  /* Half-open: Monday to the Tuesday after it is one working day. */
  assert.equal(office('businessDaysBetween').run('2026-09-21', '2026-09-22'), 1);
  /* A whole week is five, not seven. */
  assert.equal(office('businessDaysBetween').run('2026-09-21', '2026-09-28'), 5);
  /* Backwards is negative. */
  assert.equal(office('businessDaysBetween').run('2026-09-28', '2026-09-21'), -5);

  /* Month ends clamp rather than overflowing into the next month. */
  assert.match(office('shift').run('2026-01-31', 1, 'months'), /^2026-02-28/);
  assert.match(office('shift').run('2026-09-19', -1, 'years'), /^2025-09-19/);
  assert.match(office('shift').run('2026-09-19', 3, 'days'), /^2026-09-22/);

  /*
   * A day across the end of summer time is 25 hours, so a shift that moved the
   * instant rather than the wall clock would land an hour out. Warsaw falls
   * back on 2026-10-25.
   */
  const acrossDst = office('shift').run('2026-10-24T12:00:00+02:00', 1, 'days');
  assert.match(acrossDst, /^2026-10-25T12:00:00\+01:00$/);

  /* Calendar counting, not an average month length. */
  assert.equal(office('between').run('2026-01-01', '2026-03-01', 'months'), 2);
  assert.equal(office('between').run('2026-01-31', '2026-02-28', 'months'), 0);
  assert.equal(office('between').run('2026-09-19', '2026-09-22', 'days'), 3);

  /* The gate: a working day inside the working hours, and nothing else. */
  assert.equal(office('isBusinessHours').run('2026-09-21T10:00:00+02:00', ''), true);
  assert.equal(office('isBusinessHours').run('2026-09-21T08:59:00+02:00', ''), false);
  assert.equal(office('isBusinessHours').run('2026-09-21T17:00:00+02:00', ''), false);
  /* Saturday is out whatever the clock says, and so is a configured holiday. */
  assert.equal(office('isBusinessHours').run('2026-09-19T10:00:00+02:00', ''), false);
  assert.equal(office('isBusinessHours').run('2026-12-25T10:00:00+01:00', ''), false);

  /* A weekend that is not Saturday and Sunday, because it is not everywhere. */
  const gulf = configured({ timezone: 'Asia/Dubai', weekend: 'fri,sat' });
  assert.equal(gulf('describe').run('2026-09-20', '').weekend, false);
  assert.equal(gulf('describe').run('2026-09-18', '').weekend, true);

  /* And the refusals name what they take. */
  assert.throws(() => office('shift').run('2026-09-19', 1, 'fortnights'), /no unit called fortnights/);
  assert.throws(() => office('describe').run('not a date', ''), /not a date this understands/);
  assert.throws(
    () => configured({ timezone: 'Mars/Olympus' })('now').run(''),
    /no timezone called Mars\/Olympus/,
  );
});

test('the web plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('web'));

  assert.equal(inspected.id, 'web');
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['backend', 'apiKey', 'answer'],
  );
  /* The key is the one secret; the backend and the answer toggle are settings. */
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.secret),
    [false, true, false],
  );
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.required),
    [true, true, false],
  );

  /*
   * The one parameter here that is a closed choice says so, rather than
   * checking the string itself and throwing a sentence listing the two. The
   * runtime refusal stays until a settings page draws the picker — a text box
   * can still hold a typo, and falling through to the wrong backend silently
   * would be worse than being told.
   */
  assert.deepEqual(inspected.parameters[0].options, ['tavily', 'brave']);
  /* And nothing else names a set: a secret may not, and a key is not a choice. */
  assert.equal(inspected.parameters[1].options, null);
  assert.equal(inspected.parameters[2].options, null);

  /* Nothing of the language is needed — only the request and what came back. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, ['NETWORK_REQUEST']);
  /* Two searches, one index: pictures and pages come from the same key. */
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['searchImages', 'search'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['search', 'searchImages'],
  );
});

test('a web search says which setting is wrong, before reaching anything', async () => {
  const url = new URL(`../../plugins/web/web.js`, import.meta.url);
  const { default: Web } = await import(url.href);

  /*
   * An instance carrying settings. The base class freezes `settings` onto an
   * instance as it constructs one, and does it non-configurably — so a test
   * that wants a workspace's answers builds the object without running that
   * constructor, which is the only door left and is enough: `functions()` is
   * a prototype method and the runs read `this.settings`.
   */
  const configured = (settings) => {
    const plugin = Object.create(Web.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    return plugin.functions().find((one) => one.name === 'search');
  };

  /* Nothing to search for is decided before any setting is looked at. */
  assert.throws(() => configured({}).run('   ', 0), /nothing to search for/);

  /* Then the backend, named or not, and the refusal says what it takes. */
  assert.throws(
    () => configured({}).run('what happened today', 0),
    /backend parameter is not set: it takes tavily or brave/,
  );
  assert.throws(
    () => configured({ backend: 'bing' }).run('what happened today', 0),
    /no search backend called bing: it takes tavily or brave/,
  );

  /*
   * And the key last — asked for by the backend's own name, off a setting
   * that was typed into a page and so is matched trimmed and in any case.
   */
  assert.throws(
    () => configured({ backend: '  TAVILY ' }).run('what happened today', 0),
    /apiKey parameter is not set, and tavily needs one/,
  );
  assert.throws(
    () => configured({ backend: 'Brave' }).run('what happened today', 0),
    /apiKey parameter is not set, and brave needs one/,
  );

  /* With both set, the only thing left is the network — which is not granted here. */
  assert.throws(
    () => configured({ backend: 'brave', apiKey: 'nope' }).run('what happened today', 0),
    /could not reach Brave: this plugin was not granted NETWORK_REQUEST/,
  );
  assert.throws(
    () => configured({ backend: 'tavily', apiKey: 'nope' }).run('what happened today', 0),
    /could not reach Tavily: this plugin was not granted NETWORK_REQUEST/,
  );
});

test('the todo plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('todo'));

  assert.equal(inspected.id, 'todo');
  assert.deepEqual(validate(inspected), []);
  assert.deepEqual(inspected.parameters, []);
  /* The session store is not a capability, so this asks for nothing at all. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, []);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['add', 'list', 'reorder', 'note', 'complete'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['add', 'list', 'reorder', 'note', 'complete'],
  );
});

test('the todo plugin outside a session: an empty truth, and thrown sentences', async () => {
  /*
   * Out here the contract's fallback store holds nothing and takes nothing —
   * so `list` answers the empty list that is true, a write is refused in the
   * server's own sentence, and everything that names a task says which task
   * is not there before it would have written.
   */
  const url = new URL(`../../plugins/todo/todo.js`, import.meta.url);
  const { default: Todo } = await import(url.href);
  const functions = new Todo().functions();
  const one = (name) => functions.find((declared) => declared.name === name);

  assert.deepEqual(one('list').run(), { tasks: [], remaining: 0 });
  assert.throws(() => one('add').run(['split the work']), /could not keep the list: there is no session store here/);
  assert.throws(() => one('add').run(['   ', 42]), /no tasks to add/);
  assert.throws(() => one('reorder').run([1]), /there is no task 1/);
  assert.throws(() => one('note').run(1, 'a finding'), /there is no task 1/);
  assert.throws(() => one('note').run(1, '   '), /no note to add/);
  assert.throws(() => one('complete').run(1), /there is no task 1/);
});

test('the todo plugin works a list end to end where a store exists', async () => {
  const url = new URL(`../../plugins/todo/todo.js`, import.meta.url);
  const { default: Todo } = await import(url.href);
  const functions = new Todo().functions();
  const one = (name) => functions.find((declared) => declared.name === name);

  /*
   * A store the way the session's behaves — values make the trip as JSON, so
   * what comes back out is a copy — swapped in under the fallback `orknux`
   * for the length of this test.
   */
  const held = new Map();
  const store = globalThis.orknux.session.store;
  globalThis.orknux.session.store = {
    put: (key, value) => {
      held.set(key, JSON.stringify(value));
      return { ok: true };
    },
    get: (key) => (held.has(key) ? JSON.parse(held.get(key)) : null),
  };
  try {
    const added = one('add').run(['read the code', 'write the fix', 'run the tests']);
    assert.deepEqual(
      added.tasks.map((task) => task.id),
      [1, 2, 3],
    );
    assert.equal(added.remaining, 3);

    /* One id fronts one task; the rest keep their order. Ids never change. */
    const reordered = one('reorder').run([2]);
    assert.deepEqual(
      reordered.tasks.map((task) => task.title),
      ['write the fix', 'read the code', 'run the tests'],
    );

    const noted = one('note').run(2, 'the bug is in the parser');
    assert.deepEqual(noted, {
      id: 2,
      title: 'write the fix',
      done: false,
      notes: ['the bug is in the parser'],
    });

    assert.equal(one('complete').run(2).remaining, 2);
    /* Already-done counts as done, and the list survives as stored state. */
    assert.equal(one('complete').run(2).remaining, 2);
    const listed = one('list').run();
    assert.equal(listed.tasks.find((task) => task.id === 2).done, true);
    assert.deepEqual(listed.tasks.find((task) => task.id === 2).notes, ['the bug is in the parser']);

    /* New work keeps counting from where the ids left off. */
    assert.deepEqual(
      one('add').run(['ship it']).tasks.map((task) => task.id),
      [2, 1, 3, 4],
    );
  } finally {
    globalThis.orknux.session.store = store;
  }
});

test('a slack upload without a bot token is a thrown sentence, not a request', async () => {
  /*
   * The token is optional at load so the tokenless surface can stand alone —
   * which makes "unset but called" a case both upload functions have to
   * answer well: with the parameter's name, before anything reaches for the
   * network.
   */
  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);
  const functions = new Slack().functions();

  const upload = functions.find((one) => one.name === 'upload');
  assert.throws(
    () => upload.run('C1', 'report.csv', 'a,b\n1,2', '', ''),
    /botToken parameter is not set/,
  );
  const remote = functions.find((one) => one.name === 'remoteFile');
  assert.throws(
    () => remote.run('C1', 'https://example.com/report.pdf', 'The report', 'pdf'),
    /botToken parameter is not set/,
  );
  /* And a remote file that has no url is refused before any of that. */
  assert.throws(() => remote.run('C1', 'not a url', '', ''), /needs the http\(s\) url/);

  const binary = functions.find((one) => one.name === 'uploadBinary');
  assert.throws(() => binary.run('C1', 'a.pdf', 'JVBERi0=', '', ''), /botToken parameter is not set/);
  assert.throws(() => binary.run('C1', 'a.pdf', '   ', '', ''), /no bytes to upload/);

  /* The fetch-and-host door refuses a missing url, then a missing token — before fetching anything. */
  const copied = functions.find((one) => one.name === 'uploadFromUrl');
  assert.throws(() => copied.run('C1', 'not a url', '', '', ''), /fetched by its http\(s\) url/);
  assert.throws(
    () => copied.run('C1', 'https://mermaid.ink/img/abc', '', '', ''),
    /botToken parameter is not set/,
  );
});

test('an ungranted slack call from a shipped plugin is a thrown sentence, not a guess', async () => {
  /*
   * The slack plugin throws where a condition could not be decided, and the
   * fallback helpers answer an ungranted call with the sandbox's own words —
   * so running `isFirstReply` here, outside any grant, has to fail saying so
   * rather than quietly answering false.
   */
  const inspected = await inspect(shipped('slack'));
  assert.ok(inspected.functions.some((declared) => declared.name === 'isFirstReply'));

  const url = new URL(`../../plugins/slack/slack.js`, import.meta.url);
  const { default: Slack } = await import(url.href);
  const declared = new Slack().functions().find((one) => one.name === 'isFirstReply');

  assert.throws(
    () => declared.run.call(new Slack(), { id: 1, type: 'SLACK' }, 'C1', '1.0', '2.0'),
    /could not read the thread: this plugin was not granted SLACK_READ_THREAD/,
  );
});

test('the github plugin verifies a real signature, and refuses a wrong one', async () => {
  /*
   * Testable at all only because crypto is not a granted capability: the
   * tooling hosts a real implementation outside the sandbox, so the one thing
   * actually worth checking about the webhook half — that a delivery GitHub
   * signed is accepted and one it did not is not — can be checked here rather
   * than only on a server.
   */
  const url = new URL(`../../plugins/github/github.js`, import.meta.url);
  const { default: Github } = await import(url.href);

  const secret = 'it is a secret to everybody';
  const configured = () => {
    const plugin = Object.create(Github.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze({ webhookSecret: secret }) });
    return plugin.functions().find((one) => one.name === 'verify');
  };

  /* Signed the way GitHub signs it: HMAC-SHA256 over the exact bytes, as hex. */
  const body = JSON.stringify({ action: 'opened', number: 7 });
  const signed = createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  assert.equal(configured().run({ 'x-hub-signature-256': `sha256=${signed}` }, body), true);

  /* A body that changed by one character is a different signature. */
  assert.equal(
    configured().run({ 'x-hub-signature-256': `sha256=${signed}` }, body.replace('7', '8')),
    false,
  );
  /* And so is one signed with somebody else's secret. */
  const forged = createHmac('sha256', 'not the secret').update(body, 'utf8').digest('hex');
  assert.equal(configured().run({ 'x-hub-signature-256': `sha256=${forged}` }, body), false);

  /* Unsigned, wrongly-signed and malformed deliveries are all refused. */
  assert.equal(configured().run({}, body), false);
  /* The SHA-1 header GitHub still sends for compatibility is not accepted. */
  assert.equal(configured().run({ 'x-hub-signature': `sha1=${signed}` }, body), false);
  assert.equal(configured().run({ 'x-hub-signature-256': 'sha256=nothex' }, body), false);
});

test('the teams plugin verifies a real signature, and refuses a wrong one', async () => {
  const url = new URL(`../../plugins/teams/teams.js`, import.meta.url);
  const { default: Teams } = await import(url.href);

  /* Teams hands out the secret as base64, and signs with those bytes. */
  const secret = Buffer.from('the security token Teams showed').toString('base64');
  const configured = () => {
    const plugin = Object.create(Teams.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze({ webhookSecret: secret }) });
    return plugin.functions().find((one) => one.name === 'verify');
  };

  const body = JSON.stringify({ type: 'message', text: 'hello' });
  const signed = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(body, 'utf8')
    .digest('base64');

  assert.equal(configured().run({ authorization: `HMAC ${signed}` }, body), true);
  /* Teams' own spelling is upper case, and the scheme is matched either way. */
  assert.equal(configured().run({ authorization: `hmac ${signed}` }, body), true);

  /* A changed body, a wrong secret, and a missing header are all refused. */
  assert.equal(configured().run({ authorization: `HMAC ${signed}` }, `${body} `), false);
  const forged = createHmac('sha256', Buffer.from('not it')).update(body, 'utf8').digest('base64');
  assert.equal(configured().run({ authorization: `HMAC ${forged}` }, body), false);
  assert.equal(configured().run({}, body), false);
  /* And a header that is not the scheme Teams sends. */
  assert.equal(configured().run({ authorization: `Bearer ${signed}` }, body), false);
});

test('the sweeps below are sweeping something', () => {
  /*
   * A directory read that finds nothing passes every test that iterates it.
   * This is the one assertion that would notice - the plugins are named here
   * so that a rename or a move fails loudly rather than quietly reducing three
   * whole-repository invariants to nothing at all.
   */
  assert.deepEqual(everyPlugin, [
    'charts',
    'confluence',
    'date',
    'github',
    'http',
    'jenkins',
    'jira',
    'markdown',
    'mermaid',
    'nomnoml',
    'pdf',
    'plantuml',
    'prometheus',
    'slack',
    'teams',
    'todo',
    'web',
  ]);
});

test('the sentinel convention is gone from the parameters that could carry a default', async () => {
  /*
   * Thirty-six places used to say "0 for the default" or "an empty string to
   * use the configured one", each a workaround for every positional argument
   * having to be supplied. Those sentences lived in tool descriptions a model
   * reads on every call, so the convention cost context repeatedly — and
   * "pass 0 to mean default" is exactly the instruction a model gets wrong.
   */
  const optional = [];
  for (const key of everyPlugin) {
    const inspected = await inspect(shipped(key));
    for (const declared of [...inspected.functions, ...inspected.tools]) {
      for (const param of declared.params) {
        if (param.required === false) {
          optional.push(`${key}.${declared.name}.${param.name}`);
        }
      }
    }
  }
  assert.ok(optional.length >= 20, `only ${optional.length} parameters are optional`);

  /*
   * And every one of them is last, or followed only by others that are. An
   * argument is positional, so "may be left out" means nothing in the middle —
   * validate refuses that, and this is the shipped proof it never happens.
   */
  for (const key of everyPlugin) {
    const inspected = await inspect(shipped(key));
    for (const declared of inspected.functions) {
      let seenOptional = false;
      for (const param of declared.params) {
        if (param.required === false) seenOptional = true;
        else {
          assert.ok(
            !seenOptional,
            `${key}.${declared.name} has a required ${param.name} after an optional one`,
          );
        }
      }
    }
  }
});

test('a default is of the type its parameter declared', async () => {
  /* Refused at load rather than at the call that would have found it. */
  for (const key of everyPlugin) {
    const inspected = await inspect(shipped(key));
    for (const declared of inspected.functions) {
      for (const param of declared.params) {
        if (param.default === undefined) continue;
        /*
         * A map's default is an object - `{}`, the empty headers `http_get`
         * starts from. The mapping used to fall through to 'string' for
         * anything it did not recognise, which would have called that default
         * wrong the moment a plugin declared one.
         */
        const kind =
          param.type === 'number'
            ? 'number'
            : param.type === 'boolean'
              ? 'boolean'
              : param.type === 'map' || param.type === 'array'
                ? 'object'
                : 'string';
        assert.equal(
          typeof param.default,
          kind,
          `${key}.${declared.name}.${param.name} is a ${param.type} with a ${typeof param.default} default`,
        );
      }
    }
  }
});

test('the charts plugin declares what the server would accept, and draws offline', async () => {
  const inspected = await inspect(shipped('charts'));

  assert.equal(inspected.id, 'charts');
  assert.deepEqual(validate(inspected), []);
  assert.deepEqual(inspected.parameters, []);
  /* No permission, and one capability: the one thing this sandbox cannot do is rasterise. */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, ['RENDER_PNG']);
  assert.deepEqual(inspected.functions.map((declared) => declared.name), ['render']);
  assert.deepEqual(inspected.tools.map((declared) => declared.name), ['render']);

  const url = new URL(`../../plugins/charts/charts.js`, import.meta.url);
  const { default: Charts } = await import(url.href);
  const render = new Charts().functions().find((declared) => declared.name === 'render').run;

  const spec = JSON.stringify({
    type: 'column',
    title: 'Revenue by quarter',
    unit: '$',
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [
      { name: 'Product', values: [412, 468, 455, 521] },
      { name: 'Services', values: [120, 131, 149, 158] },
    ],
  });

  /* Drawn right here, in a Node with no DOM - the sandbox's own situation. */
  const drawn = render(spec, '', 'svg', 0);
  assert.ok(drawn.svg.startsWith('<svg'), 'renders svg');
  assert.equal(drawn.bytes, drawn.svg.length);
  assert.equal(drawn.width, 800);
  assert.equal(drawn.height, 480);
  assert.ok(drawn.svg.includes('Revenue by quarter'), 'the title is set');
  /* Two series: a figure each - swatch, name and total - standing in for the legend. */
  assert.ok(drawn.svg.includes('Product · total') && drawn.svg.includes('Services · total'), 'two series get a figure each');
  assert.ok(drawn.svg.includes('>$1,856<'), 'and the figure is the total, with the unit on it');

  /* The card's furniture: an eyebrow in small capitals above, the source line below, and a display face on the title. */
  const furnished = render(
    '{"type":"line","eyebrow":"Platform · 14 days","title":"p95","labels":["a","b","c"],"values":[100,120,150],"source":"Source: Prometheus"}',
    '', 'svg', 0,
  ).svg;
  assert.ok(furnished.includes('>PLATFORM · 14 DAYS<'), 'the eyebrow is set in capitals');
  assert.ok(furnished.includes('>Source: Prometheus<'), 'the source line is in the footer');
  assert.ok(furnished.includes("font-family=\"'Familjen Grotesk'"), 'the title is set in the display face');
  /* One series over time: total, average and latest, with how far it moved. */
  assert.ok(furnished.includes('>Total<') && furnished.includes('>Average<') && furnished.includes('>Latest<'), 'three figures');
  assert.ok(furnished.includes('>+50%<'), 'the latest carries its change from the first');
  assert.ok(!render('{"type":"line","labels":["a","b"],"values":[1,2],"summary":false}', '', 'svg', 0).svg.includes('>Total<'), 'summary: false leaves the row out');
  assert.ok(drawn.svg.includes('$1,000') || drawn.svg.includes('$500'), 'ticks carry the unit and a thousands separator');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(drawn.svg), 'no remote reference');
  /* The markup is what the rasteriser will be handed, so it has to say its size and use no CSS. */
  handedOver(drawn.svg, 800);

  /* One series: no legend, and the value on each bar. */
  const single = render('{"type":"bar","labels":["a","b"],"values":[1500,2500]}', '', 'svg', 0).svg;
  assert.ok(single.includes('>1,500<') && single.includes('>2,500<'), 'a single series labels its bars');
  assert.ok(!single.includes('rx="2"'), 'and gets no legend swatch');

  /* Every kind draws, in both themes. */
  for (const type of ['bar', 'column', 'line', 'area', 'pie', 'donut']) {
    for (const theme of ['light', 'dark']) {
      const one = render(JSON.stringify({ type, labels: ['a', 'b', 'c'], values: [3, 2, 1] }), theme, 'svg', 0);
      assert.ok(one.svg.includes('<svg'), `${type} draws in ${theme}`);
    }
  }
  assert.ok(render('{"type":"donut","labels":["a","b"],"values":[3,1]}', '', 'svg', 0).svg.includes('>total<'), 'a donut holds its total');
  assert.ok(render('{"type":"pie","labels":["a","b"],"values":[3,1]}', '', 'svg', 0).svg.includes('75%'), 'a pie labels its shares');

  /* The dark theme paints the dark surface. */
  assert.ok(render(spec, 'dark', 'svg', 0).svg.includes('#141a1f'), 'the theme colours the drawing');

  /* Text that is markup is escaped, not executed. */
  const escaped = render('{"type":"column","title":"<b>&","labels":["<x>"],"values":[1]}', '', 'svg', 0).svg;
  assert.ok(escaped.includes('&lt;b&gt;&amp;') && !escaped.includes('<b>'), 'a title is text');

  /* Refused with a sentence naming what was expected. */
  assert.throws(() => render('{"type":"radar","labels":["a"],"values":[1]}', '', 'svg', 0), /no chart type called radar: it is bar, column, line, area, pie or donut/);
  assert.throws(() => render('{"type":"column","labels":["a","b"],"values":[1]}', '', 'svg', 0), /has 1 values for 2 labels/);
  assert.throws(() => render('{"type":"pie","labels":["a"],"series":[{"values":[1]},{"values":[2]}]}', '', 'svg', 0), /a pie shows one series/);
  assert.throws(() => render('{"type":"pie","labels":["a","b"],"values":[1,-1]}', '', 'svg', 0), /cannot show a negative value/);
  assert.throws(
    () => render(JSON.stringify({ type: 'line', labels: ['a'], series: Array.from({ length: 9 }, () => ({ values: [1] })) }), '', 'svg', 0),
    /9 series is more than the 8/,
  );
  assert.throws(() => render('{"type":"column","labels":["a"],"values":["x"]}', '', 'svg', 0), /not a number at position 1/);
  assert.throws(() => render('not json', '', 'svg', 0), /the spec is not JSON/);
  assert.throws(() => render(spec, 'sepia', 'svg', 0), /no theme called sepia: it is light or dark/);
  assert.throws(() => render(spec, '', 'jpeg', 0), /no format called jpeg/);
  assert.throws(() => render('   ', '', 'svg', 0), /no spec to draw/);

  /* A picture is the default, and out here there is no renderer to draw one. */
  assert.throws(() => render(spec), /could not draw the chart: there is no renderer here/);

  /* Outside a session the fallback store keeps nothing, and the key says so. */
  assert.equal(drawn.key, '', 'no session, no key');

  /* Given one, the key names exactly the bytes that were answered, and the same spec lands on the same key. */
  const held = new Map();
  const store = globalThis.orknux.session.store;
  globalThis.orknux.session.store = {
    put: (key, value) => {
      held.set(key, value);
      return { ok: true };
    },
    get: (key) => (held.has(key) ? held.get(key) : null),
  };
  try {
    const kept = render(spec, '', 'svg', 0);
    assert.ok(kept.key.startsWith('charts.'), 'the key is named for its plugin');
    assert.equal(held.get(kept.key), kept.svg, 'what is kept is what was answered');
    assert.equal(render(spec, '', 'svg', 0).key, kept.key, 'the same spec lands on the same key');

    /* The tool answers the key and not the drawing; the function answers both. */
    const tool = new Charts().tools().find((declared) => declared.name === 'render');
    const said = tool.run(spec, '', 'svg', 0);
    assert.equal(said.svg, '', 'the tool strips the markup');
    assert.equal(said.key, kept.key, 'and names the same bytes');
  } finally {
    globalThis.orknux.session.store = store;
  }

  /* A png is the server's drawing, asked for at 1200 across with the height in proportion. */
  const render_ = globalThis.orknux.render;
  let handed = null;
  globalThis.orknux.render = {
    pngFromSvg: (svg, width) => {
      handed = { svg, width };
      return { base64: 'UE5H', bytes: 3, width, height: Math.round((width * 480) / 800) };
    },
  };
  try {
    const png = render(spec, '', 'png', 0);
    assert.equal(handed.width, 1200);
    assert.equal(png.width, 1200);
    assert.equal(png.height, 720);
    assert.equal(png.png, 'UE5H');
    assert.equal(png.svg, '');
    handedOver(handed.svg, 1200);
    assert.equal(render(spec, '', 'png', 600).width, 600, 'a caller who names a width gets it');
  } finally {
    globalThis.orknux.render = render_;
  }
});

test('the nomnoml plugin declares what the server would accept, and renders offline', async () => {
  const inspected = await inspect(shipped('nomnoml'));

  assert.equal(inspected.id, 'nomnoml');
  assert.deepEqual(validate(inspected), []);
  assert.deepEqual(inspected.parameters, []);
  /*
   * No permission at all — it measures text from metrics it carries rather
   * than through a builtin behind one — and exactly one capability, for the
   * one thing this sandbox cannot do: turn the markup into a picture. The
   * layout is still entirely local; nothing is ever fetched.
   */
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(inspected.capabilities, ['RENDER_PNG']);
  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['render'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['render'],
  );

  const url = new URL(`../../plugins/nomnoml/nomnoml.js`, import.meta.url);
  const { default: Nomnoml } = await import(url.href);
  const functions = new Nomnoml().functions();
  const render = functions.find((declared) => declared.name === 'render').run;

  /* Drawn right here, in a Node with no DOM — the sandbox's own situation. */
  const drawn = render('[<actor>User] -> [<usecase>Load a plugin]', '', '', 'svg', 0);
  assert.ok(drawn.svg.includes('<svg'), 'renders svg');
  assert.ok(drawn.svg.includes('Load a plugin'), 'the nodes are in the drawing');
  assert.equal(drawn.bytes, drawn.svg.length);

  /* And carrying no outward reference, so the drawing is as offline as the drawing was. */
  assert.ok(!drawn.svg.includes('@import'), 'no font import');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(drawn.svg), 'no remote reference');

  /* A theme is directives put in front of the source, so it colours the result. */
  assert.ok(
    render('[a] -> [b]', 'dark', '', 'svg', 0).svg.includes('#141a1f'),
    'the theme colours the drawing',
  );

  /*
   * And the caller's own directives beat the argument, because they come
   * after it — the argument is the convenience, the source is the statement.
   */
  const asked = render('[a] -> [b]', '', 'right', 'svg', 0);
  const said = render('#direction: down\n[a] -> [b]', '', 'right', 'svg', 0);
  assert.notEqual(asked.svg, said.svg, 'a direction in the source overrides the argument');

  assert.throws(() => render('[a] -> [b]', 'solarized', '', 'svg', 0), /no theme called solarized/);
  assert.throws(() => render('[a] -> [b]', '', 'sideways', 'svg', 0), /no direction called sideways/);
  assert.throws(() => render('[a] -> [b]', '', '', 'jpeg', 0), /no format called jpeg/);
  assert.throws(() => render('[a] ->', '', '', 'svg', 0), /could not render the diagram: Parse error/);
  assert.throws(() => render('   ', '', '', 'svg', 0), /no diagram source/);

  /* The editor url escapes the way nomnoml's own does — quotes spelled out. */
  assert.ok(
    render("[<note>it's here]", '', '', 'svg', 0).editor.startsWith('https://www.nomnoml.com/#view/'),
    'the editor url points at the editor',
  );
  assert.ok(
    render("[<note>it's here]", '', '', 'svg', 0).editor.includes('%27'),
    'an apostrophe is escaped',
  );

  /*
   * A picture is the default, and out here there is no renderer to draw one —
   * so the fallback's sentence is what a caller gets, rather than a drawing
   * that silently is not one.
   */
  assert.throws(() => render('[a] -> [b]'), /could not draw the diagram: there is no renderer here/);

  /* Outside a session the fallback store keeps nothing, and the key says so. */
  assert.equal(drawn.key, '', 'no session, no key');

  /* Given one, the key names exactly the bytes that were answered. */
  const held = new Map();
  const store = globalThis.orknux.session.store;
  globalThis.orknux.session.store = {
    put: (key, value) => {
      held.set(key, value);
      return { ok: true };
    },
    get: (key) => (held.has(key) ? held.get(key) : null),
  };
  try {
    const kept = render('[a] -> [b]', '', '', 'svg', 0);
    assert.ok(kept.key.startsWith('nomnoml.'), 'the key is named for its plugin');
    assert.equal(held.get(kept.key), kept.svg, 'what is kept is what was answered');
    /* Content-derived, so the same diagram twice overwrites itself rather than piling up. */
    assert.equal(
      render('[a] -> [b]', '', '', 'svg', 0).key,
      kept.key,
      'the same source lands on the same key',
    );

    /*
     * And with a renderer, the picture is what comes back: png carries the
     * base64, svg is empty, and the key names the bytes rather than the
     * markup — because the png is what a caller goes on to upload.
     */
    const renderer = globalThis.orknux.render;
    let drawnFrom = null;
    let widthAsked;
    globalThis.orknux.render = {
      pngFromSvg: (svg, width) => {
        drawnFrom = svg;
        widthAsked = width;
        /* Stands in for the server: scales the viewBox to the width it was handed. */
        const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg);
        const drawn = width ?? Number(box[1]);
        return {
          base64: 'UE5H',
          bytes: 3,
          width: Math.round(drawn),
          height: Math.round((drawn / Number(box[1])) * Number(box[2])),
        };
      },
    };
    try {
      const picture = render('[a] -> [b]', 'dark', '', 'png', 640);
      assert.equal(picture.png, 'UE5H', 'the picture comes back as base64');
      assert.equal(picture.svg, '', 'and the markup does not come with it');
      assert.equal(picture.bytes, 3, 'the byte count is the picture(s)');
      assert.equal(held.get(picture.key), 'UE5H', 'the key names the picture, not the markup');
      assert.ok(drawnFrom.includes('#141a1f'), 'the themed markup is what was drawn');
      assert.equal(widthAsked, 640, 'the width is passed through');
      assert.equal(handedOver(drawnFrom, 640).width, 640, 'and reaches the markup');

      /*
       * A width of zero asks for the legible default, not for the size the
       * renderer declared. Two boxes declare about eighty points, and a
       * picture eighty pixels wide is one Slack scales up into a blur -
       * redrawing vector larger costs a bigger file and nothing else.
       *
       * The long side is what reaches the floor, not the width. These two
       * boxes are 82 by 160, so a width floor would have drawn them 1200
       * across and 2341 down - taller than the budget for no gain, because
       * the side that has to be legible is already past it.
       *
       * Drawn `plain`, because 82 by 160 is nomnoml's own geometry and the
       * house theme adds air; the arithmetic being pinned here is the
       * scale's, not the theme's.
       */
      const tiny = render('[a] -> [b]', 'plain', '', 'png', 0);
      assert.equal(widthAsked, 615, 'the long side reaches the floor, and the width follows');
      handedOver(drawnFrom, 615);
      assert.equal(Math.max(tiny.width, tiny.height), 1200, 'which is what the floor is measured on');

      /*
       * And the two shapes that made this a rule about area rather than
       * width. Both were shipped and both came out wrong.
       *
       * Wide: fourteen unconnected pairs lay out side by side and declare
       * 4074 by 192. A cap of 2400 on
       * the width drew that at 0.59x - smaller than it laid itself out, which
       * is where text stops existing - and Slack fitted the resulting sliver
       * to its column. Nothing may be drawn below 1x now, whatever it costs.
       */
      const chain = Array.from(
        { length: 14 },
        (_, at) => `[node ${at} with a fairly long label|field: string] -> [node ${at + 1}]`,
      ).join('\n');
      const wide = render(chain, '', '', 'png', 0);
      handedOver(drawnFrom, widthAsked);
      assert.ok(wide.width / 4074 >= 1, `a wide diagram was shrunk to ${wide.width / 4074}x`);
      assert.ok(wide.width * wide.height <= 4e6, 'and is still inside the area budget');

      /*
       * Tall: the other direction, where asking for a width says nothing at
       * all. A diagram five times longer than it is wide drawn 1200 across is
       * 5890 down, and a server ceiling then brings the whole thing back to
       * something unreadable. The budget is on the area, so it catches both.
       */
      const linked = Array.from({ length: 16 }, (_, at) => `[step ${at}] -> [step ${at + 1}]`)
        .join('\n');
      const tall = render(linked, '', '', 'png', 0);
      handedOver(drawnFrom, widthAsked);
      assert.ok(tall.width * tall.height <= 4e6, `a tall diagram covered ${tall.width * tall.height}`);
      assert.ok(tall.height / tall.width > 1, 'and is still the shape it was drawn in');

      /* What comes back is what the renderer said, not what was asked for. */
      assert.equal(tiny.width, 615, 'the answer carries the drawn size');
      assert.ok(tiny.height > tiny.width, 'both sides of it');
    } finally {
      globalThis.orknux.render = renderer;
    }
  } finally {
    globalThis.orknux.session.store = store;
  }
});

test('the http plugin declares what the server would accept', async () => {
  const inspected = await inspect(shipped('http'));

  assert.equal(inspected.id, 'http');
  assert.equal(inspected.apiVersion, 1);
  assert.deepEqual(validate(inspected), []);

  assert.deepEqual(inspected.permissions, []);
  /*
   * The widest capability there is, asked for without naming a service —
   * which is the whole point of this plugin and the whole of its risk. What
   * narrows it is `hosts`, and that is a workspace's decision rather than a
   * declaration, so this is the one plugin whose capability line says less
   * than its settings do.
   */
  assert.deepEqual(inspected.capabilities, ['NETWORK_REQUEST']);

  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.name),
    ['baseUrl', 'hosts', 'token', 'authHeader', 'authScheme'],
  );
  /* The credential is a secret; the fence is not, because a fence is worth reading. */
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.secret),
    [false, false, true, false, false],
  );
  assert.deepEqual(
    inspected.parameters.map((parameter) => parameter.required),
    [false, false, false, false, false],
  );

  assert.deepEqual(
    inspected.functions.map((declared) => declared.name),
    ['get', 'post', 'request', 'download'],
  );
  assert.deepEqual(
    inspected.tools.map((declared) => declared.name),
    ['get', 'post', 'request', 'download'],
  );

  /*
   * Three answers are untyped maps rather than a declared shape: headers and
   * a parsed body hold whatever the other end decided to send, and a property
   * of kind `object` has to name the object it points at. There is no naming
   * somebody else's JSON, so the fields are named in the descriptions
   * instead — the same trade `prometheus_query` makes.
   */
  assert.deepEqual(
    inspected.functions.map((declared) => declared.returnType),
    ['map', 'map', 'map', 'Fetched'],
  );
  assert.deepEqual(
    inspected.objects.map((shape) => shape.name),
    ['Fetched'],
  );
  for (const declared of inspected.functions.slice(0, 3)) {
    assert.match(
      declared.description,
      /status/,
      `${declared.name} answers a map without saying what is in it`,
    );
  }
});

test('the http plugin fences the host, and keeps the credential inside it', async () => {
  const url = new URL(`../../plugins/http/http.js`, import.meta.url);
  const { default: Http } = await import(url.href);

  const configured = (settings) => {
    const plugin = Object.create(Http.prototype);
    Object.defineProperty(plugin, 'settings', { value: Object.freeze(settings) });
    const functions = plugin.functions();
    return (name) => functions.find((one) => one.name === name);
  };

  /* Nothing to do with is decided before any setting is read. */
  assert.throws(() => configured({})('get').run('   ', {}), /there is no url to fetch/);
  assert.throws(
    () => configured({})('get').run('/v1/issues', {}),
    /is not an absolute url, and no baseUrl is configured/,
  );
  /* A scheme this cannot speak is refused by name rather than called a path. */
  assert.throws(
    () => configured({})('get').run('ftp://files.example.com/x', {}),
    /ftp is not a scheme this can fetch/,
  );
  assert.throws(
    () => configured({})('request').run('https://api.example.com/x', 'FETCH', {}, {}),
    /no method called FETCH/,
  );

  const sent = [];
  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = (what) => {
    sent.push(what);
    return { status: 204, headers: {}, body: '', json: null };
  };
  try {
    /* A path resolves against baseUrl, and baseUrl's own host is always inside the fence. */
    configured({ baseUrl: 'https://api.example.com/', token: 'SECRET' })('get').run('/v1/issues', {});
    /* A host named in `hosts` is too, absolute url and all. */
    configured({ hosts: 'api.example.com, status.example.com', token: 'SECRET' })('get')
      .run('https://status.example.com/up', {});
    /* A caller's own header wins: it is saying it has a better credential. */
    configured({ baseUrl: 'https://api.example.com', token: 'SECRET' })('get')
      .run('/x', { Authorization: 'Bearer THEIRS' });
    /* And a header name and scheme of the workspace's choosing, for the x-api-key APIs. */
    configured({
      baseUrl: 'https://api.example.com',
      token: 'SECRET',
      authHeader: 'X-Api-Key',
      authScheme: '',
    })('get').run('/x', {});

    /*
     * The fence, and the reason for it. A model persuaded to fetch some other
     * host by something it read in a page must not take the workspace's key
     * there — so the refusal happens before a request is made, and `sent`
     * staying four long is the proof that nothing left.
     */
    assert.throws(
      () =>
        configured({ hosts: 'api.example.com', token: 'SECRET' })('get')
          .run('https://elsewhere.test/collect', {}),
      /elsewhere\.test is not a host this plugin may reach: it is configured for api\.example\.com/,
    );
    /* A token with nowhere named is refused rather than sent to whatever was asked for. */
    assert.throws(
      () => configured({ token: 'SECRET' })('get').run('https://anywhere.test/x', {}),
      /no baseUrl and no hosts are, so there is nowhere it may safely be sent/,
    );
    /* With no token there is nothing to leak, so an open plugin reaches anywhere the proxy allows. */
    configured({})('get').run('https://anywhere.test/x', {});
  } finally {
    globalThis.orknux.http.request = door;
  }

  assert.equal(sent.length, 5, 'a refused call is refused before it is made');
  const [onBase, onListed, withTheirs, withApiKey, unfenced] = sent;

  assert.equal(onBase.url, 'https://api.example.com/v1/issues', 'one slash, not two');
  assert.equal(onBase.method, 'GET');
  assert.equal(onBase.headers.authorization, 'Bearer SECRET');

  assert.equal(onListed.url, 'https://status.example.com/up');
  assert.equal(onListed.headers.authorization, 'Bearer SECRET');

  assert.equal(withTheirs.headers.authorization, 'Bearer THEIRS');

  assert.equal(withApiKey.headers['x-api-key'], 'SECRET', 'sent bare, the way x-api-key wants it');
  assert.equal(withApiKey.headers.authorization, undefined);

  assert.equal(unfenced.headers.authorization, undefined, 'no token, no header');

  /* A port and a credential in the authority are not the host being fenced on. */
  const ported = [];
  const again = globalThis.orknux.http.request;
  globalThis.orknux.http.request = (what) => {
    ported.push(what);
    return { status: 200, headers: {}, body: '{}', json: { ok: true } };
  };
  try {
    configured({ hosts: 'API.Example.com' })('get').run('https://api.example.com:8443/v1/x', {});
  } finally {
    globalThis.orknux.http.request = again;
  }
  assert.equal(ported.length, 1, 'the port is not part of the host');
});

test('an http answer is read rather than thrown, and download names its bytes', async () => {
  const url = new URL(`../../plugins/http/http.js`, import.meta.url);
  const { default: Http } = await import(url.href);

  const plugin = Object.create(Http.prototype);
  Object.defineProperty(plugin, 'settings', { value: Object.freeze({ hosts: 'api.example.com' }) });
  const get = plugin.functions().find((one) => one.name === 'get').run;

  const door = globalThis.orknux.http.request;
  globalThis.orknux.http.request = () => ({
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: '{"message":"no such issue"}',
    json: { message: 'no such issue' },
  });
  try {
    /*
     * A 404 is an answer, not a failure of the call. Throwing would lose the
     * body, which is where the other end said what it objected to — and "it
     * failed" is not something a workflow can branch on.
     */
    const answered = get('https://api.example.com/v1/issues/9', {});
    assert.equal(answered.status, 404);
    assert.equal(answered.ok, false);
    assert.equal(answered.json.message, 'no such issue');
    assert.equal(answered.body, '{"message":"no such issue"}');

    /* An array parses, but a map cannot hold one — so it stays in `body` and json is null. */
    globalThis.orknux.http.request = () => ({ status: 200, headers: {}, body: '[1,2]', json: [1, 2] });
    const listed = get('https://api.example.com/v1/all', {});
    assert.equal(listed.ok, true);
    assert.equal(listed.json, null, 'an array does not fit a map');
    assert.equal(listed.body, '[1,2]', 'and is still there for whoever asked for it');

    /* Only an unreachable host throws, because then there is no answer to read. */
    globalThis.orknux.http.request = () => ({ error: 'connection refused' });
    assert.throws(
      () => get('https://api.example.com/v1/x', {}),
      /could not reach api\.example\.com: connection refused/,
    );
  } finally {
    globalThis.orknux.http.request = door;
  }

  /*
   * And the bytes. The function keeps base64 filled, because a workflow node
   * has no session store to read a key from; the tool empties it, because a
   * model reading a megabyte on the way to a twelve-character key is the one
   * thing that does not survive the trip to the next call.
   */
  const held = new Map();
  const store = globalThis.orknux.session.store;
  const fetching = globalThis.orknux.http.download;
  globalThis.orknux.session.store = {
    put: (key, value) => {
      held.set(key, value);
      return { ok: true };
    },
    get: (key) => (held.has(key) ? held.get(key) : null),
  };
  globalThis.orknux.http.download = () => ({
    status: 200,
    headers: {},
    base64: 'JVBERi0xLjQK',
    size: 9,
    contentType: 'application/pdf',
  });
  try {
    const got = plugin.functions().find((one) => one.name === 'download').run;
    const fetched = got('https://api.example.com/reports/q3.pdf', {});
    assert.ok(fetched.key.startsWith('http.'), 'the key is named for its plugin');
    assert.equal(held.get(fetched.key), 'JVBERi0xLjQK', 'what is kept is what was fetched');
    assert.equal(fetched.base64, 'JVBERi0xLjQK', 'the function still carries the bytes');
    assert.equal(fetched.contentType, 'application/pdf');

    /* Content-derived, so the same file twice overwrites itself rather than piling up. */
    assert.equal(got('https://api.example.com/reports/q3.pdf', {}).key, fetched.key);

    const asTool = plugin.tools().find((one) => one.name === 'download' && one.run !== undefined).run;
    const named = asTool('https://api.example.com/reports/q3.pdf', {});
    assert.equal(named.key, fetched.key, 'the same bytes under the same name');
    assert.equal(named.base64, '', 'and the agent gets the name, not the megabyte');
    assert.equal(held.get(named.key), 'JVBERi0xLjQK', 'which is still there to be had');
  } finally {
    globalThis.orknux.session.store = store;
    globalThis.orknux.http.download = fetching;
  }
});
