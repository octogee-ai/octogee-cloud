import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { _setGatewayTokenReviewerForTests } from "../../middleware/gateway-internal-auth.js";
import { createProjectPersistenceRouter } from "./project-persistence.js";
import { claimedTestUser, installTestUserIdentity } from "../../__tests__/helpers/user-identity.js";
let directory: string;
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),"project-flush-auth-"));
  writeFileSync(join(directory,"token"),"projected-token");
  vi.stubEnv("GATEWAY_CLASS","isolated");installTestUserIdentity(claimedTestUser("alice","builder-one"));
  vi.stubEnv("GATEWAY_PROFILE","isolated");vi.stubEnv("INTERNAL_SERVICE_KEY","");
  vi.stubEnv("GATEWAY_ID","builder-one");vi.stubEnv("K8S_NAMESPACE","octogee-test");
  vi.stubEnv("K8S_SERVICE_ACCOUNT_NAME","octogee-gw-builder-one");
  vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH",join(directory,"token"));
  _setGatewayTokenReviewerForTests(vi.fn(async token=>token === "own-token" ? {authenticated:true as const,namespace:"octogee-test",saName:"octogee-gw-builder-one",audiences:["octogee-api"]}:token === "other-token" ? {authenticated:true as const,namespace:"octogee-test",saName:"octogee-gw-other",audiences:["octogee-api"]}:{authenticated:false as const}));
});
afterEach(()=>{_setGatewayTokenReviewerForTests(null);vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});});
function app(...persist: Parameters<typeof createProjectPersistenceRouter>) {
  const a = express();
  a.use(express.json());
  a.use("/internal/projects", createProjectPersistenceRouter(...persist));
  return a;
}
it("requires this gateway's authenticated identity and user owner",async()=>{
  const persist=vi.fn(async()=>({projects:1}));const a=app(persist);
  expect((await request(a).post("/internal/projects/flush").send({slug:"alice"})).status).toBe(401);
  expect((await request(a).post("/internal/projects/flush").set("x-k8s-sa-token","other-token").send({slug:"alice"})).status).toBe(401);
  expect((await request(a).post("/internal/projects/flush").set("x-k8s-sa-token","own-token").send({slug:"bob"})).status).toBe(403);
  expect(persist).not.toHaveBeenCalled();
});
it("acknowledges only a confirmed save and returns retryable failure otherwise",async()=>{
  const persist=vi.fn(async()=>({projects:2}));const a=app(persist);
  const saved=await request(a).post("/internal/projects/flush").set("x-k8s-sa-token","own-token").send({slug:"alice"});
  expect(saved.status).toBe(200);expect(saved.body).toEqual({projects:2});
  persist.mockRejectedValueOnce(new Error("Gitea unavailable"));
  expect((await request(a).post("/internal/projects/flush").set("x-k8s-sa-token","own-token").send({slug:"alice"})).status).toBe(503);
});


it("checkpoints the whole managed workspace on an ephemeral Hobby gateway under the same owner fence", async () => {
  vi.stubEnv("GATEWAY_EPHEMERAL_HOME", "true");
  const projects = vi.fn(async () => ({ projects: 1 }));
  const managed = vi.fn(async () => ({ projects: 2 }));
  const a = app(projects, managed);
  const route = "/internal/projects/flush";
  expect((await request(a).post(route).set("x-k8s-sa-token", "own-token").send({ slug: "bob" })).status).toBe(403);
  expect(managed).not.toHaveBeenCalled();
  expect((await request(a).post(route).set("x-k8s-sa-token", "own-token").send({ slug: "alice" })).status).toBe(200);
  expect(managed).toHaveBeenCalledOnce();
  expect(managed).toHaveBeenCalledWith(expect.objectContaining({ slug: "alice" }));
  expect(projects).not.toHaveBeenCalled();
});
