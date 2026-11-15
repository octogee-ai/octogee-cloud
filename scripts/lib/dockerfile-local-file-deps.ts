import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface DockerfileLocalFileDeps {
  installs: string[];
  missing: string[];
  distDirs: string[];
}

interface CopyEntry {
  container: string;
  source: string;
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

function providedSource(copies: CopyEntry[], container: string): string | undefined {
  for (let index = copies.length - 1; index >= 0; index -= 1) {
    const copy = copies[index];
    if (copy.container === container) return copy.source;
    if (container.startsWith(`${copy.container}/`)) return path.posix.join(copy.source, container.slice(copy.container.length + 1));
  }
  return undefined;
}

function recordCopy(stage: Stage, args: string[], contextDir: string): void {
  const operands = args.filter((arg) => !arg.startsWith("--"));
  if (args.some((arg) => arg.startsWith("--from="))) return;
  const destination = operands.pop();
  if (!destination) return;
  const destinationPath = path.posix.resolve(stage.workdir, destination);
  const intoDirectory = destination.endsWith("/") || destination === "." || operands.length > 1;
  for (const operand of operands) {
    const source = path.posix.normalize(operand.replace(/\*$/, "")).replace(/\/$/, "");
    const sourcePath = path.join(contextDir, source);
    const isDirectory = existsSync(sourcePath) && statSync(sourcePath).isDirectory();
    const container = isDirectory || !intoDirectory ? destinationPath : path.posix.join(destinationPath, path.posix.basename(source));
    stage.copies.push({ container, source });
  }
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
      recordCopy(stage, args, contextDir);
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

function checkInstalls(command: string, stage: Stage, stageName: string, contextDir: string, result: DockerfileLocalFileDeps): void {
  for (const { segment, installDir, packs, omitsDev } of installsIn(command, stage.workdir)) {
    const manifestSource = providedSource(stage.copies, `${installDir}/package.json`);
    if (!manifestSource) continue;
    const description = `${stageName}: ${segment} (${path.posix.dirname(manifestSource)})`;
    result.installs.push(description);
    for (const [name, section, target] of localFileDeps(path.join(contextDir, manifestSource), omitsDev)) {
      const sourceDir = path.posix.join(path.posix.dirname(manifestSource), target);
      const containerDir = path.posix.resolve(installDir, target);
      const required = packs && existsSync(path.join(contextDir, sourceDir, "dist")) ? ["package.json", "dist"] : ["package.json"];
      if (required.includes("dist") && !result.distDirs.includes(`${sourceDir}/dist`)) result.distDirs.push(`${sourceDir}/dist`);
      for (const file of required) {
        const container = `${containerDir}/${file}`;
        if (providedSource(stage.copies, container) !== `${sourceDir}/${file}`) {
          result.missing.push(`${description} needs ${name} (${section}): ${sourceDir}/${file} at ${container}`);
        }
      }
    }
  }
}
