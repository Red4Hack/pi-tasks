/**
 * task-widget.ts — Persistent widget showing task list with status glyphs and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 *
 * Every glyph on screen is a default that `glyphs` in tasks-config.json can
 * replace — see task-glyphs.ts.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolveTaskGlyphs } from "../task-glyphs.js";
import type { TaskStore } from "../task-store.js";
import type { TaskLayout, TasksConfig } from "../tasks-config.js";
import { TaskSummaryEditor } from "./summary-editor.js";

// ---- Truncation ----

import type { Task } from "../types.js";

function truncateFromTop(tasks: Task[], limit: number): Task[] {
  return tasks.slice(-limit);
}

function truncateFromBottom(tasks: Task[], limit: number): Task[] {
  return tasks.slice(0, limit);
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateFromBottom };

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

type SummaryEditorArgs = ConstructorParameters<typeof TaskSummaryEditor>;
type SummaryEditorFactory = (
  tui: SummaryEditorArgs[0],
  theme: SummaryEditorArgs[1],
  keybindings: SummaryEditorArgs[2],
) => TaskSummaryEditor;

export type UICtx = {
  readonly theme: Theme;
  setStatus(key: string, text: string | undefined): void;
  setEditorComponent(factory: SummaryEditorFactory | undefined): void;
  /** Only ever compared by identity, to tell our editor from another extension's. */
  getEditorComponent(): object | undefined;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

const DEFAULT_MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (active time, token usage). */
export interface TaskMetrics {
  /** Active time already banked, excluding the stretch currently being timed. */
  elapsedMs: number;
  /** Start of the stretch being timed, or undefined while the clock is stopped. */
  runningSince: number | undefined;
  inputTokens: number;
  outputTokens: number;
}

/** Active time a task has accumulated, including any stretch still running. */
function elapsedOf(m: TaskMetrics): number {
  return m.elapsedMs + (m.runningSince === undefined ? 0 : Date.now() - m.runningSince);
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;
  /** Whether the agent is working. Starts true: the widget only exists because
   *  tasks do, and every path that creates one runs inside a turn. */
  private agentActive = true;
  /** The editor this widget installed for the compact layout, kept to tell it apart
   *  from one another extension installed. */
  private summaryFactory: SummaryEditorFactory | undefined;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Narrowed rather than defaulted, like `hiddenAt`: config is hand-editable JSON, and
   *  an unrecognised value must land on the default instead of on no layout at all. */
  private layout(): TaskLayout {
    return this.config.layout === "list" ? "list" : "compact";
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, {
          elapsedMs: 0,
          runningSince: this.agentActive ? Date.now() : undefined,
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /**
   * The agent started or stopped working.
   *
   * A task left in_progress when the run ends is not being worked on: nothing is
   * running, and the user is reading a finished screen. Elapsed time is banked at
   * that point and timed again when the agent comes back, so the figure beside a
   * task counts the time it was actually worked on rather than the time since it
   * was started. The spinner stops with it — an animation is a claim that
   * something is happening.
   */
  setAgentActive(active: boolean) {
    if (active === this.agentActive) return;
    this.agentActive = active;
    for (const m of this.metrics.values()) {
      if (active) {
        m.runningSince = Date.now();
      } else {
        m.elapsedMs = elapsedOf(m);
        m.runningSince = undefined;
      }
    }
    this.update();
  }

  /** Ensure the widget update timer is running. The spinner advances here and
   *  nowhere else: `update()` also runs on every task mutation and tool execution,
   *  so incrementing there tied the animation speed to how busy the agent was. */
  ensureTimer() {
    if (!this.widgetInterval && this.agentActive) {
      this.widgetInterval = setInterval(() => {
        this.widgetFrame++;
        this.update();
      }, 150);
    }
  }

  private stopTimer() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
  }

  /** Render callback entry point. Guarded so a render error can never escape to
   *  the TUI timer and crash the whole host process — worst case the widget is
   *  empty for one frame. */
  private renderWidget(tui: any, theme: Theme): string[] {
    try {
      return this.buildWidgetLines(tui, theme);
    } catch {
      return [];
    }
  }

  /** Build widget lines from current live state. */
  private buildWidgetLines(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    // Resolved per render, not cached: the extension swaps this config object's
    // contents when the host moves to a session in another workspace.
    const glyphs = resolveTaskGlyphs(this.config.glyphs);
    const tasks = this.store.list(sortOrder);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w, glyphs.truncation);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerFrame = glyphs.spinner[this.widgetFrame % glyphs.spinner.length];
    const lines: string[] = [truncate(theme.fg("accent", glyphs.header) + " " + theme.fg("accent", statusText))];

    // Collapsing only decides what goes in the list; the visible-limit logic below
    // then runs unchanged over whatever remains.
    const collapseCompleted = this.config.collapseCompleted ?? false;
    const listed = collapseCompleted ? tasks.filter(t => t.status !== "completed") : tasks;
    const showAll = this.config.showAll ?? false;
    const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
    // Narrowed rather than defaulted: config is hand-editable JSON, and an
    // unrecognised value would index TRUNCATE_FNS to undefined and blank the widget.
    const hiddenAt = this.config.hiddenAt === "top" ? "top" : "bottom";
    const visible = showAll ? listed : TRUNCATE_FNS[hiddenAt](listed, limit);

    const hiddenCount = listed.length - visible.length;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    ${glyphs.overflow} and ${hiddenCount} more`))
      : undefined;

    if (overflowLine && hiddenAt === "top") {
      lines.push(overflowLine);
    }
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let statusGlyph: string;
      if (isActive) {
        statusGlyph = theme.fg("accent", spinnerFrame);
      } else if (task.status === "completed") {
        statusGlyph = theme.fg("success", glyphs.completed);
      } else if (task.status === "in_progress") {
        statusGlyph = theme.fg("accent", glyphs.inProgress);
      } else {
        statusGlyph = glyphs.pending;
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` ${glyphs.blocked} blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(elapsedOf(m));
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`${glyphs.inputTokens} ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`${glyphs.outputTokens} ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} ${glyphs.statsSeparator} ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${
          theme.fg("accent", form + agentLabel + glyphs.trailingEllipsis)
        }${stats}`;
      } else if (task.status === "completed") {
        text = `  ${statusGlyph} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `  ${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (overflowLine && hiddenAt !== "top") {
      lines.push(overflowLine);
    }
    if (collapseCompleted && completed.length > 0) {
      lines.push(truncate(`  ${theme.fg("success", glyphs.completedSummary)} ${theme.fg("dim", `${completed.length} completed`)}`));
    }

    return lines;
  }

  /** Make the prompt editor the one that draws the summary. False when it cannot be:
   *  another extension's editor is installed, or the host has no editor to replace. */
  private ensureSummaryEditor(ui: UICtx): boolean {
    const current = ui.getEditorComponent();
    if (current !== undefined) return current === this.summaryFactory;
    const factory: SummaryEditorFactory = (tui, theme, keybindings) => {
      this.tui = tui;
      return new TaskSummaryEditor(tui, theme, keybindings, maxWidth => this.compactLabel(maxWidth));
    };
    ui.setEditorComponent(factory);
    if (ui.getEditorComponent() !== factory) return false;
    this.summaryFactory = factory;
    return true;
  }

  /** The summary for the editor border, or undefined to leave the border plain. Guarded
   *  like renderWidget: this runs inside the editor's render, so a throw would take
   *  the prompt down with it. */
  private compactLabel(maxWidth: number): string | undefined {
    if (!this.uiCtx || this.layout() !== "compact" || maxWidth <= 0) return undefined;
    try {
      return this.buildSummary(this.uiCtx.theme, maxWidth);
    } catch {
      return undefined;
    }
  }

  /** One line: progress, then the task being worked on — `● 2/5 · ✳ #3 Doing it… (2m 10s)`. */
  private buildSummary(theme: Theme, maxWidth: number): string | undefined {
    const glyphs = resolveTaskGlyphs(this.config.glyphs);
    const tasks = this.store.list(this.config.sortOrder ?? "id");
    if (tasks.length === 0) return undefined;

    const done = tasks.filter(t => t.status === "completed").length;
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const focus = inProgress.find(t => this.activeTaskIds.has(t.id)) ?? inProgress[0] ??
      tasks.find(t => t.status === "pending");

    const sep = theme.fg("dim", glyphs.statsSeparator);
    let text = theme.fg("accent", `${glyphs.header} ${done}/${tasks.length}`);
    if (!focus) {
      text += ` ${sep} ${theme.fg("success", glyphs.completed)} ${theme.fg("dim", "all done")}`;
    } else {
      const active = this.activeTaskIds.has(focus.id) && focus.status === "in_progress";
      const glyph = active
        ? theme.fg("accent", glyphs.spinner[this.widgetFrame % glyphs.spinner.length])
        : focus.status === "in_progress"
        ? theme.fg("accent", glyphs.inProgress)
        : glyphs.pending;
      const label = active ? (focus.activeForm || focus.subject) + glyphs.trailingEllipsis : focus.subject;
      text += ` ${sep} ${glyph} ${theme.fg("accent", `#${focus.id} ${label}`)}`;
      const metrics = active ? this.metrics.get(focus.id) : undefined;
      if (metrics) text += ` ${theme.fg("dim", `(${formatDuration(elapsedOf(metrics))})`)}`;
      if (focus.status === "in_progress" && inProgress.length > 1) {
        text += ` ${theme.fg("dim", `+${inProgress.length - 1}`)}`;
      }
    }
    return truncateToWidth(text, maxWidth, glyphs.truncation);
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    // Settled before the empty-list return: swapping the editor discards its prompt
    // history, so it is done as early as the layout is known rather than when the
    // first task appears.
    const compact = this.layout() === "compact" && this.ensureSummaryEditor(this.uiCtx);
    const tasks = this.store.list();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      this.stopTimer();
      if (compact) this.tui?.requestRender(); // wipes the summary
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Animate only what is actually moving: a task being executed, by an agent that
    // has not stopped.
    if (this.agentActive && tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress")) {
      this.ensureTimer();
    } else {
      this.stopTimer();
    }

    // The summary lives on the editor, so the list widget has nothing to show.
    if (compact) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      this.tui?.requestRender();
      return;
    }

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    this.stopTimer();
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
      if (this.summaryFactory && this.uiCtx.getEditorComponent() === this.summaryFactory) {
        this.uiCtx.setEditorComponent(undefined);
      }
    }
    this.summaryFactory = undefined;
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
