import { assertUserStorePath } from "../lib/postgres-anchor-file.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { landAuxiliaryAnchors, readLocalAuxiliaryAnchors, auxiliaryStorePath, verifyAuxiliaryAnchorInPostgres } from "../lib/user-auxiliary-anchors.js";

const roots: string[] = [];
async function root() { const dir = await fs.mkdtemp(path.join(tmpdir(), "aux-anchors-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const families = ["workboard", "logbook", "team-reports"] as const;
const anchors = families.map((family, i) => ({ family, storeId: `92c817cc-770f-466d-b4a6-4e9b0299836${i}`, schema: `octogee_aux_${i}` }));

it("restores all three anchors at native paths after verifying every PostgreSQL identity", async () => {
  const dir = await root();
  const verify = vi.fn(async () => { expect(await readLocalAuxiliaryAnchors(dir)).toEqual([]); });
  await landAuxiliaryAnchors(dir, anchors, verify);
  expect(await readLocalAuxiliaryAnchors(dir)).toEqual(anchors);
  expect(verify).toHaveBeenCalledTimes(3);
  expect(auxiliaryStorePath(dir, "logbook")).toBe(path.join(dir, "logbook/logbook.sqlite"));
  expect((await fs.stat(auxiliaryStorePath(dir, "workboard"))).mode & 0o777).toBe(0o600);
  await landAuxiliaryAnchors(dir, anchors, async () => {});
  expect(await readLocalAuxiliaryAnchors(dir)).toEqual(anchors);
});
it("lands nothing when a recorded namespace is missing or belongs to a different store", async () => {
  const dir = await root();
  await expect(landAuxiliaryAnchors(dir, anchors, async anchor => {
    await verifyAuxiliaryAnchorInPostgres(anchor, async () => anchor.family === "logbook" ? [] : [{ store_id: anchor.storeId }]);
  })).rejects.toThrow("missing");
  expect(await readLocalAuxiliaryAnchors(dir)).toEqual([]);
  await expect(verifyAuxiliaryAnchorInPostgres(anchors[0], async () => [{ store_id: anchors[1].storeId }])).rejects.toThrow("different");
});
it("queries the recorded family and propagates database outages", async () => {
  const query = vi.fn(async () => [{ store_id: anchors[2].storeId }]);
  await verifyAuxiliaryAnchorInPostgres(anchors[2], query);
  expect(query.mock.calls[0]).toEqual([anchors[2], "SELECT store_id FROM $schema.openclaw_schema_meta WHERE store = 'team-reports'"]);
  await expect(verifyAuxiliaryAnchorInPostgres(anchors[0], async () => { throw new Error("offline"); })).rejects.toThrow("offline");
});
it("preserves and rejects retained SQLite or a conflicting local PostgreSQL identity", async () => {
  const dir = await root();
  const file = auxiliaryStorePath(dir, "workboard"); await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('keep')"); db.close();
  const before = await fs.readFile(file);
  await expect(landAuxiliaryAnchors(dir, [anchors[0]], async () => {})).rejects.toThrow("different");
  expect(await fs.readFile(file)).toEqual(before);
  await fs.unlink(file);
  await landAuxiliaryAnchors(dir, [anchors[0]], async () => {});
  await expect(landAuxiliaryAnchors(dir, [{ ...anchors[0], schema: "another" }], async () => {})).rejects.toThrow("different");
});
it("refuses duplicate families, unsafe identities, and symlinked store parents", async () => {
  const dir = await root();
  await expect(landAuxiliaryAnchors(dir, [anchors[0], anchors[0]], async () => {})).rejects.toThrow("invalid");
  await expect(landAuxiliaryAnchors(dir, [{ ...anchors[0], schema: "../escape" }], async () => {})).rejects.toThrow("invalid");
  const outside = await root(); await fs.symlink(outside, path.join(dir, "plugins"));
  await expect(landAuxiliaryAnchors(dir, [anchors[0]], async () => {})).rejects.toThrow("symlink");
  expect(await fs.readdir(outside)).toEqual([]);
});

it("rejects noncanonical, escaping, and hard-linked paths", async () => {
  const dir = await root(), outside = await root();
  await expect(assertUserStorePath(dir, path.join(outside, "store.sqlite"))).rejects.toThrow("contained");
  await expect(assertUserStorePath(dir, `${dir}/plugins/../store.sqlite`)).rejects.toThrow("canonical");
  const original = path.join(outside, "store.sqlite"), linked = path.join(dir, "store.sqlite");
  await fs.writeFile(original, "retained"); await fs.link(original, linked);
  await expect(assertUserStorePath(dir, linked)).rejects.toThrow("hard link");
});
