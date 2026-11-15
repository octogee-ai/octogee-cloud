import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeStagedSymlinks, RSYNC_DAEMON_SYMLINK_POLICY, STAGED_RSYNC_COPY_OPTIONS } from "../lib/rsync-staged-symlinks.js";

let root: string;
let source: string;
let stage: string;
let target: string;
const project = "customers/alice/projects/octogee";
const links = { "AGENTS.md": "CLAUDE.md", "functions/src/_shared": "../../shared", "site/public/ds": "../../design-system" };
const daemonTransfer = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),path=require('node:path');
(async()=>{const [source,stage,mode,policy]=process.argv.slice(1);const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});const config=stage+'.conf';fs.writeFileSync(config,['use chroot = no',policy,...(process.getuid()===0?['uid = 0','gid = 0']:[]),'pid file = '+stage+'.pid','lock file = '+stage+'.lock','[import]','path = '+stage,'read only = false','write only = true','list = false','hosts allow = 127.0.0.1'].join('\n'));const daemon=cp.spawn('rsync',['--daemon','--no-detach','--config='+config,'--port='+port,'--address=127.0.0.1'],{stdio:'inherit'});try{for(let n=0;;n++){try{await new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve()});s.once('error',reject)});break}catch(e){if(n===100)throw e;await new Promise(r=>setTimeout(r,20))}}cp.execFileSync('rsync',['-a',...(mode==='final'?['--delete-delay']:[]),source+'/', 'rsync://127.0.0.1:'+port+'/import/'],{stdio:'inherit'});}finally{daemon.kill();await new Promise(resolve=>daemon.once('exit',resolve));}})().catch(e=>{console.error(e);process.exitCode=1});`;

function run(command: string, args: string[]) {
  const image = process.env.OCTOGEE_RSYNC_TEST_IMAGE;
  return execFileSync(image ? "docker" : command, image ? ["run", "--rm", "--network=none", "--user=0:0", "--mount", `type=bind,src=${root},dst=${root}`, "--entrypoint", command, image, ...args] : args,
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}
async function transfer(mode: "pre" | "final") {
  await fs.mkdir(stage, { recursive: true });
  run("node", ["-e", daemonTransfer, source, stage, mode, RSYNC_DAEMON_SYMLINK_POLICY]);
  await assertSafeStagedSymlinks(stage, target, "alice");
  run("rsync", [...STAGED_RSYNC_COPY_OPTIONS, `${stage}/`, `${target}/`]);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "octogee-rsync-links-"));
  source = path.join(root, "source"); stage = path.join(root, "stage"); target = path.join(root, "target");
  await fs.mkdir(path.join(source, project, "functions/src"), { recursive: true });
  await fs.mkdir(path.join(source, project, "site/public"), { recursive: true });
  await fs.mkdir(target);
  await fs.mkdir(path.join(source, project, "shared"));
  await fs.mkdir(path.join(source, project, "design-system"));
  await fs.writeFile(path.join(source, project, "CLAUDE.md"), "authored instructions\n");
  for (const [name, value] of Object.entries(links)) await fs.symlink(value, path.join(source, project, name));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("rsync daemon staging symlinks", () => {
  it("retains project links, Git history and local edits through pre/final transfers and a return hop", async () => {
    const repo = path.join(source, project);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@octogee.test", "commit", "-qm", "fixture"]);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
    await fs.appendFile(path.join(repo, "CLAUDE.md"), "uncommitted work\n");
    for (const mode of ["pre", "final"] as const) {
      await transfer(mode);
      for (const [name, value] of Object.entries(links)) {
        expect(await fs.readlink(path.join(stage, project, name))).toBe(`/rsyncd-munged/${value}`);
        expect(await fs.readlink(path.join(target, project, name))).toBe(value);
      }
    }
    source = target; stage = path.join(root, "return-stage"); target = path.join(root, "returned"); await fs.mkdir(target);
    await transfer("final");
    for (const [name, value] of Object.entries(links)) expect(await fs.readlink(path.join(target, project, name))).toBe(value);
    expect(execFileSync("git", ["-C", path.join(target, project), "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(head);
    expect(execFileSync("git", ["-C", path.join(target, project), "status", "--porcelain"], { encoding: "utf8" })).toBe(" M CLAUDE.md\n");
    expect(await fs.readFile(path.join(target, project, "CLAUDE.md"), "utf8")).toBe("authored instructions\nuncommitted work\n");
  });
  it("retains safe symlink chains and dangling in-project links", async () => {
    await fs.symlink("CLAUDE.md", path.join(source, project, "alias"));
    await fs.symlink("alias", path.join(source, project, "chain"));
    await fs.symlink("not-created-yet", path.join(source, project, "dangling"));
    await transfer("pre");
    expect(await fs.readlink(path.join(target, project, "chain"))).toBe("alias");
    expect(await fs.readFile(path.join(target, project, "chain"), "utf8")).toBe("authored instructions\n");
    expect(await fs.readlink(path.join(target, project, "dangling"))).toBe("not-created-yet");
  });
  it.each(["staged", "destination"])("rejects an escape through a %s symlink chain before installing", async location => {
    const tree = location === "staged" ? source : target;
    await fs.mkdir(path.join(tree, project), { recursive: true });
    await fs.symlink("/etc", path.join(tree, project, "escape"));
    await fs.symlink("escape/passwd", path.join(source, project, "chain"));
    await expect(transfer("pre")).rejects.toThrow(/unsafe staged symlink/);
    expect(await fs.readdir(path.join(target, project)).catch(() => [])).toEqual(location === "staged" ? [] : ["escape"]);
  });
  it("rejects cyclic decoded links", async () => {
    await fs.symlink("cycle", path.join(source, project, "cycle"));
    await expect(transfer("pre")).rejects.toThrow(/unsafe staged symlink.*cycle/);
    expect(await fs.readdir(target)).toEqual([]);
  });
  it.each(["/etc/passwd", "../../../bob/private", "../../other/secret", "/rsyncd-munged/CLAUDE.md"])("rejects unsafe decoded link %s before installing any files", async value => {
    await fs.unlink(path.join(source, project, "AGENTS.md")); await fs.symlink(value, path.join(source, project, "AGENTS.md"));
    await expect(transfer("pre")).rejects.toThrow(/unsafe staged symlink/);
    expect(await fs.readdir(target)).toEqual([]);
  });
});
