import { containsAsciiControlCharacter } from '@octogee/shared/types/text-validation';
export function browserRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function text(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !containsAsciiControlCharacter(value); }
function number(value: unknown, max = 16384): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max; }
type BrowserBody = Record<string, unknown>;
const ACT_BASE = ['kind', 'targetId'];
const ACT_VALIDATORS: Record<string, (body: BrowserBody) => boolean> = {
  clickCoords: body => exact(body, [...ACT_BASE, 'x', 'y', 'doubleClick']) && number(body.x) && number(body.y) && (body.doubleClick === undefined || typeof body.doubleClick === 'boolean'),
  press: body => exact(body, [...ACT_BASE, 'key']) && text(body.key, 128),
  insertText: body => exact(body, [...ACT_BASE, 'text']) && typeof body.text === 'string' && body.text.length <= 65536,
  resize: body => exact(body, [...ACT_BASE, 'width', 'height']) && number(body.width) && number(body.height),
  evaluate: body => exact(body, [...ACT_BASE, 'fn']) && typeof body.fn === 'string' && body.fn.length > 0 && body.fn.length <= 65536,
};
function actionValid(body: BrowserBody): boolean {
  return typeof body.kind === 'string' && Object.hasOwn(ACT_VALIDATORS, body.kind) && ACT_VALIDATORS[body.kind](body);
}
const TARGET_VALIDATORS: Record<string, (body: BrowserBody) => boolean> = {
  '/tabs/focus': body => exact(body, ['targetId']),
  '/screenshot': body => exact(body, ['targetId', 'type']) && (body.type === undefined || body.type === 'png' || body.type === 'jpeg'),
  '/screencast': body => exact(body, ['targetId', 'maxWidth', 'maxHeight']) && number(body.maxWidth) && number(body.maxHeight),
  '/download': body => exact(body, ['targetId', 'currentDocument', 'expectedUrl', 'timeoutMs']) && body.currentDocument === true && text(body.expectedUrl, 8192) && number(body.timeoutMs, 120000),
  '/act': actionValid,
};
function bodyValid(path: string, body: BrowserBody, profile: string): boolean {
  switch (path) {
    case '/control': return exact(body, ['profile', 'control']) && (body.profile === undefined || body.profile === profile) && typeof body.control === 'boolean';
    case '/start': return exact(body, []);
    case '/tabs/open': return exact(body, ['url']) && text(body.url, 8192);
    case '/navigate': return exact(body, ['url', 'targetId']) && text(body.url, 8192) && (body.targetId === undefined || text(body.targetId));
    default: return text(body.targetId) && Object.hasOwn(TARGET_VALIDATORS, path) && TARGET_VALIDATORS[path](body);
  }
}
function operationValid(params: BrowserBody, profile: string): boolean {
  switch (params.method) {
    case 'GET': return ['/tabs', '/control'].includes(String(params.path)) && params.body === undefined;
    case 'DELETE': return typeof params.path === 'string' && /^\/tabs\/[a-zA-Z0-9_-]{1,256}$/u.test(params.path) && params.body === undefined;
    case 'POST': {
      const body = browserRecord(params.body);
      return typeof params.path === 'string' && body !== null && bodyValid(params.path, body, profile);
    }
    default: return false;
  }
}
interface BrowserScope {
  sessionKey: string;
  referencedTabs: ReadonlyMap<string, { target: 'host'; profile: string; targetId: string }>;
}
function browserTabScope(value: unknown, listTabs: boolean, profile: string, binding: BrowserScope): Record<string, unknown> {
  const scope = value === undefined ? { sessionKey: binding.sessionKey } : browserRecord(value);
  if (!scope || !exact(scope, listTabs ? ['sessionKey', 'referencedTabs'] : ['sessionKey']) || scope.sessionKey !== binding.sessionKey) {
    throw new Error('Browser session does not match');
  }
  if (!listTabs) return { sessionKey: binding.sessionKey };
  const references = scope.referencedTabs === undefined ? [] : scope.referencedTabs;
  if (!Array.isArray(references) || references.length > 64) throw new Error('Invalid Browser tab references');
  const referencedTabs = references.map(value => {
    const tab = browserRecord(value);
    if (!tab || !exact(tab, ['target', 'profile', 'targetId']) || tab.target !== 'host' ||
      (tab.profile !== undefined && tab.profile !== profile) || !text(tab.targetId)) throw new Error('Invalid Browser tab reference');
    const admitted = binding.referencedTabs.get(tab.targetId);
    if (!admitted || admitted.profile !== profile) throw new Error('Browser tab is not referenced by this session');
    return admitted;
  });
  return { sessionKey: binding.sessionKey, referencedTabs };
}
export function browserRequestParams(value: unknown, profile: string, binding: BrowserScope): Record<string, unknown> {
  const p = browserRecord(value);
  if (!p || !exact(p, ['method', 'path', 'body', 'query', 'target', 'timeoutMs', 'tabScope']) ||
    (p.target !== undefined && p.target !== 'host') ||
    (p.timeoutMs !== undefined && !number(p.timeoutMs, 150000))) throw new Error('Browser operation is unavailable');
  const query = p.query === undefined ? {} : browserRecord(p.query);
  if (!query || !exact(query, ['profile']) || (query.profile !== undefined && query.profile !== profile)) throw new Error('Browser profile does not match');
  if (!operationValid(p, profile)) throw new Error('Browser operation is unavailable');
  return { ...p, target: 'host', query: { profile }, tabScope: browserTabScope(p.tabScope, p.method === 'GET' && p.path === '/tabs', profile, binding) };
}
export function browserStreamPath(value: unknown): string {
  const result = browserRecord(value);
  if (!result || !text(result.token, 256) || typeof result.wsPath !== 'string' || !result.wsPath.startsWith('/browser/screencast?')) throw new Error('Invalid native Browser stream');
  const url = new URL(result.wsPath, 'http://localhost');
  if (url.pathname !== '/browser/screencast' || url.searchParams.get('token') !== result.token || [...url.searchParams.keys()].join(',') !== 'token' || url.hash) throw new Error('Invalid native Browser stream');
  return result.wsPath;
}
