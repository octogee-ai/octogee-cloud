import { createBrokeredProjectBlobHydrator as createHydrator, type ProjectBlobHydrationClient } from "@octogee/core/project-blob-materialization";
import { CUSTOMERS_DIR } from "./config.js";
export type { ProjectBlobHydration, ProjectBlobHydrator } from "@octogee/core/project-blob-materialization";

export function createBrokeredProjectBlobHydrator(client: ProjectBlobHydrationClient) {
  return createHydrator(client, CUSTOMERS_DIR);
}
