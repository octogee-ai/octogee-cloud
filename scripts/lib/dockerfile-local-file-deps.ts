import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface DockerfileLocalFileDeps {
  installs: string[];
  missing: string[];
  distDirs: string[];
}

interface Provided {
  source: string;
  builtInStage: boolean;
}

interface CopyEntry extends Provided {
  container: string;
}

interface Stage {
  workdir: string;
  copies: CopyEntry[];
}

const INSTALL_SECTIONS = ["dependencies", "optionalDependencies", "devDependencies"] as const;

function logicalLines(contents: string): string[] {
  return contents
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function provided(copies: CopyEntry[], container: string): Provided | undefined {
  for (let index = copies.length - 1; index >= 0; index -= 1) {
    const copy = copies[index];
    if (copy.container === container) return { source: copy.source, builtInStage: copy.builtInStage };
    if (container.startsWith(`${copy.container}/`)) {
      return { source: path.posix.join(copy.source, container.slice(copy.container.length + 1)), builtInStage: copy.builtInStage };
    }
  }
  return undefined;
}

function providedSource(copies: CopyEntry[], container: string): string | undefined {
  return provided(copies, container)?.source;
}

function fromStage(from: Stage, stagePath: string): Provided | undefined {
  const copied = provided(from.copies, stagePath);
  if (copied) return copied;
  const manifest = provided(from.copies, path.posix.join(path.posix.dirname(stagePath), "package.json"));
  if (!manifest || manifest.builtInStage) return undefined;
  return { source: path.posix.join(path.posix.dirname(manifest.source), path.posix.basename(stagePath)), builtInStage: true };
}

function recordCopy(stage: Stage, args: string[], contextDir: string, stages: ReadonlyMap<string, Stage>): void {
  const operands = args.filter((arg) => !arg.startsWith("--"));
  const fromName = args.find((arg) => arg.startsWith("--from="))?.slice("--from=".length);
  const from = fromName === undefined ? undefined : stages.get(fromName);
  if (fromName !== undefined && !from) return;
  const destination = operands.pop();
  if (!destination) return;
  const destinationPath = path.posix.resolve(stage.workdir, destination);
  const intoDirectory = destination.endsWith("/") || destination === "." || operands.length > 1;
  for (const operand of operands) {
    const named = path.posix.normalize(operand.replace(/\*$/, "")).replace(/\/$/, "");
    const source = from ? fromStage(from, path.posix.resolve("/", named)) : { source: named, builtInStage: false };
    if (!source) continue;
    const container = isDirectoryCopy(named, source, contextDir) || !intoDirectory
      ? destinationPath
      : path.posix.join(destinationPath, path.posix.basename(named));
    stage.copies.push({ container, ...source });
  }
}

function isDirectoryCopy(named: string, source: Provided, contextDir: string): boolean {
  const sourcePath = path.join(contextDir, source.source);
  return path.posix.basename(named) === "dist" || (existsSync(sourcePath) && statSync(sourcePath).isDirectory());
}

export function dockerfileLocalFileDeps(dockerfilePath: string, contextDir: string): DockerfileLocalFileDeps {
  const result: DockerfileLocalFileDeps = { installs: [], missing: [], distDirs: [] };
  const stages = new Map<string, Stage>();
  let stage: Stage = { workdir: "/", copies: [] };
  let stageName = "";

  for (const line of logicalLines(readFileSync(dockerfilePath, "utf8"))) {
    const [instruction, ...args] = line.split(/\s+/);
    const keyword = instruction.toUpperCase();
    if (keyword === "FROM") {
      const operands = args.filter((arg) => !arg.startsWith("--"));
      const parent = stages.get(operands[0]);
      stage = parent ? { workdir: parent.workdir, copies: [...parent.copies] } : { workdir: "/", copies: [] };
      stageName = operands[2] ?? operands[0];
      stages.set(stageName, stage);
    } else if (keyword === "WORKDIR") {
      stage.workdir = path.posix.resolve(stage.workdir, args[0]);
    } else if (keyword === "COPY" || keyword === "ADD") {
      recordCopy(stage, args, contextDir, stages);
    } else if (keyword === "RUN") {
      checkInstalls(args.join(" "), stage, stageName, contextDir, result);
    }
  }
  return result;
}

interface Install {
  segment: string;
  installDir: string;
  packs: boolean;
  omitsDev: boolean;
}

function installsIn(command: string, workdir: string): Install[] {
  const installs: Install[] = [];
  let cwd = workdir;
  for (const segment of command.split(/&&|;/).map((part) => part.trim())) {
    const cd = segment.match(/^cd\s+(\S+)$/);
    if (cd) cwd = path.posix.resolve(cwd, cd[1]);
    const install = segment.match(/\bnpm\s+(ci|install)\b/);
    if (!install || /\s(--global|-g)\b/.test(segment)) continue;
    const prefix = segment.match(/--prefix[=\s]+(\S+)/);
    installs.push({
      segment,
      installDir: prefix ? path.posix.resolve(cwd, prefix[1]) : cwd,
      packs: install[1] === "ci",
      omitsDev: /--omit[=\s]+dev\b/.test(segment),
    });
  }
  return installs;
}

function localFileDeps(manifestPath: string, omitsDev: boolean): Array<[string, string, string]> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Record<string, string> | undefined>;
  const sections = omitsDev ? INSTALL_SECTIONS.filter((section) => section !== "devDependencies") : INSTALL_SECTIONS;
  return sections.flatMap((section) => Object.entries(manifest[section] ?? {})
    .filter(([, spec]) => spec.startsWith("file:"))
    .map(([name, spec]): [string, string, string] => [name, section, spec.slice("file:".length)]));
}

function publishesDist(manifestPath: string): boolean {
  const files = (JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: string[] }).files ?? [];
  return files.some((file) => file.replace(/\/$/, "") === "dist");
}

function checkInstalls(command: string, stage: Stage, stageName: string, contextDir: string, result: DockerfileLocalFileDeps): void {
  for (const { segment, installDir, packs, omitsDev } of installsIn(command, stage.workdir)) {
    const manifestSource = providedSource(stage.copies, `${installDir}/package.json`);
    if (!manifestSource) continue;
    const description = `${stageName}: ${segment} (${path.posix.dirname(manifestSource)})`;
    result.installs.push(description);
    for (const [name, section, target] of localFileDeps(path.join(contextDir, manifestSource), omitsDev)) {
      const sourceDir = path.posix.join(path.posix.dirname(manifestSource), target);
      const containerDir = path.posix.resolve(installDir, target);
      const required = packs && publishesDist(path.join(contextDir, sourceDir, "package.json")) ? ["package.json", "dist"] : ["package.json"];
      const builtDist = provided(stage.copies, `${containerDir}/dist`)?.builtInStage === true;
      if (required.includes("dist") && !builtDist && !result.distDirs.includes(`${sourceDir}/dist`)) result.distDirs.push(`${sourceDir}/dist`);
      for (const file of required) {
        const container = `${containerDir}/${file}`;
        if (providedSource(stage.copies, container) !== `${sourceDir}/${file}`) {
          result.missing.push(`${description} needs ${name} (${section}): ${sourceDir}/${file} at ${container}`);
        }
      }
    }
  }
}
