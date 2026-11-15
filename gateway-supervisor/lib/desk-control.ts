export const OCTO_DESK_USAGE = 'usage: octo-desk note "<text>"';
export const OCTO_DESKTOP_STYLE_USAGE = "usage: octo-desktop-style familiar|omarchy";
export const DEFAULT_EDGE_URL = "http://127.0.0.1:3001";
export const DEFAULT_TOKEN_PATH = "/var/run/secrets/octogee-gateway-broker/token";
const NOTE_MAX = 500;
const STYLES = ["familiar", "omarchy"] as const;
const REQUEST_TIMEOUT_MS = 150_000;

export type DeskCliName = "octo-desk" | "octo-desktop-style";

export interface DeskCommand {
  path: "/desk/note" | "/style";
  body: Record<string, string>;
}

export function parseOctoDeskArgs(args: string[]): DeskCommand {
  const note = args.length === 2 && args[0] === "note" ? args[1].trim() : "";
  if (!note || note.length > NOTE_MAX) throw new Error(OCTO_DESK_USAGE);
  return { path: "/desk/note", body: { note } };
}

export function parseOctoDesktopStyleArgs(args: string[]): DeskCommand {
  const style = args.length === 1 ? args[0] : "";
  if (!(STYLES as readonly string[]).includes(style)) throw new Error(OCTO_DESKTOP_STYLE_USAGE);
  return { path: "/style", body: { style } };
}

export interface DeskCliIo {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  readFile: (path: string) => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const PARSERS: Record<DeskCliName, (args: string[]) => DeskCommand> = {
  "octo-desk": parseOctoDeskArgs,
  "octo-desktop-style": parseOctoDesktopStyleArgs,
};

function describeAnswer(command: DeskCommand, answer: Record<string, unknown>): string {
  return command.path === "/style" ? `Desktop style set to ${String(answer.style)}.` : "Desk note updated.";
}

function parseAnswer(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { error: text.slice(0, 200) };
  } catch {
    return { error: text.slice(0, 200) };
  }
}

async function postCommand(io: DeskCliIo, edge: string, token: string, command: DeskCommand): Promise<{ status: number; answer: Record<string, unknown> }> {
  const res = await io.fetchImpl(`${edge}/internal/computer${command.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-k8s-sa-token": token },
    body: JSON.stringify(command.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, answer: parseAnswer(await res.text()) };
}

function failureLine(name: DeskCliName, status: number, answer: Record<string, unknown>): string | null {
  if (status === 404 && answer.error === "computer_unavailable") return "This workspace has no VM, so there is no Desk to change.";
  if (status < 200 || status >= 300) return `${name} failed (HTTP ${status}): ${String(answer.error ?? "unexpected answer")}`;
  return null;
}

export async function runDeskCli(name: DeskCliName, argv: string[], io: DeskCliIo): Promise<number> {
  let command: DeskCommand;
  try {
    command = PARSERS[name](argv);
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const edge = (io.env.GATEWAY_EDGE_INTERNAL_URL?.trim() || DEFAULT_EDGE_URL).replace(/\/$/u, "");
  const tokenPath = io.env.OCTOGEE_API_SA_TOKEN_PATH?.trim() || DEFAULT_TOKEN_PATH;
  let token: string;
  try {
    token = (await io.readFile(tokenPath)).trim();
  } catch (err) {
    io.stderr(`${name} could not read this gateway's credential at ${tokenPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let outcome: { status: number; answer: Record<string, unknown> };
  try {
    outcome = await postCommand(io, edge, token, command);
  } catch (err) {
    io.stderr(`${name} could not reach this gateway's edge at ${edge}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const failure = failureLine(name, outcome.status, outcome.answer);
  if (failure) {
    io.stderr(failure);
    return 1;
  }
  io.stdout(describeAnswer(command, outcome.answer));
  return 0;
}
