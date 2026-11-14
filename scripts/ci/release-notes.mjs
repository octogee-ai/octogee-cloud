import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SOURCE = "https://github.com/octogee-ai/octogee-cloud";
const VERSION = /^v\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function releaseNotes({ tag, fleetVersion, manifest }) {
  if (!VERSION.test(tag ?? "")) throw new Error(`A release tag looks like v0.1.0, not ${tag}`);
  if (!VERSION.test(fleetVersion ?? "")) throw new Error(`An octogee-fleet release version looks like v0.2.0, not ${fleetVersion}`);
  if (!/^[a-f0-9]{40}$/.test(manifest?.sha ?? "")) throw new Error("The image manifest names no full commit SHA");
  const rows = Object.entries(manifest.images ?? {}).map(([name, image]) => {
    if (!DIGEST.test(image?.digest ?? "")) throw new Error(`The image manifest has no index digest for ${name}`);
    return `| \`${manifest.registry}/${name}:${tag}\` | \`${image.digest}\` | ${Object.keys(image.platforms ?? {}).join(", ")} |`;
  });
  return `${tag} is commit ${manifest.sha} on main.

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

octogee-cloud is pre-1.0. A minor release can change Helm values, the Admin API and stored state, and there are no migrations between releases. Read the notes of every release you skip. A minor upgrade may need \`down\` and a fresh \`up\`, which removes the users, gateways and data of the install. A patch release only fixes.
`;
}

const option = (argv, name) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const argv = process.argv.slice(2);
    const manifest = JSON.parse(readFileSync(option(argv, "manifest") ?? "", "utf8"));
    process.stdout.write(releaseNotes({ tag: option(argv, "tag"), fleetVersion: option(argv, "fleet"), manifest }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
