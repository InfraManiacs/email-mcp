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

### Google Workspace: service account (recommended)

For Workspace domains you administer, use a service account with
domain-wide delegation: no consent screen, no Google app verification, no
per-user login.

1. Google Cloud → IAM & Admin → Service Accounts → create one (no roles) and
   download a JSON key. Note its **Unique ID**.
2. Each domain's Admin console → Security → API controls → Domain-wide
   delegation → Add new: the Unique ID, scope `https://mail.google.com/`.
3. Make sure IMAP is enabled (Apps → Google Workspace → Gmail → End User Access).
4. Store the key and list the addresses:

```bash
kubectl -n email-mcp create secret generic email-mcp-google-sa \
  --from-file=service-account.json=./key.json
```

```yaml
image:
  repository: ghcr.io/inframaniacs/email-mcp   # service-account auth is fork-only
googleWorkspace:
  existingSecret: email-mcp-google-sa
  accounts:
    - name: main
      email: you@yourdomain.com
```

The key can impersonate **any** user in every domain that authorized it;
only the listed addresses are exposed to agents, but guard the Secret.

### Shared calendar (Google Calendar)

Workspace accounts can also feed the shared calendar tools
(`list_shared_calendars`, `list_calendar_events`, `find_free_time`,
`create_calendar_event`, …), which merge every calendar on those users'
calendar lists into one view, including calendars shared *to* them (share a
personal Gmail calendar with the Workspace user to bring it in).

1. Enable the **Google Calendar API** in the service account's Cloud project.
2. Add `https://www.googleapis.com/auth/calendar` to the service account's
   domain-wide delegation entry (comma-separated after `https://mail.google.com/`).
3. Opt the account in:

```yaml
googleWorkspace:
  accounts:
    - name: work
      email: you@yourdomain.com
      calendar: true
      # calendarInclude: [primary, Team]   # default: every calendar
calendar:
  default: work/Agents   # where new events go when none is named
```

Calendars are addressed as `source/calendarId` (`work/primary`), a unique
calendar name, or a bare source name. With calendars configured, the
macOS-only local calendar/reminders tools are not registered.

### Gmail / Google Workspace: hub mode (OAuth)

Workspace accounts no longer accept password logins, so Google accounts are
connected through the hub's hosted OAuth flow instead of `accounts`:

1. Google Cloud console → new project → enable the **Gmail API**.
2. OAuth consent screen: **External**, publishing status **In production**
   (Testing-mode refresh tokens expire after 7 days). Scopes: `openid`,
   `email`, `https://mail.google.com/`. Unverified is fine for < 100 users;
   you will click through an "unverified app" warning.
3. Credentials → **OAuth client ID → Web application**, authorized redirect
   URI `https://<host>/oauth/callback`.
4. In each Workspace admin console: Security → API controls → Manage
   third-party app access → add the client ID → **Trusted**.
5. Create the hub Secret and enable hub mode:

```bash
kubectl -n email-mcp create secret generic email-mcp-hub \
  --from-literal=EMAIL_MCP_HUB_GOOGLE_CLIENT_ID=… \
  --from-literal=EMAIL_MCP_HUB_GOOGLE_CLIENT_SECRET=… \
  --from-literal=EMAIL_MCP_HUB_SECRET_KEY="$(openssl rand -base64 48)"
```

```yaml
image:
  repository: ghcr.io/inframaniacs/email-mcp   # hub mode is fork-only
hub:
  enabled: true
  adminEmails: [you@example.com]
  existingSecret: email-mcp-hub
```

Then open `https://<host>/admin`, sign in, and **Connect with Google** once
per mailbox. Tokens are stored encrypted (AES-256-GCM, key derived from
`EMAIL_MCP_HUB_SECRET_KEY`) on the state volume; accounts appear to agents
immediately, without a restart. Removing an account revokes its token.

Back up `EMAIL_MCP_HUB_SECRET_KEY`: without it the stored tokens cannot be
decrypted and every account must be reconnected.

## Exposure

- `ingress.*` — standard Ingress.
- `ingressRoute.*` — Traefik IngressRoute; `ingressRoute.namespace` lets it
  live next to a shared TLS secret (requires Traefik `allowCrossNamespace`).

Only `http.path` (default `/mcp`) — plus `/admin` and `/oauth/callback` in hub mode — is routed; `/healthz` stays cluster-internal.
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
