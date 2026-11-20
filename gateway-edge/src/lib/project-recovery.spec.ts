import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commitLocalProjectAsset, editRemoteProjectAsset } from "@octogee/core/workspace/project-blob-edit";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import { persistUserProjects } from "./project-persistence.js";
import { commitAndPushWorkspace, gitStatus, resolveProjectDir } from "@octogee/core/workspace/workspace-git";
import { divertWorktreeBinaries } from "@octogee/core/workspace/binary-diversion";
import { createBrokeredProjectBlobHydrator, prepareUserProjectAssets } from "@octogee/core/project-blob-materialization";
import { readProjectRestoreReady, writeProjectRestoreReady, withMaterializedProjectAssets } from "@octogee/core/project-asset-state";
const linuxTest = it.skipIf(process.platform !== "linux");
let root: string;
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();if(root)await rm(root,{recursive:true,force:true});});
function git(cwd: string,...args: string[]){return execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();}
async function readUser(slug: string) {
  return { uid: `uid-${slug}`, slug, gatewayId: "builder-one", status: "complete" as const, checkpointEpoch: 1,
    projects: [{ projectSlug: "demo", giteaRepoName: "demo" }] };
}
linuxTest("restores text and the matching immutable asset after losing the working set, including an older commit",async()=>{
  root=await mkdtemp(path.join(tmpdir(),"project-recovery-"));
  const users=path.join(root,"customers"),projects=path.join(users,"alice/projects"),dir=path.join(projects,"demo"),remote=path.join(root,"remote.git");
  await mkdir(dir,{recursive:true});
  await writeProjectRestoreReady(dir,"alice","demo");
  git(root,"init","--bare","--initial-branch=main",remote);
  git(dir,"init","--initial-branch=main");git(dir,"config","user.name","Fixture");git(dir,"config","user.email","fixture@example.test");
  await writeFile(path.join(dir,"README.md"),"initial\n");git(dir,"add",".");git(dir,"commit","-m","initial");git(dir,"remote","add","origin",remote);git(dir,"push","-u","origin","main");
  const transport=path.join(root,"test-ssh");
  await writeFile(transport,"#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n");await chmod(transport,0o755);
  git(dir,"remote","set-url","origin",`ssh://git@localhost${remote}`);vi.stubEnv("GIT_SSH",transport);
  const objects=new Map<string,Buffer>();
  const store=vi.fn(async(target:any,_name:string,body:Buffer)=>{
    const sha256=createHash("sha256").update(body).digest("hex");objects.set(sha256,Buffer.from(body));
    return {sha256,size:body.length,gcsPath:`${target.gcsPrefix}/.objects/${sha256}`};
  });
  const deps={readUser,resolveProject:resolveProjectDir,commit:commitAndPushWorkspace,prepare:async()=>{throw new Error("unexpected asset preparation");},
    divert:(cwd:string,target:any)=>divertWorktreeBinaries(cwd,target,{gitStatus,storeWorkspaceBlob:store},{retainLocalFiles:true})};
  const versions=[];
  for(const n of [1,2]){
    const body=Buffer.from([0,1,2,n]);await writeFile(path.join(dir,"asset.bin"),body);await writeFile(path.join(dir,"README.md"),`revision ${n}\n`);
    expect(await persistUserProjects({root:users,slug:"alice"},deps)).toEqual({projects:1});
    expect(await readProjectRestoreReady(dir,"alice","demo")).toBe(true);
    for (let save = 0; save < 2; save++) {
      const head = git(dir,"rev-parse","HEAD");
      const uploads = store.mock.calls.length;
      expect(await persistUserProjects({root:users,slug:"alice"},deps)).toEqual({projects:1});
      expect(git(dir,"ls-files")).not.toContain("asset.bin");
      expect(git(dir,"rev-parse","HEAD")).toBe(head);
      expect(store).toHaveBeenCalledTimes(uploads);
    }
    expect(await readFile(path.join(dir,"asset.bin"))).toEqual(body);
    const sha=git(dir,"rev-parse","HEAD");
    expect(git(root,"--git-dir",remote,"rev-parse","refs/heads/main")).toBe(sha);
    expect(git(dir,"ls-files")).not.toContain("asset.bin");
    expect(git(dir,"ls-files")).toContain(".files/manifest.json");
    versions.push({sha,body,n});
  }
  expect(objects.size).toBe(2);
  const target: FileTarget = {slug:"alice",projectSlug:"demo",provider:"gitea",org:"octogee-alice",repoName:"alice-demo",gcsPrefix:"customers/alice/projects/demo",sudoUser:"ws-alice"};
  const uploaded = Buffer.from([0,7,8,9]);
  await commitLocalProjectAsset({target,dir,name:"asset.bin",contents:uploaded,upload:()=>store(target,"asset.bin",uploaded),mimeType:"application/custom",divert:deps.divert});
  expect(await readFile(path.join(dir,"asset.bin"))).toEqual(uploaded);
  expect(JSON.parse(await readFile(path.join(dir,".files/manifest.json"),"utf8"))["asset.bin"].mimeType).toBe("application/custom");
  expect(git(root,"--git-dir",remote,"rev-parse","refs/heads/main")).toBe(git(dir,"rev-parse","HEAD"));
  await commitLocalProjectAsset({target,dir,name:"asset.bin",contents:null,upload:async()=>{throw new Error("deletion must not upload");},divert:deps.divert});
  await expect(readFile(path.join(dir,"asset.bin"))).rejects.toMatchObject({code:"ENOENT"});
  await writeFile(path.join(dir,"asset.bin"),versions[1].body);
  await persistUserProjects({root:users,slug:"alice"},deps);
  await rm(path.join(dir, "asset.bin"));
  await persistUserProjects({root:users,slug:"alice"},deps);
  expect(JSON.parse(await readFile(path.join(dir,".files/manifest.json"),"utf8"))).toEqual({});
  const deleted = git(dir,"rev-parse","HEAD");
  const manifestRead=vi.fn(async()=>{throw new Error("committed manifest must be authoritative");});
  const hydrate=createBrokeredProjectBlobHydrator({workspaceManifestReadUrl:manifestRead,blobMaterializationReadUrl:async(input:any)=>{
    const body=objects.get(input.sha256);if(!body)throw new Error("missing immutable object");
    // eslint-disable-next-line sonarjs/hashing -- emulates the GCS transport checksum
    return {generation:"1",size:body.length,md5Hash:createHash("md5").update(body).digest("base64"),download:{url:`https://objects.test/${input.sha256}`,method:"GET",gcsPath:`customers/alice/projects/demo/.objects/${input.sha256}`,expiresAt:"later"}};
  }});
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>new Response(new Uint8Array(objects.get(new URL(url).pathname.slice(1))!),{headers:{"x-goog-generation":"1"}})));
  await rm(dir,{recursive:true});git(root,"clone",remote,dir);
  expect(git(dir,"rev-parse","HEAD")).toBe(deleted);
  expect(await hydrate({slug:"alice",project:"demo",destination:dir,maxBytes:1024})).toMatchObject({files:0,bytes:0});
  await expect(readFile(path.join(dir,"asset.bin"))).rejects.toMatchObject({code:"ENOENT"});
  for(const version of versions.reverse()){
    await rm(dir,{recursive:true});git(root,"clone",remote,dir);git(dir,"checkout","--detach",version.sha);
    expect(await hydrate({slug:"alice",project:"demo",destination:dir,maxBytes:1024})).toMatchObject({files:1,bytes:4});
    expect(await readFile(path.join(dir,"asset.bin"))).toEqual(version.body);
    expect(await readFile(path.join(dir,"README.md"),"utf8")).toBe(`revision ${version.n}\n`);
  }
  expect(manifestRead).not.toHaveBeenCalled();
});

linuxTest("retains restoration and materialized receipts after a local asset upload and deletion",async()=>{
  root=await mkdtemp(path.join(tmpdir(),"project-edit-ready-"));
  const dir=path.join(root,"demo"),remote=path.join(root,"remote.git");
  await mkdir(dir);
  git(root,"init","--bare","--initial-branch=main",remote);
  git(dir,"init","--initial-branch=main");git(dir,"config","user.name","Fixture");git(dir,"config","user.email","fixture@example.test");
  await writeFile(path.join(dir,"README.md"),"initial\n");git(dir,"add",".");git(dir,"commit","-m","initial");git(dir,"remote","add","origin",remote);git(dir,"push","-u","origin","main");
  const transport=path.join(root,"test-ssh");
  await writeFile(transport,"#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n");await chmod(transport,0o755);
  git(dir,"remote","set-url","origin",`ssh://git@localhost${remote}`);vi.stubEnv("GIT_SSH",transport);
  await writeProjectRestoreReady(dir,"alice","demo");
  const target:FileTarget={slug:"alice",projectSlug:"demo",provider:"gitea",org:"alice",repoName:"demo",gcsPrefix:"customers/alice/projects/demo",sudoUser:"ws-alice"};
  const contents=Buffer.from([0,7,8,9]),sha256=createHash("sha256").update(contents).digest("hex");
  const stored={sha256,size:contents.length,gcsPath:`${target.gcsPrefix}/.objects/${sha256}`};
  const divert=async()=>({diverted:[],failures:[],failedPaths:[]});

  await commitLocalProjectAsset({target,dir,name:"asset.bin",contents,upload:async()=>stored,divert});

  const manifest=JSON.parse(await readFile(path.join(dir,".files/manifest.json"),"utf8"));
  expect(await withMaterializedProjectAssets(dir,target.gcsPrefix,async files=>files)).toEqual(manifest);
  expect(await readProjectRestoreReady(dir,"alice","demo")).toBe(true);
  await commitLocalProjectAsset({target,dir,name:"asset.bin",contents:null,upload:async()=>{throw new Error("delete must not upload");},divert});
  expect(await withMaterializedProjectAssets(dir,target.gcsPrefix,async files=>files)).toEqual({});
  expect(await readProjectRestoreReady(dir,"alice","demo")).toBe(true);
});

linuxTest.each(["available", "unavailable", "replacement", "conflict", "deletion"])("keeps a normal remote project asset upload eligible for source flush when storage is %s",async storage=>{
  root=await mkdtemp(path.join(tmpdir(),"project-remote-upload-flush-"));
  const users=path.join(root,"customers"),dir=path.join(users,"alice/projects/demo"),remote=path.join(root,"remote.git"),seed=path.join(root,"seed");
  await mkdir(seed);
  git(root,"init","--bare","--initial-branch=main",remote);
  git(seed,"init","--initial-branch=main");git(seed,"config","user.name","Fixture");git(seed,"config","user.email","fixture@example.test");
  await writeFile(path.join(seed,"README.md"),"initial\n");git(seed,"add",".");git(seed,"commit","-m","initial");git(seed,"remote","add","origin",remote);git(seed,"push","-u","origin","main");
  await mkdir(path.dirname(dir),{recursive:true});git(root,"clone",remote,dir);
  await writeProjectRestoreReady(dir,"alice","demo");
  const transport=path.join(root,"test-ssh");
  await writeFile(transport,"#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n");await chmod(transport,0o755);
  git(dir,"remote","set-url","origin",`ssh://git@localhost${remote}`);vi.stubEnv("GIT_SSH",transport);
  const target:FileTarget={slug:"alice",projectSlug:"demo",provider:"gitea",org:"alice",repoName:"demo",gcsPrefix:"customers/alice/projects/demo",sudoUser:"ws-alice"};
  const sha256="bc8bd51d2be39b728495aed2f94ca02435c6de88f82be92c5f4452e4be6cf3bc";
  const asset={type:"blob" as const,gcsPath:`${target.gcsPrefix}/.objects/${sha256}`,sha256,size:117,mimeType:"image/png",uploadedAt:"2026-10-16T21:14:41.904Z"};
  await editRemoteProjectAsset(target,"qa-515b-982-asset.png",asset,{
    read:async()=>null,readLegacy:async()=>({}),write:async(_target,body)=>{
      await mkdir(path.join(seed,".files"));
      await writeFile(path.join(seed,".files/manifest.json"),Buffer.from(body.content,"base64"));
      git(seed,"add",".files/manifest.json");git(seed,"commit","-m",body.message);git(seed,"push","origin","main");
      return {content:{sha:git(seed,"rev-parse","HEAD:.files/manifest.json")}};
    },
  });
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAHXRFWHRRQQBRQS01MTVCLTk4Mi1SRVRBSU5FRC1BU1NFVFJ5O88AAAATSURBVHicY/jPwPAfDBkY/oMBAEnICfcUYzKdAAAAAElFTkSuQmCC","base64");
  const objects=new Map([[sha256,bytes]]);
  const blobRead=vi.fn(async(input:any)=>{
    const body=objects.get(input.sha256)!;
    // eslint-disable-next-line sonarjs/hashing -- emulates the GCS transport checksum
    return {generation:"1",size:body.length,md5Hash:createHash("md5").update(body).digest("base64"),download:{url:`https://objects.test/${input.sha256}`,method:"GET" as const,gcsPath:`${target.gcsPrefix}/.objects/${input.sha256}`,expiresAt:"later"}};
  });
  const hydrate=createBrokeredProjectBlobHydrator({workspaceManifestReadUrl:async()=>{throw new Error("local Git manifest is authoritative");},blobMaterializationReadUrl:blobRead},users);
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>storage === "unavailable" ? new Response(null,{status:503}) : new Response(new Uint8Array(objects.get(new URL(url).pathname.slice(1))!),{headers:{"x-goog-generation":"1"}})));
  const deps={readUser,resolveProject:resolveProjectDir,commit:commitAndPushWorkspace,
    prepare:async()=>prepareUserProjectAssets({projects:path.dirname(dir),slug:"alice",project:"demo",hydrate,requireRestoredCheckout:true}),
    divert:(cwd:string,scope:any)=>divertWorktreeBinaries(cwd,scope,{gitStatus,storeWorkspaceBlob:async(_target,_name,body)=>{
      const hash=createHash("sha256").update(body).digest("hex");objects.set(hash,Buffer.from(body));
      return {gcsPath:`${target.gcsPrefix}/.objects/${hash}`,sha256:hash,size:body.length};
    }},{retainLocalFiles:true})};

  if (storage === "unavailable") {
    await expect(persistUserProjects({root:users,slug:"alice"},deps)).rejects.toThrow(/503/);
    expect(await readProjectRestoreReady(dir,"alice","demo")).toBe(false);
    await expect(readFile(path.join(dir,"qa-515b-982-asset.png"))).rejects.toMatchObject({code:"ENOENT"});
    return;
  }
  await expect(persistUserProjects({root:users,slug:"alice"},deps)).resolves.toEqual({projects:1});
  expect(JSON.parse(await readFile(path.join(dir,".files/manifest.json"),"utf8"))).toEqual({"qa-515b-982-asset.png":asset});
  expect(await readFile(path.join(dir,"qa-515b-982-asset.png"))).toEqual(bytes);
  expect(await readProjectRestoreReady(dir,"alice","demo")).toBe(true);
  await expect(persistUserProjects({root:users,slug:"alice"},deps)).resolves.toEqual({projects:1});
  expect(blobRead).toHaveBeenCalledOnce();
  expect(git(dir,"ls-files")).not.toContain("qa-515b-982-asset.png");
  if (storage !== "replacement" && storage !== "conflict" && storage !== "deletion") return;
  const replacement=Buffer.from([0,2,3,4]),replacementHash=createHash("sha256").update(replacement).digest("hex");
  objects.set(replacementHash,replacement);
  git(seed,"pull","--ff-only","origin","main");
  await editRemoteProjectAsset(target,"qa-515b-982-asset.png",storage === "deletion" ? null : {...asset,sha256:replacementHash,gcsPath:`${target.gcsPrefix}/.objects/${replacementHash}`,size:replacement.length,uploadedAt:"2026-10-16T22:00:00Z"},{
    read:async()=>({sha:git(seed,"rev-parse","HEAD:.files/manifest.json"),encoding:"base64",content:(await readFile(path.join(seed,".files/manifest.json"))).toString("base64")}),
    readLegacy:async()=>({}),write:async(_target,body)=>{
      await writeFile(path.join(seed,".files/manifest.json"),Buffer.from(body.content,"base64"));
      git(seed,"add",".files/manifest.json");git(seed,"commit","-m",body.message);git(seed,"push","origin","main");
      return {content:{sha:git(seed,"rev-parse","HEAD:.files/manifest.json")}};
    },
  });
  if (storage === "conflict") {
    const local=Buffer.from([0,9,8,7]);await writeFile(path.join(dir,"qa-515b-982-asset.png"),local);
    await expect(persistUserProjects({root:users,slug:"alice"},deps)).rejects.toThrow(/project demo/);
    expect(await readFile(path.join(dir,"qa-515b-982-asset.png"))).toEqual(local);
  } else {
    await expect(persistUserProjects({root:users,slug:"alice"},deps)).resolves.toEqual({projects:1});
    await expect(persistUserProjects({root:users,slug:"alice"},deps)).resolves.toEqual({projects:1});
    if (storage === "deletion") {
      expect.soft(await readFile(path.join(dir,"qa-515b-982-asset.png")).then(()=>"present",error=>error.code)).toBe("ENOENT");
      expect.soft(await withMaterializedProjectAssets(dir,target.gcsPrefix,async files=>files)).toEqual({});
    } else expect.soft(await readFile(path.join(dir,"qa-515b-982-asset.png"))).toEqual(replacement);
  }
  const remoteManifest=JSON.parse(git(root,"--git-dir",remote,"show","main:.files/manifest.json"));
  if (storage === "deletion") expect.soft(remoteManifest).toEqual({});
  else expect.soft(remoteManifest["qa-515b-982-asset.png"].sha256).toBe(replacementHash);
});
