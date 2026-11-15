# ── Custom Namespace Overrides (template) ──────────────────────────────────
# Rendered by scripts/provision-namespace.sh into values.${NAMESPACE}.yaml.
# Placeholders are rendered from the selected TEST deployment target.
#
# Design: custom namespaces are internal-only, share the TEST target's Firebase
# project, have no public ingress, no Cloud Armor, no preview host. Access is
# via `kubectl port-forward`. Cheap, isolated, and disposable.

global:
  secretStoreBackend: secret-manager
  ingressClassName: gce
  nodeSelector:
    cloud.google.com/private-node: "true"
  deploymentTargetId: "__TARGET_ID__"
  deploymentProjectId: "__FIREBASE_PROJECT__"
  blobStoreBackend: gcs
  blobStore:
    gcsBucket: "__FIREBASE_PROJECT__.firebasestorage.app"
  publicAppOrigins:
    - "__SITE_ORIGIN__"
    - "__APP_ORIGIN__"
    - https://app-__HOSTING_PROJECT__.web.app
    - https://__FIREBASE_PROJECT__.firebaseapp.com
    - https://app-__FIREBASE_PROJECT__.firebaseapp.com

npmCacheProxy:
  enabled: false

cloud-sql-proxy:
  enabled: true
  connectionName: "__CLOUD_SQL_CONNECTION__"
  usePrivateIp: true

mattermost:
  image:
    repository: us-central1-docker.pkg.dev/octogee/octogee/mattermost
    tag: "12.0.1-octogee-4ee2e9ab"
    digest: "sha256:6fa50729743aaf50e839e33d33c709bdf3cbdbde718b0306cb9574f112fdf2a4"
  db:
    host: cloud-sql-proxy
    name: mattermost___DB_SLUG__
  siteUrl: "http://mattermost.__NAMESPACE__.svc.cluster.local:8065"
  pvc:
    size: 5Gi
  resources:
    limits:
      memory: "1Gi"

gitea:
  service:
    http:
      annotations:
        cloud.google.com/backend-config: '{"default":"gitea-backend"}'
        cloud.google.com/neg: '{"ingress":true}'
  nodeSelector:
    cloud.google.com/private-node: "true"
  gitea:
    config:
      database:
        HOST: cloud-sql-proxy:5432
        NAME: gitea___DB_SLUG__
      server:
        # Internal-only — no DNS, no public access. Use port-forward.
        DOMAIN: "octogee-gitea-http.__NAMESPACE__.svc.cluster.local"
        ROOT_URL: "http://octogee-gitea-http.__NAMESPACE__.svc.cluster.local:3000"
  persistence:
    storageClass: standard-rwo
    size: 10Gi
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 200m
      memory: 256Mi

gateway-edge:
  cloudArmor:
    enabled: false
  image:
    repository: __AR_REPOSITORY__/gateway-edge
  env:
    FIREBASE_PROJECT_ID: "__FIREBASE_PROJECT__"
    GCLOUD_PROJECT: "__FIREBASE_PROJECT__"
    APP_URL: "__APP_ORIGIN__"
    SITE_URL: "__SITE_ORIGIN__"
    K8S_NAMESPACE: "__NAMESPACE__"
  ingress:
    enabled: false

# octogee-api defaults to PROD URLs in the subchart values; a custom
# namespace MUST override them or it would mint prod mmUrl values + proxy
# to prod Mattermost. MM_INTERNAL_URL is namespace-local; API_PUBLIC_URL
# has no public ingress here (port-forward for local testing), so the
# test app URL is the safe non-prod placeholder.
octogee-api:
  image:
    repository: __AR_REPOSITORY__/octogee-api
  gatewayServiceAccount: octogee-gateway@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  serviceAccount:
    annotations:
      iam.gke.io/gcp-service-account: octogee-api@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  env:
    OCTOGEE_KMS_KEY_NAME: "__KMS_KEY_NAME__"
    API_PUBLIC_URL: "__SITE_ORIGIN__"
    MM_INTERNAL_URL: "http://mattermost.__NAMESPACE__.svc.cluster.local:8065"
    PLATFORM_CREDIT_MARKUP_MULTIPLIER: "1.25"
    PLATFORM_WEB_MARKUP_MULTIPLIER: "1.25"

gateway:
  cloudArmor:
    enabled: false
  preview:
    enabled: false
  image:
    repository: __AR_REPOSITORY__/octogee-gateway
  env:
    gcloudProject: "__FIREBASE_PROJECT__"
    firebaseProjectId: "__FIREBASE_PROJECT__"
    githubOrg: "__FIREBASE_PROJECT__"
    mmUrl: ""  # auto-computed from release namespace
  resources:
    limits:
      ephemeral-storage: "10Gi"

serviceAccount:
  gcpServiceAccount: "octogee-gateway@__FIREBASE_PROJECT__.iam.gserviceaccount.com"

glm-controller:
  image:
    repository: __AR_REPOSITORY__/glm-controller
  gcpServiceAccount: octogee-glm-controller@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  gatewayServiceAccount: octogee-gateway@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  workloadIdentityProject: "__CLUSTER_PROJECT__"
  kmsKeyName: "__KMS_KEY_NAME__"
  platformRelease:
    gatewayImageRepository: __AR_REPOSITORY__/octogee-gateway
    gatewayEdgeImageRepository: __AR_REPOSITORY__/gateway-edge

llmBroker:
  image:
    repository: __AR_REPOSITORY__/octogee-api
  gcpServiceAccount: octogee-llm-broker@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  prepaidCreditMarkupMultiplier: "1.25"

artifactWorker:
  image:
    repository: __AR_REPOSITORY__/artifact-worker

opsAgent:
  image:
    repository: __AR_REPOSITORY__/octogee-ops-agent
  gcpServiceAccount: octogee-ops-agent@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  loggingProjectId: __CLUSTER_PROJECT__
  loggingResourceName: projects/__CLUSTER_PROJECT__/locations/global/buckets/ops-agent-test/views/ops-agent
  appUrl: "__APP_ORIGIN__"

networkPolicy:
  agentStorePostgresCidr: "__AGENT_STORE_POSTGRES_CIDR__"

gatewayFleet:
  computeClass:
    enabled: true
