{{- define "octogee.blobStoreEnv" -}}
{{- $blobBackend := (.Values.global).blobStoreBackend | default "s3" -}}
{{- $blobStore := (.Values.global).blobStore | default dict -}}
- name: BLOB_STORE_BACKEND
  value: {{ $blobBackend | quote }}
{{- if eq $blobBackend "gcs" }}
- name: BLOB_GCS_BUCKET
  value: {{ required "global.blobStore.gcsBucket is required" $blobStore.gcsBucket | quote }}
{{- end }}
{{- if and (eq $blobBackend "s3") $blobStore.endpoint }}
- name: BLOB_S3_ENDPOINT
  value: {{ $blobStore.endpoint | quote }}
- name: BLOB_S3_PUBLIC_ENDPOINT
  value: {{ $blobStore.publicEndpoint | default $blobStore.endpoint | quote }}
- name: AWS_REGION
  value: {{ $blobStore.region | default "us-east-1" | quote }}
- name: BLOB_S3_BUCKET
  value: {{ required "global.blobStore.bucket is required" $blobStore.bucket | quote }}
- name: BLOB_S3_WORKSPACE_BUCKET
  value: {{ required "global.blobStore.workspaceBucket is required" $blobStore.workspaceBucket | quote }}
{{- $credentialsSecret := required "global.blobStore.credentialsSecretName is required" $blobStore.credentialsSecretName }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $credentialsSecret | quote }}
      key: access-key-id
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $credentialsSecret | quote }}
      key: secret-access-key
{{- end }}
{{- end -}}
