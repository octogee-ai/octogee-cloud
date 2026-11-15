{{- define "octogee-monitoring.labels" -}}
app.kubernetes.io/part-of: octogee-monitoring
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "octogee-monitoring.environmentNamespaces" -}}
{{- if not .Values.environmentNamespaces -}}
{{- fail "environmentNamespaces must list every environment namespace the alert rules and dashboards select" -}}
{{- end -}}
{{- join "|" .Values.environmentNamespaces -}}
{{- end -}}
