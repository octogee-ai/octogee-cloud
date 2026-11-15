import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

import { useUmbrellaChart } from "./helpers/umbrella-chart";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STOCK_REPOSITORY = "mattermost/mattermost-team-edition";
const STOCK_TAG = "12.0.2";
const STOCK_AMD64_DIGEST = "sha256:08c0b4b93a14196b0850f62faa4a437d2643533f009cac4868a0b793aad61fc3";

const chart = useUmbrellaChart("octogee-mattermost-stock-image-");

interface Workload {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec?: { containers?: Array<{ name: string; image: string }> } } };
}

function mattermostImage(rendered: string): string | undefined {
  return parseAllDocuments(rendered)
    .map((doc) => doc.toJS() as Workload | null)
    .find((doc) => doc?.kind === "Deployment" && doc.metadata?.name === "mattermost")
    ?.spec?.template?.spec?.containers?.find(({ name }) => name === "mattermost")?.image;
}

describe("charts/octogee/ — Mattermost image", () => {
  it("runs the stock Mattermost Team Edition release, pinned by version and amd64 digest, when an installation names no image", () => {
    expect(mattermostImage(chart.helmTemplate())).toBe(`${STOCK_REPOSITORY}:${STOCK_TAG}@${STOCK_AMD64_DIGEST}`);
  });

  it("runs the same Mattermost image as the stock install manifest", () => {
    const manifest = readFileSync(path.join(REPO_ROOT, "deploy/manifests/mattermost.yaml"), "utf8");
    expect(mattermostImage(manifest)).toBe(`${STOCK_REPOSITORY}@${STOCK_AMD64_DIGEST}`);
  });

  it("runs an installation's own Mattermost image", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const rendered = chart.helmTemplate({
      sets: { "mattermost.image.repository": "registry.example/mattermost", "mattermost.image.tag": "custom", "mattermost.image.digest": digest },
    });
    expect(mattermostImage(rendered)).toBe(`registry.example/mattermost:custom@${digest}`);
  });
});
