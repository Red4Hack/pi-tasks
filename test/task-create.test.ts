/**
 * TaskCreate at the tool boundary: the `tasks` array, the single-task shape it
 * replaced, and the fact that both are one code path.
 *
 * A list built one call per task costs a round trip each — the whole point of the
 * array is that a plan arrives in a single call, so what matters here is that the
 * batch is numbered, reported and stored exactly as the equivalent run of single
 * calls would have been.
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

beforeEach(() => {
  process.env.PI_TASKS = "off";
  config.current = {};
  mock = mockPi();
  initExtension(mock.pi as any);
});

afterEach(() => { delete process.env.PI_TASKS; });

const create = async (params: Record<string, unknown>): Promise<string> =>
  (await mock.executeTool("TaskCreate", params, mockCtx())).content[0].text;

const list = async (): Promise<string> =>
  (await mock.executeTool("TaskList", {}, mockCtx())).content[0].text;

const get = async (taskId: string): Promise<string> =>
  (await mock.executeTool("TaskGet", { taskId }, mockCtx())).content[0].text;

describe("TaskCreate — batch", () => {
  it("creates a whole list in one call", async () => {
    const result = await create({
      tasks: [
        { subject: "Read the spec", description: "d" },
        { subject: "Write the code", description: "d" },
        { subject: "Run the tests", description: "d" },
      ],
    });

    expect(result).toBe([
      "Task #1 created successfully: Read the spec",
      "Task #2 created successfully: Write the code",
      "Task #3 created successfully: Run the tests",
    ].join("\n"));
  });

  it("keeps the order it was given", async () => {
    await create({
      tasks: [
        { subject: "First", description: "d" },
        { subject: "Second", description: "d" },
      ],
    });

    const lines = (await list()).split("\n");
    expect(lines[0]).toContain("#1 [pending] First");
    expect(lines[1]).toContain("#2 [pending] Second");
  });

  it("numbers a batch after tasks that already exist", async () => {
    await create({ subject: "Existing", description: "d" });

    expect(await create({ tasks: [{ subject: "Batched", description: "d" }] }))
      .toContain("#2");
  });

  it("carries each task's optional fields", async () => {
    await create({
      tasks: [
        { subject: "Plain", description: "Plain desc" },
        { subject: "Detailed", description: "Detailed desc", activeForm: "Doing it", metadata: { note: "keep" } },
      ],
    });

    const detailed = await get("2");
    expect(detailed).toContain("Detailed desc");
    expect(detailed).toContain("keep");
  });

  it("marks a batched task for subagent execution via agentType", async () => {
    await create({ tasks: [{ subject: "Explore", description: "d", agentType: "general-purpose" }] });

    expect(await get("1")).toContain("general-purpose");
  });

  it("still accepts a single task passed directly", async () => {
    expect(await create({ subject: "Just one", description: "d" }))
      .toBe("Task #1 created successfully: Just one");
  });

  it("defaults a missing description to the subject", async () => {
    // A model that only sees the signature sends a bare subject; failing it costs a retry.
    expect(await create({ subject: "Bare" })).toBe("Task #1 created successfully: Bare");
  });

  it("reports an empty `tasks` instead of silently creating nothing", async () => {
    // A model that builds the array dynamically can arrive here with nothing in
    // it. Answering "created successfully" to that would be a lie it then acts on.
    expect(await create({ tasks: [] })).toContain("needs a subject");
    expect(await list()).toBe("No tasks found");
  });

  it("rejects the whole batch when one task is incomplete", async () => {
    // Partial creation would leave the model's plan half-numbered, with no way to
    // tell which half landed.
    const result = await create({
      tasks: [
        { subject: "Fine", description: "d" },
        { description: "Missing a subject" },
      ] as unknown,
    });

    expect(result).toContain("needs a subject");
    expect(await list()).toBe("No tasks found");
  });
});
