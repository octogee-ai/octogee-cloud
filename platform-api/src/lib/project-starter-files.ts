import type { ProjectRecipeId } from "@octogee/shared/types/project";

export const PROJECT_STARTER_MAX_LENGTH = 64;
export const PROJECT_STARTER_FILES_MAX_COUNT = 200;
export const PROJECT_STARTER_FILES_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_STARTER_FILE_PATH_MAX_LENGTH = 200;

const PROJECT_STARTER_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export interface ProjectStarterFilesRequest {
  uid: string;
  workspaceId: string;
  projectSlug: string;
  projectType: string | null;
  recipe: ProjectRecipeId;
  starter: string | null;
}

export interface ProjectStarterFile {
  path: string;
  content: string;
  encoding?: "base64";
}

export type ProjectStarterFiles = (
  request: ProjectStarterFilesRequest,
) => Promise<ProjectStarterFile[] | null>;

export const PLATFORM_RECIPE_STARTER_FILES: ProjectStarterFiles = async () => null;

let active: ProjectStarterFiles = PLATFORM_RECIPE_STARTER_FILES;

export function installProjectStarterFiles(starterFiles: ProjectStarterFiles): void {
  active = starterFiles;
}

export function projectStarterFiles(): ProjectStarterFiles {
  return active;
}

export type ProjectStarterFilesOutcome =
  | { ok: true; files: ProjectStarterFile[] | null }
  | { ok: false; error: string };

export async function requestProjectStarterFiles(
  request: ProjectStarterFilesRequest,
): Promise<ProjectStarterFilesOutcome> {
  let files: ProjectStarterFile[] | null;
  try {
    files = await active(request);
  } catch (error) {
    return { ok: false, error: `starter files could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (files === null) return { ok: true, files: null };
  const problem = projectStarterFilesProblem(files);
  return problem ? { ok: false, error: `starter files are invalid: ${problem}` } : { ok: true, files };
}

export function isValidProjectStarter(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= PROJECT_STARTER_MAX_LENGTH
    && PROJECT_STARTER_PATTERN.test(value);
}

export function projectStarterFilePathProblem(path: string): string | null {
  if (path.length === 0 || path.length > PROJECT_STARTER_FILE_PATH_MAX_LENGTH) {
    return `path must be 1-${PROJECT_STARTER_FILE_PATH_MAX_LENGTH} characters`;
  }
  for (const segment of path.split("/")) {
    if (!PATH_SEGMENT_PATTERN.test(segment)) return "path must be relative and use letters, digits, '.', '_' and '-'";
    if (segment === "." || segment === "..") return "path must not contain '.' or '..' segments";
    if (segment.toLowerCase() === ".git") return "path must not reach into .git";
  }
  return null;
}

function starterFileBytes(file: ProjectStarterFile): number {
  return file.encoding === "base64"
    ? Buffer.byteLength(file.content, "base64")
    : Buffer.byteLength(file.content, "utf8");
}

function starterFileProblem(value: unknown, index: number): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `starter file ${index} must be an object`;
  const file = value as Record<string, unknown>;
  const unknownKey = Object.keys(file).find((key) => key !== "path" && key !== "content" && key !== "encoding");
  if (unknownKey) return `starter file ${index} has an unknown field ${unknownKey}`;
  if (typeof file.path !== "string") return `starter file ${index} path must be text`;
  const pathProblem = projectStarterFilePathProblem(file.path);
  if (pathProblem) return `starter file ${file.path}: ${pathProblem}`;
  if (typeof file.content !== "string") return `starter file ${file.path} content must be text`;
  if (file.encoding !== undefined && file.encoding !== "base64") {
    return `starter file ${file.path} encoding must be base64 when given`;
  }
  if (file.encoding === "base64" && !BASE64_PATTERN.test(file.content)) {
    return `starter file ${file.path} content is not base64`;
  }
  return null;
}

export function projectStarterFilesProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "starter files must be a list";
  if (value.length > PROJECT_STARTER_FILES_MAX_COUNT) {
    return `starter files must number at most ${PROJECT_STARTER_FILES_MAX_COUNT}`;
  }
  const seen = new Set<string>();
  let bytes = 0;
  for (const [index, entry] of value.entries()) {
    const problem = starterFileProblem(entry, index);
    if (problem) return problem;
    const file = entry as ProjectStarterFile;
    if (seen.has(file.path)) return `starter file ${file.path} is listed twice`;
    seen.add(file.path);
    bytes += starterFileBytes(file);
    if (bytes > PROJECT_STARTER_FILES_MAX_BYTES) {
      return `starter files must total at most ${PROJECT_STARTER_FILES_MAX_BYTES} bytes`;
    }
  }
  return null;
}
