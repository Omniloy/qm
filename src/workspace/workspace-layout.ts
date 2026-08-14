import { TURN_FILES_DIR } from "../core/attachments.ts";
import { SKILLS_DIR } from "../skills/materialization-paths.ts";
import { RO_LAYERS_MANIFEST } from "../sandbox/ro-layers.ts";
import { carriesGitMetadata } from "../deploy/deploy-fs.ts";

export const ORG_MOUNT_PATH = "global";

export function teamMountPath(teamId: string): string {
  return `team-${teamId}`;
}

const TEAM_MOUNT_PREFIX = teamMountPath("");

const NOISE_DIRS = new Set(["node_modules", "__pycache__", ".venv", "venv"]);

export function normalizeWorkspacePath(path: string): string | null {
  const segments = path.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    out.push(segment);
  }
  return out.length ? out.join("/") : null;
}

function isMountedLayerDir(segment: string): boolean {
  return (
    segment === ORG_MOUNT_PATH || (segment.startsWith(TEAM_MOUNT_PREFIX) && segment.length > TEAM_MOUNT_PREFIX.length)
  );
}

export function hiddenWorkspaceReason(path: string): "mount" | "machine" | null {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === null) return "machine";
  const segments = normalized.split("/");
  const head = segments[0]!;
  if (isMountedLayerDir(head)) return "mount";
  if (head === TURN_FILES_DIR || head === SKILLS_DIR || normalized === RO_LAYERS_MANIFEST) return "machine";
  if (carriesGitMetadata(normalized) || segments.some((s) => NOISE_DIRS.has(s))) return "machine";
  return null;
}

export function isHiddenWorkspacePath(path: string): boolean {
  return hiddenWorkspaceReason(path) !== null;
}
