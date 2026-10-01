# Prometheus

The question "what is the system doing", asked from a workflow's condition or
an agent's hand: is the error rate above the line, is this job up, what
metrics are there to ask about at all.

It brings a connection kind of its own, **Prometheus**. Add one per server
with the server's root as its URL: a bare Prometheus needs no auth, one behind
a token takes Bearer, and a Grafana Cloud endpoint takes Basic with
`instanceId:token` as the secret. Then point the plugin's `prometheus`
parameter at the one to ask.

The address and the credential live on the connection rather than on the
plugin's page, so they are kept encrypted, and a workspace can hold as many
Prometheus servers as it has. Calls run through the server under
`NETWORK_REQUEST`, so the installation's proxy rules govern where they may go.

Coming from 0.4: the `url`, `username` and `token` parameters are gone. Make a
Prometheus connection from them and point `prometheus` at it.
