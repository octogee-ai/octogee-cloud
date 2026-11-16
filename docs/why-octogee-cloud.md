# Why Octogee Cloud

Octogee Cloud brings user accounts, chat, Git repositories, model access, and
agent hosting into one platform. It gives operators two ways to run OpenClaw
agents: shared gateways for platform-controlled tools, and isolated gateways
for users who need their own execution environment.

A **gateway** is the service that runs OpenClaw agents. A **fleet** is the set
of gateways an operator manages. A **broker** is a platform service that checks
access before making a request on an agent's behalf.

## From a message to an agent's work

1. An operator creates a user and assigns them to a gateway with `octogee-fleet`.
2. The platform provisions their Mattermost account and team, agent bot, and
   Gitea organization with a workspace repository.
3. The user messages the agent in Mattermost. The gateway runs the agent,
   using the model broker for AI model calls and platform tools for work.
4. When the user needs a different environment, the operator moves them to
   another gateway. The fleet controller coordinates the move and records it
   in the operations journal.

## Two gateway types

| | Shared gateway | Isolated gateway |
| --- | --- | --- |
| Serves | Multiple independent users | One user and the people they invite |
| Runs on | A Kubernetes pod | A Kubernetes pod with its own home claim, or a Google Cloud virtual machine |
| User interface | Mattermost and Gitea | Mattermost, Gitea, and the OpenClaw Control UI |
| Tools | Platform-controlled tools, with host code execution denied | Host tools, including shell access |
| Resource model | Users share gateway resources | Resources are dedicated to one user |

Shared gateways let operators serve several users on the same infrastructure.
Isolated gateways provide the execution environment needed for shell tools and
coding command lines. An isolated user can type `/ui` in Mattermost to receive
a private, single-use Control UI link that expires after two minutes.

## How the trust boundaries work

Users on a shared gateway have separate accounts and permissions. The platform
must check those permissions independently of anything an agent says. A user
ID supplied by a model or a gateway token alone does not establish authority.

| Boundary | Enforcement |
| --- | --- |
| Host execution | Shared agents cannot run host code. Process and terminal tools, native command-line runtimes, sub-agent execution, and user-defined plugins, hooks, MCP servers, and model providers are denied. The policy is applied at boot and configuration reconciliation. |
| Credentials | Model keys, connector tokens, and Git admin credentials stay behind brokers. Gateways use their own registered Git keys. Brokers check the calling gateway and the user it serves before granting access. |
| Tool access | The platform checks its ownership and membership records for the gateway, agent, account, provider, requester, and conversation. |
| Agent state | User files have separate directories, and each agent has a PostgreSQL schema. Database logins are per gateway. Within a shared gateway, separation depends on the host execution restrictions. |
| Host isolation | Cloud shared gateway pods use gVisor, a container sandbox, on nodes without platform credentials. Isolated VM gateways have no platform credentials. |

A shared gateway depends on these controls working together; its directories
and schemas are not independent process boundaries. An isolated gateway uses
OpenClaw's single-user trust model: the owner trusts the people they invite.
See [OpenClaw compatibility](openclaw-compatibility.md) for the patches used by
the fleet image and their upstream status.

## Moving a user

The fleet controller coordinates a user's agents, chat channels, repositories,
agent stores, and schedules. During a move, it prevents two gateways from
serving the user at once and transfers responsibility for scheduled work.
Operators initiate moves through the Admin API or `octogee-fleet`.

Applications built on this platform can add policies such as automatic scaling
or moving idle users back to shared infrastructure. The platform provides the
placement and migration operations those policies use.

## Explore the platform

- [Getting started](getting-started.md): message an agent on a local foundation.
- [Full platform on kind](kind.md): create users and operate shared gateways.
- [Contributing](../CONTRIBUTING.md): work on a package or improve a guide.
