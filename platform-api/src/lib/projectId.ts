export interface ProjectIdParts {
  wid: string;
  pid: string;
}

export function decomposeProjectId(id: string): ProjectIdParts | null {
  const idx = id.indexOf("_");
  if (idx < 1 || idx === id.length - 1) return null;
  return { wid: id.slice(0, idx), pid: id.slice(idx + 1) };
}

