{{- define "octogee.platformStateSecretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: platform-state-postgres
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}

{{- define "octogee.platformDatabaseConnectionEnv" -}}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_HOST" "key" "host") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_PORT" "key" "port" "optional" true) }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_NAME" "key" "database") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_SSLMODE" "key" "sslmode") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_CA_CERT" "key" "ca-cert" "optional" true) }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_TLS_SERVER_IDENTITY" "key" "tls-server-identity" "optional" true) }}
{{- end -}}

{{- define "octogee.platformDatabaseRuntimeEnv" -}}
{{ include "octogee.platformDatabaseConnectionEnv" . }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_USER" "key" "runtime-user") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_PASSWORD" "key" "runtime-password") }}
{{- end -}}

{{- define "octogee.platformStateEnv" -}}
- name: PLATFORM_STATE_BACKEND
  value: "postgres"
{{ include "octogee.platformDatabaseRuntimeEnv" . }}
{{- end -}}

{{- define "octogee.runtimeSecretStoreEnv" -}}
{{- $backend := (.Values.global).secretStoreBackend | default "postgres" -}}
- name: SECRET_STORE_BACKEND
  value: {{ $backend | quote }}
{{- if eq $backend "postgres" }}
{{- $rootKeySecret := (.Values.global).secretStoreRootKeySecretName | default (.Values.global).encryptionRootKeySecretName }}
{{- with $rootKeySecret }}
- name: SECRET_STORE_ROOT_KEY
  valueFrom:
    secretKeyRef:
      name: {{ . | quote }}
      key: root-key
- name: SECRET_STORE_PREVIOUS_ROOT_KEY
  valueFrom:
    secretKeyRef:
      name: {{ . | quote }}
      key: previous-root-key
      optional: true
{{- end }}
{{- end }}
{{- end }}
