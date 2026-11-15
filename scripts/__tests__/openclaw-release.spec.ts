import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { releaseAssets, stageRelease } from "../../gateway/openclaw-tarball/fetch-release.mjs";

const bytes = (text: string) => Buffer.from(text);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const pin = {
  sourceSha: "9".repeat(40),
  openclawObject: `openclaw-fork-${sha256("openclaw").slice(0, 8)}.tgz`,
  mattermostObject: `openclaw-mattermost-${sha256("mattermost").slice(0, 8)}.tgz`,
  openclawSha256: sha256("openclaw"),
  mattermostSha256: sha256("mattermost"),
  releaseRepository: "ceckert/openclaw",
  releaseTag: "octogee-99999999",
};

describe("pinned OpenClaw release", () => {
  it("names each asset, its public download and the file the image build reads", () => {
    expect(releaseAssets(pin)).toEqual([
      {
        name: pin.openclawObject, sha256: pin.openclawSha256, staged: "openclaw-fork.tgz",
        url: `https://github.com/ceckert/openclaw/releases/download/octogee-99999999/${pin.openclawObject}`,
      },
      {
        name: pin.mattermostObject, sha256: pin.mattermostSha256, staged: "openclaw-mattermost-fork.tgz",
        url: `https://github.com/ceckert/openclaw/releases/download/octogee-99999999/${pin.mattermostObject}`,
      },
    ]);
  });

  it.each([
    [{ openclawSha256: undefined }, "full sha256"],
    [{ openclawSha256: sha256("other") }, "does not match its object name"],
    [{ releaseRepository: "not a repo" }, "release repository"],
    [{ releaseTag: "" }, "release tag"],
  ])("refuses a pin with %j", (overrides, message) => {
    expect(() => releaseAssets({ ...pin, ...overrides })).toThrow(message);
  });

  it("downloads and stages assets whose digests match the pin", async () => {
    const to = mkdtempSync(join(tmpdir(), "openclaw-release-"));
    const download = vi.fn(async (url: string) => bytes(url.endsWith(pin.openclawObject) ? "openclaw" : "mattermost"));
    await stageRelease(pin, { to, download });
    expect(readFileSync(join(to, "openclaw-fork.tgz"), "utf8")).toBe("openclaw");
    expect(readFileSync(join(to, "openclaw-mattermost-fork.tgz"), "utf8")).toBe("mattermost");
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("stages local copies instead of downloading when given a directory", async () => {
    const from = mkdtempSync(join(tmpdir(), "openclaw-local-"));
    const to = mkdtempSync(join(tmpdir(), "openclaw-release-"));
    writeFileSync(join(from, pin.openclawObject), "openclaw");
    writeFileSync(join(from, pin.mattermostObject), "mattermost");
    const download = vi.fn();
    await stageRelease(pin, { to, from, download });
    expect(download).not.toHaveBeenCalled();
    expect(readFileSync(join(to, "openclaw-fork.tgz"), "utf8")).toBe("openclaw");
  });

  it("refuses an asset whose digest differs from the pin and stages nothing for it", async () => {
    const to = mkdtempSync(join(tmpdir(), "openclaw-release-"));
    await expect(stageRelease(pin, { to, download: async () => bytes("tampered") })).rejects.toThrow(`${pin.openclawObject} has sha256 ${sha256("tampered")}`);
    expect(() => readFileSync(join(to, "openclaw-fork.tgz"))).toThrow();
  });
});
