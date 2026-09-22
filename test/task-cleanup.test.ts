/**
 * Retiring session task files nobody will open again.
 *
 * The sweep deletes data the user never asked it to delete, so every test here is
 * really about what it must *not* touch: the running session, a shared project
 * list, a file whose session pi can still resume, and anything at all when the
 * session directory cannot be read.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TASK_FILE_RETENTION_DAYS, sweepSessionTaskFiles } from "../src/task-cleanup.js";
import { globalSessionTasksDir, workspaceSessionTasksDir } from "../src/task-paths.js";

const DAY_MS = 86_400_000;

let cwd: string;
let sessionDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-tasks-sweep-"));
  sessionDir = mkdtempSync(join(tmpdir(), "pi-tasks-sessions-"));
});

afterEach(() => {
  rmSync(globalSessionTasksDir(cwd), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

/** A task file for one session, optionally backdated by `ageDays`. */
function taskFile(dir: string, sessionId: string, ageDays = 0): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `tasks-${sessionId}.json`);
  writeFileSync(path, JSON.stringify({ nextId: 1, tasks: [] }));
  if (ageDays > 0) {
    const when = (Date.now() - ageDays * DAY_MS) / 1000;
    utimesSync(path, when, when);
  }
  return path;
}

/** A pi transcript, named the way pi names them: `<timestamp>_<sessionId>.jsonl`. */
function transcript(sessionId: string): void {
  writeFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`), "");
}

describe("sweepSessionTaskFiles", () => {
  it("deletes a file whose session pi no longer has a transcript for", () => {
    transcript("live");
    const orphan = taskFile(workspaceSessionTasksDir(cwd), "gone");
    const kept = taskFile(workspaceSessionTasksDir(cwd), "live");

    expect(sweepSessionTaskFiles({ cwd, sessionDir })).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("deletes a file untouched for longer than the retention window", () => {
    transcript("old");
    transcript("recent");
    const old = taskFile(workspaceSessionTasksDir(cwd), "old", DEFAULT_TASK_FILE_RETENTION_DAYS + 1);
    const recent = taskFile(workspaceSessionTasksDir(cwd), "recent", DEFAULT_TASK_FILE_RETENTION_DAYS - 1);

    expect(sweepSessionTaskFiles({ cwd, sessionDir })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("never sweeps the running session, however old its file is", () => {
    // The session being resumed right now has a file older than the window by
    // definition — it was written the last time it ran.
    const current = taskFile(workspaceSessionTasksDir(cwd), "current", DEFAULT_TASK_FILE_RETENTION_DAYS + 30);

    expect(sweepSessionTaskFiles({ cwd, sessionDir, keepSessionId: "current" })).toBe(0);
    expect(existsSync(current)).toBe(true);
  });

  it("leaves project scope's shared list alone", () => {
    // tasks.json belongs to no session, so neither rule can speak for it: it is
    // the list a whole workspace shares, and nothing here is entitled to it.
    const dir = workspaceSessionTasksDir(cwd);
    mkdirSync(dir, { recursive: true });
    const shared = join(dir, "tasks.json");
    writeFileSync(shared, JSON.stringify({ nextId: 1, tasks: [] }));
    utimesSync(shared, 0, 0);

    expect(sweepSessionTaskFiles({ cwd, sessionDir })).toBe(0);
    expect(existsSync(shared)).toBe(true);
  });

  it("skips the orphan rule when the session directory cannot be read", () => {
    // A custom session directory, or one pi has not created yet, looks empty from
    // here. Treating that as "no session is live" would delete every task file the
    // workspace has, so the age rule is left to work alone.
    const fresh = taskFile(workspaceSessionTasksDir(cwd), "s1");

    expect(sweepSessionTaskFiles({ cwd, sessionDir: join(sessionDir, "nope") })).toBe(0);
    expect(sweepSessionTaskFiles({ cwd })).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it("still ages out files when the session directory cannot be read", () => {
    const old = taskFile(workspaceSessionTasksDir(cwd), "s1", DEFAULT_TASK_FILE_RETENTION_DAYS + 1);

    expect(sweepSessionTaskFiles({ cwd })).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it("sweeps both scopes, whichever one is configured now", () => {
    // A file left by the scope in force last month is exactly what this collects.
    transcript("live");
    const inWorkspace = taskFile(workspaceSessionTasksDir(cwd), "gone-a");
    const inAgentDir = taskFile(globalSessionTasksDir(cwd), "gone-b");

    expect(sweepSessionTaskFiles({ cwd, sessionDir })).toBe(2);
    expect(existsSync(inWorkspace)).toBe(false);
    expect(existsSync(inAgentDir)).toBe(false);
  });

  it("removes the lock and temp files left beside a swept file", () => {
    transcript("live");
    const orphan = taskFile(workspaceSessionTasksDir(cwd), "gone");
    writeFileSync(`${orphan}.lock`, "999999");
    writeFileSync(`${orphan}.tmp`, "{}");

    sweepSessionTaskFiles({ cwd, sessionDir });

    expect(existsSync(`${orphan}.lock`)).toBe(false);
    expect(existsSync(`${orphan}.tmp`)).toBe(false);
  });

  it("reclaims the global directory it emptied", () => {
    transcript("live");
    taskFile(globalSessionTasksDir(cwd), "gone");

    sweepSessionTaskFiles({ cwd, sessionDir });

    expect(existsSync(globalSessionTasksDir(cwd))).toBe(false);
  });

  it("leaves a directory standing while anything is still in it", () => {
    transcript("live");
    taskFile(globalSessionTasksDir(cwd), "gone");
    const kept = taskFile(globalSessionTasksDir(cwd), "live");

    sweepSessionTaskFiles({ cwd, sessionDir });

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(globalSessionTasksDir(cwd))).toBe(true);
  });

  it("does nothing at all when retention is disabled", () => {
    transcript("live");
    const orphan = taskFile(workspaceSessionTasksDir(cwd), "gone", 365);

    expect(sweepSessionTaskFiles({ cwd, sessionDir, retentionDays: 0 })).toBe(0);
    expect(existsSync(orphan)).toBe(true);
  });

  it("honours a configured retention window", () => {
    transcript("s1");
    const old = taskFile(workspaceSessionTasksDir(cwd), "s1", 2);

    expect(sweepSessionTaskFiles({ cwd, sessionDir, retentionDays: 1 })).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it("is a no-op on a workspace that has never stored a task file", () => {
    expect(sweepSessionTaskFiles({ cwd, sessionDir })).toBe(0);
  });
});
