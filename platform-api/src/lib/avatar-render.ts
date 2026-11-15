import sharp from "sharp";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const AVATAR_PX = 256;

export type AvatarKind = "png" | "jpeg" | "gif" | "webp" | "svg";

function hasBytes(buf: Buffer, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => buf[index] === byte);
}

function hasAscii(buf: Buffer, offset: number, value: string): boolean {
  return buf.toString("ascii", offset, offset + value.length) === value;
}

function normalizedTextHead(buf: Buffer): string {
  const head = buf.subarray(0, 1024).toString("utf8");
  const withoutBom = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  return withoutBom.trimStart().toLowerCase();
}

function isSvgHead(head: string): boolean {
  return (
    head.startsWith("<?xml") ||
    head.startsWith("<svg") ||
    head.startsWith("<!doctype svg") ||
    head.includes("<svg ")
  );
}

export function sniffImageKind(buf: Buffer): AvatarKind | null {
  if (buf.length >= 4 && hasBytes(buf, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (buf.length >= 3 && hasBytes(buf, [0xff, 0xd8, 0xff])) return "jpeg";
  if (buf.length >= 4 && hasBytes(buf, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (buf.length >= 12 && hasAscii(buf, 0, "RIFF") && hasAscii(buf, 8, "WEBP")) return "webp";
  if (isSvgHead(normalizedTextHead(buf))) return "svg";
  return null;
}

const UNSAFE_SVG_TOKENS = ["<!entity", "<!doctype", "<image", "<foreignobject"] as const;

function skipSpaces(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && value.charCodeAt(cursor) <= 0x20) cursor += 1;
  return cursor;
}

function hrefValueStart(value: string, index: number): number | null {
  const equals = skipSpaces(value, index + "href".length);
  if (value[equals] !== "=") return null;
  const valueStart = skipSpaces(value, equals + 1);
  return value[valueStart] === "\"" || value[valueStart] === "'" ? valueStart + 1 : valueStart;
}

function hasExternalHref(svg: string): boolean {
  const lower = svg.toLowerCase();
  let index = lower.indexOf("href");
  while (index !== -1) {
    const start = hrefValueStart(lower, index);
    if (
      start !== null &&
      (lower.startsWith("http://", start) || lower.startsWith("https://", start) || lower.startsWith("//", start))
    ) {
      return true;
    }
    index = lower.indexOf("href", index + "href".length);
  }
  return false;
}

export function assertSafeSvg(svg: string): void {
  const lower = svg.toLowerCase();
  if (UNSAFE_SVG_TOKENS.some((token) => lower.includes(token)) || hasExternalHref(svg)) {
    throw new Error("svg references external resources");
  }
}

export async function renderAvatarPng(bytes: Buffer): Promise<Buffer> {
  if (!bytes || bytes.length === 0) throw new Error("avatar is empty");
  if (bytes.length > MAX_INPUT_BYTES) throw new Error("avatar exceeds 2MB");
  const kind = sniffImageKind(bytes);
  if (!kind) throw new Error("unsupported avatar format (need png/jpeg/gif/webp/svg)");
  if (kind === "svg") assertSafeSvg(bytes.toString("utf8"));
  const input = kind === "svg" ? sharp(bytes, { density: 384 }) : sharp(bytes);
  return input.resize(AVATAR_PX, AVATAR_PX, { fit: "cover" }).png().toBuffer();
}
