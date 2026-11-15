{{/*
Common labels
*/}}
{{- define "gateway-edge.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: gateway-edge
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Mattermost admin secret name — resolved from global values with a required guard.
Fails at template time if not configured.
*/}}
{{- define "octogee.mmAdminSecretName" -}}
{{ required "global.mattermost.adminSecret.name is required — run ./scripts/setup-mattermost.sh --env=ENV first" .Values.global.mattermost.adminSecret.name }}
{{- end }}

{{/*
Mattermost admin token key within the secret.
*/}}
{{- define "octogee.mmAdminTokenKey" -}}
{{ .Values.global.mattermost.adminSecret.tokenKey | default "admin_token" }}
{{- end }}
