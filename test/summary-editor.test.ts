import { describe, expect, it } from "vitest";
import { TaskSummaryEditor } from "../src/ui/summary-editor.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (line: string) => line.replace(ANSI, "");

const tui = { terminal: { rows: 40, columns: 40 }, requestRender() {} };
const theme = {
  borderColor: (s: string) => s,
  selectList: {
    selectedPrefix: (s: string) => s,
    selectedText: (s: string) => s,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  },
};
const keybindings = { matches: () => false };

function editor(label: (maxWidth: number) => string | undefined) {
  return new TaskSummaryEditor(tui as any, theme, keybindings as any, label);
}

describe("TaskSummaryEditor", () => {
  it("draws the label into the bottom border, padded to the full width", () => {
    const lines = editor(() => "1/2 working").render(40);

    expect(plain(lines[lines.length - 1])).toBe(`── 1/2 working ${"─".repeat(40 - 4 - 11)}`);
    expect(plain(lines[lines.length - 1])).toHaveLength(40);
  });

  it("leaves the top border alone", () => {
    const lines = editor(() => "1/2 working").render(40);

    expect(plain(lines[0])).toBe("─".repeat(40));
  });

  it("keeps the plain border when there is no label", () => {
    const lines = editor(() => undefined).render(40);

    expect(plain(lines[lines.length - 1])).toBe("─".repeat(40));
  });

  it("keeps the plain border when the label does not fit", () => {
    const lines = editor(() => "x".repeat(40)).render(40);

    expect(plain(lines[lines.length - 1])).toBe("─".repeat(40));
  });

  it("offers the label the width left once the border chrome is taken", () => {
    let offered = 0;
    editor(maxWidth => {
      offered = maxWidth;
      return undefined;
    }).render(40);

    // `── ` before the label and ` ─` after it.
    expect(offered).toBe(35);
  });

  it("does not mistake a line of typed dashes for the border", () => {
    const e = editor(() => "1/2");
    e.setText("────────");
    const lines = e.render(40);

    expect(plain(lines[1]).trimEnd()).toBe("────────");
    expect(plain(lines[lines.length - 1])).toBe(`── 1/2 ${"─".repeat(40 - 4 - 3)}`);
  });
});
