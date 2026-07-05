// Decoration painting for the OpenCues VS Code extension.
//
// The runtime emits transport-neutral RenderDirectives (character
// ranges); this module maps them onto TextEditorDecorationType sets.
// Contract (PLAN.md Q2/Q3 in adapters/vscode/REPAIR.md):
//   - WHOLESALE repaint of every decoration type per directive batch.
//     VS Code auto-shifts decoration ranges on edits; the runtime owns
//     range truth, so between-batch tracking is never trusted.
//   - Ranges are coalesced per type before painting (Q11) — overlapping
//     dim ranges otherwise paint patchy.
//
// VS Code is the first non-terminal host that renders all six markdown
// styling range types (chrome manages 3/6). Styles a decoration can't
// express are approximated with theme colors; the buffer is already
// marker-free so any dropped styling degrades to plain text, never to
// garbled `**syntax**`.

import * as vscode from 'vscode';
import type { RenderDirectives } from '@opencues/runtime/dist/src/adapter';
import { coalesceRanges, type CharRange } from './pure';

type StyleKind = 'dim' | 'highlight' | 'bold' | 'italic' | 'code' | 'strike' | 'heading' | 'list';

const STYLE_DEFS: Record<StyleKind, vscode.DecorationRenderOptions> = {
  dim: { opacity: '0.55' },
  highlight: {
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editorCursor.foreground'),
  },
  bold: { fontWeight: 'bold' },
  italic: { fontStyle: 'italic' },
  code: {
    backgroundColor: new vscode.ThemeColor('textCodeBlock.background'),
    borderRadius: '3px',
  },
  strike: { textDecoration: 'line-through' },
  heading: { fontWeight: 'bold', textDecoration: 'underline' },
  list: { color: new vscode.ThemeColor('descriptionForeground') },
};

export class DecorationRenderer {
  private types = new Map<StyleKind, vscode.TextEditorDecorationType>();
  /** Per-hex loading-animation colours (rgb path of BlankLoadingAnimator). */
  private coloredTypes = new Map<string, vscode.TextEditorDecorationType>();
  private disposed = false;

  private typeFor(kind: StyleKind): vscode.TextEditorDecorationType {
    let t = this.types.get(kind);
    if (!t) {
      t = vscode.window.createTextEditorDecorationType(STYLE_DEFS[kind]);
      this.types.set(kind, t);
    }
    return t;
  }

  private coloredTypeFor(hex: string): vscode.TextEditorDecorationType {
    let t = this.coloredTypes.get(hex);
    if (!t) {
      t = vscode.window.createTextEditorDecorationType({ color: hex });
      this.coloredTypes.set(hex, t);
    }
    return t;
  }

  /** Apply one collected directive batch to the editor, wholesale. */
  paint(editor: vscode.TextEditor, directiveSets: readonly RenderDirectives[]): void {
    if (this.disposed) return;
    const doc = editor.document;
    const byKind = new Map<StyleKind, CharRange[]>();
    const byHex = new Map<string, CharRange[]>();
    const add = (kind: StyleKind, ranges: ReadonlyArray<CharRange> | undefined): void => {
      if (!ranges || ranges.length === 0) return;
      const bucket = byKind.get(kind) ?? [];
      bucket.push(...ranges);
      byKind.set(kind, bucket);
    };

    for (const d of directiveSets) {
      add('dim', d.dimRanges);
      if (d.highlight) add('highlight', [d.highlight]);
      add('bold', d.boldRanges);
      add('italic', d.italicRanges);
      add('code', d.codeRanges);
      add('strike', d.strikeRanges);
      add('heading', d.headingRanges);
      add('list', d.listRanges);
      const colored = (d as { coloredRanges?: ReadonlyArray<{ start: number; end: number; rgb?: string }> }).coloredRanges;
      if (colored) {
        for (const r of colored) {
          if (!r.rgb) continue;
          const hex = r.rgb.toLowerCase();
          const bucket = byHex.get(hex) ?? [];
          bucket.push({ start: r.start, end: r.end });
          byHex.set(hex, bucket);
        }
      }
    }

    const max = doc.getText().length;
    const toVsRanges = (ranges: CharRange[]): vscode.Range[] =>
      coalesceRanges(ranges)
        .filter(r => r.start < r.end && r.start >= 0 && r.end <= max)
        .map(r => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)));

    // Every known type gets set (possibly to []) — that IS the
    // wholesale clear of stale paint from the previous batch.
    for (const kind of Object.keys(STYLE_DEFS) as StyleKind[]) {
      editor.setDecorations(this.typeFor(kind), toVsRanges(byKind.get(kind) ?? []));
    }
    for (const [hex, type] of this.coloredTypes) {
      editor.setDecorations(type, toVsRanges(byHex.get(hex) ?? []));
    }
    for (const [hex, ranges] of byHex) {
      if (!this.coloredTypes.has(hex)) {
        editor.setDecorations(this.coloredTypeFor(hex), toVsRanges(ranges));
      }
    }
  }

  /** Remove all OpenCues paint from an editor (target switch / disable). */
  clear(editor: vscode.TextEditor): void {
    if (this.disposed) return;
    for (const t of this.types.values()) editor.setDecorations(t, []);
    for (const t of this.coloredTypes.values()) editor.setDecorations(t, []);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.types.values()) t.dispose();
    for (const t of this.coloredTypes.values()) t.dispose();
    this.types.clear();
    this.coloredTypes.clear();
  }
}
