// OpenCues VS Code extension — activation + host wiring.
//
// One runtime per VS Code window, re-targeted (PLAN.md D3): a single
// current-editor pointer that every adapter closure reads through;
// resetBufferState() fires on every real document switch, undo/redo,
// detected external mutation, and document close. Keys arrive as
// contributed commands (VS Code has no raw key stream) and are
// synthesized into runtime KeyEvents. Rendering is decoration-based
// (src/render.ts); writes are minimal single-range edits (src/pure.ts).
//
// Read packages/opencues-runtime/adapters/vscode/REPAIR.md before
// debugging anything here — every non-obvious contract in this file
// has a numbered entry there.

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync as fsExistsSync, appendFile as fsAppendFile } from 'node:fs';
import { boot, type BootResult } from '@opencues/runtime/dist/adapters/vscode/v1/boot';
import type { KeyEvent, LogLevel } from '@opencues/runtime/dist/src/adapter';
import { createSourceReclassifier } from '@opencues/runtime/dist/src/boot-common';
import { DecorationRenderer } from './render';
import {
  buildBlanksBundle,
  makeSpawnProcess,
  loadApiKeys,
  resolveTtsScript,
} from './host-bindings';
import {
  computeSingleRangeEdit,
  looksLikeExternalMutation,
  underWordGate,
} from './pure';

interface OpencuesConfig {
  enabled: boolean;
  languages: readonly string[];
  maxCueDocumentWords: number;
}

let bootResult: BootResult | null = null;
let renderer: DecorationRenderer | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let output: vscode.OutputChannel | null = null;

let currentEditor: vscode.TextEditor | null = null;
let currentDocKey: string | null = null;
let suspendedForMultiCursor = false;
let cachedUnderGate = true;
let config: OpencuesConfig = { enabled: true, languages: [], maxCueDocumentWords: 500 };

/** Read-after-write overlay: VS Code edits are async Promises, but the
 *  runtime's cycling writes via setText and may read getText back in
 *  the same dispatch. Until the edit's echo lands in
 *  onDidChangeTextDocument, getText serves the pending target text. */
let pendingText: string | null = null;
/** Serializes edits — concurrent TextEditor.edit calls reject. */
let editChain: Promise<void> = Promise.resolve();

const reclassifier = createSourceReclassifier();

// ─── logging ────────────────────────────────────────────────────────────

function log(level: LogLevel, msg: string, data?: unknown): void {
  try {
    let dataStr = '';
    if (data !== undefined && data !== null) {
      if (data instanceof Error) dataStr = `${data.name}: ${data.message}`;
      else if (typeof data === 'string') dataStr = data;
      else dataStr = JSON.stringify(data).slice(0, 400);
    }
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}][vscode][${level}] ${msg} ${dataStr}`;
    output?.appendLine(line);
    // Shared cross-host log — the [vscode] prefix is the multi-host
    // debugging convention (see PR #45 in the drift-bug table).
    fsAppendFile('/tmp/opencues.log', line + '\n', () => {});
  } catch { /* logging must never throw */ }
}

// ─── config / eligibility ───────────────────────────────────────────────

function readConfig(): OpencuesConfig {
  const c = vscode.workspace.getConfiguration('opencues');
  return {
    enabled: c.get<boolean>('enabled', true),
    languages: c.get<string[]>('languages', ['markdown', 'plaintext', 'git-commit', 'restructuredtext', 'latex']),
    maxCueDocumentWords: c.get<number>('maxCueDocumentWords', 500),
  };
}

function isEligibleDoc(doc: vscode.TextDocument): boolean {
  if (!config.enabled) return false;
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return false;
  return config.languages.includes(doc.languageId);
}

function recomputeGate(text: string): void {
  cachedUnderGate = underWordGate(text, config.maxCueDocumentWords);
}

// ─── target tracking (D3 / Q6) ──────────────────────────────────────────

function publishTarget(editor: vscode.TextEditor | undefined): void {
  const eligible = !!editor && isEligibleDoc(editor.document);
  if (!eligible) {
    if (currentEditor) renderer?.clear(currentEditor);
    if (currentDocKey !== null) bootResult?.resetBufferState();
    currentEditor = null;
    currentDocKey = null;
    pendingText = null;
    setContextKeys(false, false);
    return;
  }
  const key = editor.document.uri.toString();
  const docChanged = key !== currentDocKey;
  // Same document in a different (split) editor: move the pointer so
  // the active editor supplies the cursor, but do NOT reset — the
  // buffer is identical (Q6, chrome's spurious-focusin lesson).
  currentEditor = editor;
  suspendedForMultiCursor = editor.selections.length > 1;
  if (docChanged) {
    currentDocKey = key;
    pendingText = null;
    bootResult?.resetBufferState();
    recomputeGate(editor.document.getText());
    repaint();
  }
}

// ─── buffer closures ────────────────────────────────────────────────────

function getTextNow(): string {
  return pendingText ?? currentEditor?.document.getText() ?? '';
}

function cursorNow(): number {
  if (!currentEditor) return 0;
  try { return currentEditor.document.offsetAt(currentEditor.selection.active); } catch { return 0; }
}

function setCursorNow(offset: number): void {
  const editor = currentEditor;
  if (!editor) return;
  try {
    const pos = editor.document.positionAt(Math.max(0, offset));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
  } catch (err) {
    log('error', 'setCursorOffset failed', err);
  }
}

/** Serialized, reclassifier-marked, single-range edit (D12/D13/Q9). */
function applyTextEdit(newText: string, cursor?: number): void {
  const editor = currentEditor;
  if (!editor) return;
  pendingText = newText;
  reclassifier.markRuntimeWrite(newText);
  editChain = editChain.then(async () => {
    if (currentEditor !== editor) return; // target moved while queued
    const doc = editor.document;
    const edit = computeSingleRangeEdit(doc.getText(), newText);
    if (edit) {
      let ok = false;
      try {
        ok = await editor.edit(eb => {
          eb.replace(
            new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
            edit.text,
          );
        }, { undoStopBefore: true, undoStopAfter: true });
      } catch (err) {
        log('error', 'edit threw', err);
      }
      if (!ok) {
        // Q9: no blind retry, no length-comparison fallback — log,
        // drop the overlay, reset so tracked spans can't go stale.
        log('warn', 'edit rejected (editor closed / concurrent edit) — resetting buffer state');
        pendingText = null;
        bootResult?.resetBufferState();
        repaint();
        return;
      }
    } else {
      pendingText = null; // no-op write — nothing will echo
    }
    if (cursor !== undefined) setCursorNow(cursor);
    // Q10: async fills have no upcoming key dispatch — repaint now.
    repaint();
  }).catch(err => {
    log('error', 'edit chain failed', err);
    pendingText = null;
  });
}

// ─── render + context keys ──────────────────────────────────────────────

function setContextKeys(cueActive: boolean, highlightActive: boolean): void {
  void vscode.commands.executeCommand('setContext', 'opencues.cueActive', cueActive && !suspendedForMultiCursor);
  void vscode.commands.executeCommand('setContext', 'opencues.highlightActive', highlightActive && !suspendedForMultiCursor);
}

function repaint(): void {
  if (!bootResult || !currentEditor || !renderer) return;
  const sets = bootResult.collectRenderDirectives(getTextNow(), cursorNow());
  renderer.paint(currentEditor, sets);
  const hasAny = sets.some(d =>
    (d.dimRanges?.length ?? 0) > 0 || !!d.highlight ||
    ((d as { coloredRanges?: readonly unknown[] }).coloredRanges?.length ?? 0) > 0);
  const highlightActive = sets.some(d => !!d.highlight);
  setContextKeys(hasAny, highlightActive);
}

// ─── status bar (Q18/Q19) ───────────────────────────────────────────────

interface StatusPayload {
  active?: boolean;
  cueTip?: string | null;
  highlightedWord?: string;
  alts?: readonly string[];
  currentAltIndex?: number;
  cueBlank?: boolean;
  agentTask?: string | null;
}

function onStatusSnapshot(payload: StatusPayload): void {
  if (!statusItem) return;
  const agentBadge = payload.agentTask ? `[task: ${payload.agentTask}]` : null;
  let wordPart: string | null = null;
  if (payload.active) {
    const tip = payload.cueTip ?? null;
    if (payload.cueBlank) {
      wordPart = tip;
    } else if (payload.alts && payload.alts.length > 1 && payload.highlightedWord) {
      const idx = (payload.currentAltIndex ?? 0) + 1;
      const head = `${payload.highlightedWord} (${idx}/${payload.alts.length})`;
      wordPart = tip ? `${head} - ${tip}` : head;
    } else {
      wordPart = tip;
    }
  }
  const combined = wordPart && agentBadge ? `${wordPart} | ${agentBadge}` : (agentBadge ?? wordPart);
  if (combined) {
    statusItem.text = `$(lightbulb) ${combined.length > 80 ? combined.slice(0, 79) + '…' : combined}`;
    statusItem.tooltip = combined;
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

function showBootError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  log('error', 'activation failed', err);
  if (statusItem) {
    // Q18: a dead boot must be visible, not buried in a log nobody reads.
    statusItem.text = '$(warning) OpenCues failed';
    statusItem.tooltip = `OpenCues failed to activate: ${msg}\nSee Output → OpenCues and /tmp/opencues.log`;
    statusItem.show();
  }
}

// ─── key dispatch (D11) ─────────────────────────────────────────────────

function dispatch(key: 'left' | 'right' | 'up' | 'down' | 'escape'): void {
  if (!bootResult || !currentEditor || suspendedForMultiCursor) return;
  const arrows = key !== 'escape';
  const e: KeyEvent = {
    key,
    modifiers: { ctrl: arrows, alt: arrows, shift: false, meta: false },
    text: getTextNow(),
    cursorOffset: cursorNow(),
  };
  const consumed = bootResult.dispatchKey(e);
  if (consumed) repaint();
}

// ─── activation ─────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('OpenCues');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.name = 'OpenCues';
  renderer = new DecorationRenderer();
  context.subscriptions.push(output, statusItem, renderer);
  try {
    activateInner(context);
  } catch (err) {
    showBootError(err);
  }
}

function activateInner(context: vscode.ExtensionContext): void {
  config = readConfig();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const cuesHome = process.env['OPENCUES_HOME'] ?? `${os.homedir()}/.cues`;
  if (!fsExistsSync(cuesHome)) {
    log('warn', `${cuesHome} not found — run \`opencues install vscode\` (or \`opencues seed-configs\`) for the shipped cues/blanks`);
  }

  const apiKeys = loadApiKeys();
  const blanks = buildBlanksBundle(workspaceRoot, log);

  bootResult = boot({
    hostVersion: vscode.version,
    cwd: workspaceRoot ?? os.homedir(),
    getText: getTextNow,
    getCursorOffset: cursorNow,
    setText: (text) => applyTextEdit(text),
    setCursorOffset: setCursorNow,
    pushText: (text, cursor) => applyTextEdit(text, cursor),
    forceRender: () => repaint(),
    readFile: async (p) => {
      try { return await fs.readFile(p, 'utf8'); } catch { return null; }
    },
    readDir: async (p) => {
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch { return null; }
    },
    writeFile: async (p, c) => { await fs.writeFile(p, c); },
    spawnProcess: makeSpawnProcess(workspaceRoot),
    blankInvoke: blanks.blankInvoke,
    blanks: blanks.registry,
    log,
    statusSnapshotHook: (payload) => onStatusSnapshot(payload as StatusPayload),
    ttsScriptPath: resolveTtsScript(),
    ttsRate: 2,
    llmApiKey: apiKeys['GROQ_API_KEY'],
    llmEndpoint: process.env['OPENCUES_LLM_ENDPOINT'],
    llmDefaultModel: process.env['OPENCUES_LLM_MODEL'],
    llmApiKeys: apiKeys,
    // D14: over the word gate the document gets the no-cycling profile
    // (word-cues / sentence-cues / cycleable blanks pruned; FluidBlank /
    // TransformBlank / compute blanks survive). Cheap by construction
    // (REPAIR.md #9): reads cached state only.
    supportsCycling: () => currentEditor !== null && cachedUnderGate,
    supportsAgentRewrite: () => currentEditor !== null,
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => publishTarget(editor)),

    vscode.workspace.onDidChangeTextDocument(event => {
      if (!bootResult || !currentEditor || event.document !== currentEditor.document) return;
      if (event.contentChanges.length === 0) return;
      const text = event.document.getText();
      const source = reclassifier.reclassify(text, 'user');
      if (source === 'runtime') {
        if (pendingText === text) pendingText = null; // our write landed
      } else {
        if (event.reason === vscode.TextDocumentChangeReason.Undo ||
            event.reason === vscode.TextDocumentChangeReason.Redo) {
          bootResult.resetBufferState(); // authoritative — not the heuristic
        } else if (looksLikeExternalMutation(event.contentChanges.map(c => ({
          rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, textLength: c.text.length,
        })))) {
          bootResult.resetBufferState(); // Q14: formatter / paste / Copilot
        }
        recomputeGate(text);
      }
      bootResult.notifyTextChange(text, cursorNow(), source);
      repaint();
    }),

    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!bootResult || !currentEditor || e.textEditor !== currentEditor) return;
      const multi = e.selections.length > 1;
      if (multi !== suspendedForMultiCursor) {
        suspendedForMultiCursor = multi; // Q15
        repaint();
      }
      if (multi) return;
      bootResult.notifyCursorChange(getTextNow(), cursorNow(), 'user');
      repaint();
    }),

    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.toString() === currentDocKey) publishTarget(undefined);
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('opencues')) return;
      config = readConfig();
      if (currentEditor) recomputeGate(currentEditor.document.getText());
      publishTarget(vscode.window.activeTextEditor);
    }),

    vscode.commands.registerCommand('opencues.navLeft', () => dispatch('left')),
    vscode.commands.registerCommand('opencues.navRight', () => dispatch('right')),
    vscode.commands.registerCommand('opencues.cycleUp', () => dispatch('up')),
    vscode.commands.registerCommand('opencues.cycleDown', () => dispatch('down')),
    vscode.commands.registerCommand('opencues.escape', () => dispatch('escape')),
    vscode.commands.registerCommand('opencues.toggle', async () => {
      const next = !readConfig().enabled;
      await vscode.workspace.getConfiguration('opencues').update('enabled', next, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`OpenCues ${next ? 'enabled' : 'disabled'}`, 3000);
    }),
  );

  publishTarget(vscode.window.activeTextEditor);
  log('info', 'extension activated', {
    workspaceRoot,
    languages: config.languages,
    maxCueDocumentWords: config.maxCueDocumentWords,
  });
}

export function deactivate(): void {
  try { bootResult?.dispose(); } catch { /* teardown */ }
  bootResult = null;
  currentEditor = null;
  currentDocKey = null;
}
