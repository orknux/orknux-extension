# Prometheus

The question "what is the system doing", asked from a workflow's condition or
an agent's hand: is the error rate above the line, is this job up, what
metrics are there to ask about at all.

It brings a connection kind of its own, **Prometheus**. Add one per server
with the server's root as its URL: a bare Prometheus needs no auth, one behind
a token takes Bearer, and a Grafana Cloud endpoint takes Basic with
`instanceId:token` as the secret.

Every call takes the connection to ask as its first argument, `prometheus` -
picked from a list in a workflow, passed by id from an agent. So production,
staging and a Thanos in front of both are three connections in one workspace,
and each call says which it means. There is nothing to configure on the
plugin's own page.

The address and the credential live on the connection, so they are kept
encrypted. Calls run through the server under `NETWORK_REQUEST`, so the
installation's proxy rules govern where they may go.

Coming from 0.5: the plugin's `prometheus` parameter is gone, and
`listMetrics` and `query` take the connection as their first argument instead.
A workflow calling either needs that argument set to the connection the
parameter used to name.
