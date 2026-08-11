export interface TreeEntry {
  kind: "dir" | "file";
  name: string;
  path: string;
  fileCount: number;
}

export interface Crumb {
  label: string;
  path: string;
}

function childOf(path: string, dir: string): string | null {
  if (!dir) return path;
  const prefix = `${dir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

export function levelOf(paths: readonly string[], dir: string): TreeEntry[] {
  const dirs = new Map<string, number>();
  const files: TreeEntry[] = [];
  for (const path of paths) {
    const rest = childOf(path, dir);
    if (rest === null) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ kind: "file", name: rest, path, fileCount: 0 });
    } else {
      const name = rest.slice(0, slash);
      dirs.set(name, (dirs.get(name) ?? 0) + 1);
    }
  }
  const folders: TreeEntry[] = [...dirs].map(([name, fileCount]) => ({
    kind: "dir",
    name,
    path: dir ? `${dir}/${name}` : name,
    fileCount,
  }));
  const byName = (a: TreeEntry, b: TreeEntry) => a.name.localeCompare(b.name);
  return [...folders.sort(byName), ...files.sort(byName)];
}

export function crumbsOf(dir: string, rootLabel = "workspace"): Crumb[] {
  const crumbs: Crumb[] = [{ label: rootLabel, path: "" }];
  if (!dir) return crumbs;
  const parts = dir.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

export function nearestExistingDir(paths: readonly string[], dir: string): string {
  let candidate = dir;
  while (candidate) {
    if (paths.some((p) => p.startsWith(`${candidate}/`))) return candidate;
    const slash = candidate.lastIndexOf("/");
    candidate = slash === -1 ? "" : candidate.slice(0, slash);
  }
  return "";
}
