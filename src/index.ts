/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks as subagents (requires @tintinweb/pi-subagents)
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import {
  type CadenceConfig,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "./reminder-cadence.js";
import { sweepSessionTaskFiles } from "./task-cleanup.js";
import { resolveTaskGlyphs } from "./task-glyphs.js";
import { reclaimGlobalSessionTasksDir, sessionTaskFile } from "./task-paths.js";
import { TaskStore } from "./task-store.js";
import { DEFAULT_TASK_SCOPE, loadGlobalTasksConfig, loadTasksConfig } from "./tasks-config.js";
import type { NewTask, Task } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** Shorter interval used while any task is in_progress, so stale work is caught faster. */
const ACTIVE_REMINDER_INTERVAL = 2;

/** Cap on how many tasks the reminder echoes, to bound its size on large lists. */
const REMINDER_MAX_TASKS = 10;

/** Effective reminder interval for a given task list (pure — no disk I/O). */
function intervalFor(tasks: Task[]): number {
  return tasks.some(t => t.status === "in_progress") ? ACTIVE_REMINDER_INTERVAL : REMINDER_INTERVAL;
}

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

/** Neutralize a task field for the echo: collapse newlines and strip reminder tags. */
function sanitizeField(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/<\/?system-reminder>/gi, "").trim();
}

/**
 * Build the system reminder, shaped after Claude Code's todo reminders: an
 * empty-list nudge, or a state echo that dumps the current list as JSON. The
 * wording mirrors Claude Code (adapted to this extension's task tool names).
 */
function buildSystemReminder(tasks: Task[]): string {
  if (tasks.length === 0) {
    return [
      "<system-reminder>",
      "This is a reminder that your task list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a task list please use the TaskCreate tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.",
      "</system-reminder>",
    ].join("\n");
  }

  // Bound the echo on large lists. When over the cap, drop completed tasks
  // first (the reminder exists to surface unfinished work); ties keep task
  // order since Array.sort is stable.
  let shown = tasks;
  if (tasks.length > REMINDER_MAX_TASKS) {
    const rank = (t: Task) => (t.status === "in_progress" ? 0 : t.status === "pending" ? 1 : 2);
    shown = [...tasks].sort((a, b) => rank(a) - rank(b)).slice(0, REMINDER_MAX_TASKS);
  }
  const hidden = tasks.length - shown.length;
  const overflow = hidden > 0
    ? ` (${hidden} more task${hidden === 1 ? "" : "s"} not shown — use TaskList for the full list.)`
    : "";

  const items = shown.map(t => {
    const item: Record<string, string> = {
      id: t.id,
      content: sanitizeField(t.subject),
      status: t.status,
    };
    if (t.activeForm) item.activeForm = sanitizeField(t.activeForm);
    return item;
  });

  // When truncated, don't claim these are the full contents.
  const prefix = "The task tools haven't been used recently. DO NOT mention this explicitly to the user.";
  const header = hidden > 0
    ? `${prefix} Here are your most relevant tasks (list truncated):`
    : `${prefix} Here are the latest contents of your task list:`;

  return [
    "<system-reminder>",
    header,
    "",
    `${JSON.stringify(items)}.${overflow} Continue on with the tasks at hand if applicable.`,
    "</system-reminder>",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  // Project overrides require ExtensionContext.cwd, which is unavailable while
  // the extension factory runs. Start with global defaults, then merge the
  // active workspace's overrides on the first context-bearing event.
  const cfg = loadGlobalTasksConfig();
  const piTasks = process.env.PI_TASKS;
  let taskScope = cfg.taskScope ?? DEFAULT_TASK_SCOPE;

  /** Both session scopes persist one file per session; they differ only in where it
   *  lives, so every lifecycle rule about session files applies to each of them. */
  const isSessionScope = () => taskScope === "session" || taskScope === "session-global";

  /** Resolve both the backing path and a stable identity for the active store. */
  function resolveStoreTarget(cwd?: string, sessionId?: string): { key: string; path?: string } {
    if (piTasks === "off") return { key: "memory:env" };
    if (piTasks?.startsWith("/")) return { key: `path:${piTasks}`, path: piTasks };
    if (piTasks?.startsWith(".")) {
      const path = cwd ? resolve(cwd, piTasks) : undefined;
      return path ? { key: `path:${path}`, path } : { key: "pending:relative" };
    }
    if (piTasks) return { key: `named:${piTasks}`, path: piTasks };
    if (taskScope === "memory") return { key: "memory:config" };
    if (!cwd) return { key: "pending:workspace" };
    if (isSessionScope() && sessionId) {
      const path = sessionTaskFile(cwd, sessionId, taskScope);
      return { key: `path:${path}`, path };
    }
    if (isSessionScope()) return { key: "pending:session" };
    const path = join(cwd, ".pi", "tasks", "tasks.json");
    return { key: `path:${path}`, path };
  }

  // Project and relative paths need ExtensionContext.cwd, which is unavailable
  // while the extension factory runs. Absolute and named PI_TASKS overrides can
  // still be opened immediately; all other stores start in memory.
  let storeTarget = resolveStoreTarget();
  let store = new TaskStore(storeTarget.path);
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store, cfg);

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Cascade config — set by TaskExecute, consumed by completion listener. */
  let cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;
  /** Maps agent IDs to task IDs for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();

  // ── Subagent RPC helpers ──

  /** RPC reply envelope — matches pi-mono's RpcResponse shape. */
  type RpcReply<T = void> =
    | { success: true; data?: T }
    | { success: false; error: string };

  /** Call a subagents RPC method: emit request, wait for scoped reply, unwrap envelope. */
  function rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub(); clearTimeout(timer);
        debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      pi.events.emit(channel, { requestId, ...params });
      debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string }>("subagents:rpc:spawn", { type, prompt, options }, 30_000)
      .then(d => { debug("spawn:ok", d); return d.id; });
  }

  /** Stop a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000).catch(() => {});
  }

  /** Tell subagents its result has been handed to the model, which suppresses the
   *  completion notification it would otherwise deliver for the same result — the
   *  same consumption `get_subagent_result` performs when it returns one.
   *
   *  Fire-and-forget rather than an `rpcCall`: the reply carries nothing to act on,
   *  and the channel is deliberately outside the version handshake so a pi-subagents
   *  without the handler keeps notifying instead of failing the read. */
  function consumeSubagentResult(agentId: string): void {
    pi.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId });
  }

  // ── Subagent extension presence & version detection ──
  const PROTOCOL_VERSION = 2;
  let subagentsAvailable = false;
  let pendingWarning: string | undefined;

  /** Ping subagents and check protocol version. Works with any handler version. */
  function checkSubagentsVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => { unsub(); }, 5_000);
    const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub(); clearTimeout(timer);
      const remoteVersion = (raw as any)?.data?.version as number | undefined;
      if (remoteVersion === undefined) {
        pendingWarning =
          "@tintinweb/pi-subagents is outdated — please update for task execution support.";
      } else if (remoteVersion > PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-tasks is outdated (protocol v${PROTOCOL_VERSION}, ` +
          `pi-subagents has v${remoteVersion}) — please update for task execution support.`;
      } else if (remoteVersion < PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-subagents is outdated (protocol v${remoteVersion}, ` +
          `pi-tasks has v${PROTOCOL_VERSION}) — please update for task execution support.`;
      } else {
        subagentsAvailable = true;
      }
    });
    pi.events.emit("subagents:rpc:ping", { requestId });
  }

  checkSubagentsVersion();
  pi.events.on("subagents:ready", () => checkSubagentsVersion());

  /** Resolve a task ID, or an agent ID (or unique-ish prefix) mapped to a task, to a task ID. */
  function resolveTaskId(id: string): string {
    if (store.get(id)) return id;
    for (const [agentId, taskId] of agentTaskMap) {
      if (agentId === id || agentId.startsWith(id)) return taskId;
    }
    return id;
  }

  /** Build a prompt for a task being executed by a subagent.
   *  Injects completed dependency results so cascaded agents have context from prerequisites.
   */
  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    // Inject completed dependency results so cascaded agents have full context
    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > 4000
            ? dep.metadata.result.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ── Subagent completion listener ──
  // Listens for subagent lifecycle events to update task status and optionally cascade.

  // Success → mark task completed, cascade if enabled
  pi.events.on("subagents:completed", async (data) => {
    const { id, result } = data as { id: string; result?: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    store.update(task.id, { status: "completed", metadata: { ...task.metadata, result } });
    widget.setActiveTask(task.id, false);

    // Auto-cascade: find unblocked dependents with agentType
    if ((cfg.autoCascade ?? false) && cascadeConfig && latestCtx) {
      const unblocked = store.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.blockedBy.includes(task.id) &&
        t.blockedBy.every(depId => store.get(depId)?.status === "completed")
      );
      for (const next of unblocked) {
        store.update(next.id, { status: "in_progress" });
        const prompt = buildTaskPrompt(next, cascadeConfig.additionalContext);
        try {
          const agentId = await spawnSubagent(next.metadata.agentType, prompt, {
            description: next.subject,
            isBackground: true,
            maxTurns: cascadeConfig.maxTurns,
            ...(cascadeConfig.model ? { model: cascadeConfig.model } : {}),
          });
          agentTaskMap.set(agentId, next.id);
          store.update(next.id, { owner: agentId, metadata: { ...next.metadata, agentId } });
          widget.setActiveTask(next.id);
        } catch (err: any) {
          store.update(next.id, { status: "pending", metadata: { ...next.metadata, result: null, lastError: err.message } });
        }
      }
    }
    autoClear.trackCompletion(task.id, cadence.currentTurn);
    widget.update();
  });

  // Failure → store error, revert to pending, don't cascade (branch stops)
  // Intentional stop (status === "stopped") → mark completed, preserve partial result
  pi.events.on("subagents:failed", (data) => {
    const { id, error, result, status } = data as { id: string; error?: string; result?: string; status: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    if (status === "stopped") {
      // Intentional stop — mark completed, preserve partial result
      store.update(task.id, { status: "completed", metadata: { ...task.metadata, result: result || task.metadata?.result } });
      autoClear.trackCompletion(task.id, cadence.currentTurn);
    } else {
      // Actual error — revert to pending. `result: null` drops it (the store deletes
      // a key set to null): a task back to pending has no current result, and an
      // earlier run's would otherwise outrank this error everywhere it is read.
      store.update(task.id, { status: "pending", metadata: { ...task.metadata, result: null, lastError: error || status } });
      autoClear.resetBatchCountdown();
    }
    widget.setActiveTask(task.id, false);
    widget.update();
  });

  // ── Context-scoped store initialization ──
  // Project paths cannot be resolved until an ExtensionContext is available.
  // Initialize on the first context-bearing event and reinitialize when a host
  // switches this extension instance to a session in another workspace.
  let configuredCwd: string | undefined;
  let activeSessionId: string | undefined;
  let persistedTasksShown = false;
  let agentsReattached = false;
  function initializeStoreForContext(ctx: ExtensionContext, reloadConfig = false) {
    // Keep the config object identity stable because the widget and auto-clear
    // manager retain references to it, but replace every value so overrides
    // from a previous workspace cannot leak into the next one.
    if (reloadConfig || configuredCwd !== ctx.cwd) {
      for (const key of Object.keys(cfg) as (keyof typeof cfg)[]) delete cfg[key];
      Object.assign(cfg, loadTasksConfig(ctx.cwd));
      taskScope = cfg.taskScope ?? DEFAULT_TASK_SCOPE;
    }

    // `pi --no-session` mints a session ID but never a session file. Keying off the
    // ID alone would write tasks-<id>.json for a session that can never be resumed
    // and is orphaned the moment pi exits: if pi is not persisting the conversation,
    // don't persist the task list either.
    const sessionId = isSessionScope() && !piTasks && ctx.sessionManager.getSessionFile()
      ? ctx.sessionManager.getSessionId()
      : undefined;
    activeSessionId = sessionId;
    const nextTarget = resolveStoreTarget(ctx.cwd, sessionId);
    if (nextTarget.key !== storeTarget.key) {
      store = new TaskStore(nextTarget.path);
      widget.setStore(store);
      storeTarget = nextTarget;
      // The new store owns a different task list, so the agent map has to be
      // rebuilt from it rather than kept from the previous one.
      agentsReattached = false;
    }
    configuredCwd = ctx.cwd;
  }

  /** Delete an emptied session file, and — under `session-global` only — the
   *  directory that held it once its last session is gone. Nothing else is ours
   *  to reclaim: a PI_TASKS path can point anywhere, and `<workspace>/.pi/tasks/`
   *  is left standing exactly as it always has been. */
  function deleteSessionFileIfEmpty() {
    if (!store.deleteFileIfEmpty()) return;
    if (taskScope === "session-global" && !piTasks && configuredCwd) {
      reclaimGlobalSessionTasksDir(configuredCwd);
    }
  }

  /** Workspaces already swept this process, so the scan runs once per workspace
   *  rather than on every /new, /resume and fork. */
  const sweptWorkspaces = new Set<string>();

  /** Retire session task files left behind by sessions that ended without emptying
   *  their list. Skipped entirely when PI_TASKS points the store somewhere of the
   *  user's choosing — that path is theirs, not ours to tidy. */
  function sweepStaleTaskFiles(ctx: ExtensionContext) {
    if (piTasks || sweptWorkspaces.has(ctx.cwd)) return;
    sweptWorkspaces.add(ctx.cwd);
    const deleted = sweepSessionTaskFiles({
      cwd: ctx.cwd,
      sessionDir: ctx.sessionManager?.getSessionDir(),
      keepSessionId: activeSessionId,
      retentionDays: cfg.taskFileRetentionDays,
    });
    if (deleted > 0) debug(`cleanup: removed ${deleted} stale task file(s)`);
  }

  /** Re-link persisted in-progress tasks to the subagents still running for them.
   *  `agentTaskMap` lives only in this extension instance, so a reload starts empty
   *  while the agents keep going — their completion events would then be dropped and
   *  the tasks would stay in_progress forever. Everything needed is already on disk:
   *  TaskExecute records the agent ID in task metadata.
   *
   *  Only in_progress tasks are relinked. A task reverted to pending keeps its
   *  `metadata.agentId`, and relinking that would let a late event resurrect work the
   *  user has already reset. Only runs once — the first caller wins. */
  function reattachAgents() {
    if (agentsReattached) return;
    agentsReattached = true;
    for (const task of store.list()) {
      const agentId = task.metadata?.agentId;
      if (task.status === "in_progress" && typeof agentId === "string" && agentId) {
        agentTaskMap.set(agentId, task.id);
      }
    }
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (isSessionScope()) deleteSessionFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for system-reminder injection ──
  // Cadence decisions live in `reminder-cadence.ts` so they're
  // unit-testable without spinning up a fake ExtensionAPI.
  const cadence = createCadenceState();
  const cadenceConfig: CadenceConfig = {
    reminderInterval: REMINDER_INTERVAL,
    taskToolNames: TASK_TOOL_NAMES,
  };

  pi.on("turn_start", async (_event, ctx) => {
    onTurnStart(cadence);
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    widget.setAgentActive(true);
    initializeStoreForContext(ctx);
    if (autoClear.onTurnStart(cadence.currentTurn)) {
      if (isSessionScope()) deleteSessionFileIfEmpty();
      widget.update();
    }
  });

  // The end of a run is the only signal that separates a new batch of tasks from the
  // same batch still being built — the store looks identical either way. Nothing is
  // cleared here; this only marks the boundary for the next TaskCreate.
  pi.on("agent_settled", async () => {
    autoClear.onRunEnded();
    // Nothing is being worked on once the run ends, so the elapsed time beside a
    // task stops counting and its spinner stops turning.
    widget.setAgentActive(false);
  });

  // ── Token usage tracking + stale-task detection ──
  // Feed per-turn token counts from assistant messages into the widget.
  // Also detect when the agent has stopped referencing tasks but left
  // them in_progress — schedule a reminder for the next LLM call.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }

    // Stale-task detection: catch the case where the agent finishes work in a
    // text-only turn (no tool calls, so tool_result never fires) but left tasks
    // in_progress. Cheap-first: only read the store once the turn gap could
    // matter — the in_progress interval is the smallest a reminder can need.
    if (!cadence.reminderDue) {
      const gap = cadence.currentTurn - cadence.lastTaskToolUseTurn;
      if (gap >= ACTIVE_REMINDER_INTERVAL && store.list().some(t => t.status === "in_progress")) {
        cadence.reminderDue = true;
      }
    }
  });

  // ── System-reminder injection ──
  //
  // tool_result is used ONLY to track cadence. We DO NOT mutate non-task
  // tool result content — appending a <system-reminder> there would
  // corrupt model-visible transcript semantics for unrelated tools (read,
  // bash, grep, …) and make tool-output debugging miserable.
  //
  // The actual injection happens in the `context` hook below, which fires
  // before each LLM call and returns a modified copy of the messages
  // without persisting or polluting any tool output.
  pi.on("tool_result", async (event) => {
    // Task tool usage resets cadence (interval is irrelevant on this path — the
    // helper resets and returns before reading it).
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      evaluateToolResult(cadence, event.toolName, false, cadenceConfig);
      return {};
    }

    // Cheap-first: avoid store.list() disk I/O until the turn gap could matter.
    // ACTIVE_REMINDER_INTERVAL is the smallest interval any reminder can need.
    if (cadence.currentTurn - cadence.lastTaskToolUseTurn < ACTIVE_REMINDER_INTERVAL) return {};

    const tasks = store.list();
    // Shorter interval while in_progress; passed per-call so the shared config
    // is never mutated.
    evaluateToolResult(cadence, event.toolName, tasks.length > 0, {
      ...cadenceConfig,
      reminderInterval: intervalFor(tasks),
    });
    return {};
  });

  // Inject the transient system-reminder into the upcoming LLM call's
  // messages, never into a tool result. The reminder is appended as a
  // user message so models that don't support custom message types still
  // receive it. It is not persisted in the session store — `context`
  // returns a transformed messages array used only for this one request.
  pi.on("context", async (event) => {
    if (!drainReminderForContext(cadence)) return {};
    const tasks = store.list();

    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: buildSystemReminder(tasks) }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  // session_start replaces the never-emitted session_switch event. Rehydrating
  // here matters because before_agent_start only fires once the user prompts.
  pi.on("session_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const reason = event.reason;
    // new/resume/fork reuse the running extension instance (getExtensions() is
    // cached), so session-scoped state must be reset. startup/reload re-run the
    // factory and start clean.
    const isSwitch = reason === "new" || reason === "resume" || reason === "fork";
    // A fork branches the conversation, so its tasks carry over as an independent
    // copy. Snapshot before the store re-points to the new (empty) session file.
    const forkSeed = reason === "fork" ? store.snapshot() : undefined;
    if (isSwitch) {
      persistedTasksShown = false;
      agentsReattached = false;
      // Task IDs restart at 1 in every session, so a mapping held over from the
      // previous one points at an unrelated task here — the agent's completion would
      // close a task it never ran. reattachAgents() rebuilds what this session owns.
      agentTaskMap.clear();
      resetCadenceState(cadence);
      autoClear.reset();
      // Memory mode has no file to switch — clear tasks explicitly on /new.
      if (reason === "new" && taskScope === "memory") {
        store.clearAll();
      }
    }

    initializeStoreForContext(ctx, true);
    sweepStaleTaskFiles(ctx);
    if (forkSeed?.tasks.length) store.seed(forkSeed); // carry the parent's tasks into the fork
    reattachAgents(); // subagents outlive a reload; relink them before events arrive
    // resume/reload/fork keep tasks; startup/new auto-clear an all-completed list.
    const keepsTasks = reason === "reload" || reason === "resume" || reason === "fork";
    showPersistedTasks(keepsTasks);
    // Those tasks are shown for review, but the run that produced them ended with the
    // session before this one — so the next batch must not be added to them either.
    if (keepsTasks) autoClear.onRunEnded();
    // showPersistedTasks only updates when there are tasks; the compact layout has to
    // swap the editor in now, before the prompt history it would discard builds up.
    widget.update();

    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Fallback for hosts that init UI lazily. Guarded by persistedTasksShown, so
  // it never double-renders after session_start.
  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    widget.setAgentActive(true);
    initializeStoreForContext(ctx);
    reattachAgents();
    showPersistedTasks();
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Create tasks to track and show progress on multi-step work. Pass \`tasks\` to create a whole list in one call.

## When to use it

- Work that takes 3 or more distinct steps, or needs planning across several operations
- The user lists what they want done — create the whole list in one call
- New instructions worth capturing before you start, and follow-up work you discover while implementing

Skip it for a single straightforward step or a purely conversational request; just do the work.

## Fields

- **subject**: short imperative title ("Fix authentication bug in login flow")
- **description** (optional): what to do, with enough context and acceptance criteria for another agent to pick it up; defaults to the subject
- **activeForm** (optional): present continuous shown while the task runs ("Fixing authentication bug"); defaults to the subject
- **agentType** (optional): marks the task for subagent execution via TaskExecute ("general-purpose", "Explore")

Tasks start \`pending\`. Check TaskList first to avoid duplicates, and use TaskUpdate for status changes and dependencies.`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Batch instead of repeating a call: TaskCreate takes `tasks`, TaskUpdate takes `updates` (e.g. complete one task and start the next), TaskGet takes `taskIds`.",
      "ALWAYS set a task to in_progress with TaskUpdate BEFORE you start working on it (the UI shows progress only for in_progress tasks), and to completed as soon as it is done. Never work on a task that is still pending.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.Optional(Type.String({ description: "A brief title for the task. Omit when using `tasks`." })),
      description: Type.Optional(Type.String({ description: "A detailed description of what needs to be done; defaults to the subject. Omit when using `tasks`." })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore'). Tasks with agentType can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
      tasks: Type.Optional(Type.Array(
        Type.Object({
          subject: Type.String({ description: "A brief title for the task" }),
          description: Type.Optional(Type.String({ description: "A detailed description of what needs to be done; defaults to the subject" })),
          activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
          agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution via TaskExecute" })),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
        }),
        { description: "Several tasks to create at once, in list order. Preferred over one call per task." },
      )),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // `tasks` and the single-task fields are the same request in two shapes, so one
      // path handles both. An empty `tasks` is a mistake worth reporting rather than a
      // silent no-op, hence the length check instead of a truthiness one.
      const requested = params.tasks?.length ? params.tasks : [params];
      const specs: NewTask[] = [];
      for (const spec of requested) {
        // The schema cannot say "subject, unless tasks", so a model that only sees the signature sends a bare subject: accept it.
        if (!spec.subject) {
          return Promise.resolve(textResult("TaskCreate needs a subject — pass it directly, or a `tasks` array of them."));
        }
        const metadata = { ...spec.metadata, ...(spec.agentType ? { agentType: spec.agentType } : {}) };
        specs.push({
          subject: spec.subject,
          description: spec.description || spec.subject,
          activeForm: spec.activeForm,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }

      // A finished list must not collect the batch that follows it. The turn countdowns
      // cannot be relied on for that: they only tick at `turn_start`, so a run that ends
      // right after its last completion freezes one mid-count.
      autoClear.startNewBatch();
      const created = store.createMany(specs);
      widget.update();
      const lines = created.map(task => `Task #${task.id} created successfully: ${task.subject}`);
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `List every task, one line each: \`#id [status] subject\`, plus its owner and any blockers still open.

Use it to see what is available to work on, to check progress, and to find newly unblocked work after finishing something. Work in ID order when several are open — earlier tasks usually set up later ones. A task with open blockers is not ready.

TaskGet returns one task's full description.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Read tasks in full: subject, description, status, owner, metadata, and both sides of their dependencies. Pass \`taskIds\` to read several in one call.

Use it before starting a task, to get the requirements and confirm nothing still blocks it. TaskList gives the whole list in summary form.`,
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "The ID of the task to retrieve. Omit when using `taskIds`." })),
      taskIds: Type.Optional(Type.Array(Type.String(), { description: "Several task IDs to read at once, in the order given" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Two shapes, one path, as in TaskCreate — and an empty `taskIds` is reported
      // rather than answered with nothing.
      const ids = params.taskIds?.length ? params.taskIds : params.taskId ? [params.taskId] : [];
      if (ids.length === 0) return Promise.resolve(textResult("TaskGet needs a taskId, or a `taskIds` array of them."));

      const blocks = ids.map(id => {
        const task = store.get(id);
        if (!task) return `Task #${id} not found`;

        // Unescape literal \n sequences the LLM may have double-escaped in JSON
        const desc = task.description.replace(/\\n/g, "\n");

        const lines: string[] = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
        if (task.owner) lines.push(`Owner: ${task.owner}`);
        lines.push(`Description: ${desc}`);

        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map(bid => "#" + bid).join(", ")}`);
        if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(bid => "#" + bid).join(", ")}`);
        if (Object.keys(task.metadata).length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);

        return lines.join("\n");
      });

      return Promise.resolve(textResult(blocks.join("\n\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  /** What one TaskUpdate entry can change — shared by the single-task shape and each
   *  entry of `updates`, so the two cannot drift apart. */
  const taskUpdateFields = {
    status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
      type: "string",
      enum: ["pending", "in_progress", "completed", "deleted"],
      description: "New status for the task",
    })),
    subject: Type.Optional(Type.String({ description: "New subject for the task" })),
    description: Type.Optional(Type.String({ description: "New description for the task" })),
    activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
    owner: Type.Optional(Type.String({ description: "New owner for the task" })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
    addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
    addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
  };

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Update tasks: their status, details, or dependencies. Pass \`updates\` to change several tasks in one call — e.g. finish one and start the next:
\`{"updates": [{"taskId": "1", "status": "completed"}, {"taskId": "2", "status": "in_progress"}]}\`

## Status

\`pending\` → \`in_progress\` → \`completed\`, plus \`deleted\` to remove a task that is no longer relevant.

- Mark a task in_progress *before* starting it, and completed as soon as it is genuinely done.
- Keep it in_progress if tests fail, the implementation is partial, or you hit an error you have not resolved — and create a task for whatever is blocking you.
- After completing one, call TaskList to find the next.

## Other fields

- **subject** / **description**: revise the task when requirements change
- **activeForm**: present continuous shown while it runs ("Running tests")
- **owner**: claim the task
- **metadata**: merged into the task; a key set to null is removed
- **addBlocks** / **addBlockedBy**: dependencies, e.g. \`{"taskId": "2", "addBlockedBy": ["1"]}\`

Read the task with TaskGet first when you are unsure of its current state.`,
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "The ID of the task to update. Omit when using `updates`." })),
      ...taskUpdateFields,
      updates: Type.Optional(Type.Array(
        Type.Object({ taskId: Type.String({ description: "The ID of the task to update" }), ...taskUpdateFields }),
        { description: "Several updates to apply at once, in order. Preferred over one call per task." },
      )),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // One path for both shapes, as in TaskCreate. Every entry is checked before any is
      // applied, so a malformed batch changes nothing. Past that the entries are
      // independent: a missing task gets its own line rather than undoing the others.
      const { updates, ...single } = params;
      const requested: Array<typeof single> = updates?.length ? updates : [single];
      const entries = requested.filter((u): u is typeof single & { taskId: string } => Boolean(u.taskId));
      if (entries.length < requested.length) {
        return Promise.resolve(textResult("TaskUpdate needs a taskId — pass it directly, or on each entry of `updates`."));
      }

      const lines = entries.map(({ taskId, ...fields }) => {
        const { task, changedFields, warnings } = store.update(taskId, fields);
        if (changedFields.length === 0 && !task) return `Task #${taskId} not found`;

        // Update widget active task tracking
        if (fields.status === "in_progress") {
          widget.setActiveTask(taskId);
          autoClear.resetBatchCountdown();
        } else if (fields.status === "pending") {
          autoClear.resetBatchCountdown();
        } else if (fields.status === "completed" || fields.status === "deleted") {
          widget.setActiveTask(taskId, false);
          if (fields.status === "completed") autoClear.trackCompletion(taskId, cadence.currentTurn);
        }

        const msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
        return warnings.length > 0 ? `${msg} (warning: ${warnings.join("; ")})` : msg;
      });

      widget.update();
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Optional(Type.Boolean({ description: "Whether to wait for completion", default: true })),
      timeout: Type.Optional(Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block = true, timeout = 30000 } = params;
      // Reject an empty id up front: every agent ID starts with "", so the prefix
      // match below would resolve it to whichever agent the map yields first.
      if (!task_id) throw new Error("task_id is required");

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs (resolve agent ID → task ID)
        const resolvedId = resolveTaskId(task_id);
        const task = store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        if (task.metadata?.agentId) {
          // Subagent task — wait for completion if blocking
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, timeout ?? 30000);
              const cleanup = () => { clearTimeout(timer); resolve(); };
              const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              // Re-read before committing to the wait. Nothing awaits since the outer
              // check, so this only differs on a shared file-backed list, where
              // store.get() reloads and another session may have finished the task.
              const current = store.get(resolvedId);
              if (current && current.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
              signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
            });
          }
          // Re-read by resolved ID — `task` predates the wait, and a file-backed
          // store deserializes a fresh object on every load, so it is stale here.
          const updated = store.get(resolvedId) ?? task;
          const agentId: string = task.metadata.agentId;
          // Consume only what is actually handed over: the agent has reported back
          // (it leaves the map when it does) and the task carries its outcome. Short
          // of both — still running, or an update that never landed — the model is
          // getting a status, and the notification pi-subagents is holding is the
          // only thing that will announce the result.
          if (!agentTaskMap.has(agentId) && updated.status !== "in_progress") consumeSubagentResult(agentId);
          const output = updated.metadata?.result
            ?? (updated.metadata?.lastError ? `Error: ${updated.metadata.lastError}` : undefined);
          return textResult(
            `Task #${resolvedId} [${updated.status}] — subagent ${agentId}${output ? `\n\n${output}` : ""}`,
          );
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs
        const resolvedId = resolveTaskId(taskId);
        const task = store.get(resolvedId);
        if (task?.metadata?.agentId && task.status === "in_progress") {
          // Unlink first: a late completed/failed event for this agent must not
          // re-process a task the user already stopped.
          agentTaskMap.delete(task.metadata.agentId);
          store.update(resolvedId, { status: "completed" });
          autoClear.trackCompletion(resolvedId, cadence.currentTurn);
          await stopSubagent(task.metadata.agentId);
          widget.setActiveTask(resolvedId, false);
          widget.update();
          return textResult(`Task #${resolvedId} stopped successfully`);
        }
        throw new Error(
          task?.status === "in_progress"
            ? `Task #${resolvedId} is in_progress but has no background process or agent to stop — use TaskUpdate to change its status`
            : `No running background process for task ${taskId}`,
        );
      }

      store.update(taskId, { status: "completed" });
      autoClear.trackCompletion(taskId, cadence.currentTurn);
      widget.setActiveTask(taskId, false);
      widget.update();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable (@tintinweb/pi-subagents not loaded " +
          "or version mismatch). You can run these as plain Agent-tool spawns, but pi-tasks " +
          "won't track them — status stays pending, cascade won't fire, TaskOutput stays empty."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];

      for (const taskId of params.task_ids) {
        const task = store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        // Check all blockers are completed
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return !blocker || blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          results.push(`#${taskId}: blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
          continue;
        }

        // Mark in_progress and spawn agent via RPC
        store.update(taskId, { status: "in_progress" });
        const prompt = buildTaskPrompt(task, params.additional_context);
        try {
          const agentId = await spawnSubagent(task.metadata.agentType, prompt, {
            description: task.subject,
            isBackground: true,
            maxTurns: params.max_turns,
            ...(params.model ? { model: params.model } : {}),
          });
          agentTaskMap.set(agentId, taskId);
          store.update(taskId, { owner: agentId, metadata: { ...task.metadata, agentId } });
          widget.setActiveTask(taskId);
          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          debug(`spawn:error task=#${taskId}`, err);
          store.update(taskId, { status: "pending" });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      // Save cascade config for the completion listener
      cascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        maxTurns: params.max_turns,
      };

      widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      latestCtx = ctx;
      widget.setUICtx(ctx.ui as UICtx);
      initializeStoreForContext(ctx);
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
          if (isSessionScope()) deleteSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (isSessionScope()) deleteSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const glyphs = resolveTaskGlyphs(cfg.glyphs);
        const statusGlyph = (status: string) => {
          switch (status) {
            case "completed": return glyphs.completed;
            case "in_progress": return glyphs.inProgress;
            default: return glyphs.pending;
          }
        };

        const choices = tasks.map(t =>
          `${statusGlyph(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Matched by row position rather than parsed out of the label: both the glyph
        // and the subject are free text, and either can contain something like "#42".
        const picked = tasks[choices.indexOf(selected)];
        if (picked) await viewTaskDetail(picked.id);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          store.update(taskId, { status: "in_progress" });
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, cadence.currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          store.update(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      // The layout moves tasks between the list and the editor border, and nothing
      // else redraws on a settings change, so the widget is refreshed on the way out.
      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, () => {
          widget.update();
          return mainMenu();
        }, AUTO_CLEAR_DELAY, ctx.cwd);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
