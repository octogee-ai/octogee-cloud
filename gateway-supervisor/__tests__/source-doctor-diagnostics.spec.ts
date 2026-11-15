import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSourceDoctorDiagnostics, SOURCE_DOCTOR_DIAGNOSTICS_DIRECTORY } from "../lib/source-doctor-diagnostics.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-diagnostics-test-"))); homes.push(home);
  const log = vi.fn(), root = path.join(home, SOURCE_DOCTOR_DIAGNOSTICS_DIRECTORY);
  return { home, root, log, input: { home, excludedRoots: [path.join(home, ".openclaw"), path.join(home, "workspace")],
    context: { requestId: "private-request", releaseKey: "private-release", log } } };
}
it("persists private bounded output and phase timings without putting raw text or identity in logs or metadata", async () => {
  const f = await fixture(), diagnostic = await createSourceDoctorDiagnostics(f.input);
  await expect(diagnostic.phase("postgres-doctor", async () => { throw new Error("private-detail"); })).rejects.toThrow("private-detail");
  await diagnostic.seal({ stdout: "private-output-é", stderr: "private-error" });
  await diagnostic.seal({ stdout: "replacement refused" });
  await diagnostic.phase("private-cleanup", async () => {});
  await diagnostic.finish("failed");
  const directory = path.join(f.root, "slot-0"), metadata = await fs.readFile(path.join(directory, "metadata.json"), "utf8");
  expect(await fs.readFile(path.join(directory, "stdout.bin"), "utf8")).toBe("private-output-é");
  expect(await fs.readFile(path.join(directory, "stderr.bin"), "utf8")).toBe("private-error");
  expect(JSON.parse(metadata)).toMatchObject({ status: "failed", sealed: true, phases: [
    { phase: "postgres-doctor", status: "failed" }, { phase: "private-cleanup", status: "passed" },
  ] });
  for (const text of [JSON.stringify(f.log.mock.calls), metadata]) {
    for (const sensitive of ["private-request", "private-release", "private-detail", "private-output", "private-error"]) expect(text).not.toContain(sensitive);
  }
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  for (const file of await fs.readdir(directory)) expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
});
it("reserves at most eight slots without overwriting retained evidence", async () => {
  const f = await fixture();
  for (let i = 0; i < 8; i++) { const diagnostic = await createSourceDoctorDiagnostics(f.input); await diagnostic.seal({ stdout: String(i) }); }
  await expect(createSourceDoctorDiagnostics(f.input)).rejects.toThrow("full");
  expect(await fs.readFile(path.join(f.root, "slot-0/stdout.bin"), "utf8")).toBe("0");
});
it.each(["root-link", "home-link", "open-mode", "unknown", "linked-file", "oversize", "overlap", "workspace-link", "home-open", "inherited-name"])("refuses unsafe storage: %s", async change => {
  const f = await fixture();
  if (change === "home-link") { const linked = f.home + "-link"; homes.push(linked); await fs.symlink(f.home, linked); f.input.home = linked; }
  else if (change === "home-open") await fs.chmod(f.home, 0o777);
  else if (change === "root-link") await fs.symlink(f.home, f.root);
  else if (change === "overlap") f.input.excludedRoots.push(f.home);
  else if (change === "workspace-link") {
    await fs.mkdir(f.root, { mode: 0o700 });
    await fs.symlink(f.root, path.join(f.home, "workspace"));
  }
  else {
    await fs.mkdir(f.root, { mode: change === "open-mode" ? 0o755 : 0o700 });
    if (change === "unknown") await fs.mkdir(path.join(f.root, "unknown"));
    if (change === "inherited-name") {
      await fs.mkdir(path.join(f.root, "slot-0"), { mode: 0o700 });
      await fs.writeFile(path.join(f.root, "slot-0/constructor"), "unknown", { mode: 0o600 });
    }
    if (change === "linked-file" || change === "oversize") {
      const slot = path.join(f.root, "slot-0"); await fs.mkdir(slot, { mode: 0o700 });
      const file = path.join(slot, "stdout.bin"); await fs.writeFile(file, "retained", { mode: 0o600 });
      if (change === "linked-file") await fs.link(file, path.join(f.home, "other"));
      else await fs.truncate(file, 2 * 1024 * 1024 + 1);
    }
  }
  await expect(createSourceDoctorDiagnostics(f.input)).rejects.toThrow(/unsafe|unknown|overlaps/);
});
it("refuses oversized output without marking the snapshot sealed", async () => {
  const f = await fixture(), diagnostic = await createSourceDoctorDiagnostics(f.input);
  await expect(diagnostic.seal({ stdout: "x".repeat(2 * 1024 * 1024 + 1) })).rejects.toThrow("bound");
  await diagnostic.finish("failed");
  expect(JSON.parse(await fs.readFile(path.join(f.root, "slot-0/metadata.json"), "utf8")).sealed).toBe(false);
});
