{{/*
Resolve the revision id for this render.

`revisionId` ({gatewayId}-r{n}) is the disposable instance dimension: every
per-instance K8s resource NAME and the `gateway-instance` selector key off it so
two simultaneous revisions of one gateway never collide. Legacy renders that
pass only `gatewayId` (e.g. `shared-a`) get revisionId == gatewayId, so their
resource names are unchanged. Tenant identity (KSA, secrets, GATEWAY_ID) stays
gateway-scoped on `.Values.gatewayId` — see serviceAccountName / GATEWAY_ID.
*/}}
{{- define "octogee-gateway.revisionId" -}}
{{- $gateway := required "gatewayId is required (the fleet controller must pass --set gatewayId=<id>)" .Values.gatewayId -}}
{{- .Values.revisionId | default $gateway -}}
{{- end }}

{{/*
Common labels for the gateway pod's resources.

`gateway-instance` is the per-revision instance identity that selects this
revision's per-instance Services. The shared public gateway-router forwards
`/g/<id>/*` traffic to the gateway-scoped Service, whose selector the fleet controller points
at the serving revision.
*/}}
{{- define "octogee-gateway.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: octogee-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
gateway-instance: {{ include "octogee-gateway.revisionId" . }}
{{- end }}

{{/*
Resolve the Kubernetes ServiceAccount for this gateway pod.

Gateways must never fall back to the shared platform KSA (`octogee-gateway`)
just because a manual Helm render or legacy release value omitted the fleet controller's
serviceAccountName override. The API broker binds tenant identity from this KSA
name, so derive the locked per-gateway KSA whenever the requested name is empty
or still the legacy shared value.
*/}}
{{- define "octogee-gateway.generatedServiceAccountName" -}}
octogee-gw-{{ required "gatewayId is required (the fleet controller must pass --set gatewayId=<id>)" .Values.gatewayId }}
{{- end }}

{{- define "octogee-gateway.serviceAccountName" -}}
{{- $requested := .Values.serviceAccountName | default "" -}}
{{- if or (eq $requested "") (eq $requested "octogee-gateway") -}}
{{- include "octogee-gateway.generatedServiceAccountName" . -}}
{{- else -}}
{{- required "serviceAccountName is required" $requested -}}
{{- end -}}
{{- end }}

{{/*
Resolve the product/security class for this gateway.

New desired state passes `.Values.gatewayClass`. Missing class defaults to the
shared gateway; retired user operator values are rejected by the schema.
*/}}
{{- define "octogee-gateway.gatewayClass" -}}
{{- if .Values.gatewayClass -}}
{{- .Values.gatewayClass -}}
{{- else -}}
shared
{{- end -}}
{{- end }}

{{- define "octogee-gateway.dualReadGatewayClass" -}}
{{- $class := include "octogee-gateway.gatewayClass" . -}}
{{- ternary "isolated" $class (eq $class "builder") -}}
{{- end }}

{{- define "octogee-gateway.dualReadImageProfile" -}}
{{- $profile := include "octogee-gateway.imageProfile" . -}}
{{- ternary "isolated" $profile (eq $profile "builder") -}}
{{- end }}

{{/*
Resolve the installed image/tooling profile. Shared uses the standard image;
owner-bound isolated gateways use the isolated image.
*/}}
{{- define "octogee-gateway.imageProfile" -}}
{{- if .Values.imageProfile -}}
{{- .Values.imageProfile -}}
{{- else if .Values.profile -}}
{{- .Values.profile -}}
{{- else if eq (include "octogee-gateway.dualReadGatewayClass" .) "isolated" -}}
isolated
{{- else -}}
standard
{{- end -}}
{{- end }}

{{/*
Validate required values up front so a typo in the fleet controller's --set call
fails at helm render rather than producing a half-rendered Deployment.

The `$_ :=` discards the return value so the helper emits no text.
Without that, `required` returns the value it just validated, and
the literal gatewayId got concatenated onto the top of every doc
that called this helper — producing `blueapiVersion: apps/v1` on
the first line of the rendered Deployment and the famous helm
`apiVersion not set` validation error that broke add-gateway
end-to-end on first real exercise.
*/}}
{{- define "octogee-gateway.requireIdentity" -}}
{{- $_ := required "gatewayId is required (the fleet controller must pass --set gatewayId=<id>)" .Values.gatewayId -}}
{{- end }}

{{/*
Resolve the effective sizing tier for this gateway instance.

Precedence:
  1. `.Values.sizingTier` if set (the fleet controller passed it explicitly).
  2. `.Values.classDefaults[<gatewayClass>]` if declared.
  3. `.Values.profileDefaults[<imageProfile>]` for legacy values.
  4. `.Values.profileDefaults.standard` as the last-resort default.

The result is a string — one of the declared sizing tiers. The schema rejects any
other value before this helper runs, so callers can trust the lookup
into `.Values.tiers` will succeed.
*/}}
{{- define "octogee-gateway.effectiveTier" -}}
{{- if .Values.sizingTier -}}
{{- .Values.sizingTier -}}
{{- else if and .Values.classDefaults (index .Values.classDefaults (include "octogee-gateway.dualReadGatewayClass" .)) -}}
{{- index .Values.classDefaults (include "octogee-gateway.dualReadGatewayClass" .) -}}
{{- else if and .Values.profileDefaults (index .Values.profileDefaults (include "octogee-gateway.dualReadImageProfile" .)) -}}
{{- index .Values.profileDefaults (include "octogee-gateway.dualReadImageProfile" .) -}}
{{- else -}}
{{- .Values.profileDefaults.standard -}}
{{- end -}}
{{- end }}

{{/*
Return the resolved tier preset dict — has `.resources` (requests/limits)
and `.nodejs` (uvThreadpoolSize, maxOldSpaceSizeMb). Fails loud if the
tier isn't declared in `.Values.tiers`.
*/}}
{{- define "octogee-gateway.tierPreset" -}}
{{- $tier := include "octogee-gateway.effectiveTier" . -}}
{{- $preset := index .Values.tiers $tier -}}
{{- if not $preset -}}
{{- fail (printf "no preset defined for sizingTier=%q (add it under .Values.tiers in values.yaml)" $tier) -}}
{{- end -}}
{{- $preset | toYaml -}}
{{- end }}

{{- define "octogee-gateway.imageLabel" -}}
{{- $imageTag := .Values.image.tag | default .Values.imageTag -}}
{{- $imageReference := index (splitList "@" $imageTag) 0 -}}
{{- $shortSha := regexFind "^[a-f0-9]{7}" $imageReference -}}
{{- if $shortSha -}}
{{- $shortSha -}}
{{- else if and (le (len $imageTag) 63) (regexMatch "^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$" $imageTag) -}}
{{- $imageTag -}}
{{- else -}}
{{- printf "sha256-%s" (trunc 56 (sha256sum $imageTag)) -}}
{{- end -}}
{{- end -}}

{{- define "octogee-gateway.computerDesktop" -}}
{{- $class := include "octogee-gateway.dualReadGatewayClass" . -}}
{{- $tier := include "octogee-gateway.effectiveTier" . -}}
{{- $desktop := .Values.computerDesktop | default "auto" -}}
{{- if eq $desktop "auto" -}}
{{- if and (eq $class "isolated") (eq (.Values.runtimeKind | default "cluster") "gce-vm") -}}x11{{- else -}}none{{- end -}}
{{- else if has $desktop (list "none" "x11" "omarchy") -}}
{{- $desktop -}}
{{- else -}}{{- fail "computerDesktop must be auto, none, x11, or omarchy" -}}{{- end -}}
{{- end -}}
