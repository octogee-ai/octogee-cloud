# Getting started

Try the Octogee Cloud foundation on your own machine in Docker, or install it
on managed cloud services. One installer, `install.sh`, handles both. The full
platform runs on a local kind cluster or on GKE.

## Three installers

This repository holds the whole platform: the fleet controller with its Admin
API, the platform API, the gateway edge and the OpenClaw gateway image. It has
three installers.

- `install.sh` installs the foundation: Kubernetes, PostgreSQL, S3 storage,
  ingress, a Git host, chat, and one OpenClaw gateway you can talk to. It runs
  on your own machine or on managed cloud services, and the rest of this guide
  covers it.
- `scripts/ops/kind-install.sh` installs the full platform on a local kind
  cluster, with the fleet controller, users, shared gateways and the LLM broker
  that gives agents their model provider. It copies the platform images this
  repository publishes, or builds them from your checkout.
  See [The full platform on kind](kind.md).
- `scripts/ops/gke-install.sh` installs the same platform on GKE, with Cloud
  SQL and Cloud Storage, from the published images. See
  [The full platform on GKE](gke.md).

On the full platform, users on a shared gateway reach their agent through
Mattermost and Gitea. The OpenClaw Control UI is for users on an isolated
gateway only. Such a user types `/ui` in Mattermost. The reply, which only they
can see, holds a link to their Control UI that works once and expires after two
minutes. Anyone else who types `/ui` is told the Control UI is for isolated
gateways only.

## What you need to sign up for

This is the complete list. Mattermost, Gitea, PostgreSQL, file storage and the
OpenClaw gateway are installed for you and need no account.

### To try it on your own machine

| Sign up for | Tier to choose | What it costs |
| --- | --- | --- |
| [Google](https://aistudio.google.com/apikey), for a Gemini API key | [Free tier](https://ai.google.dev/pricing) | Nothing. Google may use free-tier content to improve its products, so use a paid key for private work |

Docker Desktop on macOS and Windows is [free for personal use and small
businesses](https://docs.docker.com/subscription/desktop-license/). Linux needs
only Docker Engine.

A key from Anthropic, OpenAI or OpenRouter works in place of Gemini. They bill
by use.

### To run the full platform on kind

The kind install script needs one model provider key and stops without one.
OpenRouter is the suggestion: one key reaches Muse Ember, the default agent
model, and other providers' models such as Grok. An OpenAI or Anthropic key
works too.

| Sign up for | Tier to choose | What it costs | Export it as |
| --- | --- | --- | --- |
| [OpenRouter](https://openrouter.ai/keys), for an API key (suggested) | Pay as you go | What the agents' model calls cost | `OPENROUTER_API_KEY` |
| [OpenAI](https://platform.openai.com/api-keys), for an API key | Pay as you go | What the agents' model calls cost | `OPENAI_API_KEY` |
| [Anthropic](https://platform.claude.com/settings/keys), for an API key | Pay as you go | What the agents' model calls cost | `ANTHROPIC_API_KEY` |

[Model provider keys](kind.md#model-provider-keys) lists the models the script
sets for each key, and how to run Muse or Grok.

### To run it on Google Cloud

| Sign up for | Tier to choose | What it costs |
| --- | --- | --- |
| [Google Cloud](https://cloud.google.com/free), with billing turned on | New account with the [welcome credit](https://cloud.google.com/free) | Nothing while the credit lasts, up to 90 days. After that you pay for what you use |
| A domain, from any registrar | Any | A yearly fee. There is no free tier |
| [Google](https://aistudio.google.com/apikey), for a Gemini API key | [Free tier](https://ai.google.dev/pricing) | Nothing |

[Let's Encrypt](https://letsencrypt.org) issues your certificates for free. It
needs no account, only an email address for notices.

Google Cloud is not free once the credit is gone. Its
[free tier](https://cloud.google.com/free/docs/free-cloud-features) covers the
fee for one zonal GKE cluster, but not the nodes or networking, and Cloud SQL
is free only for one 30-day instance. To make the credit last, follow
[Start small](running-in-the-cloud.md#start-small-on-the-welcome-credit) and
[set a budget alert](https://cloud.google.com/billing/docs/how-to/budgets).

### To manage gateways with `octogee-fleet`

The [`octogee-fleet`](https://github.com/octogee-ai/octogee-fleet) command line
signs in with your Google account. It needs one more free item in the same
Google Cloud project: an OAuth client of the type
**TVs and Limited Input devices**. That odd name is Google's term for sign-in
from a command line, where `octogee-fleet` prints a code and you approve it in
a browser. On kind it signs in with a key the installer generates instead, so
it needs no OAuth client there.

Install it with Go. Go puts it in `$(go env GOPATH)/bin`, usually `~/go/bin`,
which has to be on your `PATH`:

```bash
go install github.com/octogee-ai/octogee-fleet@latest
```

## Install

Run this from any shell. Your login shell can be zsh or anything else, because
the script itself runs in Bash.

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh | bash
```

The installer asks where to run, checks your machine, and tells you how to fix
anything missing. It then shows what it will create and asks before it creates
anything.

To read the script before you run it:

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh -o install.sh
```

```bash
bash install.sh
```

To check your machine without installing, or to run without questions:

```bash
bash install.sh --target=local --check-only
```

```bash
bash install.sh --target=local --yes --no-prompt
```

| Your machine | Where to run the installer |
| --- | --- |
| macOS | Any terminal, with Docker Desktop running |
| Linux, including Omarchy and other Arch systems | Any terminal, with Docker Engine running |
| Windows | Inside WSL2, not PowerShell or Git Bash |

[Requirements](requirements.md) lists the tools. The installer gives you the
install command for each one on your system.

### Windows

1. In PowerShell as Administrator, run `wsl --install`, then restart.
2. Install Docker Desktop. Under **Settings > Resources > WSL integration**,
   turn on your Ubuntu distribution.
3. Open Ubuntu and run the install command there.

Keep the checkout in your Linux home folder, which is the default. Files under
`/mnt/c` are slow and lose their permissions.

## Use it

The local install takes five to ten minutes the first time, mostly downloading
images. When it finishes:

1. Open <http://chat.localhost:8088>.
2. Sign in as `platformadmin`. Get the password from your checkout:

   ```bash
   ./deploy/local/credentials.sh
   ```

3. Send a direct message to `@agent`.

The agent needs a model key to answer. If one is exported in your shell, the
installer lists it before you confirm and copies it into the cluster. Without
one, the agent answers with a sign-in error. To add a key later, run the install
recipe again with it set. It is safe to run repeatedly.

```bash
ANTHROPIC_API_KEY=your-key ./deploy/local/up.sh
```

It also reads `OPENAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`. The
agent uses the first of these it finds, in the order Anthropic, OpenAI, Gemini,
OpenRouter. With a Gemini key it uses `gemini-3.6-flash`, which is on the free
tier.

Git is at <http://git.localhost:8088> with the same username and password.

To open the OpenClaw Control UI, start a port-forward and go to
<http://localhost:18789>. The gateway token is in the output of
`credentials.sh`.

```bash
kubectl --kubeconfig ~/.kube/octogee-cloud-local -n octogee-cloud-local port-forward deploy/gateway 18789
```

Everything runs inside a kind cluster with its own kubeconfig at
`~/.kube/octogee-cloud-local`. The installer does not change your current
Kubernetes context. Only localhost can reach the ports.

Check the install at any time:

```bash
./deploy/local/check.sh
```

## Run the foundation in the cloud

[Running the foundation in the cloud](running-in-the-cloud.md) covers GKE and
EKS with managed PostgreSQL and object storage. It installs the same foundation
as the local install, not the full platform.

## Work on the code

You need Node.js 24 for this part and for the kind install. `install.sh` does
not need it.

```bash
git clone https://github.com/octogee-ai/octogee-cloud.git
```

There are no npm workspaces. Each package, such as `core`, `glm-controller` or
`scripts`, has its own `package.json` and lockfile, so install the one you work
on. For `scripts`:

```bash
cd octogee-cloud/scripts && npm ci
```

```bash
npx tsc --noEmit && npm run gate
```

`.github/workflows/checks.yml` has the typecheck and test commands each pull
request runs, and [AGENTS.md](../AGENTS.md) describes every package.

## Remove it

This deletes the local cluster and all of its data.

```bash
./deploy/local/down.sh
```
