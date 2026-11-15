import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createDesktopControl, desktopActionTimeoutMs } from "../../lib/vm-gateway-agent/desktop-control";

it("sends only lifecycle actions through the private socket and surfaces systemd failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-desktop-control-"));
  const socket = join(root, "control.sock");
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/stop") res.writeHead(500).end("systemctl failed");
    else res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const control = createDesktopControl(socket);
    await control.run("freeze");
    await control.run("thaw");
    await expect(control.run("stop")).rejects.toThrow("systemctl failed");
    expect(requests).toEqual(["POST /freeze", "POST /thaw", "POST /stop"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("waits for desktop start longer than the user manager and the home migration it starts may take", async () => {
  const migration = await readFile(resolve(__dirname, "../../../desktop/image/rootfs/etc/systemd/system/octo-home-migrate.service"), "utf8");
  const migrationMs = Number(/^TimeoutStartSec=(\d+)min$/mu.exec(migration)![1]) * 60_000;
  const userManagerDefaultStartMs = 90_000;
  expect(desktopActionTimeoutMs("start")).toBeGreaterThan(migrationMs + userManagerDefaultStartMs);
  expect(desktopActionTimeoutMs("reconcile-tools")).toBeGreaterThan(20 * 60_000);
  expect(desktopActionTimeoutMs("freeze")).toBe(60_000);
});

it("reads validated native recovery admission through the root-owned socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-recovery-control-"));
  const socket = join(root, "control.sock");
  const sample = { currentPointId: "image-new-" + "a".repeat(32), retainedPoints: 1, ready: true, bundleVersion: "v1", freeBytes: 3 * 1024 ** 3 };
  let body: unknown = sample;
  const server = createServer((req, res) => { expect(req.url).toBe("/accept-home-recovery"); res.end(JSON.stringify(body)); });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const control = createDesktopControl(socket);
    expect(await control.recovery!()).toEqual(sample);
    body = { ...sample, retainedPoints: -1 };
    await expect(control.recovery!()).rejects.toThrow("malformed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["retires older recovery points only after actual native readiness", "test_home_recovery.py"],
  ["quiesces applications and recovers lifecycle failures", "test_lifecycle.py"],
  ["keeps managed desktops awake before starting the compositor", "test_idle.py"],
  ["preserves the desktop when Chromium closes and supervises core services", "test_supervision.py"],
  ["checks fresh-image resize support before and after reboot", "test_acceptance.py"],
  ["checks screenshot and XWayland resize geometry", "test_display_resize.py"],
  ["keeps untested image candidates outside the family", "test_build.py"],
  ["validates resize requests and waits for output dimensions", "test_resize.py"],
  ["serves the Desk page, apps, launch, note and style endpoints", "test_desk.py"],
  ["keeps the host desktop off only for an X11 VM", "test_desktop_wanted.py"],
])("%s", async (_behavior, filename) => {
  const script = resolve(__dirname, "../../../desktop/image", filename);
  await expect(promisify(execFile)("python3", [script])).resolves.toMatchObject({
    stderr: expect.stringMatching(/Ran [1-9]\d* tests? in [^\n]+\n\nOK\s*$/),
  });
}, 90_000);

it("records read-only native tool declarations and rejects malformed status", async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-tools-control-"));
  const socket = join(root, "control.sock");
  let body: unknown = { rebuildable: true };
  const server = createServer((req, res) => { expect(req.url).toBe("/record-tools"); res.end(JSON.stringify(body)); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const control = createDesktopControl(socket);
    expect(await control.tools!()).toEqual({ rebuildable: true });
    body = { rebuildable: "yes" };
    await expect(control.tools!()).rejects.toThrow("malformed");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
