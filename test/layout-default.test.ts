/**
 * The layout at the extension boundary: compact is the default, and it claims the
 * editor at session start rather than when the first task appears — swapping the
 * editor later would discard the prompt history typed in the meantime.
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

afterEach(() => {
  delete process.env.PI_TASKS;
});

/** A UI context that keeps the editor it is given, as pi's interactive mode does. */
function interactiveCtx() {
  let editor: unknown;
  const ctx = mockCtx();
  Object.assign(ctx.ui, {
    theme: { fg: (_color: string, text: string) => text, bold: (t: string) => t, strikethrough: (t: string) => t },
    setEditorComponent: vi.fn((factory: unknown) => {
      editor = factory;
    }),
    getEditorComponent: () => editor,
  });
  return ctx;
}

const start = (ctx: ReturnType<typeof interactiveCtx>) => mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

describe("default layout", () => {
  it("claims the editor at session start, before any task exists", async () => {
    const ctx = interactiveCtx();
    await start(ctx);

    expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("keeps the editor, and draws no list, as tasks come and go", async () => {
    const ctx = interactiveCtx();
    await start(ctx);
    await mock.executeTool("TaskCreate", { subject: "A", description: "d" }, ctx);
    await mock.fireLifecycle("tool_execution_start", {}, ctx);

    expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("leaves the editor alone and lists the tasks under layout \"list\"", async () => {
    config.current = { layout: "list" };
    const ctx = interactiveCtx();
    await start(ctx);
    await mock.executeTool("TaskCreate", { subject: "A", description: "d" }, ctx);

    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget.mock.calls.at(-1)?.[1]).toBeTypeOf("function");
  });

  it("lists the tasks when the host has no editor to replace", async () => {
    const ctx = mockCtx();
    await start(ctx as ReturnType<typeof interactiveCtx>);
    await mock.executeTool("TaskCreate", { subject: "A", description: "d" }, ctx);

    expect(ctx.ui.setWidget.mock.calls.at(-1)?.[1]).toBeTypeOf("function");
  });
});
