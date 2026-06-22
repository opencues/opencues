// Pins the undo-stack shape of replaceAllText — the whole-body rewrite
// path used by transform-blank, fluid-blank, and generate-draft.
//
// The bug: replaceAllText currently performs a TWO-STEP write
// (wipe → paste). Each step lands a separate entry on the editor's
// native undo stack, so the user's first Ctrl+Z reverts only the
// paste, leaving the buffer EMPTY (the wipe is still in effect).
// They see a blank screen.
//
// We can't measure the real undo stack in jsdom — execCommand is a
// stub. Instead, we count the distinct "history-entry-emitting"
// operations replaceAllText emits.
//
// Operations that land a NEW undo entry on a contenteditable:
//   - execCommand('delete' | 'insertText' | 'insertHTML' | ...)
//   - dispatchEvent(ClipboardEvent('paste', ...))   ← replaces or inserts
//   - dispatchEvent(KeyboardEvent('keydown', { Backspace | Delete | Enter | char-key }))
//
// Operations that DO NOT land an undo entry (selection-only):
//   - dispatchEvent(KeyboardEvent('keydown', { Ctrl+A | Ctrl+C | arrow }))
//   - execCommand('queryCommandState' | 'selectAll')
//   - Selection / Range mutations on window.getSelection()
//
// The correct shape is ONE history-emitting op. The bug is two-or-more —
// the first Ctrl+Z reverts only the last, leaving the buffer in the
// intermediate (typically empty) state.

import { describe, it, expect, beforeEach } from 'vitest';
import { publishTarget, replaceAllText } from './opencues-bootstrap';

// jsdom 29 doesn't ship DataTransfer or a constructible ClipboardEvent.
// Without these, the bootstrap's paste-dispatch path silently catches
// + falls back to direct textContent assignment, masking the very
// bug we're trying to surface (two-step delete+paste). Shim both so
// the real path executes.
class FakeDataTransfer {
  private data = new Map<string, string>();
  setData(format: string, value: string): void { this.data.set(format, value); }
  getData(format: string): string { return this.data.get(format) ?? ''; }
}
if (typeof (globalThis as { DataTransfer?: unknown }).DataTransfer === 'undefined') {
  (globalThis as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer;
}
if (typeof (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent === 'undefined') {
  class FakeClipboardEvent extends Event {
    clipboardData: FakeDataTransfer | null;
    constructor(type: string, init?: { clipboardData?: FakeDataTransfer; bubbles?: boolean; cancelable?: boolean }) {
      super(type, { bubbles: init?.bubbles, cancelable: init?.cancelable });
      this.clipboardData = init?.clipboardData ?? null;
    }
  }
  (globalThis as unknown as { ClipboardEvent: unknown }).ClipboardEvent = FakeClipboardEvent;
}

type Op =
  | { kind: 'execCommand'; cmd: string; arg?: string }
  | { kind: 'paste'; text: string; html: string }
  | { kind: 'keydown'; key: string; ctrl: boolean };

// Keys whose keydown produces a content mutation (and therefore a
// history entry) when the editor's keymap honours it. Selection-only
// keys (Ctrl+A, Ctrl+C, arrow keys) are excluded.
const MUTATION_KEYS = new Set(['Backspace', 'Delete', 'Enter']);
function isMutationKeydown(op: Op): boolean {
  if (op.kind !== 'keydown') return false;
  if (op.ctrl) return false; // any ctrl-chord on its own is selection/copy, not a mutation
  return MUTATION_KEYS.has(op.key) || op.key.length === 1;
}

// History-emitting ops: anything that creates a new undo entry on
// the editor's native stack. The bug shape is >1; correct is ≤1.
function historyEntries(ops: Op[]): Op[] {
  return ops.filter(o => {
    if (o.kind === 'execCommand') {
      // queryCommandState is a read, not a write — no history entry.
      return o.cmd !== 'queryCommandState' && o.cmd !== 'selectAll';
    }
    if (o.kind === 'paste') return true;
    if (o.kind === 'keydown') return isMutationKeydown(o);
    return false;
  });
}

function installMutationSpy(target: HTMLElement): { ops: Op[]; restore: () => void } {
  const ops: Op[] = [];

  // jsdom doesn't ship document.execCommand (deprecated in standards).
  // Define it ourselves so the bootstrap's calls land here.
  const origExec = (document as unknown as { execCommand?: unknown }).execCommand;
  (document as unknown as { execCommand: unknown }).execCommand =
    (cmd: string, _ui?: boolean, arg?: string): boolean => {
      ops.push({ kind: 'execCommand', cmd, arg });
      // Best-effort emulation so post-state is plausible.
      if (cmd === 'delete') target.textContent = '';
      if (cmd === 'insertText' && typeof arg === 'string') target.textContent = arg;
      if (cmd === 'queryCommandState') return false;
      return true;
    };
  (document as unknown as { queryCommandState: unknown }).queryCommandState =
    (_cmd: string): boolean => false;

  const origDispatch = target.dispatchEvent.bind(target);
  target.dispatchEvent = ((e: Event): boolean => {
    if (e.type === 'paste') {
      const ce = e as ClipboardEvent;
      ops.push({
        kind: 'paste',
        text: ce.clipboardData?.getData('text/plain') ?? '',
        html: ce.clipboardData?.getData('text/html') ?? '',
      });
    } else if (e.type === 'keydown') {
      const ke = e as KeyboardEvent;
      ops.push({ kind: 'keydown', key: ke.key, ctrl: ke.ctrlKey });
    }
    return origDispatch(e);
  }) as typeof target.dispatchEvent;

  return {
    ops,
    restore: () => {
      (document as unknown as { execCommand: unknown }).execCommand = origExec;
      target.dispatchEvent = origDispatch;
    },
  };
}

function makeContentEditable(initial: string): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  el.textContent = initial;
  document.body.appendChild(el);
  return el;
}

describe('replaceAllText — undo-stack shape', () => {
  const originalLocation = window.location;
  beforeEach(() => {
    document.body.innerHTML = '';
    publishTarget(null);
    // Restore location — the Luma test mutates window.location and
    // otherwise pollutes subsequent tests' isLuma branch detection.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('generic contenteditable: emits ONE mutation op (replaces selection in a single undo entry)', () => {
    const target = makeContentEditable('original body');
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('rewritten body');

    // Bug shape: ['execCommand: delete', 'paste'] — two undo entries.
    // Fix shape: one selection-replacing op (e.g. execCommand('insertHTML' | 'insertText') OR a single paste).
    const entries = historyEntries(spy.ops);
    spy.restore();

    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it('generic contenteditable: the single op must REPLACE — not delete then insert separately', () => {
    const target = makeContentEditable('original body');
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('rewritten body');

    const isolatedDelete = spy.ops.some(
      o => o.kind === 'execCommand' && o.cmd === 'delete',
    );
    spy.restore();

    // A standalone execCommand('delete') is the smoking gun: it lands
    // its own undo entry, and the paste/insert that follows lands a
    // SECOND entry. First Ctrl+Z reverts only the second → blank screen.
    expect(isolatedDelete).toBe(false);
  });

  it('generic contenteditable: trims a TRAILING blank-line run (no compounding newlines on cycle)', () => {
    const target = makeContentEditable('seed');
    publishTarget(target);
    const spy = installMutationSpy(target);

    // A body with content + a long trailing blank-line run — the shape
    // that accumulates on Gmail when the read→write cycle feeds the
    // editor's appended placeholder back in (June 2026 "lots of newlines").
    replaceAllText('Dear Karen,\n\nBest,\nWilfred\n\n\n\n\n\n\n\n');

    const insert = spy.ops.find(o => o.kind === 'execCommand' && o.cmd === 'insertHTML') as
      | { kind: 'execCommand'; cmd: string; arg?: string } | undefined;
    spy.restore();

    expect(insert, 'generic path should write via insertHTML').toBeTruthy();
    const html = insert!.arg ?? '';
    // The interior paragraph break survives; the trailing blank run does NOT.
    expect(html).toContain('<div>Dear Karen,</div>');
    expect(html).toContain('<div>Wilfred</div>');
    // No trailing empty-block run at the end of the emitted HTML.
    expect(html).not.toMatch(/(<div><br><\/div>)+$/);
    expect(html.endsWith('<div>Wilfred</div>')).toBe(true);
  });

  it('generic contenteditable: an interior blank line (paragraph break) is preserved', () => {
    const target = makeContentEditable('seed');
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('para one\n\npara two');

    const insert = spy.ops.find(o => o.kind === 'execCommand' && o.cmd === 'insertHTML') as
      | { kind: 'execCommand'; cmd: string; arg?: string } | undefined;
    spy.restore();

    // The empty line BETWEEN paragraphs must remain (one <div><br></div>).
    expect(insert!.arg).toBe('<div>para one</div><div><br></div><div>para two</div>');
  });

  it('managed editor (ProseMirror): keyboard-sim wipe is NOT used for the default path', () => {
    // ChatGPT / LinkedIn / claude.ai shape — has .ProseMirror class.
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.classList.add('ProseMirror');
    target.textContent = 'original';
    document.body.appendChild(target);
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('rewritten');

    // Default PM path is a single execCommand('insertText', false, text)
    // on the select-all range. ONE undo entry expected.
    const entries = historyEntries(spy.ops);
    spy.restore();

    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it('Lexical (Reddit shape): does NOT split clear + paste into two undo entries', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.setAttribute('data-lexical-editor', 'true');
    target.textContent = 'original';
    document.body.appendChild(target);
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('rewritten');

    // Lexical fallback (no __lexicalEditor instance — jsdom shape):
    //   - Ctrl+A keydown    ← selection-only (NOT a history entry)
    //   - Backspace keydown ← MUTATION (one history entry)
    //   - paste dispatch     ← MUTATION (second history entry)
    //
    // Two history entries → first Ctrl+Z reverts paste → blank screen.
    // Correct shape: ONE history entry. Achieved by dropping the
    // Backspace and letting the paste's replace-selection mechanic
    // (Lexical paste handler reads the Ctrl+A-set internal selection
    // and replaces) do the clear-and-insert in a single transaction.
    const entries = historyEntries(spy.ops);
    spy.restore();
    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it('Draft.js (Twitter/X shape): does not split clear + paste into two undo entries', () => {
    // isDraftJsEditor uses el.closest('.public-DraftEditor-content'),
    // so the class must be on the target OR an ancestor.
    const wrapper = document.createElement('div');
    wrapper.className = 'public-DraftEditor-content';
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.textContent = 'original';
    wrapper.appendChild(target);
    document.body.appendChild(wrapper);
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('rewritten');

    const entries = historyEntries(spy.ops);
    spy.restore();
    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it('Luma TipTap (managed-with-paste branch): single history entry', () => {
    // Production routes Luma (lu.ma host) through the keyboard-sim
    // + paste fallback. We can't change location.hostname easily, but
    // the same branch fires whenever a managed editor needs a paste
    // dispatch (the .else after isLuma sets up identically). Mark
    // the target as a managed editor + simulate Luma's hostname so
    // the code path executes.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: 'lu.ma' },
    });
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.classList.add('ProseMirror');
    target.textContent = 'original';
    document.body.appendChild(target);
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('rewritten');

    const entries = historyEntries(spy.ops);
    spy.restore();
    expect(entries.length).toBeLessThanOrEqual(1);
  });

  // Correctness — stateless layer.
  //
  // Final-textContent assertions can't be made in jsdom: no real Lexical /
  // ProseMirror / Draft.js engine is listening for our synthetic paste +
  // keydown events, and jsdom's execCommand is a no-op. So these tests
  // verify what statelessness CAN verify: that the bootstrap issues the
  // editor-correct WRITE CALL. The browser's / editor's implementation of
  // that call is the production contract — Playwright is required to
  // verify final text. Tagged CALL-SHAPE so failures point at the right
  // remediation (the call shape changed, not the editor's response).

  it('CALL-SHAPE — generic CE: emits insertHTML carrying the new body', () => {
    const target = makeContentEditable('original body');
    publishTarget(target);
    const spy = installMutationSpy(target);
    replaceAllText('rewritten body');
    spy.restore();
    // Production contract: Chrome's execCommand('insertHTML') replaces
    // the current selection (set to select-all earlier in replaceAllText)
    // in one undo entry. Pin BOTH the command and that the arg carries
    // the new body verbatim.
    const insertHtmlOps = spy.ops.filter(
      o => o.kind === 'execCommand' && o.cmd === 'insertHTML',
    ) as Array<{ kind: 'execCommand'; cmd: string; arg?: string }>;
    expect(insertHtmlOps.length).toBe(1);
    expect(insertHtmlOps[0].arg).toContain('rewritten body');
  });

  it('CALL-SHAPE — ProseMirror: emits insertHTML carrying the new body wrapped in <p>', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.classList.add('ProseMirror');
    target.textContent = 'original';
    document.body.appendChild(target);
    publishTarget(target);
    const spy = installMutationSpy(target);
    replaceAllText('rewritten');
    spy.restore();
    // Managed-editor branch now uses insertHTML (May 2026) — fixes the
    // claude.ai 2-entry undo bug where the prior `insertText` path hit
    // a custom handleTextInput that split delete+insert into two PM
    // transactions. insertHTML's "insertReplacementText" beforeinput
    // inputType is less commonly intercepted; observed atomic on
    // claude.ai, ChatGPT, LinkedIn. Single undo entry.
    const insertHtmlOps = spy.ops.filter(
      o => o.kind === 'execCommand' && o.cmd === 'insertHTML',
    ) as Array<{ kind: 'execCommand'; cmd: string; arg?: string }>;
    expect(insertHtmlOps.length).toBe(1);
    expect(insertHtmlOps[0].arg).toContain('rewritten');
    expect(insertHtmlOps[0].arg).toContain('<p>'); // managed editors get <p>-per-line
  });

  it('CALL-SHAPE — Lexical fallback: emits Ctrl+A keydown then paste carrying the new body', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.setAttribute('data-lexical-editor', 'true');
    target.textContent = 'original';
    document.body.appendChild(target);
    publishTarget(target);
    const spy = installMutationSpy(target);
    replaceAllText('rewritten');
    spy.restore();
    // Sequence must be: Ctrl+A keydown (selection-only — Lexical's
    // keymap sets internal selection to all) → paste carrying the new
    // body (Lexical's paste handler reads selection + replaces in one
    // editor.update transaction). NO Backspace step — that would land
    // its own history entry and produce the blank-screen bug.
    const ctrlA = spy.ops.find(o => o.kind === 'keydown' && o.key === 'a' && o.ctrl);
    const backspace = spy.ops.find(o => o.kind === 'keydown' && o.key === 'Backspace');
    const pasteOps = spy.ops.filter(o => o.kind === 'paste') as Array<{ kind: 'paste'; text: string; html: string }>;
    expect(ctrlA).toBeDefined();
    expect(backspace).toBeUndefined();
    expect(pasteOps.length).toBe(1);
    expect(pasteOps[0].text).toBe('rewritten');
  });

  it('CALL-SHAPE — Draft.js: emits Ctrl+A keydown then paste with text/plain (no Backspace)', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'public-DraftEditor-content';
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.textContent = 'original';
    wrapper.appendChild(target);
    document.body.appendChild(wrapper);
    publishTarget(target);
    const spy = installMutationSpy(target);
    replaceAllText('rewritten');
    spy.restore();
    const ctrlA = spy.ops.find(o => o.kind === 'keydown' && o.key === 'a' && o.ctrl);
    const backspace = spy.ops.find(o => o.kind === 'keydown' && o.key === 'Backspace');
    const pasteOps = spy.ops.filter(o => o.kind === 'paste') as Array<{ kind: 'paste'; text: string; html: string }>;
    expect(ctrlA).toBeDefined();
    expect(backspace).toBeUndefined();
    expect(pasteOps.length).toBeGreaterThanOrEqual(1);
    expect(pasteOps[0].text).toBe('rewritten');
  });

  // Quill (LinkedIn share composer). Three-step ladder:
  //   1. PREFERRED — `__quill.clipboard.dangerouslyPasteHTML(html, 'user')`
  //      with managed-shape HTML (split on `\n\n+`, `<br>` for soft breaks).
  //      Inherits the new paragraph emission so Quill's blot tree gets
  //      single-margin paragraphs, not double-spaced from empty blocks.
  //   2. SECONDARY — `__quill.setText(condensed, 'user')` where
  //      `condensed = text.replace(/\n\n+/g, '\n')`. Used when clipboard
  //      module isn't exposed but setText is.
  //   3. FALLBACK — Ctrl+A keydown + synthetic paste with `text/html`
  //      (Quill's ClipboardModule reads HTML first, falls back to plain).
  it('Quill — preferred: calls __quill.clipboard.dangerouslyPasteHTML with managed-shape HTML', () => {
    const container = document.createElement('div');
    container.className = 'ql-container';
    const editor = document.createElement('div');
    editor.className = 'ql-editor';
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'original';
    container.appendChild(editor);
    document.body.appendChild(container);

    const pasteHtmlCalls: Array<{ html: string; source?: string }> = [];
    (container as unknown as { __quill: unknown }).__quill = {
      setText: () => true,
      clipboard: {
        dangerouslyPasteHTML: (html: string, source?: string) => {
          pasteHtmlCalls.push({ html, source });
          editor.innerHTML = html;
          return true;
        },
      },
    };

    publishTarget(editor);
    const spy = installMutationSpy(editor);

    replaceAllText('Hi\n\nHope\n\nBest,\nWilfred');

    spy.restore();
    expect(pasteHtmlCalls.length).toBe(1);
    expect(pasteHtmlCalls[0].source).toBe('user');
    // Managed-shape HTML: `<p>` per paragraph, `<br>` for soft break inside.
    expect(pasteHtmlCalls[0].html).toContain('<p>Hi</p>');
    expect(pasteHtmlCalls[0].html).toContain('<p>Hope</p>');
    expect(pasteHtmlCalls[0].html).toContain('Best,<br>Wilfred');
    // No execCommand wipe, no Ctrl+A — Quill API does it all.
    const usedCtrlA = spy.ops.some(o => o.kind === 'keydown' && o.key === 'a' && o.ctrl);
    expect(usedCtrlA).toBe(false);
  });

  it('Quill — secondary: setText with collapsed text when clipboard.dangerouslyPasteHTML is unavailable', () => {
    const container = document.createElement('div');
    container.className = 'ql-container';
    const editor = document.createElement('div');
    editor.className = 'ql-editor';
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'original';
    container.appendChild(editor);
    document.body.appendChild(container);

    const setTextCalls: Array<{ text: string; source?: string }> = [];
    (container as unknown as { __quill: unknown }).__quill = {
      // No clipboard module — exercise secondary path.
      setText: (text: string, source?: string) => {
        setTextCalls.push({ text, source });
        editor.textContent = text;
        return true;
      },
    };

    publishTarget(editor);
    const spy = installMutationSpy(editor);

    replaceAllText('Hi\n\nHope\n\nBest,\nWilfred');

    spy.restore();
    expect(setTextCalls.length).toBe(1);
    // \n\n collapsed to \n; soft break (\n in signature) preserved.
    expect(setTextCalls[0].text).toBe('Hi\nHope\nBest,\nWilfred');
    expect(setTextCalls[0].source).toBe('user');
    const usedCtrlA = spy.ops.some(o => o.kind === 'keydown' && o.key === 'a' && o.ctrl);
    expect(usedCtrlA).toBe(false);
  });

  it('Quill — fallback: selectAll via Range API + per-line insertText with mixed soft/hard breaks when no __quill is reachable', () => {
    const container = document.createElement('div');
    container.className = 'ql-container';
    const editor = document.createElement('div');
    editor.className = 'ql-editor';
    editor.setAttribute('contenteditable', 'true');
    // Empty DOM forces the fallback path: the in-place hunk fast path
    // can't run when there are no text-node segments to anchor hunks
    // against (`wordDiff('', new) → one big insertion hunk @ position 0`
    // with no segment to receive it). For populated-DOM scenarios where
    // the hunks DO fit in existing text nodes, the fast path takes over;
    // those are covered by `quill-in-place-update.test.ts`.
    container.appendChild(editor);
    document.body.appendChild(container);
    // Deliberately do NOT install __quill — exercise the fallback.

    publishTarget(editor);
    const spy = installMutationSpy(editor);

    // `Hi\n\nHope\n\nBest,\nWilfred`:
    //   - paragraphs (split on `\n\n+`): ["Hi", "Hope", "Best,\nWilfred"]
    //   - Last paragraph has TWO lines (signature soft-break).
    replaceAllText('Hi\n\nHope\n\nBest,\nWilfred');

    spy.restore();
    // Each non-empty line gets an insertText. 4 lines total.
    const insertTextOps = spy.ops.filter(
      o => o.kind === 'execCommand' && o.cmd === 'insertText',
    ) as Array<{ kind: 'execCommand'; cmd: string; arg?: string }>;
    expect(insertTextOps.length).toBe(4);
    expect(insertTextOps[0].arg).toBe('Hi');
    expect(insertTextOps[1].arg).toBe('Hope');
    expect(insertTextOps[2].arg).toBe('Best,');
    expect(insertTextOps[3].arg).toBe('Wilfred');
    // Paragraph breaks (\n\n+ in source): TWICE each to create empty
    // <p><br></p> middle block (LinkedIn's CSS collapses default <p>
    // margin so a single insertParagraph stacks tight; need the empty
    // middle to create a visible blank line).
    // 2 paragraph breaks × 2 = 4 insertParagraphs for body.
    // Soft breaks (single \n in source — signature): 1 each.
    // 1 soft break × 1 = 1 insertParagraph for signature.
    // Total: 5 insertParagraph ops.
    const insertParagraphOps = spy.ops.filter(
      o => o.kind === 'execCommand' && o.cmd === 'insertParagraph',
    );
    expect(insertParagraphOps.length).toBe(5);
    // No more insertLineBreak — LinkedIn's Quill converts it to <p>
    // anyway, so we use insertParagraph everywhere with TWICE for
    // body paragraph breaks.
    const insertLineBreakOps = spy.ops.filter(
      o => o.kind === 'execCommand' && o.cmd === 'insertLineBreak',
    );
    expect(insertLineBreakOps.length).toBe(0);
    // No synthetic Enter keydown (caused stale-cursor issues), no Ctrl+A,
    // no synthetic paste.
    const enterKeydowns = spy.ops.filter(o => o.kind === 'keydown' && o.key === 'Enter');
    expect(enterKeydowns.length).toBe(0);
    const ctrlA = spy.ops.find(o => o.kind === 'keydown' && o.key === 'a' && o.ctrl);
    expect(ctrlA).toBeUndefined();
    const pasteOps = spy.ops.filter(o => o.kind === 'paste');
    expect(pasteOps.length).toBe(0);
  });

  it('Quill — preferred path swallows dangerouslyPasteHTML errors and falls back to setText', () => {
    const container = document.createElement('div');
    container.className = 'ql-container';
    const editor = document.createElement('div');
    editor.className = 'ql-editor';
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'original';
    container.appendChild(editor);
    document.body.appendChild(container);

    let pasteHtmlCalled = false;
    const setTextCalls: Array<{ text: string }> = [];
    (container as unknown as { __quill: unknown }).__quill = {
      setText: (text: string) => {
        setTextCalls.push({ text });
        return true;
      },
      clipboard: {
        dangerouslyPasteHTML: () => {
          pasteHtmlCalled = true;
          throw new Error('linkedin internal: editor in read-only mode');
        },
      },
    };

    publishTarget(editor);
    const spy = installMutationSpy(editor);

    replaceAllText('rewritten after error');

    spy.restore();
    expect(pasteHtmlCalled).toBe(true);
    // Secondary setText path took over.
    expect(setTextCalls.length).toBe(1);
    expect(setTextCalls[0].text).toBe('rewritten after error');
  });

  it('records the actual op sequence for the generic path (diagnostic — never asserts)', () => {
    const target = makeContentEditable('original body');
    publishTarget(target);
    const spy = installMutationSpy(target);

    replaceAllText('rewritten body');

    spy.restore();
    // Surface the sequence as part of the test name so failures in the
    // assertions above carry context. console.log is intentional here.
    // eslint-disable-next-line no-console
    console.log('[diagnostic] generic-path op sequence:', JSON.stringify(spy.ops, null, 2));
    expect(spy.ops.length).toBeGreaterThan(0);
  });
});
