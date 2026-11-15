import { redactStructuredSecrets } from '@octogee/shared/types/secret-redaction';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function conversationText(message: Record<string, unknown>): string {
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  const content = blocks.flatMap(block => {
    const part = record(block);
    let value = block;
    if (part) value = ['text', 'input_text', 'output_text'].includes(String(part.type)) ? part.text : undefined;
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  }).join('\n');
  if (content) return content;
  if (blocks.some(block => ['toolCall', 'toolUse', 'functionCall', 'thinking', 'reasoning', 'redacted_thinking'].includes(String(record(block)?.type)))) return '';
  return typeof message.text === 'string' ? message.text : '';
}

function identityFields(metadata: Record<string, unknown> | undefined): Record<string, string | number> {
  const identity: Record<string, string | number> = {};
  for (const key of ['id', 'runId', 'idempotencyKey', 'mirrorOrigin']) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) identity[key] = value;
  }
  if (typeof metadata?.seq === 'number' && Number.isSafeInteger(metadata.seq) && metadata.seq > 0) identity.seq = metadata.seq;
  return identity;
}

export function activityConversationMessage(value: unknown): Record<string, unknown> | undefined {
  const message = record(value);
  const metadata = record(message?.__openclaw);
  if (!message || !['user', 'assistant'].includes(String(message.role)) || message.phase === 'commentary'
    || message.openclawStreamFallback || metadata?.importedFrom || metadata?.cliSessionId || metadata?.externalId) return undefined;
  if (!Number.isFinite(message.timestamp)) return undefined;
  const content = conversationText(message);
  if (!content.trim()) return undefined;
  const safeText = redactStructuredSecrets({ text: content }) as { text: string };
  return { role: message.role, content: safeText.text.slice(0, 4000), timestamp: message.timestamp,
    ...identityFields({ idempotencyKey: message.idempotencyKey }),
    ...(message.api === 'cli' ? { api: 'cli' } : {}), __openclaw: identityFields(metadata) };
}
