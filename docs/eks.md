# The full platform on EKS

This guide installs the whole platform in one AWS account and region, from an
empty account to an agent that replies in Mattermost. It uses only what this
repository publishes: the images Build main pushes to GitHub's container
registry, the Helm chart in `charts/octogee`, and the
[octogee-fleet](https://github.com/octogee-ai/octogee-fleet) command line. One
script, `scripts/ops/eks-install.sh`, creates the cloud resources and installs
the chart. It follows [The full platform on GKE](gke.md) step for step.

This install has run end to end on a new AWS account, as
[a small install](#a-small-install) grown to five gateway nodes. That run
showed that:

- the gateway nodes install gVisor at boot and containerd runs pods under it.
  `up` checks this before it creates the database: it starts a pod of runtime
  class `gvisor` and stops if the pod does not report the gVisor kernel;
- eksctl accepts the gateway node group with the script's own launch template;
- the VPC CNI enforces the chart's network policies, and gateways reach the
  Kubernetes API and the model providers through them;
- a shared gateway serves about two minutes after `gateway add`, and a new
  user is provisioned within a minute;
- a move to a new isolated gateway takes about six minutes, most of it the new
  gateway starting, and a move back to a shared gateway about two;
- the agent answers in the Coach channel within about 15 seconds. With an
  OpenRouter key it answered from the model on a shared gateway. On the
  isolated gateway the run had only a key that was not valid, so the answer
  was the provider's sign-in error, which shows the request reached the
  provider;
- `gateway retire` removes an empty isolated gateway in under 10 seconds.

One problem the run found is not fixed yet. When `gateway restart` fails, the
platform cannot tell whether the gateway restarted, and it keeps the gateway
locked. The gateway stops converging, and it cannot be retired. Moves to or
from it never start, and moves of other users off the same shared gateway wait
behind them. No command clears the lock. On a test install, `down` and a new
`up` start over.

Expect rough edges, and please report them.

The account runs:

- an EKS cluster with private nodes in a new VPC, with one NAT gateway, network
  policies enforced by the VPC CNI, and the EBS CSI driver;
- a second managed node group, `gateways`, that runs gateways under gVisor.
  Its nodes are tainted so that only gateways land on them, and their pods
  cannot reach the instance metadata service;
- RDS for PostgreSQL 16 on private subnets, encrypted, that takes connections
  from the cluster only, for platform state, Mattermost, Gitea and the agent
  stores;
- two S3 buckets as the blob store, and an IAM user whose access key the
  platform signs with;
- in the cluster: Mattermost, Gitea, the fleet controller with its Admin API,
  the gateway edge, the platform API, the LLM broker, and the gateways you add.

The cluster's API endpoint is public and checks your AWS credentials, as eksctl
sets it up by default; nothing else is exposed to the internet. You reach
Mattermost, Gitea and the Admin API through `kubectl port-forward`, as on kind.

RDS for PostgreSQL 16 takes encrypted connections only (`rds.force_ssl` is on by
default), but no client verifies the server's certificate: Mattermost and Gitea
connect with `sslmode=require`, the platform with `require`, and the agent
stores with `no-verify`. Something that could answer on the database's address
inside the VPC could stand in for it. Giving each client RDS's certificate
bundle to verify against would close that; the platform already takes
`verify-full` with a CA, but this install does not set it up yet.

EKS has no managed gVisor, so the script makes its own node group for it. A
launch template gives the gateway nodes a boot script that downloads one
pinned gVisor release from gVisor's release bucket, checks it against the
SHA-512 sum committed in the script, unpacks `runsc` and its containerd shim,
and adds a `runsc` runtime to containerd's configuration before containerd
starts. The `gvisor` runtime class schedules pods onto those nodes. A newer
gVisor comes with a newer checkout of this repository and
[new gateway nodes](#change-the-gateway-nodes).

The platform's S3 client signs with a static access key, so the blob store uses
an IAM user, `octogee-blob-store`, whose policy allows the objects of the two
buckets and reading their settings, and nothing else. Its key lives in the
state directory and in a Secret in the cluster.

## What you need

- An AWS account you can create a VPC, an EKS cluster, an RDS instance, S3
  buckets, IAM users and roles, and EC2 launch templates in. An account of its
  own for the platform makes it easy to see and remove what it costs.
- The AWS CLI v2, eksctl, kubectl, Helm (tested with Helm 4.3), Docker (only
  `docker buildx imagetools`, to read image digests), Node.js 24, openssl,
  ssh-keygen, git, and the GitHub CLI (`gh`) to find the release or build to
  check out.
- Go, to install `octogee-fleet`.
- A model provider key. OpenRouter is recommended;
  [Model provider keys](kind.md#model-provider-keys) says where to get each one
  and which models it gives agents.
- Room for the nodes in your EC2 quota. The defaults need 16 vCPUs of
  standard instances, and a new account may run only 5. `up` checks this
  before it creates anything. See the quota, and ask for more:

  ```bash
  aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query Quota.Value
  ```

  ```bash
  aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 32
  ```

  Small increases are often approved within minutes; a new account can wait
  longer. Until then, [a small install](#a-small-install) fits in 4 vCPUs.

These are billable resources that run until you remove them. With the defaults
below, the cluster runs four `m6i.xlarge` nodes: two for the platform and two
for gateways. Add the `db.t4g.medium` database, the NAT gateway and the
cluster's hourly fee, and check current list prices before you start.

## Install

Sign in, then clone the repository and work from its root:

```bash
aws sso login
```

```bash
git clone https://github.com/octogee-ai/octogee-cloud.git && cd octogee-cloud
```

Name your region and export your model provider key. `read -s` keeps the key
out of your shell history:

```bash
export AWS_REGION=us-west-2
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
built commit instead, as [the GKE guide](gke.md#install) describes:

```bash
git checkout "$(gh run list -R octogee-ai/octogee-cloud --workflow=build-main.yml --branch=main \
  --event=push --status=success --limit=1 --json headSha --jq '.[0].headSha')"
```

Then run the script:

```bash
scripts/ops/eks-install.sh up
```

If your commit has no images, the script stops before it creates anything and
says so.

A first run takes about 35 minutes: about 20 for the cluster and 8 for the
database. A later run takes about 3. The script:

1. checks for a model provider key, exported or stored in the cluster;
2. reads the `linux/amd64` digest of each image published for the commit,
   from `ghcr.io/octogee-ai/octogee-cloud`;
3. creates the launch template `octogee-gateways` for the gateway nodes, with
   the gVisor boot script, an encrypted 100 GB root volume, and instance
   metadata limited to the node itself;
4. creates the cluster `octogee` with eksctl, with the node groups `system`
   and `gateways`, the VPC CNI's network policy agent and the EBS CSI driver,
   then the default `gp3` storage class and the `gvisor` runtime class;
5. checks that a pod of runtime class `gvisor` runs under gVisor;
6. creates the security group `octogee-database`, open on port 5432 to the
   cluster only, and the RDS instance `octogee` on the VPC's private subnets,
   with daily backups kept for 7 days;
7. creates the buckets `octogee-<account>-<region>-assets` and
   `octogee-<account>-<region>-workspaces` with public access blocked, the IAM
   user `octogee-blob-store`, and an access key for it;
8. generates every secret, as on kind, and stores each provider key you
   exported in a Secret of its own;
9. creates the databases and their accounts;
10. installs the Helm chart with `scripts/ops/eks/values.yaml` and the
    account's own addresses;
11. points agents at models of a provider whose key it stores;
12. creates the Mattermost and Gitea admins, their tokens, the `octogee` team
    and the `octogee` organization;
13. restarts the platform so it reads those tokens and keys.

Run it again at any time; each step checks what exists. The script keeps its
state in `~/.local/state/octogee-eks/<account>-<region>`: the kubeconfig, the
eksctl configuration, the generated secrets and the image digests. Set
`OCTOGEE_EKS_STATE` to keep it elsewhere.

The network policy that lets gateways and the project runner reach the
Kubernetes API names the API server's addresses and the address of the
`kubernetes` service, because the VPC CNI applies policies before a service
address is translated. EKS can change the API server's addresses when it
upgrades the control plane; run `up` again after an upgrade.

| Setting | Default | Effect |
| --- | --- | --- |
| `AWS_REGION` | none | The region to install into. Required. |
| `INSTANCE_TYPE` | `m6i.xlarge` | System nodes, of an x86_64 type: the images are `linux/amd64` only. Applies when the node group is created; `up` stops if the existing group runs another type. |
| `GATEWAY_INSTANCE_TYPE` | `m6i.xlarge` | Gateway nodes, one gateway each, of an x86_64 type. Applies when the launch template is created; `up` stops if the existing template makes another type. A shared gateway defaults to the `m` sizing tier, 2 CPUs and 8 GiB, and an isolated gateway to `s`, 1 CPU and 4 GiB. The `l` tier, 4 CPUs and 16 GiB, needs a larger instance type. |
| `SYSTEM_NODES` | `2` | Nodes in the `system` group. |
| `GATEWAY_NODES` | `2` | Nodes in the `gateways` group, one for each gateway. |
| `DB_CLASS` | `db.t4g.medium` | RDS instance class. |
| `SHARED_GATEWAY_TIER` | `m` | Sizing tier of shared gateways. `s`, 1 CPU and 4 GiB, fits a 2-vCPU gateway node. |

The node groups do not scale on their own. Gateways keep one pod per node, so
`GATEWAY_NODES` must be at least the number of gateways you run. To change a
group's size, run `up` again with the new count.

### A small install

A new account's 5 vCPUs fit one 2-vCPU node for the platform and one for a
shared gateway at the `s` tier:

```bash
INSTANCE_TYPE=m6i.large GATEWAY_INSTANCE_TYPE=m6i.large SYSTEM_NODES=1 GATEWAY_NODES=1 \
  SHARED_GATEWAY_TIER=s scripts/ops/eks-install.sh up
```

An isolated gateway needs a gateway node of its own. Once the quota allows
it, run `up` again with `GATEWAY_NODES=2` and the same other settings.

| Flag | Effect |
| --- | --- |
| `--sha=<sha>` | Install the images published for this full commit SHA. The default is the checkout's commit. |
| `--manifest=<file>` | Take the image digests from an extracted Build main `image-manifest-<sha>` artifact instead of the registry. |

### Change the gateway nodes

The launch template is made once, and `up` stops when it was made for another
gateway instance type or gVisor release than the checkout's. To change either,
delete the gateway node group and the template, then run `up` again, which
makes both anew. The gateways on those nodes stop until the new nodes are up:

```bash
eksctl delete nodegroup --cluster octogee --region "$AWS_REGION" --name gateways --wait
```

```bash
aws ec2 delete-launch-template --launch-template-name octogee-gateways
```

```bash
scripts/ops/eks-install.sh up
```

## Operate the fleet

Install the command line:

```bash
go install "github.com/octogee-ai/octogee-fleet@$(sed -n 's/^  OCTOGEE_FLEET_VERSION: //p' .github/workflows/build-main.yml)"
```

Run it from your checkout. It installs the octogee-fleet release that Build
main tested that commit with.

`up` ends by printing the variables to set in every terminal you use for the
cluster, and the port-forward the command line needs. With the default
location they are:

```bash
export STATE=~/.local/state/octogee-eks/<account>-$AWS_REGION
export OCTOGEE_FLEET_CONFIG="$STATE/fleet-config.json"
```

The command line signs in with the operator key the script generated, through
`scripts/ops/operator-token.mjs` in this checkout. Keep the Admin API forwarded
in a second terminal:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context="eks_${AWS_REGION}_octogee" -n octogee port-forward svc/glm-controller 18080:8080
```

Then add a shared gateway, a user, and place the user:

```bash
octogee-fleet --env=eks gateway add --id=shared-a --apply
octogee-fleet --env=eks gateway ls
octogee-fleet --env=eks user add lin --email=lin@example.com --apply
octogee-fleet --env=eks user assign lin --to=shared-a --apply
octogee-fleet --env=eks user inspect lin
```

Everything from [Users](kind.md#users) onward in the kind guide applies here,
with `--env=eks`, namespace `octogee` and the kubeconfig in `$STATE`.

## Talk to the agent

Issue the user's passwords, forward Mattermost, and sign in at
<http://localhost:8065> as `lin`:

```bash
octogee-fleet --env=eks user issue-passwords lin --apply
```

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context="eks_${AWS_REGION}_octogee" -n octogee port-forward svc/mattermost 8065:8065
```

Open the Coach channel (`lin-coach`) and send a message. The agent answers in
the channel, usually within a few seconds.

## An isolated gateway

The `gateways` node group runs isolated gateways too, and with the default two
nodes it has room for one next to `shared-a`. On EKS an isolated gateway's
computer is a pod; computers on virtual machines run on Google Compute Engine
only. Write a sizing profile whose computer is a pod, and move the user to a
new isolated gateway of that profile:

```bash
cat > pod-s.json <<'EOF'
{"isolation":"isolated","sizingTier":"s","computer":{"runtime":"cluster","homeSizeGiB":10},"fallbackStorageGb":null}
EOF
octogee-fleet --env=eks sizing set pod-s --file=pod-s.json --apply
octogee-fleet --env=eks user migrate lin --to-isolated=pod-s --apply
```

`user inspect` then shows the user on the isolated gateway, and the agent
answers in the same channel. Return the user with
`user migrate lin --to=shared-a --apply` and retire the isolated gateway with
`gateway retire <id> --apply`, as in
[An isolated gateway](kind.md#an-isolated-gateway).

The gateway build fixes the cause of a return failing with "agent database
files are still held open", but that fix has not yet been confirmed on EKS. If
the return still fails that way, please report it. Then delete the `shared-a`
pod, which restarts the agents of every user on it, and return the user again.

## Remove everything

```bash
scripts/ops/eks-install.sh down
```

This deletes the namespace and waits for its EBS volumes to be released, then
the database without a final snapshot, along with its automated backups, its
subnet group and security group, then the cluster with its VPC and NAT
gateway, the launch template, both buckets with everything in them, the blob
store user and its keys, and the state directory. The data goes with them. It
skips what is already gone, and it stops at the first deletion AWS refuses,
keeping the state directory; fix the cause and run it again.

If the account exists only for the platform, closing the account removes
everything at once.
