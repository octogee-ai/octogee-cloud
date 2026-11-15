import { describe, it, expect } from "vitest";
import {
  isValidAssetId,
  issueAssetsPrefix,
  parseAssetObjectPath,
  sanitizeAssetName,
} from "../issue-assets.js";

const UUID = "0b6a4c1e-9d3f-4a2b-8c1d-2e3f4a5b6c7d";

describe("sanitizeAssetName", () => {
  it("strips directories, URL-hostile and control characters", () => {
    expect(sanitizeAssetName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAssetName("shot 2026-08-05.png")).toBe("shot 2026-08-05.png");
    expect(sanitizeAssetName("a?b#c%d\u0007.png")).toBe("abcd.png");
    expect(sanitizeAssetName("C:\\Users\\me\\screen.png")).toBe("screen.png");
  });
  it("falls back to 'file' for empty or dot names", () => {
    expect(sanitizeAssetName("")).toBe("file");
    expect(sanitizeAssetName("..")).toBe("file");
    expect(sanitizeAssetName("dir/")).toBe("file");
  });
  it("caps length at 120 characters", () => {
    expect(sanitizeAssetName("x".repeat(200)).length).toBe(120);
  });
});

describe("issueAssetsPrefix", () => {
  it("scopes assets under the target's GCS namespace by issue number", () => {
    expect(issueAssetsPrefix({ gcsPrefix: "customers/alice/projects/rocket" }, 7)).toBe(
      "customers/alice/projects/rocket/.issue-assets/7/",
    );
  });
});

describe("parseAssetObjectPath", () => {
  const prefix = "customers/alice/projects/rocket/.issue-assets/7/";

  it("parses id and name from a stored object path", () => {
    expect(parseAssetObjectPath(prefix, `${prefix}${UUID}/shot.png`)).toEqual({
      id: UUID,
      name: "shot.png",
    });
  });
  it("rejects paths outside the prefix, bad ids, and nested names", () => {
    expect(parseAssetObjectPath(prefix, `other/${UUID}/shot.png`)).toBeNull();
    expect(parseAssetObjectPath(prefix, `${prefix}not-a-uuid/shot.png`)).toBeNull();
    expect(parseAssetObjectPath(prefix, `${prefix}${UUID}/a/b.png`)).toBeNull();
    expect(parseAssetObjectPath(prefix, `${prefix}${UUID}/`)).toBeNull();
  });
});

describe("isValidAssetId", () => {
  it("accepts lowercase uuids only", () => {
    expect(isValidAssetId(UUID)).toBe(true);
    expect(isValidAssetId(UUID.toUpperCase())).toBe(false);
    expect(isValidAssetId("../escape")).toBe(false);
  });
});
