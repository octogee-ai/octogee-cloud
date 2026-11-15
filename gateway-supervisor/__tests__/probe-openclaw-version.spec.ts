import { describe, it, expect, vi } from "vitest";
import {
  probeOpenClawVersion,
  type ExecFile,
} from "../lib/probe-openclaw-version.js";

describe("probeOpenClawVersion", () => {
  it("returns the trimmed stdout of `<binary> --version` on success", () => {
    const execFile = vi.fn().mockReturnValue(
      Buffer.from("2026.5.19-beta.1\n"),
    ) as unknown as ExecFile;
    const v = probeOpenClawVersion({
      execFile,
      binaryPath: "/usr/local/bin/openclaw",
    });
    expect(v).toBe("2026.5.19-beta.1");
  });

  it("passes the binary path through verbatim (production uses an absolute path to defeat PATH poisoning)", () => {
    const execFile = vi.fn().mockReturnValue(Buffer.from("v1")) as unknown as ExecFile;
    probeOpenClawVersion({ execFile, binaryPath: "/usr/local/bin/openclaw" });
    expect(execFile).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      ["--version"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  it("returns 'unknown' when execFile throws (binary missing, exit≠0, spawn denied — any reason)", () => {
    const execFile = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    }) as unknown as ExecFile;
    const v = probeOpenClawVersion({
      execFile,
      binaryPath: "/nonexistent/openclaw",
    });
    expect(v).toBe("unknown");
  });

  it("trims trailing whitespace + newlines from real CLI output", () => {
    const execFile = vi.fn().mockReturnValue(
      Buffer.from("   2026.5.19   \r\n"),
    ) as unknown as ExecFile;
    expect(
      probeOpenClawVersion({ execFile, binaryPath: "/usr/local/bin/openclaw" }),
    ).toBe("2026.5.19");
  });
});
