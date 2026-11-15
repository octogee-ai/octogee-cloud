#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: gateway/publish-plugin.sh <plugin-id> [--dry-run]"
  echo
  echo "Builds gateway/extensions/platform/<plugin-id> as committed at HEAD, the"
  echo "same way the gateway image does, packs it, and publishes it to ClawHub."
  echo
  echo "Environment:"
  echo "  EXPECTED_VERSION  refuse unless package.json has this version"
  echo "  CLAWHUB           ClawHub CLI (default: clawhub on PATH)"
  echo "  ESBUILD           esbuild binary (default: scripts/node_modules/.bin/esbuild)"
  echo "  SOURCE_REPO       GitHub repository the release cites (default: GITHUB_REPOSITORY or octogee-ai/octogee-cloud)"
  echo "  SOURCE_REF        Git ref the release cites (default: GITHUB_REF or the current branch)"
}

die() {
  echo "publish-plugin: $*" >&2
  exit 1
}

check_identity='
import { readFileSync } from "node:fs";
import path from "node:path";

const [dir, plugin, expectedVersion] = process.argv.slice(1);
const read = (file) => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
const pkg = read("package.json");
const manifest = read("openclaw.plugin.json");
const problems = [];
if (manifest.id !== plugin) problems.push(`openclaw.plugin.json id is ${manifest.id}, expected ${plugin}`);
if (!new RegExp(`^@[a-z0-9][a-z0-9-]*/${plugin}$`, "u").test(pkg.name ?? "")) {
  problems.push(`package.json name ${pkg.name} must be @<clawhub-owner>/${plugin}`);
}
if (pkg.private) problems.push("package.json is private");
if (pkg.version !== manifest.version) {
  problems.push(`package.json version ${pkg.version} differs from openclaw.plugin.json version ${manifest.version}`);
}
if (expectedVersion && pkg.version !== expectedVersion) {
  problems.push(`package.json version ${pkg.version} is not the release version ${expectedVersion}`);
}
for (const problem of problems) console.error(`publish-plugin: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`${pkg.name} ${pkg.version}`);
'

check_tarball='
const files = process.argv[1].split("\n").filter(Boolean).map((file) => file.replace(/^package\//u, ""));
const missing = ["index.js", "openclaw.plugin.json", "package.json", "README.md", "LICENSE"].filter((file) => !files.includes(file));
const source = files.filter((file) => /\.(?:cts|mts|ts|tsx)$/u.test(file));
if (missing.length > 0 || source.length > 0) {
  console.error(`publish-plugin: packed ${files.join(", ")}; missing ${missing.join(", ") || "nothing"}; TypeScript ${source.join(", ") || "none"}`);
  process.exit(1);
}
'

plugin="${1:-}"
mode="${2:-}"
if [[ -z "$plugin" || "$plugin" == -* || $# -gt 2 || ( -n "$mode" && "$mode" != "--dry-run" ) ]]; then
  usage >&2
  exit 2
fi
[[ "$plugin" =~ ^octogee-[a-z0-9]+(-[a-z0-9]+)*-tools$ ]] || die "invalid plugin id: $plugin"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_path="gateway/extensions/platform/$plugin"
commit="$(git -C "$repo_root" rev-parse HEAD)"
git -C "$repo_root" cat-file -e "$commit:$source_path/openclaw.plugin.json" 2>/dev/null \
  || die "$source_path/openclaw.plugin.json is not committed at $commit"

clawhub="${CLAWHUB:-$(command -v clawhub || true)}"
[[ -n "$clawhub" && -x "$clawhub" ]] || die "ClawHub CLI not found; set CLAWHUB or put clawhub on PATH"
esbuild="${ESBUILD:-$repo_root/scripts/node_modules/.bin/esbuild}"
[[ -x "$esbuild" ]] || die "esbuild not found at $esbuild; run npm ci --prefix scripts"

stage="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/publish-plugin.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

git -C "$repo_root" archive --format=tar "$commit" "$source_path" | tar -x -C "$stage"
package_dir="$stage/$source_path"

identity="$(node --input-type=module -e "$check_identity" "$package_dir" "$plugin" "${EXPECTED_VERSION:-}")"
read -r name version <<<"$identity"

node "$repo_root/gateway/build-extensions.mjs" "$(dirname "$package_dir")" "$esbuild"
cp "$repo_root/LICENSE" "$package_dir/LICENSE"

mkdir "$stage/pack"
(cd "$package_dir" && npm pack --ignore-scripts --pack-destination "$stage/pack" >/dev/null)
tarballs=("$stage/pack"/*.tgz)
[[ ${#tarballs[@]} -eq 1 && -f "${tarballs[0]}" ]] || die "npm pack did not produce exactly one tarball"
tarball="${tarballs[0]}"
node --input-type=module -e "$check_tarball" "$(tar -tzf "$tarball")"

owner="${name%%/*}"
owner="${owner#@}"
source_repo="${SOURCE_REPO:-${GITHUB_REPOSITORY:-octogee-ai/octogee-cloud}}"
source_ref="${SOURCE_REF:-${GITHUB_REF:-$(git -C "$repo_root" symbolic-ref -q HEAD || true)}}"

args=(package publish "$tarball" --family code-plugin --owner "$owner"
  --source-repo "$source_repo" --source-commit "$commit" --source-path "$source_path" --json)
if [[ -n "$source_ref" ]]; then
  args+=(--source-ref "$source_ref")
fi
if [[ "$mode" == "--dry-run" ]]; then
  args+=(--dry-run)
else
  args+=(--wait)
fi

echo "publish-plugin: $name@$version from $source_repo@$commit (${mode:-publish})" >&2
"$clawhub" --no-input "${args[@]}"
