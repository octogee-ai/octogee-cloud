import http from "node:http";
import { isGatewayVmBootRecoverySample, type GatewayVmBootRecoverySample } from "@octogee/shared/types/glm";

export interface DesktopControl {
  tools?(): Promise<{ rebuildable: boolean }>;
  recovery?(): Promise<GatewayVmBootRecoverySample>;
  run(action: "freeze" | "thaw" | "stop" | "stop-home" | "reconcile-tools" | "start"): Promise<void>;
}

export function desktopActionTimeoutMs(action: string): number {
  if (action === "start") return 23 * 60_000;
  if (action === "reconcile-tools") return 21 * 60_000;
  return 60_000;
}

function runDesktopAction(socketPath: string, action: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
      const req = http.request({ socketPath, method: "POST", path: `/${action}`, timeout: desktopActionTimeoutMs(action) }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode === 200) resolve(Buffer.concat(chunks).toString("utf8"));
          else reject(Object.assign(new Error(`desktop ${action}: HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(-500)}`), { status: res.statusCode }));
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`desktop ${action} timed out`)));
      req.end();
  });
}

export function createDesktopControl(socketPath = "/run/octogee-desktop/control.sock"): DesktopControl {
  return {
    run: (action) => runDesktopAction(socketPath, action).then(() => undefined),
    tools: async () => {
      const result: unknown = JSON.parse(await runDesktopAction(socketPath, "record-tools"));
      if (!result || typeof result !== "object" || typeof (result as { rebuildable?: unknown }).rebuildable !== "boolean") {
        throw new Error("native tool rebuild status is malformed");
      }
      return result as { rebuildable: boolean };
    },
    recovery: async () => {
      const result: unknown = JSON.parse(await runDesktopAction(socketPath, "accept-home-recovery"));
      if (!isGatewayVmBootRecoverySample(result)) throw new Error("native home recovery status is malformed");
      return result;
    },
  };
}
