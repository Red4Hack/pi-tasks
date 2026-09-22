/**
 * task-cleanup.ts — Retire session task files nobody will open again.
 *
 * A session file outlives the session that wrote it. It is deleted when its list
 * empties, so an interrupted session, a crash, or a list left half-done strands
 * one forever — and they accumulate silently, one per session, in whichever
 * directory the scope pointed at.
 *
 * Two rules retire a file, both conservative:
 *
 *   - **Orphaned** — pi no longer holds a transcript for that session, so nothing
 *     can resume it and read the tasks back.
 *   - **Aged out** — untouched for longer than the retention window.
 *
 * The session running right now is never swept, and neither is `project` scope's
 * shared `tasks.json`, which belongs to no session at all.
 */

import { readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { globalSessionTasksDir, workspaceSessionTasksDir } from "./task-paths.js";

/** Days a session task file is kept after its last write. `0` disables the sweep. */
export const DEFAULT_TASK_FILE_RETENTION_DAYS = 14;

const DAY_MS = 86_400_000;

/** `tasks-<sessionId>.json`, the name every session file has had. Deliberately does
 *  not match `tasks.json`: that one is `project` scope's shared list. */
const SESSION_FILE = /^tasks-(.+)\.json$/;

/** Sessions pi still holds a transcript for, read from the session directory it
 *  reported for this workspace (`<timestamp>_<sessionId>.jsonl`).
 *
 *  Undefined when that cannot be established — no directory, an unreadable one, or
 *  an empty one. The orphan rule is then skipped rather than guessed at, since
 *  guessing wrong deletes every task file the workspace has. */
function liveSessionIds(sessionDir: string | undefined): Set<string> | undefined {
  if (!sessionDir) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  const ids = new Set<string>();
  for (const name of entries) {
    const match = /_([^_]+)\.jsonl$/.exec(name);
    if (match) ids.add(match[1]);
  }
  return ids.size > 0 ? ids : undefined;
}

export interface SweepOptions {
  /** Workspace whose task files are being swept. */
  cwd: string;
  /** Where pi keeps this workspace's transcripts, for the orphan rule. */
  sessionDir?: string;
  /** The running session — never swept, however old its file is. */
  keepSessionId?: string;
  retentionDays?: number;
}

/**
 * Sweep both places session files are kept for one workspace: the in-repository
 * `session` directory and the out-of-tree `session-global` one. Both are visited
 * whatever the active scope is — a file left by the scope in force last month is
 * exactly what this is here to collect.
 *
 * Returns how many files were deleted.
 */
export function sweepSessionTaskFiles(options: SweepOptions): number {
  const retentionDays = options.retentionDays ?? DEFAULT_TASK_FILE_RETENTION_DAYS;
  if (retentionDays <= 0) return 0;
  const live = liveSessionIds(options.sessionDir);
  const expiry = Date.now() - retentionDays * DAY_MS;
  let total = 0;

  for (const dir of [workspaceSessionTasksDir(options.cwd), globalSessionTasksDir(options.cwd)]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    let deleted = 0;
    for (const name of entries) {
      const sessionId = SESSION_FILE.exec(name)?.[1];
      if (!sessionId || sessionId === options.keepSessionId) continue;
      const path = join(dir, name);
      let lastWrite: number;
      try {
        lastWrite = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (lastWrite > expiry && (!live || live.has(sessionId))) continue;
      // The lock and temp files beside it belong to a writer that is long gone.
      for (const target of [path, `${path}.lock`, `${path}.tmp`]) {
        try { unlinkSync(target); } catch { /* not there */ }
      }
      deleted++;
    }
    // Reclaimed only when this sweep emptied it: rmdir fails on a directory that
    // still holds anything, which is what keeps other files safe.
    if (deleted > 0) {
      try { rmdirSync(dir); } catch { /* still in use */ }
      total += deleted;
    }
  }

  return total;
}
