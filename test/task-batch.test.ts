/**
 * TaskUpdate `updates` and TaskGet `taskIds` at the tool boundary. TaskCreate's
 * `tasks` is covered in task-create.test.ts.
 *
 * The common turn boundary is "finish one task, start the next" — two calls
 * without a batch. What matters here is that a batch does exactly what the
 * equivalent run of single calls would, and that a malformed one changes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { mockCtx, mockPi } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  DEFAULT_TASK_SCOPE: "session-global",
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

let mock: ReturnType<typeof mockPi>;

beforeEach(async () => {
  process.env.PI_TASKS = "off";
  config.current = {};
  mock = mockPi();
  initExtension(mock.pi as any);
  await run("TaskCreate", {
    tasks: [
      { subject: "First", description: "d1" },
      { subject: "Second", description: "d2" },
      { subject: "Third", description: "d3" },
    ],
  });
});

afterEach(() => { delete process.env.PI_TASKS; });

async function run(tool: string, params: Record<string, unknown>): Promise<string> {
  return (await mock.executeTool(tool, params, mockCtx())).content[0].text;
}

describe("TaskUpdate — batch", () => {
  it("finishes one task and starts the next in one call", async () => {
    const result = await run("TaskUpdate", {
      updates: [
        { taskId: "1", status: "completed" },
        { taskId: "2", status: "in_progress" },
      ],
    });

    expect(result).toBe("Updated task #1 status\nUpdated task #2 status");
    const list = await run("TaskList", {});
    expect(list).toContain("#1 [completed] First");
    expect(list).toContain("#2 [in_progress] Second");
  });

  it("applies entries in order, so later ones can build on earlier ones", async () => {
    await run("TaskUpdate", {
      updates: [
        { taskId: "2", addBlockedBy: ["1"] },
        { taskId: "3", addBlockedBy: ["2"] },
      ],
    });

    expect(await run("TaskGet", { taskId: "3" })).toContain("Blocked by: #2");
  });

  it("reports a missing task on its own line and still applies the rest", async () => {
    // Entries are independent: one stale ID should not cost the model the
    // updates that were valid, nor leave it guessing which ones landed.
    const result = await run("TaskUpdate", {
      updates: [
        { taskId: "99", status: "completed" },
        { taskId: "1", status: "completed" },
      ],
    });

    expect(result).toBe("Task #99 not found\nUpdated task #1 status");
    expect(await run("TaskList", {})).toContain("#1 [completed] First");
  });

  it("changes nothing when an entry has no taskId", async () => {
    const result = await run("TaskUpdate", {
      updates: [
        { taskId: "1", status: "completed" },
        { status: "completed" },
      ],
    });

    expect(result).toContain("needs a taskId");
    expect(await run("TaskList", {})).toContain("#1 [pending] First");
  });

  it("reports an empty `updates` instead of silently doing nothing", async () => {
    expect(await run("TaskUpdate", { updates: [] })).toContain("needs a taskId");
  });

  it("still accepts a single update passed directly", async () => {
    expect(await run("TaskUpdate", { taskId: "1", status: "in_progress" }))
      .toBe("Updated task #1 status");
  });
});

describe("TaskGet — batch", () => {
  it("reads several tasks in one call, in the order given", async () => {
    const result = await run("TaskGet", { taskIds: ["3", "1"] });

    const [third, first] = result.split("\n\n");
    expect(third).toMatch(/^Task #3: Third/);
    expect(first).toMatch(/^Task #1: First/);
  });

  it("reports a missing task in place", async () => {
    const result = await run("TaskGet", { taskIds: ["1", "99"] });

    expect(result.split("\n\n")).toEqual([expect.stringMatching(/^Task #1: First/), "Task #99 not found"]);
  });

  it("reports an empty `taskIds` instead of returning nothing", async () => {
    expect(await run("TaskGet", { taskIds: [] })).toContain("needs a taskId");
  });

  it("still accepts a single taskId", async () => {
    expect(await run("TaskGet", { taskId: "2" })).toMatch(/^Task #2: Second\nStatus: pending/);
  });
});
