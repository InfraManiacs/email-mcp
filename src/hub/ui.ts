/**
 * Server-rendered admin pages. Plain HTML forms, no client JS — every
 * mutating action is a POST carrying a CSRF token.
 */

export interface AccountRow {
  name: string;
  email: string;
  source: 'config' | 'hub';
  connectedAt?: string;
  connectedBy?: string;
}

export interface NoticeView {
  kind: 'ok' | 'error';
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--accent:#1a5fd0;--ok:#1f7a3a;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9b9a94;--card:#1e1e1c;--line:#2e2e2b;--accent:#7aa7ff;--ok:#5fc47f;--err:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:24px}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:20px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
.muted{color:var(--muted);font-size:13px}.tag{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--err)}
input{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:100%}
form.inline{display:inline}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.row label{flex:1;min-width:180px}
.notice{padding:10px 14px;border-radius:8px;margin-bottom:20px;border:1px solid}
.notice.ok{color:var(--ok);border-color:var(--ok)}.notice.error{color:var(--err);border-color:var(--err)}
code{font-size:13px;word-break:break-all}.actions{white-space:nowrap;text-align:right}
@media (max-width:600px){.hide-sm{display:none}}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function noticeHtml(notice?: NoticeView): string {
  return notice ? `<div class="notice ${notice.kind}">${escapeHtml(notice.text)}</div>` : '';
}

export function renderLogin(notice?: NoticeView): string {
  return page(
    'Mail Hub',
    `<header><h1>Mail Hub</h1></header>${noticeHtml(notice)}
<div class="card"><h2>Admin sign-in</h2>
<p class="muted">Sign in with an allowlisted Google account to manage connected mailboxes.</p>
<a class="btn primary" href="/admin/login">Sign in with Google</a></div>`,
  );
}

export function renderDashboard(o: {
  adminEmail: string;
  csrf: string;
  accounts: AccountRow[];
  mcpUrl: string;
  notice?: NoticeView;
}): string {
  const csrfField = `<input type="hidden" name="csrf" value="${escapeHtml(o.csrf)}">`;
  const rows = o.accounts
    .map((a) => {
      const meta =
        a.source === 'hub'
          ? `<span class="muted">${escapeHtml(a.connectedBy ?? '')} · ${escapeHtml(
              a.connectedAt?.slice(0, 10) ?? '',
            )}</span>`
          : '<span class="muted">config file</span>';
      const remove =
        a.source === 'hub'
          ? `<form class="inline" method="post" action="/admin/accounts/remove">${csrfField}
<input type="hidden" name="name" value="${escapeHtml(a.name)}">
<button class="danger" type="submit">Remove</button></form>`
          : '';
      return `<tr><td><strong>${escapeHtml(a.name)}</strong><br><span class="muted">${escapeHtml(
        a.email,
      )}</span></td>
<td class="hide-sm"><span class="tag">${a.source}</span><br>${meta}</td>
<td class="actions"><form class="inline" method="post" action="/admin/accounts/test">${csrfField}
<input type="hidden" name="name" value="${escapeHtml(a.name)}">
<button type="submit">Test</button></form> ${remove}</td></tr>`;
    })
    .join('');

  return page(
    'Mail Hub',
    `<header><h1>Mail Hub</h1>
<form class="inline" method="post" action="/admin/logout">${csrfField}
<span class="muted">${escapeHtml(o.adminEmail)}</span> <button type="submit">Sign out</button></form></header>
${noticeHtml(o.notice)}
<div class="card"><h2>Connect a Google account</h2>
<form method="post" action="/admin/connect">${csrfField}
<div class="row">
<label>Account name <span class="muted">(optional)</span><input name="name" placeholder="e.g. avware-jacob" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,62}"></label>
<label>Email hint <span class="muted">(optional)</span><input name="login_hint" type="email" placeholder="you@company.com"></label>
<button class="primary" type="submit">Connect with Google</button></div>
<p class="muted">Reconnecting an existing address replaces its token. Agents use the account name to pick a mailbox.</p>
</form></div>
<div class="card"><h2>Mailboxes (${o.accounts.length})</h2>
${
  o.accounts.length > 0
    ? `<table><thead><tr><th>Account</th><th class="hide-sm">Source</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No mailboxes yet.</p>'
}</div>
<div class="card"><h2>MCP endpoint</h2><p><code>${escapeHtml(o.mcpUrl)}</code></p>
<p class="muted">Clients send <code>Authorization: Bearer &lt;token&gt;</code>. Every token holder can use every mailbox above.</p></div>`,
  );
}
