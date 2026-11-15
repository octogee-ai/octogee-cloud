import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { characterSvg } from "@octogee/shared/types/agent-characters";
import { parseAgentLook } from "@octogee/shared/types/agent-look";
import type { FleetBrokerConfiguredUserDesk } from "@octogee/shared/types/fleet-broker";
import { parseTimeZone } from "@octogee/shared/types/time-zone";

export const DESK_CONFIG_DIR = ".config/octogee";

export interface DeskIdentityFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mode: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export const localDeskIdentityFs: DeskIdentityFs = {
  readFile: (file) => readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }),
  writeFile: (file, content, mode) => writeFile(file, content, { mode }),
  mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
  rename: (from, to) => rename(from, to),
};

export function parseDeskIdentity(value: unknown): FleetBrokerConfiguredUserDesk | null {
  if (!value || typeof value !== "object") return null;
  const { builderName, agentName, look, timeZone } = value as Record<string, unknown>;
  const valid = parseAgentLook(look);
  if (typeof builderName !== "string" || typeof agentName !== "string" || !valid) return null;
  if (timeZone !== null && timeZone !== undefined && !parseTimeZone(timeZone)) return null;
  return { builderName, agentName, look: valid, timeZone: typeof timeZone === "string" ? timeZone : null };
}

export class MalformedDeskFileError extends Error {
  constructor(readonly file: string, readonly quarantined: string) {
    super(`${file} is not a JSON object; moved aside to ${quarantined}`);
  }
}

async function readStoredDesk(fs: DeskIdentityFs, file: string, now: () => number): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(file);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  const quarantined = `${file}.malformed-${now()}`;
  await fs.rename(file, quarantined);
  throw new MalformedDeskFileError(file, quarantined);
}

export function deskIdentityUnchanged(stored: Record<string, unknown> | null, desk: FleetBrokerConfiguredUserDesk): boolean {
  if (!stored) return false;
  const look = parseAgentLook(stored.look);
  return stored.builderName === desk.builderName
    && stored.agentName === desk.agentName
    && look !== null && look.style === desk.look.style && look.color === desk.look.color
    && (stored.timeZone ?? null) === desk.timeZone;
}

export async function writeDeskIdentity(
  fs: DeskIdentityFs,
  desktopHome: string,
  desk: FleetBrokerConfiguredUserDesk,
  now: () => number = Date.now,
): Promise<{ written: boolean }> {
  const dir = path.join(desktopHome, DESK_CONFIG_DIR);
  const jsonPath = path.join(dir, "desk.json");
  const svgPath = path.join(dir, "desk.svg");
  const stored = await readStoredDesk(fs, jsonPath, now);
  if (deskIdentityUnchanged(stored, desk) && (await fs.readFile(svgPath)) === characterSvg(desk.look)) return { written: false };
  const next = {
    ...(typeof stored?.note === "string" ? { note: stored.note } : {}),
    builderName: desk.builderName,
    agentName: desk.agentName,
    look: desk.look,
    timeZone: desk.timeZone,
  };
  await fs.mkdir(dir);
  await replaceFile(fs, jsonPath, `${JSON.stringify(next, null, 2)}\n`, now);
  await replaceFile(fs, svgPath, characterSvg(desk.look), now);
  return { written: true };
}

async function replaceFile(fs: DeskIdentityFs, file: string, content: string, now: () => number): Promise<void> {
  const pending = `${file}.${now()}.pending`;
  await fs.writeFile(pending, content, 0o644);
  await fs.rename(pending, file);
}
