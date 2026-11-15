// Board write convention — mirrors the app's lib/board/columns.ts column model.
// Open issues live in a status:* label column (backlog = absence of a status
// label); closed issues are Done. So backlog and done carry no status label.
export const STATUS_PREFIX = "status:";

export type ColumnKey = "backlog" | "todo" | "doing" | "review" | "done";
const COLUMNS: ColumnKey[] = ["backlog", "todo", "doing", "review", "done"];
const LABELED_COLUMNS: ColumnKey[] = ["todo", "doing", "review"];

export interface LabelSeed {
  name: string;
  color: string;
}

export const STATUS_LABEL_SEED: LabelSeed[] = [
  { name: "status:todo", color: "c5def5" },
  { name: "status:doing", color: "fbca04" },
  { name: "status:review", color: "d4c5f9" },
];

export function isValidColumn(key: string): key is ColumnKey {
  return (COLUMNS as string[]).includes(key);
}

export function labelForColumn(key: ColumnKey): string | null {
  return LABELED_COLUMNS.includes(key) ? `${STATUS_PREFIX}${key}` : null;
}

export function statusLabelsOn(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith(STATUS_PREFIX));
}

export function targetState(key: ColumnKey): "open" | "closed" {
  return key === "done" ? "closed" : "open";
}

// Non-status labels a user can apply from the Board. `bug` matches Pulse's
// bug-backlog counter; the rest mirror GitHub's default label vocabulary.
export const KNOWN_LABEL_SEED: LabelSeed[] = [
  { name: "bug", color: "d73a4a" },
  { name: "enhancement", color: "a2eeef" },
  { name: "chore", color: "cfd3d7" },
];

const DEFAULT_LABEL_COLOR = "ededed";
const LABEL_NAME_RE = /^[^\s,][^,]{0,49}$/;

export function seedForLabel(name: string): LabelSeed {
  return KNOWN_LABEL_SEED.find((seed) => seed.name === name) ?? { name, color: DEFAULT_LABEL_COLOR };
}

export function isValidLabelName(name: string): boolean {
  return LABEL_NAME_RE.test(name) && !name.startsWith(STATUS_PREFIX);
}

// A label edit replaces only the editable (non-status) labels — the status
// column assignment always survives, deduped and order-preserving.
export function computeLabelReplacement(currentLabels: string[], requested: string[]): string[] {
  const editable = requested.filter(isValidLabelName);
  return [...new Set([...statusLabelsOn(currentLabels), ...editable])];
}

export interface MovePlan {
  remove: string[];
  add: string | null;
  state: "open" | "closed";
}

export function computeMove(currentLabels: string[], target: ColumnKey): MovePlan {
  return {
    remove: statusLabelsOn(currentLabels),
    add: labelForColumn(target),
    state: targetState(target),
  };
}
