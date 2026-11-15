

export type ExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  options: { stdio: ["ignore", "pipe", "ignore"] },
) => Buffer;

export interface ProbeOpenClawVersionDeps {
  execFile: ExecFile;
  
  binaryPath: string;
}

export function probeOpenClawVersion(deps: ProbeOpenClawVersionDeps): string {
  try {
    return deps
      .execFile(deps.binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}
