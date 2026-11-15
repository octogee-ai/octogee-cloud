const removalTails = new Map<string, Promise<void>>();

export async function withUserRemoval<T>(slug: string, remove: () => Promise<T>): Promise<T> {
  const previous = removalTails.get(slug) ?? Promise.resolve();
  const current = previous.then(remove);
  const tail = current.then(() => undefined, () => undefined);
  removalTails.set(slug, tail);
  try {
    return await current;
  } finally {
    if (removalTails.get(slug) === tail) removalTails.delete(slug);
  }
}
