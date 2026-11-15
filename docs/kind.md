# The full platform on kind

This guide installs the whole platform on a local [kind](https://kind.sigs.k8s.io/)
cluster. It needs no cloud account. One script starts the cluster, puts the
platform images in a local registry and installs everything with Helm. It
copies the images this repository publishes, or builds them from your checkout.
For the smaller local foundation that `install.sh` sets up, see
[Getting started](getting-started.md).

The cluster runs:

- PostgreSQL, for platform state, Mattermost, Gitea and the agent stores;
- SeaweedFS, as the S3 blob store;
- Mattermost, for chat;
- Gitea, for git;
- the fleet controller, with its Admin API;
- the gateway edge;
- the platform API;
- the LLM broker, which holds the model provider keys;
- a shared gateway, once you add one.

## What you need

- Docker, with at least 8 CPUs and 12 GB of memory for its VM
- kind, kubectl and Helm (tested with kind 0.33, kubectl 1.36 and Helm 4.3)
- Node.js 24
- openssl, ssh-keygen and git
- the GitHub CLI, `gh`, to find the release or build to check out
- Go, to install the `octogee-fleet` command line
- a model provider key, so agents can reply. The script will not install
  without one. OpenRouter is recommended; [Model provider keys](#model-provider-keys)
  says where to get each one

## Model provider keys

Agents need a model provider key, so the script stops before it creates
anything if you export none and the cluster stores none. Export one of these in
the terminal where you run the script. It sets the agents' models from the key,
as described under [Agent models](#agent-models).

### OpenRouter (recommended)

Create a key at <https://openrouter.ai/keys> and add credit to the account.
Export it as `OPENROUTER_API_KEY`. Agents use `platform-openrouter/meta/muse-ember`
and fall back to `platform-openrouter/openai/gpt-6-luna`, which is also the
house model. One OpenRouter key also reaches the other providers' models in the
platform catalog, such as Grok.

### OpenAI

Create a key at <https://platform.openai.com/api-keys>. Export it as
`OPENAI_API_KEY`. Agents use `platform-openai/gpt-6.1-terra` and fall back to
`platform-openai/gpt-6-luna`, which is also the house model.

### Anthropic

Create a key at <https://platform.claude.com/settings/keys>. Export it as
`ANTHROPIC_API_KEY`. Agents use `anthropic/claude-sonnet-5` and fall back to
`anthropic/claude-haiku-4-5`, which is also the house model.

### Muse

Muse Ember is the default agent model with an OpenRouter key, so that key is
all it needs. The platform catalog also lists Meta's own `muse-ember-1.0`, but
shared gateways do not route to Meta directly, so the script takes no Meta key.

### Grok

Grok runs through OpenRouter as `platform-openrouter/x-ai/grok-4.6`. With an
OpenRouter key, make it the agent model with the round-trip check's `--model`
option, described under [Agent models](#agent-models).

## Install

Clone the repository and run the script from its root:

```bash
git clone https://github.com/octogee-ai/octogee-cloud.git
```

```bash
cd octogee-cloud
```

Export your model provider key in the same terminal. The script reads
`OPENROUTER_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` and needs at
least one. It stores any of these your shell already exports, and names each
one it stores, so unset a key you do not want in the cluster. `read -s` keeps
the key out of your shell history:

```bash
read -rs OPENROUTER_API_KEY && export OPENROUTER_API_KEY
```

`--pull` copies the images that the Build main workflow published for your
checkout's commit, described under [Images from GitHub](#images-from-github).
Start from the latest release. Its commit always has images:

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

```bash
scripts/ops/kind-install.sh up --pull
```

If your commit has no images, `--pull` stops and says so. `--sha=<full commit
SHA>` copies another commit's images instead, but the Helm chart and the
install steps still come from your checkout, so keep the two close.

To build the images from your checkout instead, leave out `--pull`. The gateway
image is large. The builder's cache grows to about 25 GB across the platform
images, and later builds reuse it. On an amd64 host the build includes the
isolated gateway image, the largest of them; leave it out with `--images`.

```bash
scripts/ops/kind-install.sh up
```

The script:

1. checks for a model provider key, exported or stored in the cluster, and
   stops before it changes anything if there is none;
2. starts a local image registry on `localhost:5001`;
3. creates the kind cluster `octogee` with its own kubeconfig, so your current
   kubectl context does not change. kind reports that it set the context
   `kind-octogee`; it set it only in that kubeconfig;
4. with `--pull`, copies each published image for your machine's architecture
   into the local registry, keeping its digest, except `vm-bridge`;
5. without `--pull`, downloads the pinned OpenClaw build, checks its sha256
   against `gateway/openclaw-tarball/current.json`, builds the platform
   images for your machine's architecture with a dedicated BuildKit builder,
   and pushes them to the local registry;
6. generates every secret: database passwords, the secret store root key, the
   S3 keys, the fleet signing keys, the operator key, and the Mattermost and
   Gitea admin credentials, and stores each provider key you exported in a
   Secret of its own;
7. installs PostgreSQL and SeaweedFS, then the Helm chart in `charts/octogee`;
8. points agents at models of a provider whose key it stores, described under
   [Agent models](#agent-models);
9. creates the Mattermost admin, its access token and the `octogee` team, and
   the Gitea admin, its token and the `octogee` organization;
10. restarts the platform so it reads those tokens and keys, and waits for the
    fleet controller.

Run it again at any time. Each step checks what exists, and secrets are kept
between runs.

The script keeps its state in `~/.local/state/octogee-kind/<name>`, or under
`$XDG_STATE_HOME` if you set it. `<name>` is the cluster name: `octogee` unless
you pass `--name`. To keep the state elsewhere, set `OCTOGEE_KIND_STATE` to a
parent folder; the state then goes in `$OCTOGEE_KIND_STATE/<name>`. It holds
the kubeconfig, the generated secrets and the image digests.

Keep to one install per host. Every cluster name shares the local registry on
port 5001, and every install's fleet configuration expects the Admin API on
port 18080.

| Flag | Effect |
| --- | --- |
| `--name=<name>` | Name of the cluster and of its state directory. The default is `octogee`. |
| `--pull` | Copy the images that Build main published for the checkout's commit instead of building them. |
| `--sha=<sha>` | With `--pull`, copy the images published for this full commit SHA. |
| `--manifest=<file>` | With `--pull`, copy the exact image digests from an extracted Build main manifest. Its SHA must match the selected commit. |
| `--skip-build` | Reinstall the images from the last build or copy, under that commit. |
| `--images=<a,b>` | Build or copy only these platform images. The default is every image except `vm-bridge`; on an arm64 host it also leaves out `octogee-gateway-builder` and says so. |
| `--context-dir=<dir>` | Build from another platform tree. |
| `--openclaw-dir=<dir>` | Take the OpenClaw build from local files instead of downloading it. The files keep their release names. |

To use kubectl against the cluster, always name its kubeconfig and context.
`STATE` is the state directory. `up` ends by printing the line that sets it,
and `scripts/ops/kind-install.sh status` prints it again. With the default name
and location:

```bash
STATE=~/.local/state/octogee-kind/octogee
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local get pods
```

## Operate the fleet

The fleet command line, [octogee-fleet](https://github.com/octogee-ai/octogee-fleet),
talks to the Admin API. Install it with Go:

```bash
go install "github.com/octogee-ai/octogee-fleet@$(sed -n 's/^  OCTOGEE_FLEET_VERSION: //p' .github/workflows/build-main.yml)"
```

Run it from your checkout. It installs the octogee-fleet release that Build
main tested that commit with, `OCTOGEE_FLEET_VERSION` in
`.github/workflows/build-main.yml`, which a release's notes also name.

Go downloads the newer Go version the command line needs if yours is older, and
puts the program in `$(go env GOPATH)/bin`, usually `~/go/bin`. Add that folder
to your `PATH` if your shell cannot find `octogee-fleet`.

On kind the command line signs in with the operator key that the script
generated. The fleet controller trusts the matching public key
(`FLEET_OPERATOR_PUBLIC_KEY`), and `scripts/ops/operator-token.mjs` signs a token
that lasts ten minutes. The script writes a configuration for the command line
to `$STATE/fleet-config.json`. It runs `scripts/ops/operator-token.mjs` from
this checkout by its full path, so keep the checkout where it is while you use
the cluster.

A new terminal has neither `STATE` nor `OCTOGEE_FLEET_CONFIG`, so set both in
every terminal you open for the cluster. `status` prints both lines with your
path; with the defaults they are:

```bash
export STATE=~/.local/state/octogee-kind/octogee
export OCTOGEE_FLEET_CONFIG="$STATE/fleet-config.json"
```

The command line reaches the Admin API through a port-forward that must keep
running. The fleet controller serves the Admin API, and its Service is named
`glm-controller`, a [name from before the rename](legacy-names.md#storage-and-images).
Open a second terminal, set the two variables there, and start it:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/glm-controller 18080:8080
```

Leave it running. In your first terminal, check that the command line reaches
the Admin API:

```bash
octogee-fleet --env=kind gateway ls
```

The platform adds no shared gateway on its own. Add one on the platform's build,
then wait until its status is `ready`:

```bash
octogee-fleet --env=kind gateway add --id=shared-a --apply
octogee-fleet --env=kind gateway ls
```

The gateway boots against the platform API, so the API must be running first.

## Users

Add a user, then place them on the shared gateway. The platform does not place
users on its own; until you assign one, the fleet controller logs that the user
has no gateway.

```bash
octogee-fleet --env=kind user add lin --email=lin@example.com --apply
octogee-fleet --env=kind user assign lin --to=shared-a --apply
octogee-fleet --env=kind user inspect lin
```

When `user inspect` shows provisioning `complete` and the user mounted on
`shared-a`, the user has:

- a Mattermost account `lin` and a team named after them, shown as lin's
  Workspace, with the private channels General (`lin-general`) and Coach
  (`lin-coach`); their agent, the bot `lin-coach`, is in both;
- a Gitea account `ws-lin` and an organization `lin`, with a `workspace`
  repository and an empty `system_config` repository.

A user on a shared gateway works with their agent through Mattermost and Gitea.
The OpenClaw Control UI is for users on an isolated gateway, so for a user on
`shared-a`, `/ui` in Mattermost answers that the Control UI is for isolated
gateways only.

## An isolated gateway

On an amd64 host, kind can give a user a gateway of their own. It runs as a
Kubernetes pod with its own home claim, and has no desktop or computer; those
need a VM. The isolated gateway image is published for `linux/amd64` only, so
on an arm64 host, such as an Apple Silicon Mac, the install leaves it out and a
given gateway never starts. `gateway inspect` then shows, as its last error,
that the isolated gateway image is linux/amd64 only and the cluster has no
amd64 node.

Write a sizing profile whose computer is a pod. `homeSizeGiB` sizes the
gateway's home claim, which kind's default storage class provides. CPU and
memory come from the gateway chart's preset for `sizingTier`; kind's values
shrink the `s` preset to 500m CPU and 2 GiB to fit a laptop.

```bash
cat > pod-s.json <<'EOF'
{"isolation":"isolated","sizingTier":"s","computer":{"runtime":"cluster","homeSizeGiB":2},"fallbackStorageGb":null}
EOF
octogee-fleet --env=kind sizing set pod-s --file=pod-s.json --apply
```

Move the user to a new isolated gateway of that profile. The command prints the
migration's operation id; `ops inspect` shows the new gateway's id on its
`gateway` line, and `gateway ls` lists it. Wait until `ops inspect` shows the
migration succeeded. The user is mounted on the new gateway before the
migration finishes, and the Admin API refuses to park or retire a gateway while
a migration to or from it is in flight:

```bash
octogee-fleet --env=kind user migrate lin --to-isolated=pod-s --apply
octogee-fleet --env=kind ops inspect <operation>
```

The fleet controller creates the home claim `octogee-gateway-<id>-data` before
it starts the pod, and never replaces the claim of a gateway that has served.
Until the pod runs, `gateway inspect <id>` shows what blocks it as its last
error: a claim the storage class cannot bind, a pod the scheduler cannot place,
or no amd64 node.

- `gateway park <id> --apply` stops the pod and keeps the claim, and
  `gateway resume <id> --apply` starts it again on the same home.
- `user migrate lin --to=shared-a --apply` returns the user to the shared
  gateway. Wait for that migration to succeed too.
- `gateway retire <id> --apply` then deletes the gateway, its claim and its
  service account.

## Sign in to Mattermost and Gitea

Issue the user's passwords. The command prints a chat password and a git
password once and keeps no copy:

```bash
octogee-fleet --env=kind user issue-passwords lin --apply
```

The chat username is `lin`. The git username is `ws-lin`, with a `ws-` prefix.
Run the command again if a password is lost; it replaces both.

Neither service has an ingress on kind. Forward each one in a terminal of its
own, with `STATE` set, and leave it running:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/mattermost 8065:8065
```

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/octogee-gitea-http 3000:3000
```

Mattermost is then at <http://localhost:8065> and Gitea at
<http://localhost:3000>. Gitea asks for a new password at the first sign-in.
Mattermost does not, so change the chat password under **Profile > Security**.
The user's workspace clones over the same port-forward, with the username
`ws-lin` and the git password:

```bash
git clone http://localhost:3000/lin/workspace.git
```

If the clone fails with `Authentication failed` after you reinstall, git
offered a password it saved for `localhost:3000` from an earlier cluster. Git
forgets that password when it fails, so run the clone again.

Both services keep their in-cluster addresses as their configured URLs, for
example `http://octogee-gitea-http.octogee-local.svc.cluster.local:3000`. Your
machine cannot resolve those names. Pages you open through a port-forward use
`localhost`, but if a link takes you to an in-cluster address, open the same
path on `localhost` with that service's port.

## Call the platform API as a user

The platform API knows a user by their Mattermost sign-in. A request carries
`Authorization: Bearer <token>`, where the token is one of the user's Mattermost
tokens. The API asks Mattermost whose token it is and finds the platform user
created for that Mattermost account. It trusts only the account's Mattermost id:
the username, email and Mattermost roles play no part. A Mattermost system admin
is not a platform admin; only the platform's own role decides that. Tokens of bot
accounts and deactivated accounts are refused.

There are two kinds of token:

- **A session token.** Sign in through the Mattermost API with the user's chat
  password, and take the `Token` header of the answer. The session lasts as long
  as Mattermost's session settings allow, and signing out ends it.

  ```bash
  read -rs MM_PASSWORD
  MM_TOKEN=$(printf '{"login_id":"lin","password":"%s"}' "$MM_PASSWORD" \
    | curl -sS -D - -o /dev/null http://localhost:8065/api/v4/users/login \
        -H 'content-type: application/json' --data @- \
    | sed -n 's/^[Tt]oken: //p' | tr -d '\r')
  ```

- **A personal access token.** The chart turns on Mattermost's
  `EnableUserAccessTokens` setting. Mattermost still lets a user create a token
  only after a system admin allows it, under **System Console > User Management >
  Users > Manage Roles > Allow this account to generate personal access tokens**.
  The user then creates one under **Profile > Security > Personal Access
  Tokens**, and it lasts until they revoke it.

Forward the API in a terminal of its own, then call it. Its Service keeps the
earlier name `octogee-api`:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/octogee-api 3001:3001
```

```bash
curl -sS -H "authorization: Bearer $MM_TOKEN" http://localhost:3001/api/features
```

A token Mattermost does not accept gets `401`. If Mattermost does not answer
within 5 seconds, the API answers `503` and logs it.

The API remembers a token it has checked for up to 60 seconds. A sign-out, a
revoked token or a deactivated Mattermost account can therefore keep working for
up to 60 seconds. A suspended platform user is refused at once, because the API
reads the user's platform state on every request.

A gateway's routes under `/g/<gateway>/` accept the same tokens. The gateway
has no Mattermost or platform state of its own, so it asks the platform API
whose token it is and remembers the answer for up to 60 seconds. On a gateway,
a revoked token can keep working for up to 120 seconds: 60 at the API plus 60 at
the gateway. A suspension reaches a gateway within 60 seconds.

The API answers at most 6,000 of a gateway's verify calls a minute, counting
rejected tokens too. Past that it answers `429` and logs the gateway id once a
minute. The gateway then answers `503` to a token it has not remembered, while
tokens it remembers keep working.

## Talk to the agent

Open the Coach channel in Mattermost and send a message. The agent answers in
the channel, in one post that it edits as the reply grows. To have it answer in
a thread instead, set the gateway values `env.mmReplyToMode` (`off`, `first`,
`all` or `batched`) and `env.mmStreamingMode` (`off`, `partial`, `block` or
`progress`), which fill OpenClaw's `channels.mattermost.replyToMode` and
`streaming.mode` when a gateway's config does not set them.

`kubectl port-forward` stops when a forwarded connection resets, which
Mattermost's websocket can do, and prints `lost connection to pod`. Start the
port-forward again if the page stops loading.

On a shared gateway, an agent reaches its model provider through the LLM broker.
The broker holds the provider keys and gives each agent a token of its own, so
no provider key sits in a gateway pod. It records every model call, with its
tokens and cost, in the platform database.

The script keeps each key you export in its own Secret: `octogee-openrouter`,
`octogee-anthropic` or `octogee-openai`. It passes the key to kubectl through a
file descriptor, so the key never appears in a command line, the Helm values or
the state directory. A provider whose key you never exported has no Secret, and
the broker refuses calls to it. To add or replace a key, export it and run `up`
again; the script restarts the broker so it reads the new key. A rerun needs no
export while the cluster stores a key.

### Agent models

The platform's built-in agent model and house model are OpenAI models. Without
an OpenAI key, each turn fails at OpenAI several times before it tries the
fallback. So the script sets the platform's agent model, its fallback and the
house model to models of a provider whose key it stores, listed under
[Model provider keys](#model-provider-keys).

With more than one key stored, it uses the first of OpenRouter, Anthropic and
OpenAI. It names the models it sets, and sets them again on each `up`, so they
follow the keys you store. Agents of users who are already mounted switch at
the fleet controller's next pass. Models that something else set, such as
`kind-agent-round-trip.mjs --model`, stay as they are; the script says it kept
them.

`scripts/ops/kind-agent-round-trip.mjs` checks the whole path in one command.
It adds the shared gateway `shared-a` and the user `lin` if they are missing,
issues `lin` new passwords, signs in to Mattermost as `lin`, sends one message in
`lin-coach` and waits up to five minutes for the agent's reply. It then checks
that the broker recorded a successful model call for `lin` in the platform
database. It starts its own port-forwards, so it needs none of yours:

```bash
node scripts/ops/kind-agent-round-trip.mjs --state="$STATE" \
  --model=platform-openrouter/meta/muse-ember
```

`--model` first sets the platform's default agent model and house model to that
catalog model, with no fallback, and the check then requires a call to it. The
setting stays on the cluster, and later runs of `up` keep it. Without
`--model`, any successful call passes.

## Differences from a cloud cluster

- kind has no gVisor runtime. Gateways, isolated ones included, run on the
  node's default runtime with `runtimeClassName` set to an empty value, and
  share the node's kernel. On a cluster that serves other people, install
  gVisor or another sandbox runtime and set
  `glm-controller.gatewayValues.runtimeClassName` to it, as GKE Sandbox does
  with `gvisor`.
- An isolated gateway that runs as a pod is in the same namespace as every
  other gateway. What sets it apart from other users' gateways is its own
  service account and home claim.
- The kind node carries the `topology.kubernetes.io/zone` and
  `topology.kubernetes.io/region` labels that the gateway's topology spread
  needs.
- Mattermost runs the stock Team Edition image, which is published for amd64
  only. The chart pins that platform's manifest, and kind's values let it
  schedule on any node, so on an arm64 machine it runs under the container
  runtime's amd64 emulation, which Docker Desktop provides.
- Gateways have no network policies: neither the fleet's nor each gateway's
  own. A cloud cluster lets an isolated gateway reach the Kubernetes API
  server through its own egress policy, which only adds to the fleet's
  gateway egress policy. kind's network plugin enforces network policies, so
  that egress policy alone would leave the gateway able to reach the API server
  and nothing else, not even DNS or the platform API.

## Remove everything

```bash
scripts/ops/kind-install.sh down
```

This deletes the cluster and the state directory. It also deletes the local
registry, unless another kind cluster still pulls from it. A build
without `--pull` creates the dedicated builder `octogee-cloud-kind`. It stays,
with its cache; remove it with `docker buildx rm octogee-cloud-kind`.

## Images from GitHub

The Build main workflow (`.github/workflows/build-main.yml`) builds the same
images for `linux/amd64` and `linux/arm64` on every push to `main`, together
with the two that only an install with isolated gateways runs: the VM bridge
(`vm-bridge`) and the isolated gateway image (`octogee-gateway-builder`).
The isolated gateway image is `linux/amd64` only. On arm64 clusters, schedule
it on amd64 nodes. On arm64 laptops, it will not run in kind. The
workflow pushes every image to `ghcr.io/octogee-ai/octogee-cloud/<image>`,
tagged with the full and short commit SHA, and keeps an image manifest of every
digest as a workflow artifact named `image-manifest-<sha>`. The manifest lists
each image's platforms. A running image build always finishes; a newer push's
image build waits behind it and replaces any that was already waiting. The
smoke tests and scans that follow publication do not hold up the next build. A release adds its
`vX.Y.Z` tag to each image, attaches the manifest, and publishes the charts
and npm packages at the same version, as [Releasing](releasing.md) describes. `kind-install.sh up --pull` installs
these images. The post-build kind smoke test takes the amd64 digests directly
from that run’s manifest and uses `octogee-fleet gateway ls` to query the new
cluster’s Admin API. It then runs `kind-agent-round-trip.mjs` with Muse Ember on
OpenRouter, so one user's agent replies through the LLM broker with a real
provider key. A second job runs `kind-isolated-gateway.mjs` on its own cluster
at the same time:

1. It gives the user an isolated gateway that runs as a pod.
2. It requires the gateway to mark its workspace identities ready for its
   boot (`workspace-identity-ready`), and the migration to succeed. Then it
   runs a Coach round trip whose broker call the ledger records from that
   gateway.
3. It writes a file to the gateway's home, then parks and resumes the gateway.
   It requires the resumed boot, not the one before park, to mark its
   identities ready, and then checks the file.
4. It returns the user to the shared gateway, waits for that migration to
   succeed, retires the isolated one, and checks its home claim is gone.

The job reads the identity markers only while the gateway's container is
running. It fails at once if they can't be read three times in a row while the
container runs. If the identities never become ready, the job prints the
gateway's last `Workspace identity initialization failed` log line. If a
migration ends in any state but succeeded, or is still in flight after 10
minutes, the job names its status, the step it stopped on and that step's
error. When any step after the gateway is created fails, the job adds the
gateway's pod and container states, the events of its Deployment, ReplicaSets,
pods and home claim, the network policies that select its pod, and the last 40
lines of its gateway container's log, and of the previous container's log when
the container restarted. Tokens, keys, passwords and URL credentials are
redacted from everything the job prints when it fails.

Both jobs run in the `agent-round-trip` environment, which only `main` can use;
the installer stores the environment's `OPENROUTER_API_KEY` secret in the
cluster. Pull requests never run this workflow.

The workflow keeps its build cache in GitHub Actions cache scopes named
`octogee-cloud-<image>-<platform>`. The isolated gateway image and its base
are left out, so they are rebuilt on every run. It never reads or writes a
registry cache, and no other build may share its cache. Before an image is tagged, the workflow
checks that every compiled module in it has a source file in this repository,
and that no file in it sits under a `product` path.

Run the same check against the images on your machine:

```bash
node scripts/ci/cloud-build.mjs tripwire --registry=localhost:5001/octogee \
  --digests="$STATE/digests.json" --root=.
```

### Verify published images

The Build main workflow records provenance for each multi-platform image and
each platform digest. To verify an image, use its `image` reference from the
workflow's `image-manifest-<sha>` artifact:

```bash
image=$(jq -er '.images["octogee-gateway"].image' image-manifest.json)
gh attestation verify "oci://$image" --repo octogee-ai/octogee-cloud \
  --signer-workflow octogee-ai/octogee-cloud/.github/workflows/build-main.yml \
  --source-ref refs/heads/main
```

The `image-security-*` artifacts include the source manifest, one Trivy JSON
report, and one CycloneDX SBOM per image for the named architecture. Findings
are reported in the run summary and do not fail publication. Scanner errors,
missing digests, or missing reports fail the scan job. The weekly scan reuses
the latest published Build main manifest from a push to `main` and uses current
vulnerability data.
