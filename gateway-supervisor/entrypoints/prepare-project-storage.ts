import { pathToFileURL } from "node:url";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { prepareUserProjectStorage } from "../lib/user-project-storage.js";

const OPENCLAW_DIR = "/home/node/.openclaw";

export function projectStorageSlug(env: NodeJS.ProcessEnv): string {
  const slug = userClaimSlug(env);
  if (!slug) {
    throw new Error("project storage preparation requires the user claim the VM agent writes before init");
  }
  return slug;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareUserProjectStorage({
    home: "/home/node",
    projects: "/work/materialized",
    slug: projectStorageSlug({ OPENCLAW_DIR, GATEWAY_ID: process.env.GATEWAY_ID }),
  });
}
