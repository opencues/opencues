// Minimal Draft.js harness for Playwright. Mounts a real Draft Editor
// inside #editor and exposes window.__OC.{publishTarget, replaceAllText}
// so the test can drive the production code path.
//
// Verifies the Draft.js path of replaceAllText: Ctrl+A keydown (sets
// Draft's internal selection to whole-buffer via its keymap) → paste
// dispatch with text/plain (Draft's onPaste reads clipboardData and
// runs replaceText, replacing the selection in one history entry).

import './chrome-stub';

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Editor, EditorState, ContentState } from 'draft-js';
import { publishTarget, replaceAllText } from '../../src/opencues-bootstrap';

let editorState = EditorState.createWithContent(ContentState.createFromText('original'));

const mount = document.getElementById('editor')!;
mount.style.minHeight = '40px';

function render() {
  ReactDOM.render(
    React.createElement(Editor, {
      editorState,
      onChange: (s: EditorState) => { editorState = s; render(); },
    }),
    mount,
  );
}

render();

// Draft.js mounts a .public-DraftEditor-content node inside the host.
// The bootstrap's isDraftJsEditor uses closest('.public-DraftEditor-content'),
// so the target we publish must BE or be a descendant of that node.
// Wait one tick for React to render the editor, then publish the
// contenteditable that Draft created.
setTimeout(() => {
  const editable = mount.querySelector('[contenteditable="true"]') as HTMLElement | null;
  if (!editable) {
    console.error('[draftjs harness] no contenteditable rendered');
    return;
  }
  editable.id = 'draft-editable';
  publishTarget(editable);
  (window as unknown as { __OC: unknown }).__OC = { publishTarget, replaceAllText };
}, 50);
