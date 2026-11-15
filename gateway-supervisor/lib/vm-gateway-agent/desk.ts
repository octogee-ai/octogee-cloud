import type { AgentLook } from "@octogee/shared/types/agent-look";
import { characterSvg } from "@octogee/shared/types/agent-characters";
import type { FleetBrokerConfiguredUserBootstrap, FleetBrokerConfiguredUserDesk } from "@octogee/shared/types/fleet-broker";
import { DESK_CONFIG_DIR, parseDeskIdentity } from "../desk-identity.js";
import { brokerFailure, brokerPost, type BrokerClientDeps } from "./broker.js";
import type { HomeScope } from "./home-checkpoint.js";

export const DESKTOP_CONTROL_URL = "http://127.0.0.1:7777";
const DESKTOP_STYLE_FILE = ".config/omarchy/octogee-desktop-style";
const CURRENT_THEME_FILE = ".local/state/omarchy/current/theme.name";
const OCTOGEE_THEME_COLORS = ".config/omarchy/themes/octogee/colors.toml";
const DESKTOP_UID = 1000;
const DESKTOP_GID = 1000;
const ACCENT_LINE = /^accent = "(#[0-9a-f]{6})"$/mu;
const CONTROL_TIMEOUT_MS = 150_000;

export interface DeskFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mode: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
}

export interface DeskDeps extends BrokerClientDeps {
  fs: DeskFs;
  log: (msg: string) => void;
  controlUrl?: string;
}

interface DeskFile extends FleetBrokerConfiguredUserDesk {
  note?: string;
}

export async function fetchDesk(deps: DeskDeps, slug: string): Promise<FleetBrokerConfiguredUserDesk | null> {
  const res = await brokerPost(deps, "configured-builder-bootstrap", { slug, revisionId: deps.gatewayId });
  if (res.status === 404) return null;
  if (!res.ok) throw await brokerFailure("configured-builder-bootstrap", res);
  const body = (await res.json()) as { bootstrap?: Partial<FleetBrokerConfiguredUserBootstrap> };
  const desk = parseDeskIdentity(body.bootstrap?.desk);
  if (!desk) throw new Error("configured-builder-bootstrap: payload carries no valid desk identity");
  return desk;
}

async function readDeskFile(deps: DeskDeps, path: string): Promise<Partial<DeskFile> | null> {
  const raw = await deps.fs.readFile(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Partial<DeskFile> : null;
  } catch {
    return null;
  }
}

function sameLook(a: AgentLook | undefined, b: AgentLook): boolean {
  return a !== undefined && a.style === b.style && a.color === b.color;
}

async function writeOwned(deps: DeskDeps, path: string, content: string): Promise<void> {
  await deps.fs.writeFile(path, content, 0o644);
  await deps.fs.chown(path, DESKTOP_UID, DESKTOP_GID);
}

async function control(deps: DeskDeps, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Response> {
  return deps.fetchImpl(`${deps.controlUrl ?? DESKTOP_CONTROL_URL}${path}`, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
}

async function controlFailure(label: string, res: Response): Promise<Error> {
  return new Error(`${label}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

async function reconcileAccent(deps: DeskDeps, scope: HomeScope, look: AgentLook, lookChanged: boolean): Promise<void> {
  const style = (await deps.fs.readFile(`${scope.desktopDir}/${DESKTOP_STYLE_FILE}`))?.trim() ?? "unset";
  const theme = (await deps.fs.readFile(`${scope.desktopDir}/${CURRENT_THEME_FILE}`))?.trim() ?? "unset";
  if (style !== "familiar" || theme !== "octogee") {
    if (lookChanged) deps.log(`[vm-agent] desk look is now ${look.style} ${look.color}; desktop accent left alone (style ${style}, theme ${theme})`);
    return;
  }
  const colors = await deps.fs.readFile(`${scope.desktopDir}/${OCTOGEE_THEME_COLORS}`);
  if (colors !== null && ACCENT_LINE.exec(colors)?.[1] === look.color) return;
  const res = await control(deps, "POST", "/style", { style: "familiar", accent: look.color });
  if (!res.ok) throw await controlFailure("desktop accent refresh", res);
  deps.log(`[vm-agent] desktop accent refreshed to ${look.color}`);
}

async function reconcileTimeZone(deps: DeskDeps, timeZone: string | null): Promise<void> {
  if (!timeZone) return;
  const current = await control(deps, "GET", "/timezone");
  if (!current.ok) throw await controlFailure("desktop time zone read", current);
  const installed = ((await current.json()) as { timeZone?: unknown }).timeZone;
  if (installed === timeZone) return;
  const res = await control(deps, "POST", "/timezone", { timeZone });
  if (!res.ok) throw await controlFailure("desktop time zone set", res);
  deps.log(`[vm-agent] VM time zone set to ${timeZone} (was ${String(installed)})`);
}

export async function syncDesk(deps: DeskDeps, scope: HomeScope, desk: FleetBrokerConfiguredUserDesk): Promise<{ written: boolean }> {
  const dir = `${scope.desktopDir}/${DESK_CONFIG_DIR}`;
  const jsonPath = `${dir}/desk.json`;
  const svgPath = `${dir}/desk.svg`;
  const existing = await readDeskFile(deps, jsonPath);
  const lookChanged = !sameLook(existing?.look, desk.look);
  const identityUnchanged = existing !== null
    && existing.builderName === desk.builderName
    && existing.agentName === desk.agentName
    && !lookChanged
    && (existing.timeZone ?? null) === desk.timeZone;
  let written = false;
  if (!identityUnchanged || (await deps.fs.readFile(svgPath)) === null) {
    const next: DeskFile = {
      ...(typeof existing?.note === "string" ? { note: existing.note } : {}),
      builderName: desk.builderName,
      agentName: desk.agentName,
      look: desk.look,
      timeZone: desk.timeZone,
    };
    await deps.fs.mkdir(dir);
    await deps.fs.chown(dir, DESKTOP_UID, DESKTOP_GID);
    await writeOwned(deps, jsonPath, `${JSON.stringify(next, null, 2)}\n`);
    await writeOwned(deps, svgPath, characterSvg(desk.look));
    written = true;
  }
  await reconcileTimeZone(deps, desk.timeZone);
  await reconcileAccent(deps, scope, desk.look, lookChanged);
  return { written };
}
