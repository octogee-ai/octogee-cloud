# The full platform on GKE

This guide installs the whole platform in one Google Cloud project, from an
empty project to an agent that replies in Mattermost. It uses only what this
repository publishes: the images Build main pushes to GitHub's container
registry, the Helm chart in `helm/octogee`, and the
[octogee-fleet](https://github.com/octogee-ai/octogee-fleet) command line. One
script, `scripts/ops/gke-install.sh`, creates the cloud resources and installs
the chart. For the same platform on your own machine, see
[The full platform on kind](kind.md).

The project runs:

- a zonal GKE Standard cluster with private nodes, Dataplane V2 network
  policies and Workload Identity, and a second node pool that runs gateways
  under GKE Sandbox (gVisor);
- Cloud SQL for PostgreSQL 16, on a private address that takes encrypted
  connections only, for platform state, Mattermost, Gitea and the agent stores;
- two Cloud Storage buckets, reached through Cloud Storage's S3 interface, as
  the blob store;
- Cloud NAT, so the private nodes reach GitHub's container registry and the
  model providers;
- in the cluster: Mattermost, Gitea, the fleet controller with its Admin API,
  the gateway edge, the platform API, the LLM broker, and the gateways you add.

Nothing is exposed to the internet. kubectl reaches the cluster's control plane
through its DNS endpoint, which checks your Google Cloud credentials, so the
script sets no authorized networks. You reach Mattermost, Gitea and the Admin
API through `kubectl port-forward`, as on kind.

Every connection to Cloud SQL is encrypted, but no client verifies the server's
certificate: Mattermost and Gitea connect with `sslmode=require`, the platform
with `require`, and the agent stores with `no-verify`. Something that could
answer on the database's private address inside the network could stand in for
it. Giving each client Cloud SQL's server CA to verify against would close
that; the platform already takes `verify-full` with a CA, but this install does
not set it up yet.

## What you need

- A Google Cloud project with billing on, and an account that is an owner of
  it. The script creates everything inside that one project.
- The Google Cloud CLI with `gke-gcloud-auth-plugin`, kubectl, Helm (tested
  with Helm 4.3), Docker (only `docker buildx imagetools`, to read image
  digests), Node.js 24, openssl, ssh-keygen, git, and the GitHub CLI (`gh`)
  to find the release or build to check out.
- Go, to install `octogee-fleet`.
- A model provider key. OpenRouter is recommended;
  [Model provider keys](kind.md#model-provider-keys) says where to get each one
  and which models it gives agents.

These are billable resources that run until you remove them. With the defaults
below, the cluster runs two to five `e2-standard-4` nodes: one or two for the
platform, and one for each gateway. Add the `db-custom-1-3840` database, Cloud
NAT and the cluster's management fee, and check current list prices before you
start.

## Install

Sign in, then clone the repository and work from its root:

```bash
gcloud auth login
```

```bash
git clone https://github.com/octogee-ai/octogee-cloud.git && cd octogee-cloud
```

Name your project and export your model provider key. `read -s` keeps the key
out of your shell history:

```bash
export GCP_PROJECT=your-project-id
```

```bash
read -rs OPENROUTER_API_KEY && export OPENROUTER_API_KEY
```

The script stores every provider key exported in its environment:
`OPENROUTER_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Unset any you
do not mean to give the cluster before you run it.

Pick the commit. The script installs the images Build main published for your
checkout's commit, and the chart and the install steps come from the same
checkout. Start from the latest release. Its commit always has images:

```bash
git checkout "$(gh release view -R octogee-ai/octogee-cloud --json tagName --jq .tagName)"
```

Until the first release is out, or to run newer code, check out `main`'s newest
built commit instead. Build main publishes a commit's images about 15 minutes
after it reaches `main`. A running build always finishes, and only the newest
push waits behind it, so a commit pushed in between can end up with no images.
This checks out the newest `main` commit whose Build main succeeded:

```bash
git checkout "$(gh run list -R octogee-ai/octogee-cloud --workflow=build-main.yml --branch=main \
  --event=push --status=success --limit=1 --json headSha --jq '.[0].headSha')"
```

Then run the script:

```bash
scripts/ops/gke-install.sh up
```

If your commit has no images, the script stops before it creates anything and
says so.

A first run takes about 20 minutes, most of it the cluster and the database.
The script:

1. checks for a model provider key, exported or stored in the cluster;
2. reads the `linux/amd64` digest of each image published for the commit,
   from `ghcr.io/octogee-ai/octogee-cloud`;
3. enables the Compute, Kubernetes Engine, Cloud SQL, Service Networking,
   Cloud Storage and IAM APIs;
4. creates the network `octogee` with Cloud NAT and a private services range
   for Cloud SQL;
5. creates the cluster `octogee` in `GCP_ZONE` with one system node, and the
   node pool `gateways`, which runs pods under gVisor;
6. creates the Cloud SQL instance `octogee`, private address only, encrypted
   connections only;
7. creates the buckets `<project>-octogee-assets` and
   `<project>-octogee-workspaces`, the service account `octogee-blob-store`
   with access to those two buckets only (their objects, and reading each
   bucket's settings), and an HMAC key for it;
8. generates every secret, as on kind, and stores each provider key you
   exported in a Secret of its own;
9. creates the databases and their accounts;
10. installs the Helm chart with `scripts/ops/gke/values.yaml` and the
    project's own addresses;
11. points agents at models of a provider whose key it stores;
12. creates the Mattermost and Gitea admins, their tokens, the `octogee` team
    and the `octogee` organization;
13. restarts the platform so it reads those tokens and keys.

Run it again at any time; each step checks what exists. The script keeps its
state in `~/.local/state/octogee-gke/<project>`: the kubeconfig, the generated
secrets and the image digests. Set `OCTOGEE_GKE_STATE` to keep it elsewhere.

| Setting | Default | Effect |
| --- | --- | --- |
| `GCP_PROJECT` | none | The project to install into. Required. |
| `GCP_REGION` | `us-central1` | Region of the network, NAT, database and buckets. |
| `GCP_ZONE` | `<region>-a` | Zone of the cluster and the database. |
| `MACHINE_TYPE` | `e2-standard-4` | System nodes. |
| `GATEWAY_MACHINE_TYPE` | `e2-standard-4` | Gateway nodes, one gateway each. A shared gateway defaults to the `m` sizing tier, 2 CPUs and 8 GiB, and an isolated gateway to `s`, 1 CPU and 4 GiB. The `l` tier, 4 CPUs and 16 GiB, needs a larger machine. |
| `SQL_TIER` | `db-custom-1-3840` | Cloud SQL machine. |

| Flag | Effect |
| --- | --- |
| `--sha=<sha>` | Install the images published for this full commit SHA. The default is the checkout's commit. |
| `--manifest=<file>` | Take the image digests from an extracted Build main `image-manifest-<sha>` artifact instead of the registry. |

## Operate the fleet

Install the command line:

```bash
go install "github.com/octogee-ai/octogee-fleet@$(sed -n 's/^  OCTOGEE_FLEET_VERSION: //p' .github/workflows/build-main.yml)"
```

Run it from your checkout. It installs the octogee-fleet release that Build
main tested that commit with, `OCTOGEE_FLEET_VERSION` in
`.github/workflows/build-main.yml`, which a release's notes also name.

`up` ends by printing the variables to set in every terminal you use for the
cluster, and the port-forward the command line needs. With the default
location they are:

```bash
export STATE=~/.local/state/octogee-gke/$GCP_PROJECT
export OCTOGEE_FLEET_CONFIG="$STATE/fleet-config.json"
```

The command line signs in with the operator key the script generated, through
`scripts/ops/operator-token.mjs` in this checkout. Keep the Admin API forwarded
in a second terminal:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" -n octogee port-forward svc/glm-controller 18080:8080
```

Then add a shared gateway, a user, and place the user:

```bash
octogee-fleet --env=gke gateway add --id=shared-a --apply
octogee-fleet --env=gke gateway ls
octogee-fleet --env=gke user add lin --email=lin@example.com --apply
octogee-fleet --env=gke user assign lin --to=shared-a --apply
octogee-fleet --env=gke user inspect lin
```

Everything from [Users](kind.md#users) onward in the kind guide applies here,
with `--env=gke`, namespace `octogee` and the kubeconfig in `$STATE`.

## Talk to the agent

Issue the user's passwords, forward Mattermost, and sign in at
<http://localhost:8065> as `lin`:

```bash
octogee-fleet --env=gke user issue-passwords lin --apply
```

```bash
kubectl --kubeconfig="$STATE/kubeconfig" -n octogee port-forward svc/mattermost 8065:8065
```

Open the Coach channel (`lin-coach`) and send a message. The agent answers in
the channel, usually within a few seconds.

## A project

A project gives the user a channel, a Gitea repository and an agent of its
own. Create one through the platform API. Forward it in a terminal of its own:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" -n octogee port-forward svc/octogee-api 3001:3001
```

Take a Mattermost session token for `lin` as in
[Call the platform API as a user](kind.md#call-the-platform-api-as-a-user),
then create the project:

```bash
curl -sS -H "authorization: Bearer $MM_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Garden Planner","slug":"garden","tagline":"Plan a vegetable garden"}' \
  http://localhost:3001/api/projects
```

The project's channel is `Garden Planner` (`lin-proj-garden-general`), and
the repository is `lin/garden`. The project's agent appears in the channel at
once but starts listening about two minutes later, and it does not answer a
message sent before then, so wait two minutes before you write to it. Ask it
to write a file, for example `plan.md` with three vegetables to plant. The
gateway saves the project to Gitea every 30 seconds. To check a save, forward
Gitea:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" -n octogee port-forward svc/octogee-gitea-http 3000:3000
```

Gitea refuses the issued git password until it is changed. Sign in once at
<http://localhost:3000> as `ws-lin` with that password and set a new one, then
clone the repository with the new password:

```bash
git clone http://localhost:3000/lin/garden.git && git -C garden log --oneline
```

## An isolated gateway

The `gateways` node pool runs isolated gateways too. Write a sizing profile
whose computer is a pod, and move the user to a new isolated gateway of that
profile:

```bash
cat > pod-s.json <<'EOF'
{"isolation":"isolated","sizingTier":"s","computer":{"runtime":"cluster","homeSizeGiB":10},"fallbackStorageGb":null}
EOF
octogee-fleet --env=gke sizing set pod-s --file=pod-s.json --apply
octogee-fleet --env=gke user migrate lin --to-isolated=pod-s --apply
```

Gateways keep one pod per node, so the pool grows a node for the new gateway,
and the move takes about ten minutes. `user inspect` then shows the user on the
isolated gateway, and the agent answers in the same channel. The project moves
too: ask its agent for another change, and after the move back `git pull` in
your clone shows both saves.
Return the user with `user migrate lin --to=shared-a --apply` and retire the
isolated gateway with `gateway retire <id> --apply`, where `ops inspect` of
the migration names the id, as in
[An isolated gateway](kind.md#an-isolated-gateway).

## What this install does not do yet

- **Changing a gateway's settings.** The fleet controller applies
  `glm-controller.gatewayValues` when it renders a gateway's release, so a
  change reaches only gateways added after it. Restarting the controller or
  the gateway does not apply it. Add a new shared gateway, move its users to
  it and retire the old one.
- **Builds and deploys.** `builds ls`, `gateway deploy` and `gateway add
  --sha` need immutable build manifests, which this install does not provide,
  and the Admin API refuses them. Every gateway runs the platform's build:
  the one `up --sha` installed.
- **Logs.** `octogee-fleet logs` is not configured here; read gateway logs
  with `kubectl logs`.
- **Usage in `user broker`.** The LLM broker records every call in the
  platform database, but `user broker` does not read those records yet and
  reports no usage.

## Remove everything

```bash
scripts/ops/gke-install.sh down
```

This deletes the namespace, the cluster, the database, both buckets, the blob
store service account and its keys, the network and its NAT, and the state
directory. The data goes with them. Cloud SQL can keep the network's service
networking connection in use long after the database is deleted. When Service
Networking reports that, `down` removes the network's own side of the peering
and goes on to delete the address range, the router and the network; any other
error stops it at once with the gcloud error. A stopped `down` keeps the state
directory; run it again, and it skips what is already gone.
If the project exists only for the
platform, deleting the project removes everything at once:

```bash
gcloud projects delete "$GCP_PROJECT"
```
