import { expect, it, vi } from "vitest";
import type { FileTarget } from "./fileTarget.js";
import { commitLocalProjectAsset, editRemoteProjectAsset, storeUploadedWorkspaceBlob } from "./project-blob-edit.js";
const target:FileTarget={slug:"alice",projectSlug:"demo",provider:"gitea",org:"octogee-alice",repoName:"alice-demo",gcsPrefix:"customers/alice/projects/demo",sudoUser:"ws-alice"};
const asset={type:"blob" as const,gcsPath:`${target.gcsPrefix}/.objects/${"a".repeat(64)}`,sha256:"a".repeat(64),size:10,mimeType:"application/octet-stream",uploadedAt:"2026-10-08"};
it.each(["__proto__", "constructor", "docs/prototype", "docs/./asset.bin"])("rejects reserved or noncanonical asset path %s before loading the manifest", async name => {
  const read = vi.fn(async () => null);
  const write = vi.fn();
  await expect(editRemoteProjectAsset(target, name, asset, { read, write, readLegacy: async () => ({}) }))
    .rejects.toThrow("invalid project asset edit");
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it("rejects an invalid local asset name before starting a Git operation or uploading", async () => {
  const upload = vi.fn();
  const divert = vi.fn();
  await expect(commitLocalProjectAsset({ target, dir: "/unused", name: "constructor", contents: Buffer.from("asset"), upload, divert }))
    .rejects.toThrow("invalid project asset edit");
  expect(upload).not.toHaveBeenCalled();
  expect(divert).not.toHaveBeenCalled();
});
it("rejects an invalid uploaded asset name before contacting storage", async () => {
  await expect(storeUploadedWorkspaceBlob(target, "docs/prototype", Buffer.from("asset")))
    .rejects.toThrow("invalid project asset edit");
});
it("commits an uploaded asset pointer and preserves other manifest entries after a concurrent edit",async()=>{
 const other={...asset,gcsPath:`${target.gcsPrefix}/.objects/${"b".repeat(64)}`,sha256:"b".repeat(64)};
 const read=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({sha:"new-head",encoding:"base64",content:Buffer.from(JSON.stringify({"other.bin":other})).toString("base64")});
 const write=vi.fn().mockRejectedValueOnce(new Error("Gitea API 409")).mockResolvedValue({content:{sha:"committed"}});
 await editRemoteProjectAsset(target,"asset.bin",asset,{read,write,readLegacy:async()=>({})});
 const body=write.mock.calls[1][1];
 expect(body.sha).toBe("new-head");expect(JSON.parse(Buffer.from(body.content,"base64").toString())).toEqual({"asset.bin":asset,"other.bin":other});
});
it("versions deletion without deleting the immutable object needed by older commits",async()=>{
 const read=vi.fn(async()=>({sha:"old",encoding:"base64",content:Buffer.from(JSON.stringify({"asset.bin":asset})).toString("base64")}));
 const write=vi.fn(async(_target: FileTarget,_body: {content:string})=>({content:{sha:"new"}}));
 await editRemoteProjectAsset(target,"asset.bin",null,{read,write,readLegacy:async()=>({})});
 expect(JSON.parse(Buffer.from(write.mock.calls[0][1].content,"base64").toString())).toEqual({});
});
it("does not acknowledge an unavailable repository or malformed remote manifest",async()=>{
 const write=vi.fn();
 await expect(editRemoteProjectAsset(target,"asset.bin",asset,{read:async()=>{throw new Error("Gitea API 503");},write,readLegacy:async()=>({})})).rejects.toThrow(/503/);
 expect(write).not.toHaveBeenCalled();
 await expect(editRemoteProjectAsset(target,"asset.bin",asset,{read:async()=>({sha:"x",encoding:"base64",content:Buffer.from('invalid').toString('base64')}),write,readLegacy:async()=>({})})).rejects.toThrow();
 expect(write).not.toHaveBeenCalled();
});
