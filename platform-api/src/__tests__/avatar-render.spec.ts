import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { renderAvatarPng, sniffImageKind, assertSafeSvg } from "../lib/avatar-render.js";

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<rect width="64" height="64" fill="#7c3aed"/><circle cx="32" cy="32" r="16" fill="#fff"/></svg>';

function isPng(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

describe("sniffImageKind", () => {
  it("detects svg and png", async () => {
    expect(sniffImageKind(Buffer.from(SAFE_SVG))).toBe("svg");
    expect(sniffImageKind(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`\n ${SAFE_SVG}`)]))).toBe(
      "svg",
    );
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer();
    expect(sniffImageKind(png)).toBe("png");
  });

  it("returns null for non-image text", () => {
    expect(sniffImageKind(Buffer.from("hello world, not an image"))).toBeNull();
  });
});

describe("assertSafeSvg", () => {
  it("allows fragment refs and inline shapes", () => {
    expect(() => assertSafeSvg('<svg><use href="#g"/><rect fill="url(#grad)"/></svg>')).not.toThrow();
  });

  it("rejects external image/href and entities (SSRF/XXE)", () => {
    expect(() => assertSafeSvg('<svg><image href="http://169.254.169.254/latest"/></svg>')).toThrow();
    expect(() => assertSafeSvg('<svg><image xlink:href="//evil.test/x"/></svg>')).toThrow();
    expect(() => assertSafeSvg('<svg><use href="https://evil.test/#icon"/></svg>')).toThrow();
    expect(() => assertSafeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>')).toThrow();
  });
});

describe("renderAvatarPng", () => {
  it("rasterizes a safe SVG to a 256x256 PNG", async () => {
    const out = await renderAvatarPng(Buffer.from(SAFE_SVG));
    expect(isPng(out)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it("normalizes a raster image to a 256x256 PNG", async () => {
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#0af" } }).jpeg().toBuffer();
    const out = await renderAvatarPng(jpeg);
    expect(isPng(out)).toBe(true);
    expect((await sharp(out).metadata()).width).toBe(256);
  });

  it("rejects empty, oversized, unsupported, and unsafe input", async () => {
    await expect(renderAvatarPng(Buffer.alloc(0))).rejects.toThrow();
    await expect(renderAvatarPng(Buffer.alloc(3 * 1024 * 1024))).rejects.toThrow();
    await expect(renderAvatarPng(Buffer.from("just text"))).rejects.toThrow(/unsupported/);
    await expect(
      renderAvatarPng(Buffer.from('<svg><image href="http://10.0.0.1/"/></svg>')),
    ).rejects.toThrow(/external/);
  });
});
