export type StampResult =
  | { stamped: true; configPath: string }
  | { stamped: false; reason: "no-credentials" | "already-stamped" };

export function readClaudeVersion(opts?: { claudeBin?: string }): string | null;

export function stampFirstRun(opts?: {
  home?: string;
  claudeVersion?: string | null;
  claudeConfigDir?: string;
}): StampResult;
