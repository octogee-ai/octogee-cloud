# Running the foundation in the cloud

`install.sh --target=gcp` and `--target=aws` install the foundation on your
cloud provider's managed services: Kubernetes, PostgreSQL, object storage,
Traefik, Gitea, Mattermost and one stock OpenClaw gateway. The installer does
not run a database or object store in your cluster on this path.

**This is not the full platform.** These targets do not install the fleet
controller, the platform API, the gateway edge or the LLM broker, so there are
no users, shared gateways or isolated gateways to manage. The gateway is the
stock `ghcr.io/openclaw/openclaw` image, and it holds the model keys you export
in its own environment. The full platform runs on a local kind cluster, see
[The full platform on kind](kind.md), on GKE, see
[The full platform on GKE](gke.md), or on EKS, see
[The full platform on EKS](eks.md), which has not run on a real AWS account
yet.

**The foundation has not run on a real cloud account either.** The Google
Cloud and AWS recipes pass their tests against stubbed provider command-line
tools, and their flags were checked against each provider's own tool. Expect to
find rough edges on a first real run, and please report them.

## What gets created

| | Google Cloud | AWS |
| --- | --- | --- |
| Kubernetes | Regional GKE with private nodes, 3 to 9 nodes | EKS with private nodes, 2 to 5 nodes |
| PostgreSQL 16 | Cloud SQL, highly available, private address, encrypted connections only | RDS Multi-AZ, private, encrypted |
| Backups | Daily, with point-in-time recovery | Daily, kept for 7 days |
| Object storage | Cloud Storage | S3 |
| Outbound traffic | Cloud NAT | NAT gateway |
| Inbound traffic | Traefik behind a load balancer | Traefik behind a Network Load Balancer |
| TLS | cert-manager with Let's Encrypt | cert-manager with Let's Encrypt |

The databases have deletion protection on.

Mattermost, Gitea and the OpenClaw gateway have no managed equivalent on the
default path, so they run in your cluster. Their databases are on the managed
PostgreSQL, and their files are on your provider's persistent disks.

Mattermost Team Edition runs one replica and stops creating accounts at 250
activated users across the server. Bots do not count.

## Before you start

- The accounts in [What you need to sign up for](getting-started.md#what-you-need-to-sign-up-for).
- A cloud account with billing on and permission to create the resources above.
- A domain you control. Chat and Git use `chat.` and `git.` under it.
- An email address for certificate notices.
- The tools in [Requirements](requirements.md). The installer checks them.

These are billable resources that run until you remove them. Check your
provider's pricing first.

## Start small on the welcome credit

The defaults are sized for an install you depend on: nodes in three zones and
a highly available database. They use up Google Cloud's welcome credit quickly. For a first
install, use one zone and a smaller database:

```bash
export GCP_ZONE=us-central1-a SQL_AVAILABILITY=ZONAL SQL_TIER=db-custom-1-3840
```

You get one node that can grow to three and a database with no standby. The
free tier covers the fee for a zonal cluster, but not the node, the database or
the network. If that zone goes down, so does your install, so move to the
defaults before you depend on it.

## Install on Google Cloud

Sign in first:

```bash
gcloud auth login
```

Then run the installer. It asks for anything you have not set.

```bash
export GCP_PROJECT=your-project-id GCP_REGION=us-central1 DOMAIN=platform.your-company.com ACME_EMAIL=your-email-address
```

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh | bash -s -- --target=gcp
```

## Install on AWS

Sign in first:

```bash
aws configure sso
```

Then run the installer.

```bash
export AWS_REGION=us-east-1 DOMAIN=platform.your-company.com ACME_EMAIL=your-email-address
```

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh | bash -s -- --target=aws
```

## Finish the install

An install takes 30 to 45 minutes. It ends by printing your load balancer's
address.

1. Create DNS records for `chat.` and `git.` under your domain, pointing at that
   address. Use an A record for an IP address and a CNAME for a hostname.
2. Wait a few minutes for the certificates. Plain HTTP stays closed to the apps.
3. Run the checks, then get the admin password. Use `aws` in place of `gcp` on
   AWS. Run these from the checkout, with `DOMAIN` still set.

   ```bash
   ./deploy/cloud/check.sh gcp
   ```

   ```bash
   ./deploy/cloud/credentials.sh gcp
   ```

4. Open `https://chat.your-domain` and sign in as `platformadmin`.

Any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or
`OPENROUTER_API_KEY` exported in your shell is copied into the cluster. The
installer lists them before you confirm. To add one later, set it and run the
same provider script again. It is safe to repeat.

```bash
./deploy/cloud/gcp.sh
```

Everyone with a chat account can message the agent. Accounts are invitation
only. The installer keeps cluster credentials in their own file, such as
`~/.kube/octogee-cloud-gcp`, and leaves your current Kubernetes context alone.

## Sizing

Set these before you install.

| Setting | Default | Applies to |
| --- | --- | --- |
| `CLUSTER_NAME` | `octogee-cloud` | Both |
| `MACHINE_TYPE` | `e2-standard-4` | Google Cloud nodes |
| `SQL_TIER` | `db-custom-2-7680` | Cloud SQL |
| `SQL_AVAILABILITY` | `REGIONAL` | Cloud SQL. `ZONAL` has no standby |
| `GCP_ZONE` | Not set, so the cluster is regional | Google Cloud. Set it for a zonal cluster |
| `NODE_TYPE` | `m6i.xlarge` | AWS nodes |
| `DB_CLASS` | `db.m6i.large` | RDS |

## Other providers

A provider is one short script in `deploy/cloud/`. It creates a cluster, a
PostgreSQL 16 database with `vector`, `unaccent` and `pg_trgm`, and an
S3-compatible bucket, then calls `install_on_cluster`. `gcp.sh` is the example
to copy. These are not written yet:

| Provider | Kubernetes | PostgreSQL | Object storage |
| --- | --- | --- | --- |
| Azure | AKS | Azure Database for PostgreSQL | Azure Blob has no S3 API, so use an S3-compatible store elsewhere |
| DigitalOcean | DOKS | Managed PostgreSQL | Spaces |

## Remove it

Deleting these destroys your data. Remove the load balancer first so that
deleting the cluster does not strand it.

**Google Cloud:**

```bash
helm --kubeconfig ~/.kube/octogee-cloud-gcp -n octogee-cloud uninstall traefik
```

```bash
gcloud sql instances patch octogee-cloud --no-deletion-protection --project "${GCP_PROJECT}"
```

```bash
gcloud sql instances delete octogee-cloud --project "${GCP_PROJECT}"
```

```bash
gcloud container clusters delete octogee-cloud --region "${GCP_REGION}" --project "${GCP_PROJECT}"
```

If you installed in one zone, use `--zone "${GCP_ZONE}"` in place of `--region`.

```bash
gcloud storage rm -r "gs://${GCP_PROJECT}-octogee-cloud" --project "${GCP_PROJECT}"
```

Then remove the `octogee-cloud` Cloud NAT, router and network, and the
`octogee-cloud-files` service account.

**AWS:**

```bash
helm --kubeconfig ~/.kube/octogee-cloud-aws -n octogee-cloud uninstall traefik
```

```bash
aws rds modify-db-instance --db-instance-identifier octogee-cloud --no-deletion-protection --apply-immediately
```

```bash
aws rds delete-db-instance --db-instance-identifier octogee-cloud --skip-final-snapshot
```

```bash
aws rds wait db-instance-deleted --db-instance-identifier octogee-cloud
```

```bash
eksctl delete cluster --name octogee-cloud --region "${AWS_REGION}"
```

Then remove the `octogee-cloud` database subnet group, the
`octogee-cloud-database` security group, the S3 bucket, and the
`octogee-cloud-files` IAM user.
