import type { WorkspaceProject } from "../platform-state/index.js";
import type { Project } from "@octogee/shared/types/index";
type ProductDocument = Record<string, unknown>;
export declare function projectWithPlatformState(product: ProductDocument, record: WorkspaceProject): Project;
export declare function readProject(workspaceSlug: string, projectSlug: string): Promise<Project | null>;
export {};
