export type HostErrorKind = "transient" | "terminal";

export type HostErrorCode = "key-held-elsewhere";

export class HostError extends Error {
  readonly kind: HostErrorKind;
  readonly code: HostErrorCode | undefined;

  constructor(kind: HostErrorKind, message: string, options?: { cause?: unknown; code?: HostErrorCode }) {
    super(message, options);
    this.name = "HostError";
    this.kind = kind;
    this.code = options?.code;
  }
}

export function hostErrorKind(error: unknown): HostErrorKind {
  return error instanceof HostError ? error.kind : "transient";
}

export function hostErrorKindForStatus(status: number): HostErrorKind {
  if (status === 429 || status >= 500) return "transient";
  return status >= 400 ? "terminal" : "transient";
}
