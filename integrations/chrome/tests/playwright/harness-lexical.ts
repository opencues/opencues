// Minimal Lexical harness for Playwright. Mounts a real Lexical editor
// on #editor, exposes window.__OC.{publishTarget, replaceAllText} from
// the bootstrap, and surfaces the __lexicalEditor instance on the
// contenteditable root so the bootstrap's API-path branch can find it.
//
// Verifies the Lexical paths in real Chrome:
//   - API path: lex.update(() => { root.clear(); ... insert ... })
//   - Fallback: Ctrl+A keydown + synthetic paste

import './chrome-stub';

import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { registerHistory, createEmptyHistoryState } from '@lexical/history';
import { publishTarget, replaceAllText } from '../../src/opencues-bootstrap';

// Expose Lexical creator globals on window — the bootstrap's API-path
// detects `lex.update`, `$getRoot`, `$createParagraphNode`,
// `$createTextNode` on window.* before going down the API branch.
const w = window as unknown as Record<string, unknown>;
w.$getRoot = $getRoot;
w.$createParagraphNode = $createParagraphNode;
w.$createTextNode = $createTextNode;

const editor = createEditor({
  namespace: 'OpenCuesHarness',
  onError: (err) => { console.error('[lexical]', err); },
});

const rootEl = document.getElementById('editor')!;
rootEl.setAttribute('data-lexical-editor', 'true');
// Lexical's editor.setRootElement uses the DOM element; the bootstrap
// reaches in via target.__lexicalEditor so attach the instance.
(rootEl as unknown as { __lexicalEditor: unknown }).__lexicalEditor = editor;
editor.setRootElement(rootEl);

// Plain-text plugin gives us paste handling + selectAll keymap.
registerPlainText(editor);
// History plugin gives us Ctrl+Z / Ctrl+Y handling — without it
// Ctrl+Z is a no-op and we can't measure undo behaviour.
registerHistory(editor, createEmptyHistoryState(), 1000);

// Seed body — write 'original' via editor.update so it lands in
// Lexical's internal model.
editor.update(() => {
  const root = $getRoot();
  root.clear();
  const p = $createParagraphNode();
  p.append($createTextNode('original'));
  root.append(p);
}, { discrete: true });

// Wire the runtime — publishTarget points at the contenteditable so
// currentTarget is set, which replaceAllText reads.
publishTarget(rootEl);

(window as unknown as { __OC: unknown }).__OC = { publishTarget, replaceAllText };
(window as unknown as { __EDITOR: unknown }).__EDITOR = editor;
