{{- define "octogee.labels" -}}
app.kubernetes.io/name: octogee
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/*
Static base routing table for the edge load balancer, as a YAML list of
Ingress spec.rules entries. This is NOT rendered onto the Ingress directly:
Ingress .spec.rules is an atomic SSA field with a single owner, and the fleet controller
(glm-controller) is that owner. The chart publishes these base routes via the
octogee-edge-routes ConfigMap; the fleet controller reads them and applies the rule table.
Gateway-local public traffic is stable at /g/* and is forwarded by the shared
gateway-router Service to the selected gateway's internal services.
*/}}
{{- define "octogee.edgeBaseRoutes" -}}
{{- $gke := eq ((.Values.global).ingressClassName | default "traefik") "gce" -}}
{{- $hosts := .Values.edgeIngress.hosts -}}
{{- $gatewayEdge := index .Values "gateway-edge" -}}
{{- $router := $gatewayEdge.router | default dict -}}
{{- $apiSvc := $gatewayEdge.ingress.octogeeApiService | default "octogee-api" -}}
{{- $routerSvc := $router.serviceName | default "gateway-router" -}}
{{- $glmSvc := $gatewayEdge.ingress.glmService | default "glm-controller" -}}
{{- $adminPaths := list
  "/api/admin/gateways/*"
  "/api/admin/gateways"
  "/api/admin/operations/*"
  "/api/admin/operations"
  "/api/admin/fleet-events"
  "/api/admin/restore-jobs/*"
  "/api/admin/restore-jobs"
  "/api/admin/builds"
  "/api/admin/rollouts"
  "/api/admin/release-status"
  "/api/admin/logs"
  "/api/admin/fleet-settings"
  "/api/admin/placement/*"
  "/api/admin/placement"
  "/api/admin/sizing-profiles/*"
  "/api/admin/sizing-profiles"
  "/api/admin/platform-state-projection"
  "/api/admin/gateway-migrations/*"
  "/api/admin/user-archives"
  "/api/admin/user-distribution"
  "/api/admin/user-by-slug/*"
  "/api/admin/users/*"
  "/api/admin/users" -}}
- host: {{ $hosts.api }}
  http:
    paths:
{{- range $adminPaths }}
      - path: {{ ternary . (trimSuffix "/*" .) $gke }}
        pathType: {{ ternary "ImplementationSpecific" (ternary "Prefix" "Exact" (hasSuffix "/*" .)) $gke }}
        backend:
          service:
            name: {{ $glmSvc }}
            port:
              name: http
{{- end }}
      - path: {{ ternary "/g/*" "/g" $gke }}
        pathType: {{ ternary "ImplementationSpecific" "Prefix" $gke }}
        backend:
          service:
            name: {{ $routerSvc }}
            port:
              name: http
      - path: {{ ternary "/api/*" "/api" $gke }}
        pathType: {{ ternary "ImplementationSpecific" "Prefix" $gke }}
        backend:
          service:
            name: {{ $apiSvc }}
            port:
              name: http
      - path: /health
        pathType: {{ ternary "ImplementationSpecific" "Exact" $gke }}
        backend:
          service:
            name: {{ $routerSvc }}
            port:
              name: http
- host: {{ $hosts.git }}
  http:
    paths:
      - path: {{ ternary "/*" "/" $gke }}
        pathType: {{ ternary "ImplementationSpecific" "Prefix" $gke }}
        backend:
          service:
            name: octogee-gitea-http
            port:
              number: 3000
- host: {{ $hosts.mattermost }}
  http:
    paths:
      - path: {{ ternary "/*" "/" $gke }}
        pathType: {{ ternary "ImplementationSpecific" "Prefix" $gke }}
        backend:
          service:
            name: mattermost
            port:
              number: 8065
- host: {{ $hosts.preview }}
  http:
    paths:
      - path: {{ ternary "/p/*" "/p" $gke }}
        pathType: {{ ternary "ImplementationSpecific" "Prefix" $gke }}
        backend:
          service:
            name: {{ $apiSvc }}
            port:
              name: http
{{- end -}}
