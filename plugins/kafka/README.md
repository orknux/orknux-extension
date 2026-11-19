# Kafka

A Kafka cluster's shape, read from a workflow's condition or an agent's hand:
which topics there are and how they are laid out, how many records each holds,
whether a partition has lost a replica, and whether a consumer group is keeping
up.

**Metadata only.** Nothing here reads a record, writes one, or changes
anything - every call describes or lists. The one capability it asks for,
`KAFKA_READ_METADATA`, says exactly that.

It brings a connection kind of its own, **Kafka**. Add one per cluster:

- **URL** - the bootstrap brokers, `host:port` or several separated by commas:
  `kafka-1:9092,kafka-2:9092`.
- **Auth** - **None** for a cluster with no login, or **Basic** with
  `user:password` for SASL. A login is reached over `SASL_SSL` with `PLAIN`
  unless the URL says otherwise: `SASL_PLAINTEXT://…`, `SSL://…`, or
  `?mechanism=SCRAM-SHA-256` / `SCRAM-SHA-512` after the brokers.

Every call takes the connection to ask as its first argument, `kafka`, so
production and staging are two connections in one workspace and each call says
which it means. Testing a connection asks the cluster for its id and brokers.

The login needs only `Describe` on the cluster, its topics and its groups, and
`DescribeConfigs` on topics for their settings.

| Function | Answers |
|---|---|
| `cluster(kafka)` | The cluster's id, its controller and every broker. |
| `listTopics(kafka, query, withInternal, limit)` | Topics by name with partition count and replication factor; `query` words narrow them. |
| `describeTopic(kafka, topic)` | Every partition's leader, replicas, in-sync replicas, earliest and latest offset; the settings that differ from the defaults. |
| `listGroups(kafka, query, limit)` | Consumer groups by id with their state. |
| `describeGroup(kafka, group)` | A group's members and their partitions, and its committed offset and lag on every partition. |

All five are offered to agents as tools.

The server makes every call with Kafka's own client, so the plugin never holds
a socket or a password. Kafka's client cannot go through a proxy: a broker one
of the installation's proxy rules routes is refused in words rather than
reached around the rule. Needs Orknux 1.4.7 or later.
