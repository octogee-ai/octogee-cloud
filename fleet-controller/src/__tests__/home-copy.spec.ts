import { describe, expect, it } from "vitest";
import { homeCopyCapacity, readHomeCopyProgress } from "../lib/compute-home-copy.js";

describe("verified home copy", () => {
  it("uses the smaller allowance only with headroom and otherwise retains the larger home", () => {
    expect(homeCopyCapacity({ desiredGiB: 10, sourceGiB: 100, usedBytes: 3 * 1024 ** 3 })).toBe(10);
    expect(homeCopyCapacity({ desiredGiB: 10, sourceGiB: 100, usedBytes: 12 * 1024 ** 3 })).toBe(100);
    expect(homeCopyCapacity({ desiredGiB: 50, sourceGiB: 10, usedBytes: 8 * 1024 ** 3 })).toBe(50);
    expect(() => homeCopyCapacity({ desiredGiB: 10, sourceGiB: 50, usedBytes: NaN })).toThrow();
  });
  it("accepts only the current operation's verified copy proof and propagates failures", () => {
    const operationId = "copy-one";
    const probe = `OCTOGEE_HOME_COPY_PROBE:${JSON.stringify({ operationId, usedBytes: 123 })}`;
    expect(readHomeCopyProgress(probe, operationId)).toEqual({ status: "copying", usedBytes: 123 });
    expect(readHomeCopyProgress(`2026-10-08T20:05:47Z helper google_metadata_script_runner[889]: Metadata key("startup-script"), command("/bin/bash"): ${probe}`, operationId)).toEqual({ status: "copying", usedBytes: 123 });
    expect(readHomeCopyProgress(probe, "copy-other")).toEqual({ status: "pending" });
    const receipt = { operationId, usedBytes: 123, filesystem: "btrfs", proof: { "volumes/data": "a".repeat(64), "desktop-home": "b".repeat(64) } };
    expect(readHomeCopyProgress(`${probe}\nOCTOGEE_HOME_COPY_READY:${JSON.stringify(receipt)}`, operationId)).toMatchObject({ status: "ready", filesystem: "btrfs", usedBytes: 123 });
    expect(() => readHomeCopyProgress(`OCTOGEE_HOME_COPY_READY:${JSON.stringify({ ...receipt, filesystem: "ext4" })}`, operationId)).toThrow(/proof/);
    expect(() => readHomeCopyProgress(`OCTOGEE_HOME_COPY_READY:${JSON.stringify({ ...receipt, proof: {} })}`, operationId)).toThrow(/proof/);
    expect(() => readHomeCopyProgress(`OCTOGEE_HOME_COPY_FAILED:${JSON.stringify({ operationId, error: "disk full" })}`, operationId)).toThrow(/disk full/);
  });
});

import { createHomeCopyClient, HomeCopyFailure, type HomeCopyInput } from "../lib/compute-home-copy.js";
import { homeCopyStartupScript } from "../lib/home-copy-worker.js";
import { vi } from "vitest";

function copyFixture() {
  const input: HomeCopyInput = { operationId: "home-copy-test", ownerUid: "alice", source: { projectId: "octogee", zone: "us-central1-a", name: "home-original", id: "100", sizeGb: 50, diskType: "pd-balanced", source: "projects/octogee/zones/us-central1-a/disks/home-original" }, sourceLayout: "portable", targetZone: "us-central1-a", desiredGiB: 10, subnetwork: "private-subnet" };
  const base = "https://compute.googleapis.com/compute/v1/projects/octogee";
  const zone = `${base}/zones/us-central1-a`;
  const labels = { "octogee-owner-uid": "alice", "octogee-operation": input.operationId, purpose: "octogee-home-copy" };
  const data: Record<string, any> = {
    [`${zone}/disks/home-original`]: { id: "100" },
    [`${base}/global/snapshots/home-copy-test-source`]: { id: "101", labels, sourceDiskId: "100", status: "READY", selfLink: "snapshot-link" },
    [`${zone}/disks/home-copy-test-source`]: { id: "102", labels, sourceSnapshotId: "101", status: "READY", selfLink: "clone-link" },
    [`${zone}/instances/home-copy-test`]: { id: "103", labels, status: "PROVISIONING", metadata: { items: [{ key: "startup-script", value: homeCopyStartupScript(input) }] }, disks: [{ source: "clone-link", deviceName: "octogee-source", autoDelete: false }] },
  };
  const request = vi.fn(async ({url}: any) => ({status: Object.hasOwn(data,url) ? 200 : 404,data:data[url]??{}}));
  const journal=vi.fn(async (_what: string,_input: HomeCopyInput,action:()=>Promise<any>)=>action());
  const client=createHomeCopyClient({request,projectId:"octogee",journal});
  return {input,data,zone,base,request,client,journal};
}
it("waits for the helper to run before requesting serial output",async()=>{
  const h=copyFixture();
  expect(await h.client.advance(h.input)).toEqual({progress:{status:"pending"}});
  expect(h.request.mock.calls.some(([call])=>call.url.includes("serialPort"))).toBe(false);
  expect(h.journal).not.toHaveBeenCalled();
});
it("fails a helper running an outdated worker script so the copy is cleaned and retried",async()=>{
  const h=copyFixture();
  h.data[`${h.zone}/instances/home-copy-test`].metadata.items[0].value="#!/bin/bash\nold worker";
  await expect(h.client.advance(h.input)).rejects.toBeInstanceOf(HomeCopyFailure);
  expect(h.journal).not.toHaveBeenCalled();
});
it("refuses a helper whose source attachment changed",async()=>{
  const h=copyFixture();
  h.data[`${h.zone}/instances/home-copy-test`].disks[0].source="another-clone";
  const failure=await h.client.advance(h.input).catch((error:unknown)=>error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(HomeCopyFailure);
});
it("refuses snapshot reuse after the source disk identity changes",async()=>{
  const h=copyFixture();h.data[`${h.zone}/disks/home-original`].id="999";
  await expect(h.client.advance(h.input)).rejects.toThrow(/source disk changed/);
  expect(h.journal).not.toHaveBeenCalled();
});
it("refuses cleanup of a helper whose ownership no longer matches",async()=>{
  const h=copyFixture();h.data[`${h.zone}/instances/home-copy-test`].labels={};
  await expect(h.client.abort(h.input)).rejects.toThrow(/owner/);
  expect(h.journal).not.toHaveBeenCalled();
});
it("creates the source snapshot in its zone and restores its clone in the target zone", async () => {
  const h = copyFixture();
  const input = { ...h.input, targetZone: "us-central1-b" };
  h.request.mockImplementation(async ({ url, method }: any) => ({ status: method === "POST" || Object.hasOwn(h.data, url) ? 200 : 404, data: h.data[url] ?? {} }));
  await h.client.advance(input);
  expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", url: `${h.base}/zones/us-central1-b/disks`, body: expect.objectContaining({ sourceSnapshot: "snapshot-link" }) }));
  delete h.data[`${h.base}/global/snapshots/home-copy-test-source`];
  await h.client.advance(input);
  expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", url: `${h.zone}/disks/home-original/createSnapshot` }));
});
it("does not delete a helper that would auto-delete user storage", async () => {
  const h = copyFixture();
  h.data[`${h.zone}/instances/home-copy-test`].disks.push({ boot: false, source: "unrelated-home", autoDelete: true });
  await expect(h.client.abort(h.input)).rejects.toThrow(/attachment/);
  expect(h.journal).not.toHaveBeenCalled();
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
it("reports a worker setup failure before any disk can be formatted",()=>{
 const root=mkdtempSync(path.join(tmpdir(),"home-copy-setup-"));
 try {
  writeFileSync(path.join(root,"apt-get"),"#!/bin/sh\nexit 23\n",{mode:0o755});
  const run=spawnSync("/bin/bash",["-s"],{input:homeCopyStartupScript({operationId:"copy-setup",sourceLayout:"portable"}),encoding:"utf8",env:{...process.env,PATH:`${root}:/usr/bin:/bin`}});
  expect(run.status).toBe(23);
  expect(()=>readHomeCopyProgress(run.stdout+run.stderr,"copy-setup")).toThrow(/setup failed/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

import { HOME_COPY_WORKER } from "../lib/home-copy-worker.js";
it("excludes stopped process sockets from durable home proofs while rejecting other special files", () => {
  const config = Buffer.from(JSON.stringify({ operationId: "copy-sockets" })).toString("base64");
  const program = HOME_COPY_WORKER.split("\ntry:\n")[0] + String.raw`
import socket, tempfile
with tempfile.TemporaryDirectory(prefix='home-sockets-', dir='/tmp') as base:
    root = pathlib.Path(base)
    (root / 'private-key').write_text('retain this file')
    (root / 'private-key').chmod(0o600)
    before = tree_hash(root)
    endpoint = socket.socket(socket.AF_UNIX)
    endpoint.bind(str(root / 'process.sock'))
    endpoint.close()
    assert tree_hash(root) == before
    if sys.platform == 'linux':
        with tempfile.TemporaryDirectory(prefix='home-target-', dir='/tmp') as destination:
            copied = pathlib.Path(destination)
            copy_tree(root, copied)
            assert not (copied / 'process.sock').exists()
            assert (copied / 'private-key').read_text() == 'retain this file'
            assert stat.S_IMODE((copied / 'private-key').stat().st_mode) == 0o600
            assert tree_hash(copied) == before
    os.mkfifo(root / 'unsupported-pipe')
    try:
        tree_hash(root)
        raise AssertionError('FIFO must fail closed')
    except RuntimeError as error:
        assert 'unsupported special file' in str(error)
`;
  const run = spawnSync("python3", ["-", config], { input: program, encoding: "utf8" });
  expect(run.stderr).toBe(""); expect(run.status).toBe(0);
});
