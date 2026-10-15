/**
 * summary-editor.ts — The prompt editor, with the task summary drawn into its bottom border.
 *
 * The summary sits on the bottom border rather than the top one because pi embeds
 * its working indicator and the "↑ N more" scroll marker into the top border while
 * the agent runs, which is exactly when the summary matters. The border is found
 * by content instead of through `renderBottomBorder`, which pi-tui only gained after
 * the oldest release this extension supports.
 */

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const ANSI = /\x1b\[[0-9;]*m/g;

/** A border carrying no text: pi swaps in a label (scroll marker, status) when it has one. */
const isPlainBorder = (line: string) => /^─+$/.test(line.replace(ANSI, ""));

/** Fixed part of `── <label> ───`: three columns before the label, one after. */
const LABEL_CHROME = 4;

export class TaskSummaryEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private summaryLabel: (maxWidth: number) => string | undefined,
  ) {
    // setEditorComponent does not carry pi's own editor options over to a replacement,
    // so the one that keeps the working indicator inside the border is passed here. Cast
    // because the oldest supported pi has no such option to type it with.
    super(tui, theme, keybindings, { embedWorkingStatus: true } as ConstructorParameters<typeof CustomEditor>[3]);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // Backwards: autocomplete rows, when open, follow the bottom border. Index 0 is
    // the top border and is never a candidate.
    for (let i = lines.length - 1; i > 0; i--) {
      if (!isPlainBorder(lines[i])) continue;
      const label = this.summaryLabel(width - LABEL_CHROME - 1);
      if (label) {
        const fill = width - LABEL_CHROME - visibleWidth(label);
        if (fill >= 1) lines[i] = this.borderColor("── ") + label + this.borderColor(` ${"─".repeat(fill)}`);
      }
      break;
    }
    return lines;
  }
}
