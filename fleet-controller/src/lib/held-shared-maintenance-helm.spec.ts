import { expect, it } from "vitest";
import { alignMaintenanceTemplate, verifyMaintenanceManifest } from "./held-shared-maintenance-helm.js";

const ref = (name: string, version: string) => `registry/${name}:${version}-oc1@sha256:${version[0]!.repeat(64)}`;
const images = (v: string) => ({ gateway: ref("gateway",v), "gateway-edge": ref("edge",v) });
const old = images("aaa1111"), next = images("bbb2222");
function template(i = old) {
  return {metadata:{labels:{"gateway-image":i.gateway.split(":")[1]!.slice(0,7),owner:"all"}},spec:{
    initContainers:[{name:"fix-perms",image:i.gateway}],
    containers:[{name:"gateway",image:i.gateway,env:[{name:"GATEWAY_IMAGE_TAG",value:i.gateway.slice(i.gateway.indexOf(":")+1)}]},
      {name:"gateway-edge",image:i["gateway-edge"]}], volumes:[{name:"data",emptyDir:{}}]}};
}
const manifests = (i = old) => [{kind:"Deployment",metadata:{name:"deployment"},spec:{template:template(i)}},
  {kind:"Service",metadata:{name:"edge"},spec:{selector:{owner:"all"}}}];
it("limits the accepted Helm delta to the two images, init, version environment and image label",()=>{
  expect(()=>verifyMaintenanceManifest(manifests(),manifests(next),"deployment",old,next)).not.toThrow();
  const changed=manifests(next);
  changed[1]!.spec.selector!.owner="other";
  expect(()=>verifyMaintenanceManifest(manifests(),changed,"deployment",old,next)).toThrow(/unexpected/i);
});
it("aligns the existing ReplicaSet template while preserving its Kubernetes hash and injected configuration",()=>{
  const rs=template(), deployment=template(next);
  Object.assign(rs.metadata.labels,{"pod-template-hash":"original"});
  for (const value of [rs,deployment]) Object.assign(value.spec,{nodeSelector:{injected:"yes"}});
  const merged=alignMaintenanceTemplate(rs,deployment,old,next);
  expect(merged.metadata.labels["pod-template-hash"]).toBe("original");
  expect(merged.spec.nodeSelector).toEqual({injected:"yes"});
  Object.assign(deployment.spec,{volumes:[]});
  expect(()=>alignMaintenanceTemplate(rs,deployment,old,next)).toThrow(/unexpected/i);
});
