import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();

export function withOperationLogScope<T>(operationId: string, run: () => Promise<T>): Promise<T> {
  return scope.run(operationId, run);
}

function carriesOperationTag(message: string, operationId: string): boolean {
  const token = `op=${operationId}`;
  let from = 0;
  for (;;) {
    const at = message.indexOf(token, from);
    if (at === -1) return false;
    const before = at === 0 ? " " : message[at - 1];
    const after = message[at + token.length] ?? " ";
    if (/\s/u.test(before) && /[\s,;:)]/u.test(after)) return true;
    from = at + token.length;
  }
}

export function operationScopedLog(sink: (message: string) => void): (message: string) => void {
  return (message) => {
    const operationId = scope.getStore();
    sink(operationId !== undefined && !carriesOperationTag(message, operationId) ? `${message} op=${operationId}` : message);
  };
}
