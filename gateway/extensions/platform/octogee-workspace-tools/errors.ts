export type WorkspaceToolErrorCode =
  | "no-agent"
  | "not-coach"
  | "control-error"
  | "bad-response";

export class WorkspaceToolError extends Error {
  constructor(
    public readonly code: WorkspaceToolErrorCode,
    message: string,
    public readonly edgeCode?: string,
    public readonly paths?: string[],
  ) {
    super(message);
    this.name = "WorkspaceToolError";
  }
}
