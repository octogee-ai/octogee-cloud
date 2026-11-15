#!/usr/bin/env node
// Stage the pinned OpenClaw build for the gateway image: fetch-release.mjs --to=<dir> [--from=<dir>]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const stagedNames = { openclaw: "openclaw-fork.tgz", mattermost: "openclaw-mattermost-fork.tgz" };

export function releaseAssets(pin) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(pin.releaseRepository ?? "")) throw new Error("The pin names no release repository");
  if (!/^[A-Za-z0-9._-]+$/.test(pin.releaseTag ?? "")) throw new Error("The pin names no release tag");
  return Object.entries(stagedNames).map(([kind, staged]) => {
    const name = pin[`${kind}Object`];
    const sha256 = pin[`${kind}Sha256`];
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? "")) throw new Error(`The pin has no full sha256 for ${name}`);
    if (!name?.endsWith(`-${sha256.slice(0, 8)}.tgz`)) throw new Error(`The sha256 of ${name} does not match its object name`);
    return { name, sha256, staged, url: `https://github.com/${pin.releaseRepository}/releases/download/${pin.releaseTag}/${name}` };
  });
}

async function downloadFromGitHub(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Downloading ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function stageRelease(pin, { to, from, download = downloadFromGitHub }) {
  const assets = releaseAssets(pin);
  mkdirSync(to, { recursive: true });
  for (const asset of assets) {
    const bytes = from ? readFileSync(join(from, asset.name)) : await download(asset.url);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== asset.sha256) throw new Error(`${asset.name} has sha256 ${actual}, but the pin requires ${asset.sha256}`);
    writeFileSync(join(to, asset.staged), bytes);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
  if (!options.to) {
    console.error("Usage: fetch-release.mjs --to=<dir> [--from=<dir>]");
    process.exit(2);
  }
  const pin = JSON.parse(readFileSync(new URL("./current.json", import.meta.url), "utf8"));
  try {
    await stageRelease(pin, { to: options.to, from: options.from });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
