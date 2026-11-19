/*
 * Kafka - a cluster's metadata, read from a workflow or by an agent: which
 * topics there are and how they are laid out, how many records each holds,
 * and which consumer groups are keeping up.
 *
 * Metadata only, and on purpose: nothing here reads a record, writes one or
 * changes anything. The capability it asks for, KAFKA_READ_METADATA, says
 * exactly that, so granting it is granting a look at the shape of a cluster
 * and nothing more.
 *
 * The plugin never talks to a broker. Kafka's protocol is not HTTP, so the
 * request door could not reach one even if it were granted; the server holds
 * Kafka's own client and the connection's login, and this hands it a
 * connection and a question. Where a broker may be reached is still the
 * installation's proxy rules' to say.
 */

/** A connection's id, or a sentence about what was passed instead. */
function cluster(connection) {
  if (connection === undefined || connection === null || connection === '') {
    throw new Error('no Kafka connection was given, and every Kafka call needs one');
  }
  const id = typeof connection === 'object' ? connection.id : connection;
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error('the kafka argument is not a connection - pass a Kafka connection');
  }
  return connection;
}

/** One question to the server's door, answered or thrown in its own words. */
function ask(connection, what, args) {
  const answered = orknux.kafka.metadata(cluster(connection), what, args ?? {});
  if (answered === null || typeof answered !== 'object') {
    throw new Error(`Kafka's ${what} came back as nothing`);
  }
  if (typeof answered.error === 'string') {
    throw new Error(answered.error);
  }
  return answered;
}

/** A count a caller gave, held to what the server will answer. */
function capped(limit) {
  const asked = Math.trunc(Number(limit));
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : 100;
}

const CONNECTION = {
  name: 'kafka',
  type: 'connection',
  description: 'Which cluster to ask: a Kafka connection, which carries its brokers and login.',
};

const GUIDE = `
**URL** is the bootstrap brokers as Kafka itself takes them: \`host:port\`, or
several separated by commas - \`kafka-1:9092,kafka-2:9092\`.

**Signing in.** A cluster with no login takes **None**. One with SASL takes
**Basic**, with \`user:password\` as the secret; it is then reached over
\`SASL_SSL\` with \`PLAIN\` unless the URL says otherwise:

- \`SASL_PLAINTEXT://kafka-1:9092\` - SASL without TLS
- \`SSL://kafka-1:9093\` - TLS without a login
- \`SASL_SSL://kafka-1:9093?mechanism=SCRAM-SHA-512\` - SCRAM rather than PLAIN

The login needs only to describe: \`Describe\` on the cluster, topics and
groups, and \`DescribeConfigs\` on topics for their settings. Nothing is read
from a topic and nothing is changed.

Kafka's client cannot go through a proxy, so a broker an installation's proxy
rule routes is refused rather than reached around the rule.
`.trim();

export default class Kafka extends OrknuxPlugin {

  id() {
    return 'kafka';
  }

  apiVersion() {
    return 1;
  }

  connectionTypes() {
    return [
      {
        name: 'kafka',
        label: 'Kafka',
        description: 'A Kafka cluster, by its bootstrap brokers - Apache Kafka, Redpanda, Confluent, MSK.',
        urlPlaceholder: 'kafka-1:9092,kafka-2:9092',
        guide: GUIDE,
        /* Testing a connection is asking the cluster who it is. */
        check: (connection) => {
          const said = ask(connection, 'cluster');
          const brokers = Array.isArray(said.brokers) ? said.brokers.length : 0;
          return { ok: true, message: `Cluster ${said.clusterId ?? '(no id)'}, ${brokers} broker${brokers === 1 ? '' : 's'}` };
        },
      },
    ];
  }

  permissions() {
    return [];
  }

  capabilities() {
    return ['KAFKA_READ_METADATA'];
  }

  objects() {
    return [
      new OrknuxObject({
        name: 'Broker',
        description: 'One broker, as the cluster advertises it.',
        properties: [
          { name: 'id', kind: 'number', description: 'Its node id - what a partition names as leader and replica.' },
          { name: 'host', kind: 'string' },
          { name: 'port', kind: 'number' },
          { name: 'rack', kind: 'string', description: 'Its rack or zone, or null where none is set.' },
        ],
      }),
      new OrknuxObject({
        name: 'Cluster',
        description: 'Who the cluster is and which brokers it has.',
        properties: [
          { name: 'clusterId', kind: 'string' },
          { name: 'controller', kind: 'object', of: 'Broker', description: 'The broker acting as controller.' },
          { name: 'brokers', kind: 'array', of: 'Broker', description: 'Every broker, by id.' },
        ],
      }),
      new OrknuxObject({
        name: 'TopicSummary',
        description: 'One topic, as a listing shows it.',
        properties: [
          { name: 'name', kind: 'string' },
          { name: 'internal', kind: 'boolean', description: "Kafka's own, such as __consumer_offsets." },
          { name: 'partitions', kind: 'number' },
          { name: 'replicationFactor', kind: 'number', description: 'How many copies of each partition are kept.' },
        ],
      }),
      new OrknuxObject({
        name: 'Topics',
        properties: [
          { name: 'topics', kind: 'array', of: 'TopicSummary', description: 'Alphabetical, capped by limit.' },
          { name: 'total', kind: 'number', description: 'How many matched, before limit.' },
          { name: 'complete', kind: 'boolean', description: 'Whether every match came back.' },
        ],
      }),
      new OrknuxObject({
        name: 'Partition',
        description: 'One partition: where it lives and which offsets it holds.',
        properties: [
          { name: 'partition', kind: 'number' },
          { name: 'leader', kind: 'number', description: 'The broker id leading it, or null where none is - an offline partition.' },
          { name: 'replicas', kind: 'array', of: 'number', description: 'Broker ids holding a copy.' },
          { name: 'isr', kind: 'array', of: 'number', description: 'Broker ids in sync. Fewer than replicas is an under-replicated partition.' },
          { name: 'earliest', kind: 'number', description: 'The oldest offset still kept.' },
          { name: 'latest', kind: 'number', description: 'The offset the next record will get.' },
          { name: 'messages', kind: 'number', description: 'latest minus earliest: about how many records it holds.' },
        ],
      }),
      new OrknuxObject({
        name: 'TopicConfig',
        description: 'One topic setting that is not the default.',
        properties: [
          { name: 'name', kind: 'string', description: 'As Kafka spells it: retention.ms, cleanup.policy…' },
          { name: 'value', kind: 'string', description: 'Null for a secret one, which is never said.' },
        ],
      }),
      new OrknuxObject({
        name: 'TopicDetail',
        description: 'One topic whole.',
        properties: [
          { name: 'name', kind: 'string' },
          { name: 'internal', kind: 'boolean' },
          { name: 'id', kind: 'string', description: "Kafka's topic id." },
          { name: 'partitions', kind: 'array', of: 'Partition' },
          { name: 'messages', kind: 'number', description: 'About how many records the topic holds, over every partition.' },
          {
            name: 'configs',
            kind: 'array',
            of: 'TopicConfig',
            description: "The topic's settings that differ from the broker's defaults, by name.",
          },
        ],
      }),
      new OrknuxObject({
        name: 'GroupSummary',
        properties: [
          { name: 'id', kind: 'string' },
          { name: 'state', kind: 'string', description: 'Stable, Empty, PreparingRebalance, Dead…' },
          { name: 'simple', kind: 'boolean', description: 'Whether it only commits offsets and has no members of its own.' },
        ],
      }),
      new OrknuxObject({
        name: 'Groups',
        properties: [
          { name: 'groups', kind: 'array', of: 'GroupSummary', description: 'By id, capped by limit.' },
          { name: 'total', kind: 'number', description: 'How many matched, before limit.' },
          { name: 'complete', kind: 'boolean', description: 'Whether every match came back.' },
        ],
      }),
      new OrknuxObject({
        name: 'GroupMember',
        properties: [
          { name: 'memberId', kind: 'string' },
          { name: 'clientId', kind: 'string', description: 'What the consumer calls itself - usually the service.' },
          { name: 'host', kind: 'string' },
          { name: 'assigned', kind: 'array', of: 'string', description: 'Its partitions, as topic-partition.' },
        ],
      }),
      new OrknuxObject({
        name: 'GroupOffset',
        description: 'Where the group is in one partition, and how far that is from its end.',
        properties: [
          { name: 'topic', kind: 'string' },
          { name: 'partition', kind: 'number' },
          { name: 'committed', kind: 'number', description: 'The offset the group will read next.' },
          { name: 'latest', kind: 'number', description: "The partition's end." },
          { name: 'lag', kind: 'number', description: 'How many records the group has still to read there.' },
        ],
      }),
      new OrknuxObject({
        name: 'GroupDetail',
        description: 'One consumer group whole.',
        properties: [
          { name: 'id', kind: 'string' },
          { name: 'state', kind: 'string' },
          { name: 'coordinator', kind: 'object', of: 'Broker', description: 'The broker coordinating it.' },
          { name: 'assignor', kind: 'string', description: 'How its partitions are shared out, or null.' },
          { name: 'members', kind: 'array', of: 'GroupMember', description: 'Empty for a group nobody is consuming in.' },
          { name: 'offsets', kind: 'array', of: 'GroupOffset', description: 'Every partition it has committed to.' },
          { name: 'lag', kind: 'number', description: 'Its lag over every partition, summed.' },
        ],
      }),
    ];
  }

  /* The agents' surface: every call, fronted, so each stays its function's own. */
  tools() {
    return [
      new OrknuxFunctionTool({ function: 'cluster' }),
      new OrknuxFunctionTool({ function: 'listTopics' }),
      new OrknuxFunctionTool({ function: 'describeTopic' }),
      new OrknuxFunctionTool({ function: 'listGroups' }),
      new OrknuxFunctionTool({ function: 'describeGroup' }),
    ];
  }

  functions() {
    return [
      new OrknuxFunction({
        name: 'cluster',
        description:
          'Says which Kafka cluster a connection reaches: its id, its controller, and every broker ' +
          'with its host, port and rack. The first thing to ask of a cluster you have not read before.',
        params: [CONNECTION],
        returnType: 'Cluster',
        run: (kafka) => ask(kafka, 'cluster'),
      }),

      new OrknuxFunction({
        name: 'listTopics',
        description:
          "Lists a Kafka cluster's topics alphabetically, each with its partition count and replication " +
          'factor. query narrows them to names containing every word of it, in any case ("orders eu"); ' +
          "leave it empty for all. withInternal includes Kafka's own topics such as __consumer_offsets. " +
          'Answers total, the count before limit, so a long list says it was cut.',
        params: [
          CONNECTION,
          { name: 'query', type: 'string', required: false, default: '' },
          { name: 'withInternal', type: 'boolean', required: false, default: false },
          { name: 'limit', type: 'number', required: false, default: 100 },
        ],
        returnType: 'Topics',
        run: (kafka, query, withInternal, limit) =>
          ask(kafka, 'topics', { query: String(query ?? ''), internal: withInternal === true, limit: capped(limit) }),
      }),

      new OrknuxFunction({
        name: 'describeTopic',
        description:
          'Reads one Kafka topic whole: for each partition its leader, replicas and in-sync replicas ' +
          '(fewer in sync than replicas is under-replicated; no leader is offline), its earliest and ' +
          'latest offset and about how many records it holds; and the topic settings that differ from ' +
          'the broker defaults, such as retention.ms or cleanup.policy. Never reads a record.',
        params: [CONNECTION, { name: 'topic', type: 'string' }],
        returnType: 'TopicDetail',
        run: (kafka, topic) => {
          const name = String(topic ?? '').trim();
          if (name.length === 0) throw new Error('which topic? pass its name');
          const read = ask(kafka, 'topic', { name });
          /* The door answers a map by name; a declared shape needs a list of them. */
          const configs = read.configs !== null && typeof read.configs === 'object' ? read.configs : {};
          return { ...read, configs: Object.entries(configs).map(([key, value]) => ({ name: key, value })) };
        },
      }),

      new OrknuxFunction({
        name: 'listGroups',
        description:
          "Lists a Kafka cluster's consumer groups by id, each with its state - Stable while it is " +
          'consuming, Empty when nobody is. query narrows them to ids containing every word of it; leave ' +
          'it empty for all. To see whether one is keeping up, describeGroup it.',
        params: [
          CONNECTION,
          { name: 'query', type: 'string', required: false, default: '' },
          { name: 'limit', type: 'number', required: false, default: 100 },
        ],
        returnType: 'Groups',
        run: (kafka, query, limit) => ask(kafka, 'groups', { query: String(query ?? ''), limit: capped(limit) }),
      }),

      new OrknuxFunction({
        name: 'describeGroup',
        description:
          'Reads one Kafka consumer group whole: its state, its members with the partitions each is ' +
          'assigned, and for every partition it has committed to, the committed offset, the end of the ' +
          'partition and the lag between them - plus the lag summed. The answer to "is this consumer ' +
          'keeping up" and "who is consuming this".',
        params: [CONNECTION, { name: 'group', type: 'string' }],
        returnType: 'GroupDetail',
        run: (kafka, group) => {
          const name = String(group ?? '').trim();
          if (name.length === 0) throw new Error('which consumer group? pass its id');
          return ask(kafka, 'group', { name });
        },
      }),
    ];
  }
}
