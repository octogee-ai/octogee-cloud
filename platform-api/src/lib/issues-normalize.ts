export type IssueState = "open" | "closed";

export interface WorkspaceIssue {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  closedAt: string | null;
  updatedAt: string;
  url: string;
}

export interface WorkspaceLabel {
  name: string;
  color: string;
}

interface RawNamed {
  name?: unknown;
  login?: unknown;
}

interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  labels?: unknown;
  user?: { login?: unknown } | null;
  assignees?: unknown;
  created_at?: unknown;
  closed_at?: unknown;
  updated_at?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str((v as RawNamed)?.name ?? (v as RawNamed)?.login)).filter((s) => s.length > 0);
}

export function isPullRequest(raw: unknown): boolean {
  return (raw as RawIssue)?.pull_request != null;
}

export function normalizeIssue(raw: unknown): WorkspaceIssue {
  const r = raw as RawIssue;
  const closedAt = str(r.closed_at) || null;
  return {
    number: typeof r.number === "number" ? r.number : 0,
    title: str(r.title),
    body: str(r.body),
    state: r.state === "closed" ? "closed" : "open",
    labels: names(r.labels),
    assignees: names(r.assignees),
    author: str(r.user?.login),
    createdAt: str(r.created_at),
    closedAt,
    updatedAt: str(r.updated_at),
    url: str(r.html_url),
  };
}

export function normalizeIssues(raw: unknown): WorkspaceIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => !isPullRequest(item)).map(normalizeIssue);
}

export interface WorkspaceComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

interface RawComment {
  id?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  created_at?: unknown;
}

export function normalizeComment(raw: unknown): WorkspaceComment {
  const r = raw as RawComment;
  return {
    id: typeof r.id === "number" ? r.id : 0,
    body: str(r.body),
    author: str(r.user?.login),
    createdAt: str(r.created_at),
  };
}

export function normalizeComments(raw: unknown): WorkspaceComment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeComment).filter((c) => c.id > 0);
}

export function normalizeLabel(raw: unknown): WorkspaceLabel {
  const r = raw as { name?: unknown; color?: unknown };
  return { name: str(r.name), color: str(r.color) };
}

export function normalizeLabels(raw: unknown): WorkspaceLabel[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeLabel).filter((l) => l.name.length > 0);
}
