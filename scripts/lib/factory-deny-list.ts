export const DENY_LIST_MODULE = "scripts/lib/factory-deny-list.ts";

export interface DenyRule {
  name: string;
  scope: "identity" | "wording";
  pattern: RegExp;
  accept?: (match: RegExpExecArray, line: string) => boolean;
}

export interface DenyHit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

export const VENDORED_FILES: readonly string[] = [
  "gateway-edge/src/vendor/openclaw-browser-resources/index.ts",
  "gateway-edge/src/vendor/openclaw-browser-resources/LICENSES.txt",
  "gateway-edge/src/vendor/openclaw-browser-resources/provenance.json",
  "charts/monitoring/charts/grafana-13.0.1.tgz",
  "charts/octogee/charts/gitea-12.7.0.tgz",
];

export const THIRD_PARTY_AUTHOR_FILES: readonly string[] = [
  "gateway-edge/src/vendor/openclaw-browser-resources/index.ts",
  "gateway-edge/src/vendor/openclaw-browser-resources/LICENSES.txt",
  "gateway/openclaw-tarball/npm-12.2.1.patch",
];

const PERSONAL_EMAIL_RULE = "personal email";

const NON_PERSONAL_DOMAINS: readonly RegExp[] = [
  /^octogee\.com$/i,
  /^squarepointconsulting\.com$/i,
  /\.(?:test|example|invalid|localhost)$/i,
  /(?:^|\.)example\.(?:com|net|org)$/i,
  /^[a-z0-9-]+\.(?:service|socket|target|timer|mount|slice)$/i,
];

const SERVICE_ACCOUNT_SUFFIX = ".gserviceaccount.com";
const PROJECT_NUMBER_ACCOUNT_HOSTS = new Set(["developer", "cloudbuild", "cloudservices"]);
const GOOGLE_AGENT_PROJECTS = new Set([
  "serverless-robot-prod", "container-engine-robot", "compute-system", "gs-project-accounts", "cloud-ml",
  "dataflow-service-producer-prod", "cloudcomposer-accounts", "cloud-redis", "gcf-admin-robot",
]);

function localPartBefore(line: string, index: number): string {
  let start = index;
  while (start > 0 && /[\w.+-]/.test(line[start - 1])) start -= 1;
  return line.slice(start, index);
}

function serviceAccountVerdict(localPart: string, domain: string): "identity" | "placeholder" {
  const host = domain.toLowerCase().slice(0, -SERVICE_ACCOUNT_SUFFIX.length);
  const numbered = /\d{6,}/.test(localPart);
  if (host === "appspot") return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(localPart) && localPart !== "example" ? "identity" : "placeholder";
  if (PROJECT_NUMBER_ACCOUNT_HOSTS.has(host)) return numbered ? "identity" : "placeholder";
  if (!host.endsWith(".iam")) return "identity";
  const project = host.slice(0, -".iam".length);
  if (project.startsWith("gcp-sa-") || GOOGLE_AGENT_PROJECTS.has(project)) return numbered ? "identity" : "placeholder";
  return project === "example" ? "placeholder" : "identity";
}

function isServiceAccount(match: RegExpExecArray, line: string): boolean {
  const domain = match[0].replace(/^(?:@|%40)/, "");
  return serviceAccountVerdict(localPartBefore(line, match.index), domain) === "identity";
}

function isPartnerName(match: RegExpExecArray, line: string): boolean {
  return !(match[0] === "Studio" && /\bAI $/.test(line.slice(0, match.index)));
}

function isPersonalAddress(match: RegExpExecArray, line: string): boolean {
  if (line.slice(0, match.index).trim() === "") return false;
  let domain = match[0].slice(1);
  while (domain.endsWith(".") || domain.endsWith("-")) domain = domain.slice(0, -1);
  if (domain.toLowerCase().endsWith(SERVICE_ACCOUNT_SUFFIX)) return false;
  const topLevel = domain.split(".").at(-1) ?? "";
  return domain.includes(".") && /^[a-z]{2,}$/i.test(topLevel) && !NON_PERSONAL_DOMAINS.some(pattern => pattern.test(domain));
}

const PRICE_WORDS = new Set(["cost", "costs", "pay", "paid", "price", "priced", "charge", "charged", "worth", "fee", "only", "just", "under", "over", "is", "at"]);
const NON_PRICE_FOLLOWERS = new Set(["and", "or", "then", "else", "is", "in", "do", "limit", "returning", "where"]);

function followsPriceWord(before: string): boolean {
  const opened = /[(~]$/.test(before) ? before.slice(0, -1) : before;
  const trimmed = opened.trimEnd();
  if (trimmed === opened) return false;
  const spaced = trimmed.endsWith(":") ? trimmed.slice(0, -1) : trimmed;
  const word = spaced.split(/[^A-Za-z]/).at(-1) ?? "";
  return word !== "" && PRICE_WORDS.has(word.toLowerCase()) && word !== word.toUpperCase();
}

function precedesWord(after: string): boolean {
  const word = /^ +([a-z]{2,})\b/.exec(after)?.[1];
  return word !== undefined && !NON_PRICE_FOLLOWERS.has(word);
}

function isBusinessMargin(match: RegExpExecArray, line: string): boolean {
  const before = line.slice(0, match.index);
  const after = line.slice(match.index + match[0].length);
  const previous = before.at(-1) ?? "";
  if (previous === "." || previous === "<" || before.endsWith("</") || before.endsWith("--")) return false;
  if (/^-(?:top|bottom|left|right|block|inline|start|end)\b/i.test(after)) return false;
  if (/^\s*\{/.test(after) || /^=["'{]/.test(after)) return false;
  if (/["']/.test(previous) && after.startsWith(previous) && /^\s*:/.test(after.slice(1))) return false;
  if (!/^\s*:/.test(after)) return true;
  const context = before.trimEnd();
  return context !== "" && !/[{;,"'`]$/.test(context);
}

function hasUnit(after: string): boolean {
  return /^\s*(?:\/\s*(?:mo|month|yr|year|hr|hour|day|seat|user)\b|per\b|a (?:month|year)\b)/i.test(after);
}

function isCurrencyPrefixed(before: string): boolean {
  return /\b(?:US|CA|AU|NZ|HK|SG|MX|R)$/i.test(before);
}

function isEscapedPrice(amount: string, before: string, after: string): boolean {
  if (/[\w$\\]$/.test(before) && !isCurrencyPrefixed(before)) return false;
  return amount.length > 2 || hasUnit(after) || followsPriceWord(before);
}

function isPrice(match: RegExpExecArray, line: string): boolean {
  const amount = match[0];
  const before = line.slice(0, match.index);
  const after = line.slice(match.index + amount.length);
  const previous = before.at(-1) ?? "";
  const currencyPrefixed = isCurrencyPrefixed(before);
  if (/^\w/.test(after)) return false;
  if (previous === "\\") return isEscapedPrice(amount, before.slice(0, -1), after);
  if (/[\w$]/.test(previous) && !currencyPrefixed) return false;
  if (amount.length > 2) return true;
  const quoted = /["'`=]/.test(previous);
  if (!quoted && /^\s*[–-]\s*\$?\d/.test(after)) return true;
  if (previous !== "=" && hasUnit(after)) return true;
  if (followsPriceWord(before)) return true;
  return !quoted && previous !== "-" && precedesWord(after);
}

export const DENY_LIST: readonly DenyRule[] = [
  { name: PERSONAL_EMAIL_RULE, scope: "identity", pattern: /@[a-z0-9][a-z0-9.-]*/gi, accept: isPersonalAddress },
  { name: "GCP project number", scope: "identity", pattern: /94934561284/g },
  { name: "service account", scope: "identity", pattern: /(?:@|%40)[a-z0-9][a-z0-9.-]*\.gserviceaccount\.com/gi, accept: isServiceAccount },
  { name: "TEST environment identity", scope: "identity", pattern: /octogee-test(?!er)|-test\.octogee\.com|gke_(?:[a-z0-9-]+_)?[a-z]+-[a-z]+\d/gi },
  { name: "admin host", scope: "identity", pattern: /admin\.octogee/gi },
  { name: "monitoring host", scope: "identity", pattern: /monitoring\.octogee/gi },
  { name: "partner or portfolio name", scope: "identity", pattern: /seven peaks|mountain mama|wild card|\bhobin\b|nucrew/gi },
  { name: "partner or portfolio name", scope: "identity", pattern: /\bDan\b|\bTheos?\b|\bStudio\b/g, accept: isPartnerName },
  { name: "Stripe", scope: "wording", pattern: /\bstripe\b/gi },
  { name: "markup", scope: "wording", pattern: /\bmarkups?\b/gi },
  { name: "margin", scope: "wording", pattern: /\bmargins?\b/gi, accept: isBusinessMargin },
  { name: "trial", scope: "wording", pattern: /\btrials?\b/gi },
  { name: "price", scope: "wording", pattern: /\$\d+(?:[.,]\d+)*[kKmMbB]?/g, accept: isPrice },
  { name: "price", scope: "wording", pattern: /\b\d[\d,]*(?:\.\d+)? ?(?:usd|eur|gbp)\b/gi },
  { name: "price", scope: "wording", pattern: /(?:\d[kmb]?|\$|\}) ?\/mo(?:nth)?\b/gi },
  { name: "price", scope: "wording", pattern: /\b(?:usd|eur|gbp) ?\d/gi },
  { name: "price", scope: "wording", pattern: /[€£¥] ?\d|\d ?[€£¥]/g },
  { name: "price", scope: "wording", pattern: /\b\d[\d,]* (?:dollars|euros|pounds|cents)\b/gi },
];

const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:__tests__|test-setup|fixtures)\//,
  /^tests\//,
  /\.(?:spec|test)\.[cm]?[jt]sx?$/,
  /(?:^|\/)test_[^/]+\.py$/,
];

export function isTestFile(file: string): boolean {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(file));
}

function rulesFor(file: string): readonly DenyRule[] {
  const scoped = VENDORED_FILES.includes(file) ? DENY_LIST.filter(rule => rule.scope === "identity") : DENY_LIST;
  return THIRD_PARTY_AUTHOR_FILES.includes(file) ? scoped.filter(rule => rule.name !== PERSONAL_EMAIL_RULE) : scoped;
}

export function denyListHits(files: ReadonlyMap<string, string>): DenyHit[] {
  const hits: DenyHit[] = [];
  for (const [file, content] of files) {
    if (file === DENY_LIST_MODULE || isTestFile(file)) continue;
    const rules = rulesFor(file);
    content.split("\n").forEach((text, index) => {
      const reported = new Set<string>();
      for (const rule of rules) {
        if (reported.has(rule.name)) continue;
        const match = [...text.matchAll(rule.pattern)].find(candidate => rule.accept?.(candidate, text) ?? true);
        if (!match) continue;
        reported.add(rule.name);
        hits.push({ file, line: index + 1, rule: rule.name, text: match[0] });
      }
    });
  }
  return hits;
}

export function formatRefusal(hits: readonly DenyHit[]): string {
  const lines = hits.map(hit => `  ${hit.file}:${hit.line} ${hit.rule}: ${JSON.stringify(hit.text)}`);
  return `publish refused by the deny list (${hits.length} hits):\n${lines.join("\n")}`;
}
