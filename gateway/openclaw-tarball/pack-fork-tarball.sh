#!/usr/bin/env bash
# Pack the OpenClaw fork into a SELF-CONTAINED tarball for the gateway base image.
#
# Two publication gaps make a plain `npm pack` insufficient:
#
# 1. workspace:* root deps (since 7.1: @openclaw/ai). `npm pack` ships the
#    specifier verbatim (upstream's own release rewrites it via
#    prepare-openclaw-npm-shrinkwrap.ts at publish time) and the base image's
#    `npm install -g` dies on it. Fix: vendor each workspace:* root dep into
#    `vendor/<name>/` INSIDE the tarball and rewrite its spec to
#    `file:vendor/<name>`. npm copies it from the vendored path and resolves
#    everything else (incl. its transitive deps and the shipped
#    npm-shrinkwrap.json's pinned tree) normally from the registry.
#
#    Do not add workspace deps to `bundleDependencies`: that makes npm bundle
#    the dep's ENTIRE transitive closure out of the pnpm node_modules
#    symlink farm, producing an inconsistent tree (an empty
#    @modelcontextprotocol/sdk → the CLI can't load its MCP runtime; installs
#    "green", crash-loops at the codex-plugin install step). The `file:` vendor
#    touches only the one unpublished package. Preserve upstream's explicit
#    bundles, which may contain patched runtime bytes unavailable on npm.
#
# 2. Compile Codex and Parallel from the same checkout as core and include
#    them as vendor/<pkg>.tgz, including when that version exists on npm.
#
# @openclaw/mattermost is deliberately NOT vendored here. It ships as its own
# content-addressed GCS artifact so the exact channel runtime is independently
# pinned and verified on every slot, including dev.
#
# Usage: pack-fork-tarball.sh [FORK_DIR] [OUT_DIR]
#   FORK_DIR  fork checkout    (default: ~/workspace/openclaw/openclaw)
#   OUT_DIR   tarball dest dir (default: /tmp/openclaw-fork)
# Set OPENCLAW_SKIP_BUILD=1 when the source was built in the same cycle.
# Checks the fork against every gateway/verify-*-plugin-contract.mjs in
# this tree; run it from an overlay tree to include the product's contracts.
# Prints the tarball path on success. ALWAYS run the Step 7 install-verify after.
set -euo pipefail

PACKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FORK_DIR="${1:-$HOME/workspace/openclaw/openclaw}"
OUT_DIR="${2:-/tmp/openclaw-fork}"
cd "$FORK_DIR"
FORK_DIR="$(pwd -P)"

if [ -e vendor ] || [ -L vendor ]; then
  echo "FATAL: fork source has a pre-existing ignored vendor path — move it before packing" >&2
  exit 1
fi

if [ "${OPENCLAW_SKIP_BUILD:-0}" != "1" ]; then
  echo "  building fork source" >&2
  pnpm build >&2
fi

for contract in "$PACKER_DIR"/../verify-*-plugin-contract.mjs; do
  node "$contract" "$FORK_DIR" "$(git rev-parse HEAD)" >&2
done
node "$PACKER_DIR/../verify-broker-plugin-runtime.mjs" "$FORK_DIR" "$(git rev-parse HEAD)" >&2

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
rm -f "$OUT_DIR"/openclaw-[0-9]*.tgz

OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG=1 \
  node --import ./scripts/tsx.mjs --input-type=module -e '
    const { preparePrepackArtifacts } = await import("./scripts/openclaw-prepack.ts");
    await preparePrepackArtifacts();
  ' >&2

PKG_BACKUP="$(mktemp)" || { node scripts/openclaw-postpack.mjs >&2; exit 1; }
if ! cp package.json "$PKG_BACKUP"; then
  node scripts/openclaw-postpack.mjs >&2
  rm -f "$PKG_BACKUP"
  exit 1
fi
restore() {
  cp "$PKG_BACKUP" package.json || return 1
  rm -rf vendor || return 1
  node scripts/openclaw-postpack.mjs >&2 || return 1
  rm -f "$PKG_BACKUP"
}
trap restore EXIT

WS_DEPS="$(node -e '
  const p = require("./package.json");
  const all = { ...p.dependencies, ...p.optionalDependencies };
  console.log(Object.entries(all)
    .filter(([, v]) => String(v).startsWith("workspace:"))
    .map(([k]) => k).join("\n"));
')"

for name in $WS_DEPS; do
  [ -z "$name" ] && continue
  abspkg="$(cd "node_modules/$name" && pwd -P)"
  ver="$(node -e "console.log(require('$abspkg/package.json').version)")"
  vend="vendor/$(echo "$name" | sed 's|^@||; s|/|-|g')"

  tmpp="$(mktemp -d)"
  ( cd "$abspkg" && npm pack --ignore-scripts --pack-destination "$tmpp" >/dev/null )
  mkdir -p "$vend"
  tar -xzf "$tmpp"/*.tgz -C "$vend" --strip-components=1
  rm -rf "$tmpp"
  nested_runtime_ws="$(node -e '
    const p = require("./" + process.argv[1]);
    const all = { ...p.dependencies, ...p.optionalDependencies };
    console.log(Object.entries(all)
      .filter(([, v]) => String(v).startsWith("workspace:"))
      .map(([k]) => k).join("\n"));
  ' "$vend/package.json")"
  if [ -n "$nested_runtime_ws" ]; then
    echo "FATAL: $name carries nested runtime workspace:* specs ($nested_runtime_ws) — extend vendoring" >&2
    exit 1
  fi

  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    if (p.dependencies && p.dependencies['$name']) p.dependencies['$name'] = 'file:$vend';
    if (p.optionalDependencies && p.optionalDependencies['$name']) p.optionalDependencies['$name'] = 'file:$vend';
    if (!p.files.includes('vendor/')) p.files.push('vendor/');
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
  echo "  vendored workspace dep: $name@$ver -> file:$vend" >&2
done

NPM_DIR="$(node -p 'require("node:path").dirname(require.resolve("npm/package.json"))')"
NPM_PACKAGE_VERSION="$(node -p 'require(process.argv[1]).version' "$NPM_DIR/package.json")"
DECLARED_NPM_VERSION="$(node -p 'require("./package.json").dependencies.npm')"
if [ "$NPM_PACKAGE_VERSION" != "$DECLARED_NPM_VERSION" ]; then
  echo "FATAL: installed npm does not match the source dependency" >&2
  exit 1
fi
mkdir -p vendor
(
  npmstage="$(mktemp -d)"
  trap 'rm -rf "$npmstage"' EXIT
  mkdir "$npmstage/package"
  cp -a "$NPM_DIR/." "$npmstage/package/"
  cd "$npmstage/package"
  git apply --check "$PACKER_DIR/npm-${NPM_PACKAGE_VERSION}.patch"
  git apply "$PACKER_DIR/npm-${NPM_PACKAGE_VERSION}.patch"
  npm pack --ignore-scripts --pack-destination "$npmstage" >/dev/null
  cp "$npmstage"/npm-*.tgz "$FORK_DIR/vendor/npm.tgz"
)
node -e '
  const fs = require("node:fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (!p.files.includes("vendor/")) p.files.push("vendor/");
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'

for ext in codex parallel; do
  name="$(node -e "console.log(require('./extensions/$ext/package.json').name)")"
  ver="$(node -e "console.log(require('./extensions/$ext/package.json').version)")"
  mkdir -p vendor
  extout="$(mktemp -d)"
  OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR="$extout" \
    bash scripts/plugin-npm-publish.sh --pack "extensions/$ext" >&2
  vendtgz="vendor/$(echo "$name" | sed 's|^@||; s|/|-|g').tgz"
  cp "$extout"/*.tgz "$vendtgz"
  rm -rf "$extout"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    if (!p.files.includes('vendor/')) p.files.push('vendor/');
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
  echo "  vendored source-matched companion: $name@$ver -> $vendtgz" >&2
done

node -e '
  const fs = require("node:fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  p.bundleDependencies = [...new Set([...(p.bundleDependencies ?? []), "npm"])];
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'
(
  package_stage="$(mktemp -d)"
  trap 'rm -rf "$package_stage"' EXIT
  npm pack --dry-run --ignore-scripts --json > "$package_stage/inventory.json"
  mkdir "$package_stage/package"
  node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const [source, stage] = process.argv.slice(1);
    const inventory = JSON.parse(fs.readFileSync(path.join(stage, "inventory.json"), "utf8"));
    const packages = Array.isArray(inventory) ? inventory : Object.values(inventory);
    if (packages.length !== 1 || !Array.isArray(packages[0].files)) {
      throw new Error("npm pack must provide exactly one package inventory");
    }
    const root = path.join(stage, "package");
    for (const file of packages[0].files) {
      const target = path.resolve(root, file.path);
      const relative = path.relative(root, target);
      if (path.isAbsolute(file.path) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`npm package inventory path escapes the stage: ${file.path}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, file.path), target);
      fs.chmodSync(target, file.mode);
    }
  ' "$FORK_DIR" "$package_stage"
  rm -rf "$package_stage/package/node_modules/npm"
  mkdir -p "$package_stage/package/node_modules/npm"
  tar -xzf "$FORK_DIR/vendor/npm.tgz" -C "$package_stage/package/node_modules/npm" --strip-components=1
  cd "$package_stage/package"
  npm pack --ignore-scripts --pack-destination "$OUT_DIR" >&2
)
TARBALL="$OUT_DIR/$(ls -t "$OUT_DIR"/openclaw-[0-9]*.tgz | head -1 | xargs basename)"
trap - EXIT
restore
echo "$TARBALL"
