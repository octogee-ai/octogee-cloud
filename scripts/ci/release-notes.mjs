import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SOURCE = "https://github.com/octogee-ai/octogee-cloud";
const VERSION = /^v\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function gkeRunFrom(message) {
  const match = /^GKE install guide: (\d{4}-\d{2}-\d{2}) ([a-f0-9]{40})$/m.exec(message ?? "");
  return match ? { date: match[1], commit: match[2] } : undefined;
}

export function releaseNotes({ tag, fleetVersion, manifest, gkeRun }) {
  if (!VERSION.test(tag ?? "")) throw new Error(`A release tag looks like v0.1.0, not ${tag}`);
  if (!VERSION.test(fleetVersion ?? "")) throw new Error(`An octogee-fleet release version looks like v0.2.0, not ${fleetVersion}`);
  if (!/^[a-f0-9]{40}$/.test(manifest?.sha ?? "")) throw new Error("The image manifest names no full commit SHA");
  if (!gkeRun) throw new Error("The tag message names no full GKE install guide run; add the line \"GKE install guide: YYYY-MM-DD <commit>\"");
  if (gkeRun.commit !== manifest.sha) throw new Error(`The GKE install guide run was at ${gkeRun.commit}, not the tagged commit ${manifest.sha}`);
  const rows = Object.entries(manifest.images ?? {}).map(([name, image]) => {
    if (!DIGEST.test(image?.digest ?? "")) throw new Error(`The image manifest has no index digest for ${name}`);
    return `| \`${manifest.registry}/${name}:${tag}\` | \`${image.digest}\` | ${Object.keys(image.platforms ?? {}).join(", ")} |`;
  });
  return `${tag} is commit ${manifest.sha} on main.

## What this release is

octogee-cloud runs AI agents for many users on Kubernetes. Each user's agent is an OpenClaw agent on a shared gateway or on an isolated gateway of its own, and the user works with it through Mattermost for chat and Gitea for git. A fleet controller adds, moves and retires gateways when an operator asks, through its Admin API and the octogee-fleet command line, and an LLM broker holds the model provider keys. It needs a Kubernetes cluster, PostgreSQL 16, S3-compatible object storage and at least one model provider key; the install guides set these up on kind or on GKE. Not here yet: automatic placement and scaling. Nothing places, scales or moves users automatically, so the operator does each step. The Admin API and the Helm values are pre-1.0 and can change in any minor release. The GKE guide installs a single zone with no ingress, not a production setup.

Build main published these images and the Kind smoke workflow passed both kind smoke tests on them at this commit, and [docs/gke.md](${SOURCE}/blob/${tag}/docs/gke.md) was followed end to end on a fresh Google Cloud project at ${gkeRun.commit} on ${gkeRun.date}.

## Start here

\`\`\`bash
git clone --branch ${tag} ${SOURCE}
\`\`\`

Then follow [docs/kind.md](${SOURCE}/blob/${tag}/docs/kind.md) for a local cluster or [docs/gke.md](${SOURCE}/blob/${tag}/docs/gke.md) for Google Cloud. The installers use the images published for this commit. To install these exact digests, download the attached \`image-manifest.json\` and pass \`--manifest=image-manifest.json\`, with \`--pull\` on kind.

This release was tested with octogee-fleet ${fleetVersion}:

\`\`\`bash
go install github.com/octogee-ai/octogee-fleet@${fleetVersion}
\`\`\`

## Images

| Image | Index digest | Platforms |
| --- | --- | --- |
${rows.join("\n")}

Each image is also tagged with the full commit SHA.

## Upgrading

octogee-cloud is pre-1.0. The platform's PostgreSQL schema migrations run forward automatically when you install or upgrade, and some of them change or drop stored data. 0.x makes no promise that stored data survives a minor release: a minor release may drop stored data or need \`down\` and a fresh \`up\`, which removes the users, gateways and data of the install. Read the notes of every release up to the one you install before you upgrade. A patch release only fixes.
`;
}

const option = (argv, name) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const argv = process.argv.slice(2);
    const manifest = JSON.parse(readFileSync(option(argv, "manifest") ?? "", "utf8"));
    const gkeRun = gkeRunFrom(readFileSync(option(argv, "tag-message") ?? "", "utf8"));
    process.stdout.write(releaseNotes({ tag: option(argv, "tag"), fleetVersion: option(argv, "fleet"), manifest, gkeRun }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
