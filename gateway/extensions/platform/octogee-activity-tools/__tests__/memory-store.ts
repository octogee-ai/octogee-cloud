import type { ActivityKeyedStore, ActivityStoreEntry } from "../durable-outbox.js";

export class MemoryStore<T> implements ActivityKeyedStore<T> {
  private readonly values = new Map<string, ActivityStoreEntry<T>>();
  private clock = 0;

  async register(key: string, value: T): Promise<void> {
    const existing = this.values.get(key);
    this.values.set(key, { key, value: structuredClone(value), createdAt: existing?.createdAt ?? ++this.clock });
  }

  async registerIfAbsent(key: string, value: T): Promise<boolean> {
    if (this.values.has(key)) return false;
    await this.register(key, value);
    return true;
  }

  async lookup(key: string): Promise<T | undefined> {
    const value = this.values.get(key)?.value;
    return value === undefined ? undefined : structuredClone(value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async entries(): Promise<Array<ActivityStoreEntry<T>>> {
    return [...this.values.values()].map((entry) => structuredClone(entry));
  }
}
