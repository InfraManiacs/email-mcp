# email-mcp Helm chart

Runs `email-mcp http` (Streamable HTTP) so many agents can share one MCP
endpoint for many mailboxes.

## Trust model

The server is **single-tenant**: one static bearer token, and every holder of
that token can read, send and delete mail in **every** configured account.
There is no per-client identity, per-account scoping or OAuth on the MCP side.
If different agents should see different mailboxes, install one release per
group (each with its own token and account list), and set
`settingsToml` → `read_only = true` on releases that should never send.

## Install

```bash
kubectl create ns email-mcp
kubectl -n email-mcp create secret generic email-mcp-token \
  --from-literal=EMAIL_MCP_HTTP_TOKEN="$(openssl rand -base64 48)"
kubectl -n email-mcp create secret generic email-mcp-credentials \
  --from-literal=PERSONAL_PASSWORD='abcd efgh ijkl mnop'   # Gmail App Password

helm install mail-hub charts/email-mcp -n email-mcp \
  --set auth.existingSecret=email-mcp-token \
  --set credentials.existingSecret=email-mcp-credentials \
  -f my-accounts.yaml
```

```yaml
# my-accounts.yaml
accounts:
  - name: personal
    email: me@gmail.com
    provider: gmail              # gmail | outlook | yahoo | icloud | fastmail | zoho
    passwordEnv: PERSONAL_PASSWORD
  - name: custom
    email: me@example.org
    passwordEnv: CUSTOM_PASSWORD
    imap: {host: mail.example.org, port: 993}
    smtp: {host: mail.example.org, port: 587, tls: false, starttls: true}
```

Each account references its credential as `env:<VAR>`; the variables come
from `credentials.existingSecret` via `envFrom`. Adding an account means
adding a key to that Secret and an entry to `accounts`.

### Gmail

Use an **App Password** (Google Account → Security → 2-Step Verification →
App passwords). It is the most reliable option. OAuth2 is marked experimental
upstream and the server has no consent flow, so you would have to mint the
refresh token yourself (`oauth2.clientIdEnv` / `clientSecretEnv` /
`refreshTokenEnv`).

## Exposure

- `ingress.*` — standard Ingress.
- `ingressRoute.*` — Traefik IngressRoute; `ingressRoute.namespace` lets it
  live next to a shared TLS secret (requires Traefik `allowCrossNamespace`).

Only `http.path` (default `/mcp`) is routed; `/healthz` stays cluster-internal.
The Host-header allowlist is derived from the Service DNS names and the
ingress hosts unless `http.allowedHosts` is set.

## Storage

- `persistence.state` (PVC, default on): scheduled-send queue and data dir.
  Small files, fine on NFS.
- `persistence.cache` (default emptyDir): the SQLite mirror. Rebuilt from
  IMAP after a restart. Avoid putting it on NFS.

The Deployment uses `Recreate` and must stay at one replica.

## Client config

```json
{
  "mcpServers": {
    "mail-hub": {
      "type": "http",
      "url": "https://mail-hub.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MAIL_HUB_TOKEN}" }
    }
  }
}
```
