# Production deployment

Run the full Octogee Cloud platform on Kubernetes with separate staging and
production environments. This guide uses GKE and Cloud SQL for the production
reference. Use the full-platform walkthroughs to learn the installation and
operator flows in a disposable environment. For AWS, the EKS walkthrough
covers installation and gateway operations. Qualify its ingress, RDS recovery
and upgrade procedures in your own staging environment before serving users.
[GKE walkthrough](gke.md) · [EKS walkthrough](eks.md)

## Provision the environment

Keep each environment's cloud resources, deployment identities, secret
references and Helm values in version control. Store secret values in your
secret manager. Give staging its own project, cluster, database, buckets,
credentials and DNS names. Use infrastructure as code to create resources and
check for drift.

| Component | Production configuration |
| --- | --- |
| Cluster | Use regional GKE Standard, private nodes, Dataplane V2 and Workload Identity Federation. Keep cloud and Kubernetes permissions scoped to the service and environment. Provide controlled egress to registries, storage and model providers. |
| Node pools | Spread platform capacity across zones. Provide a gVisor pool for shared gateways and compatible nodes for isolated gateways. The isolated gateway image needs amd64. Size the fleet and node pools for a zone loss, scheduled maintenance and replacement gateways running alongside the old ones. |
| PostgreSQL | Use managed PostgreSQL 16 on private networking and encrypted connections. Configure certificate verification for each client. Set regional Cloud SQL high availability for a multi-zone design. Enable automated backups, point-in-time recovery (PITR), deletion protection and retention of backups on deletion. |
| Disks | Choose storage classes for chat, Git and gateway homes that support the intended zone failover and restore procedures. Give persistent claims sufficient IOPS and free space. Identify services that run with a single replica or require exclusive volume access and budget their restart time. |
| Blob storage | Use private, separately scoped buckets for assets and workspace objects. Set retention, version and deletion policies that meet your recovery objectives, and test restoration of prior object versions. |

Check zone placement, available node capacity, quotas and storage topology as
well as the GKE control plane's region. A regional control plane leaves
workload replica counts, placement and disk replication to the workload and
storage configuration. Run a staging node drain or zone-loss exercise to
measure actual capacity and startup time. [GKE regional clusters](https://cloud.google.com/kubernetes-engine/docs/concepts/regional-clusters) · [Architecture and state](architecture.md#where-state-lives)

## Configure the public edge

Reserve a global static address for the GKE load balancer and point each
served DNS name at it. Set the external URLs in Mattermost, Gitea and the
platform configuration to their HTTPS origins. Match the WebSocket and CORS
origin lists to the clients you serve. The API host sends `/g/<gatewayId>/`
traffic to the gateway router and platform routes to the API. Preserve
WebSocket upgrades and allow time for live connections to drain. Restrict
direct operator access to service dashboards and use the fleet controller's
operator authentication for the Admin API. [Gateway routing and authentication](architecture.md)

For the shared GKE ingress, put these settings in the environment's Helm
values. Replace the example hosts and address name. This excerpt supplies
the edge values for a deployment whose identities, database connection,
object storage, application origins and secrets are configured separately.
[Chart values](../charts/octogee/values.yaml) · [GKE ingress and managed certificates](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/secure-traffic-management)

```yaml
global:
  ingressClassName: gce
edgeIngress:
  enabled: true
  staticIpName: example-edge-ip
  hosts:
    api: api.example.com
    git: git.example.com
    mattermost: chat.example.com
    preview: preview.example.com
  managedCertificates: [api-cert, git-cert, chat-cert, preview-cert]
gateway-edge:
  ingress:
    enabled: false
    resourcesEnabled: true
    host: api.example.com
    certName: api-cert
gitea:
  webIngress:
    host: git.example.com
    certName: git-cert
mattermost:
  ingress:
    host: chat.example.com
    certName: chat-cert
gatewayFleet:
  previewIngress:
    host: preview.example.com
    certName: preview-cert
```

The fleet controller reconciles the shared ingress rules from the chart's
base routes. Check the live host and path rules after it starts. From a
client network, verify the certificate and redirect for each served hostname,
authenticated API and gateway routing, chat WebSocket connection and
reconnection, and Git clone and push. Verify operator and user access
separately. [Base route configuration](../charts/octogee/templates/edge-routes-configmap.yaml)

## Deploy and verify a release

Choose a published release, read its upgrade notes and keep its image
manifest with the environment's Helm values. The release chart pins images
by digest. Provision the namespace, storage, database roles, and secret
references before installing it.
[Releases](https://github.com/octogee-ai/octogee-cloud/releases)

1. Prepare separate databases and roles for platform state, the agent stores,
   Mattermost and Gitea. The bootstrap SQL separates platform migration
   credentials from runtime credentials. Apply it from a private database
   client with authority to create the databases and roles.
   [Database bootstrap](../scripts/ops/postgres-databases.sql) · [Agent store bootstrap](../scripts/ops/postgres-agent-store.sql)
2. Point the environment's Helm values and referenced Secrets at the private
   database and the two buckets. The GKE bootstrap shows the contracts for
   `platform-state-postgres`, `agent-store-postgres`, `platform-root-key` and
   the blob store credentials. Keep the root key and any credentials
   generated during bootstrap in your secret manager.
   [GKE secret and values bootstrap](../scripts/ops/gke-install.sh)
3. On a new deployment, bring up the chart and bootstrap the Mattermost and
   Gitea admin accounts and service credentials as in the GKE walkthrough.
   Restart the consumers after the credentials are in place, load the model
   broker's provider configuration and verify the platform can authenticate
   to both hosts. When using the provisioning service, configure both the
   fleet controller and gateway callers before qualifying an account.
   [GKE bootstrap](gke.md#install) · [Provisioning service](../provisioning-service/README.md)

Deploy to staging first. Set `KUBE_CONTEXT` and `NAMESPACE` to the
intended target, `VERSION` to the chart version without the `v`, and
`VALUES_FILE` to that environment's reviewed Helm values. Render with Helm
and inspect the destinations, routes, image digests and workload identities,
then apply the same inputs. On the first apply, omit `--wait` so you can
bootstrap the service credentials, then confirm readiness after bootstrap.
Use `--wait` on upgrades.

```bash
CHART=oci://ghcr.io/octogee-ai/octogee-cloud/charts/octogee
helm template octogee "$CHART" --version "$VERSION" \
  --namespace "$NAMESPACE" --values "$VALUES_FILE"
helm upgrade --install octogee "$CHART" --version "$VERSION" \
  --kube-context "$KUBE_CONTEXT" --namespace "$NAMESPACE" \
  --values "$VALUES_FILE" --wait --timeout 15m
kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" \
  get deployments,pods,pvc,ingress
```

Use the fleet CLI to bring up shared capacity and inspect gateway readiness.
Use a test account with enough access to exercise normal user flows.
[Fleet and user setup](gke.md#operate-the-fleet)

1. Assign it to a shared gateway and verify account provisioning, model
   replies in Mattermost and a Git write under the expected identity.
2. Move it to an isolated gateway and back. Make a Git write on each side of
   the move, check that both writes reached the repository, and confirm the
   same user and bot identities continued to serve. If you use retained homes,
   exercise reopening one with its existing data. Check the operations
   journal for completed moves before retiring the test gateway.
3. Confirm monitoring receives current samples for required services and
   gateways. Alert on unavailable or saturated gateways, stalled
   reconciliation, database connectivity, backup age and failed or stalled
   provisioning. For an external placement client, scrape its execution
   metrics and confirm the stale-tick rule sees a recent successful tick.
   [Monitoring chart](../charts/monitoring)

If you run an external placement client, deploy it in shadow mode while the
fleet controller owns placement. Let active migrations and shared gateway
replacement settle. Compare decisions and check for read or execution
errors. Switch owners through the Admin API, wait for the controller's
yield, then check successful active ticks and completed operations. Dry-run
handback with the operator identity. Hand ownership back before deploying
a controller that predates the owner check.
[Placement handoff](admin-api-automation.md#handing-placement-over-and-back)

## Upgrade and roll back

1. Record the current Helm revision, image and gateway release digests,
   placement owner, database recovery window and latest successful backups.
   Review release notes and schema compatibility alongside the new values.
   Test the upgrade against representative state in staging. In pre-1.0
   releases, a minor upgrade can change data or require a fresh installation.
   [Version and upgrade policy](releasing.md#versions)
2. Apply the same release to production in an operator window. Keep spare
   shared capacity while draining old gateways. Verify convergence from live
   image and readiness data. Manage isolated gateway releases with the fleet
   CLI and the deployment's build manifests. Check active gateways and verify
   the desired release for parked ones before opening the rollout more widely.
3. Repeat the post-deploy checks and review the operations journal. When the
   schema and backing stores remain compatible, reapply the previous pinned
   release and values or roll back to its Helm revision. A Helm rollback
   changes Kubernetes resources. Reverting a forward database migration
   requires a tested recovery procedure or a compatible forward fix.

## Recover data and service

Set a recovery point objective (acceptable data loss) and recovery time
objective (acceptable downtime) for the whole service. Track the recovery
point for each backing store. Coordinate database, object and volume recovery
points so database records still refer to the correct files and revisions.

| Back up or retain | Verify on restore |
| --- | --- |
| Platform state, provisioning records and agent databases or schemas | The assignment and operation journal agree. Agent data is readable and encrypted records open using the matching key. |
| Mattermost and Gitea databases, Git repository storage and service files | A user can sign in, read existing chat, clone a repository and find its expected commit. Include attachments and repository objects as well as metadata. |
| Workspace and assets buckets, gateway home volumes or VM disks, and home checkpoints | Retrieve a saved object and reopen a known isolated home. Match the stored project and home references to the restored data. |
| The encryption root key, service secret versions, Helm values and image manifest | Recreate the services with compatible images, keys and credentials. Preserve the keys needed for the selected recovery point. |

### Exercise Cloud SQL point-in-time recovery

The exercised Cloud SQL policy kept seven daily backups and seven days
of transaction logs, with deletion protection and backup retention on
deletion enabled. Keep the policy in infrastructure as code and check live
settings, the timestamp of the last successful backup and the recovery
window regularly. For a deployment registered with the environment audit,
run the PITR policy check as part of that audit.
[Backup policy check](../scripts/lib/cloud-sql-backup-policy.sh) · [Environment audit](../scripts/verify-env.sh)

```bash
gcloud sql instances describe "$DB_INSTANCE" --project "$PROJECT_ID" \
  --format='yaml(settings.availabilityType,settings.backupConfiguration,settings.deletionProtectionEnabled,settings.retainBackupsOnDelete)'
gcloud sql backups list --instance "$DB_INSTANCE" --project "$PROJECT_ID"
```

1. In staging, write a synthetic marker and commit it. Pick a UTC time after
   that commit and before a second committed marker. Confirm the time is
   within the source instance's recovery window. Keep the audit timestamp
   and database access limited to the drill.
2. Restore to a new instance with a unique name. Keep production workloads
   pointed at their original databases. Restrict the restored instance to
   recovery operators and reach it through the deployment's private access
   path. [Cloud SQL PITR procedure](https://cloud.google.com/sql/docs/postgres/backup-recovery/pitr)

   ```bash
   gcloud sql instances clone "$DB_INSTANCE" "$RESTORE_INSTANCE" \
     --project "$PROJECT_ID" --point-in-time "$RESTORE_TIMESTAMP"
   ```

3. Read the restored database. Verify the first marker exists and the later
   marker is absent. Check the schemas and representative rows for each
   database housed on that instance. Record the selected and observed
   recovery times, then remove the disposable drill resources according to
   their retention policy.

### Recover production service

For an incident, identify the last known-good recovery point, pause
placement and affected writers, and preserve the original systems for
reconciliation. Restore to isolated targets and validate the data across
stores. Verify application reads with outbound jobs, webhooks and scheduled
work paused on the recovery target. Repoint workloads and credentials only
after validation. Bring writers back under a single owner, verify new and
historical chat, Git and agent activity, then measure the elapsed downtime
and recovered data window. Exercise this whole cutover in staging to
qualify it for your deployment.

## Exercised configurations

These results describe the paths exercised in the maintained environments.
Use them to choose what to repeat against your own data, topology and
release.

| Configuration | Evidence and scope |
| --- | --- |
| Operator staging and production on GKE | Both deployment audits passed. Production served HTTPS and passed API health checks after rollout. Staging passed fleet convergence and live end-to-end tests. |
| Cloud SQL PITR in operator staging | A restore into an isolated clone recovered the earlier committed row and excluded the later row. The Gitea repository table and Mattermost database were present. This exercise covered the application database instance and kept the live environment on the source. |
| Cloud SQL PITR in operator production | Seven retained backups and seven days of transaction logs were configured. The instance returned to runnable after enabling PITR, the first automated backup succeeded, and Cloud SQL reported a recovery window. Production service checks passed. |
| Provisioning and retained homes | Staging exercised the retained-home activation and the source-serving recovery command. Production enabled the provisioning service for both callers after staging proved adoption of an existing Mattermost bot. |
| Placement client and monitoring | The client took ownership in both environments. Production completed four clean shadow ticks after convergence and three successful active ticks after handoff. The authenticated handback dry run passed. Both monitoring evaluators saw live client executions and successful ticks. |
| Public cloud walkthroughs | The single-gateway foundation exercised single-zone GKE and EKS with Multi-AZ RDS over HTTPS. The full EKS walkthrough exercised shared and isolated placement separately. [Foundation examples](running-in-the-cloud.md#example-installations) · [Full EKS walkthrough](eks.md) |
| Qualification for your deployment | Schedule a regional failover, certificate rotation, full multi-store restore and traffic cutover, and upgrade recovery in staging. Record results for the topology, backing stores and release you intend to run. |

The operator production SQL instance used zonal availability for the checks
above. Regional SQL failover and recovery across all backing stores require
their own qualification runs.
