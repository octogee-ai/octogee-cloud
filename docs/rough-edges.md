# Known rough edges

octogee-cloud spent nine months inside a product before it had a repository of
its own. The platform runs, and the guides in `docs/` say what has been proven
where. This page lists what I would do differently starting clean, so you read
it here before you find it in the code. None of it is hidden; some of it is
simply not done.

## A product is compiled into the platform

[Architecture](architecture.md#how-a-product-builds-on-top) describes how a
product builds on this repository: its files are copied beside the platform's
and compiled as one program, and it passes its additions to each service's
start function.

- The interfaces a product implements, `ControllerProduct` and
  `ProductExtension`, are wide, and their shape follows the one product that
  uses them.
- They have no version. A product's files import platform source by relative
  path, so any platform file can be something a product depends on.
- Product automation, such as placement and scaling, runs inside the fleet
  controller's process.

What would fix it: publish the libraries and services as versioned packages,
narrow the interfaces to a few named ports, and move automation out of process
so that it calls the Admin API as `octogee-fleet` does.

## Names

- Source directories are named after their components, but the names they
  deploy under are not. The fleet controller (`fleet-controller/`) and the
  platform API (`platform-api/`) still publish images, Kubernetes deployments
  and service accounts named `glm-controller` and `octogee-api`, and stored
  records keep their names. [Legacy names](legacy-names.md) lists them.
- Some services live inside another component's directory: the LLM broker and
  the npm cache proxy in `platform-api/`, the gateway router and the
  Mattermost callback router in `gateway-edge/`, and the provisioner in
  `scripts/`.
- `scripts/` holds runtime code as well as scripts. The provisioner and the
  gateway pod's boot steps are under `scripts/lib/` and `scripts/entrypoints/`.
- The isolated gateway image is published as `octogee-gateway-builder`, and a
  sizing profile calls the pod or VM a gateway runs on its `computer`.
- Identifiers and test fixtures still use words from the product: `coach` for
  a user's default agent, `builder` for an isolated gateway and `customer` for
  a user. [Legacy names](legacy-names.md) lists the stored names that keep
  their spelling for good. The rest are not renamed yet.

## Large files

A few files hold far too much: `core/src/admin-fleet-router.ts`,
`platform-api/src/routes/fleet-broker.ts`, `fleet-controller/src/index.ts` and
`scripts/lib/fleet-http-migration.ts` are each between 3,000 and 6,200 lines.
They are covered by tests and split as they are touched.

## Packaging

- `core/` and `shared/` commit their built `dist/`, because the other packages
  install them as `file:` dependencies. Published packages would remove it.
- `platform-api` imports `gateway-edge` source by relative path instead of
  through a package.
- There are no npm workspaces. Each package installs on its own, which keeps
  the packages independent and makes a change across them slow.

## Leftovers from the hosted service

- The gateway, edge and fleet controller images include the server
  certificate authority of the hosted Octogee database, at
  `/etc/ssl/certs/octogee-postgres-ca.pem`. It is a public certificate and no
  install has to use it, but it belongs in the hosted service's configuration.
- The `charts/octogee` chart carries switched-off templates for two services
  that are not in this repository, `artifactWorker` and `opsAgent`, and
  analytics settings for PostHog that no platform code reads.
- `.dockerignore` still names directories this repository does not have.
- `gateway/` keeps `setup.sh`, `docker-compose.yml` and `.env.example`,
  a single-gateway Docker setup from before the platform existed. They
  describe Firebase and are not maintained.
- Some image READMEs are still working notes, not documentation:
  `desktop/README.md`, `desktop/image/README.md` and
  `gateway/openclaw-tarball/README.md`.
- Test fixtures use my own handle and the hosted service's hostnames.

## Google Cloud first

The platform has run end to end on kind and on GKE. Beyond that:

- An isolated gateway on a virtual machine, the kind with a desktop, needs
  Google Cloud.
- Operator sign-in is Google sign-in or a key-signed token.
- The EKS guide has not run on a real AWS account.
- There is no production install guide. The GKE install is a single zone with
  no ingress.

## OpenClaw is patched

The fleet features are developed on a patched OpenClaw build.
[OpenClaw compatibility](openclaw-compatibility.md) lists every patch, its
upstream pull request and what stops working without it.

## History

Commits before 13 November 2026 were carried over from the private repository
the platform grew up in. They predate the sign-off rule, so they carry no
`Signed-off-by` line, and many of them touch files that are not here.
