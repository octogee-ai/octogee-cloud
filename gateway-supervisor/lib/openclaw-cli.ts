import { execFile } from "node:child_process";

export interface OpenClawCommandResult { code: number; stdout: string; stderr?: string }
export interface OpenClawCommandOptions { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }
export type OpenClawCommand = (
  args: string[],
  options: OpenClawCommandOptions,
) => Promise<OpenClawCommandResult>;

export class OpenClawCommandError extends Error {
  #output: { stdout: Buffer; stderr: Buffer };

  constructor(message: string, stdout: string | Buffer, stderr: string | Buffer) {
    super(message);
    this.#output = { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  }

  readOutput(): { stdout: Buffer; stderr: Buffer } {
    return { stdout: Buffer.from(this.#output.stdout), stderr: Buffer.from(this.#output.stderr) };
  }
}

function hasStdinFailure(error: NodeJS.ErrnoException | undefined): boolean {
  return error !== undefined && error.code !== "EPIPE";
}

export const runOpenClaw: OpenClawCommand = (args, options) =>
  new Promise((resolve, reject) => {
    const { timeoutMs = 180_000, ...commandOptions } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      reject(new Error("OpenClaw command timeout must be a positive safe integer no greater than 300000ms"));
      return;
    }
    const started = performance.now();
    let stdinError: NodeJS.ErrnoException | undefined;
    const child = execFile("/usr/local/bin/openclaw", args, {
      ...commandOptions, encoding: "buffer", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
      cwd: options.env.OPENCLAW_STATE_DIR,
    }, (error, stdout, stderr) => {
      if ((error && (error.killed || typeof error.code !== "number")) || (!error && hasStdinFailure(stdinError))) {
        reject(new OpenClawCommandError(`OpenClaw ${args[0]} command failed (code=${error?.code ?? "none"}, killed=${Boolean(error?.killed)}, signal=${error?.signal ?? "none"}, elapsedMs=${Math.round(performance.now() - started)}, stdoutBytes=${Buffer.byteLength(stdout)}, stderrBytes=${Buffer.byteLength(stderr)}, stdinCode=${stdinError?.code ?? "none"})`, stdout, stderr));
      } else {
        resolve({ code: (error?.code as number | undefined) ?? 0, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
      }
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => { stdinError = error; });
    child.stdin?.end();
  });
