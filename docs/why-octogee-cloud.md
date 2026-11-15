# Why octogee-cloud, when OpenClaw Enterprise exists

## The short answer

OpenClaw Enterprise (OCE) and octogee-cloud start from the same fact about
OpenClaw and go in opposite directions.

The fact: an OpenClaw gateway is one trust boundary. Everyone who can operate an
agent on it can make that agent do anything the agent can do, and the gateway's
roles are guardrails inside a trusted group, not isolation between hostile
parties. OpenClaw says so in its
[trust model](https://docs.openclaw.ai/gateway/security/trust-model) and its
[multi-user notes](https://docs.openclaw.ai/concepts/multi-user#trust-boundary).

- **OCE keeps that boundary and multiplies it.** Each deployed Agent gets its
  own gateway. In its design document's words, the control plane "manages
  multiple single-Agent runtimes rather than making one OpenClaw gateway
  multi-tenant." Tenants are separated by namespaces, identities and
  infrastructure around the gateways, never inside one.
- **octogee-cloud puts strangers on the same gateway.** A shared gateway serves
  many users who do not know or trust each other, and any of them may be
  hostile. octogee-cloud builds the walls OpenClaw does not have for that case,
  and moves a user onto a gateway of their own when they need what a shared one
  cannot safely give.

If every agent you run can have its own gateway, OCE is the right tool and
octogee-cloud adds little. octogee-cloud exists for the case where it cannot:
a personal agent for someone who pays little or nothing, where a dedicated
gateway per person costs more than the service is worth.

## What a shared gateway has to give up, and what replaces it

On a shared gateway no user is the gateway's owner, so nothing a user or their
agent says can be treated as authority. octogee-cloud enforces that outside the
gateway:

| Risk on a gateway shared by strangers | What octogee-cloud does |
| --- | --- |
| An agent runs code and reads another user's files or the gateway's memory | Agents on shared gateways cannot run host code at all. Process and terminal tools, native CLI runtimes, sub-agent execution, user-defined plugins, hooks, MCP servers and model providers are denied. The floor is re-applied at boot and whenever configuration is reconciled. |
| The gateway process holds every user's keys | It holds none. Model keys, connector tokens and git credentials stay behind brokers. A broker releases a credential only after checking which gateway is asking and which user that gateway is serving. |
| An agent claims to act for another user | Every tool call is checked by the platform against its own ownership and membership records: the gateway, the agent, the account, the provider, the requester and the conversation. An id supplied by the model, a local allow-list or a gateway token is not authority. |
| One user's agent state is readable by another's | Each user's files live under their own directory, and each agent has its own store, a separate PostgreSQL schema. Database logins are per gateway, so an isolated gateway can reach only its owner's stores. Inside a shared gateway the separation holds because agents cannot run code. |
| A sandbox escape reaches the node | Shared gateway pods run in a gVisor sandbox on nodes with no platform credentials. |

A user on a shared gateway works with their agent through Mattermost and Gitea.
What they give up is real: no shell, no coding CLIs, and no OpenClaw Control UI,
which only isolated gateways provide. So octogee-cloud has a second class.

## Isolated gateways, and moving between the two

An isolated gateway serves exactly one user. It is what OpenClaw's
documentation calls a single-user gateway, and it is the same trust boundary
OCE gives every Agent: full OpenClaw, host tools and the Control UI included. It
runs as a Kubernetes pod with its own service account and home claim, or on a
Google Cloud virtual machine that holds no platform credentials and adds a
desktop. People the user invites are trusted the way a teammate is, exactly as
upstream describes.

The part that is specific to octogee-cloud is the movement. A user's agents,
chat channels, repositories, agent stores and schedules are records the fleet
controller owns. It can move a user from a shared gateway to an isolated one
and back, with fences so that only one gateway serves the user at a time and
the scheduler changes hands once. A user starts on a shared gateway. When they
need a gateway of their own, an operator moves them there, and later back
again. The platform moves nobody on its own; automatic moves, such as parking an
idle user back on a shared gateway, belong to a product built on top.

## Side by side

| | OpenClaw Enterprise | octogee-cloud |
| --- | --- | --- |
| Unit of isolation | One gateway per Agent | A shared gateway for many users, plus one isolated gateway per user who needs it |
| Who may share a gateway | Nobody who must not share authority | Unrelated, possibly hostile users, with host code denied |
| Tenant boundary | Namespace, identities and infrastructure around each gateway | Brokers and platform records outside the gateway, plus the no-host-code floor inside it |
| Control plane | OpenClaw Control Plane, a service with IAM and audit in PostgreSQL | A fleet controller with placement, migration and an operations journal in PostgreSQL |
| Operator interface | Console, `occ` CLI, HTTP API | A fleet command line over an Admin API; no web console |
| Where gateways run | Compute drivers: Kubernetes, SSH hosts | Kubernetes pods for shared gateways; pods or Google Cloud virtual machines for isolated ones |
| Chat and git for users | Not provided | Mattermost and Gitea, provisioned per user |
| Model access | Provider credentials delivered to each Agent's gateway | A broker meters every call; gateways hold no model keys |
| License | MIT | MIT |

## What we are not claiming

- A shared gateway is not a general multi-tenant OpenClaw. It is safe because
  of what it refuses to do. Anything that needs host code belongs on an
  isolated gateway.
- An isolated gateway is not hardened against the people its owner invites.
  That is OpenClaw's own trust model, unchanged.
- octogee-cloud does not build, test or preview users' projects. A shared
  gateway cannot run that code, and the platform has no runner for it; a
  product built on top can add one.
- octogee-cloud is not a fork of OCE and does not implement its API, IAM or
  resource model. Where the two name the same thing, we try to use the same
  word.
- The fleet features are not proven on stock OpenClaw. They are developed on a
  patched build, listed patch by patch in
  [OpenClaw compatibility](openclaw-compatibility.md), and we send fixes
  upstream as we find them. We would rather carry no patches.

## Where this may be useful to OpenClaw and OCE

- **Evidence from the awkward case.** One gateway with many unrelated owners
  exercises paths that single-owner gateways never hit: owner-less scheduling,
  per-agent stores under separate database roles, moving a live agent between
  gateways.
- **A lower rung.** A deployment that starts users on shared gateways and
  promotes them to dedicated ones could use OCE for the dedicated half. We have
  not built that, and we would like to know whether it is wanted.
