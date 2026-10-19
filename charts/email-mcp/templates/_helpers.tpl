{{- define "email-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "email-mcp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "email-mcp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "email-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "email-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "email-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "email-mcp.tokenSecretName" -}}
{{- default (printf "%s-token" (include "email-mcp.fullname" .)) .Values.auth.existingSecret }}
{{- end }}

{{/* Allowed Host headers: explicit list, else public hosts + in-cluster Service names. */}}
{{- define "email-mcp.allowedHosts" -}}
{{- if .Values.http.allowedHosts }}
{{- join "," .Values.http.allowedHosts }}
{{- else }}
{{- $fn := include "email-mcp.fullname" . }}
{{- $ns := .Release.Namespace }}
{{- $port := int .Values.service.port }}
{{- $hosts := list "localhost" "127.0.0.1" }}
{{- range (list $fn (printf "%s.%s" $fn $ns) (printf "%s.%s.svc" $fn $ns) (printf "%s.%s.svc.cluster.local" $fn $ns)) }}
{{- $hosts = append $hosts . }}
{{- $hosts = append $hosts (printf "%s:%d" . $port) }}
{{- end }}
{{- range .Values.http.publicHosts }}{{ $hosts = append $hosts . }}{{ end }}
{{- if .Values.ingress.enabled }}
{{- range .Values.ingress.hosts }}{{ $hosts = append $hosts .host }}{{ end }}
{{- end }}
{{- if .Values.ingressRoute.enabled }}
{{- range .Values.ingressRoute.hosts }}{{ $hosts = append $hosts . }}{{ end }}
{{- end }}
{{- join "," (uniq $hosts) }}
{{- end }}
{{- end }}

{{/* Default IMAP/SMTP endpoints per provider, mirroring src/config/providers.ts. */}}
{{- define "email-mcp.providerPresets" -}}
gmail:
  imap: {host: imap.gmail.com, port: 993, tls: true, starttls: false}
  smtp: {host: smtp.gmail.com, port: 465, tls: true, starttls: false}
outlook:
  imap: {host: outlook.office365.com, port: 993, tls: true, starttls: false}
  smtp: {host: smtp.office365.com, port: 587, tls: false, starttls: true}
yahoo:
  imap: {host: imap.mail.yahoo.com, port: 993, tls: true, starttls: false}
  smtp: {host: smtp.mail.yahoo.com, port: 465, tls: true, starttls: false}
icloud:
  imap: {host: imap.mail.me.com, port: 993, tls: true, starttls: false}
  smtp: {host: smtp.mail.me.com, port: 587, tls: false, starttls: true}
fastmail:
  imap: {host: imap.fastmail.com, port: 993, tls: true, starttls: false}
  smtp: {host: smtp.fastmail.com, port: 465, tls: true, starttls: false}
zoho:
  imap: {host: imap.zoho.com, port: 993, tls: true, starttls: false}
  smtp: {host: smtp.zoho.com, port: 465, tls: true, starttls: false}
{{- end }}

{{- define "email-mcp.endpointToml" -}}
host = {{ required "imap/smtp host is required (set provider or host)" .host | quote }}
{{- if hasKey . "port" }}
port = {{ int .port }}
{{- end }}
{{- if hasKey . "tls" }}
tls = {{ .tls }}
{{- end }}
{{- if hasKey . "starttls" }}
starttls = {{ .starttls }}
{{- end }}
{{- if hasKey . "verify_ssl" }}
verify_ssl = {{ .verify_ssl }}
{{- end }}
{{- end }}

{{/* Render config.toml from settingsToml + accounts. */}}
{{- define "email-mcp.configToml" -}}
{{- if .Values.configToml }}
{{- .Values.configToml }}
{{- else }}
{{- $presets := include "email-mcp.providerPresets" . | fromYaml }}
{{- .Values.settingsToml }}
{{- $saKey := printf "/etc/email-mcp/google-sa/%s" .Values.googleWorkspace.keyKey }}
{{- range $i, $a := .Values.googleWorkspace.accounts }}
{{- if not $.Values.googleWorkspace.existingSecret }}
{{- fail "googleWorkspace.accounts needs googleWorkspace.existingSecret" }}
{{- end }}

[[accounts]]
name = {{ required (printf "googleWorkspace.accounts[%d].name is required" $i) $a.name | quote }}
email = {{ required (printf "googleWorkspace.accounts[%d].email is required" $i) $a.email | quote }}
{{- with $a.fullName }}
full_name = {{ . | quote }}
{{- end }}

[accounts.google_service_account]
key_file = {{ $saKey | quote }}

[accounts.imap]
host = "imap.gmail.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.gmail.com"
port = 465
tls = true
{{- end }}
{{- range $i, $a := .Values.accounts }}
{{- $name := required (printf "accounts[%d].name is required" $i) $a.name }}
{{- $preset := dict }}
{{- if $a.provider }}
{{- $preset = required (printf "accounts[%d].provider %q is not a known preset" $i $a.provider) (get $presets $a.provider) }}
{{- end }}
{{- $imap := mergeOverwrite (deepCopy (default dict $preset.imap)) (default dict $a.imap) }}
{{- $smtp := mergeOverwrite (deepCopy (default dict $preset.smtp)) (default dict $a.smtp) }}

[[accounts]]
name = {{ $name | quote }}
email = {{ required (printf "accounts[%d].email is required" $i) $a.email | quote }}
{{- with $a.fullName }}
full_name = {{ . | quote }}
{{- end }}
{{- with $a.username }}
username = {{ . | quote }}
{{- end }}
{{- if $a.passwordEnv }}
password = {{ printf "env:%s" $a.passwordEnv | quote }}
{{- else if not $a.oauth2 }}
{{- fail (printf "accounts[%d] (%s) needs passwordEnv or oauth2" $i $name) }}
{{- end }}
{{- with $a.maxAttachmentMb }}
max_attachment_mb = {{ int . }}
{{- end }}
{{- with $a.sentMailbox }}
sent_mailbox = {{ . | quote }}
{{- end }}
{{- if hasKey $a "saveToSent" }}
save_to_sent = {{ $a.saveToSent }}
{{- end }}
{{- with $a.oauth2 }}

[accounts.oauth2]
provider = {{ required "oauth2.provider is required" .provider | quote }}
client_id = {{ printf "env:%s" (required "oauth2.clientIdEnv is required" .clientIdEnv) | quote }}
client_secret = {{ printf "env:%s" (required "oauth2.clientSecretEnv is required" .clientSecretEnv) | quote }}
refresh_token = {{ printf "env:%s" (required "oauth2.refreshTokenEnv is required" .refreshTokenEnv) | quote }}
{{- end }}

[accounts.imap]
{{ include "email-mcp.endpointToml" $imap }}

[accounts.smtp]
{{ include "email-mcp.endpointToml" $smtp }}
{{- end }}
{{- end }}
{{- end }}

{{- define "email-mcp.hostMatch" -}}
{{- $parts := list }}
{{- range (required "ingressRoute.hosts must list at least one host" .Values.ingressRoute.hosts) }}
{{- $parts = append $parts (printf "Host(`%s`)" .) }}
{{- end }}
{{- join " || " $parts }}
{{- end }}

{{- define "email-mcp.hubPublicUrl" -}}
{{- if .Values.hub.publicUrl }}
{{- .Values.hub.publicUrl | trimSuffix "/" }}
{{- else if and .Values.ingressRoute.enabled .Values.ingressRoute.hosts }}
{{- printf "https://%s" (first .Values.ingressRoute.hosts) }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- printf "https://%s" (first .Values.ingress.hosts).host }}
{{- else }}
{{- fail "hub.enabled needs hub.publicUrl or an ingress/ingressRoute host" }}
{{- end }}
{{- end }}

{{/* Paths routed publicly: the MCP endpoint, plus the hub UI and callback. */}}
{{- define "email-mcp.publicPaths" -}}
{{- $paths := list .Values.http.path }}
{{- if .Values.hub.enabled }}{{ $paths = concat $paths (list "/admin" "/oauth/callback") }}{{ end }}
{{- join "," $paths }}
{{- end }}
