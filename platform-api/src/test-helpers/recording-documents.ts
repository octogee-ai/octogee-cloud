export interface DocumentWrite {
  readonly path: string;
  readonly data: Record<string, unknown> | undefined;
}

export class RecordingDocuments extends Map<string, Record<string, unknown>> {
  readonly writes: DocumentWrite[] = [];

  constructor(seed: Record<string, Record<string, unknown>> = {}) {
    super(Object.entries(seed));
  }

  override set(path: string, data: Record<string, unknown>): this {
    this.writes?.push({ path, data });
    return super.set(path, data);
  }

  override delete(path: string): boolean {
    this.writes.push({ path, data: undefined });
    return super.delete(path);
  }

  writesAt(path: string): DocumentWrite[] {
    return this.writes.filter((write) => write.path === path);
  }
}
