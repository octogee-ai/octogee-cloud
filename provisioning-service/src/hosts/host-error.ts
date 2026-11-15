export type HostErrorKind = "transient" | "terminal";

export class HostError extends Error {
  readonly kind: HostErrorKind;

  constructor(kind: HostErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostError";
    this.kind = kind;
  }
}

export function hostErrorKind(error: unknown): HostErrorKind {
  return error instanceof HostError ? error.kind : "transient";
}

export function hostErrorKindForStatus(status: number): HostErrorKind {
  if (status === 429 || status >= 500) return "transient";
  return status >= 400 ? "terminal" : "transient";
}
