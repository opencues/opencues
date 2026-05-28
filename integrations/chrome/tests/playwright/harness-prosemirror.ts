// Minimal ProseMirror harness for Playwright. Verifies the unchanged
// ProseMirror branch (execCommand('insertText') over select-all) still
// produces ONE undo entry and Ctrl+Z restores the original.

import './chrome-stub';

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Schema, DOMParser } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { publishTarget, replaceAllText } from '../../src/opencues-bootstrap';

const mySchema = new Schema({
  nodes: basicSchema.spec.nodes,
  marks: basicSchema.spec.marks,
});

const sourceDiv = document.createElement('div');
sourceDiv.innerHTML = '<p>original</p>';

const state = EditorState.create({
  doc: DOMParser.fromSchema(mySchema).parse(sourceDiv),
  plugins: [
    history(),
    keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
    keymap(baseKeymap),
  ],
});

const editorMount = document.getElementById('editor')!;
const view = new EditorView(editorMount, { state });

// PM's .ProseMirror class lands on the editable inner node. Our
// bootstrap's isManagedEditor uses closest('.ProseMirror'), so the
// target we publish needs that class on it or an ancestor.
const target = view.dom as HTMLElement;
target.id = 'pm-editable';

publishTarget(target);

(window as unknown as { __OC: unknown }).__OC = { publishTarget, replaceAllText };
(window as unknown as { __VIEW: unknown }).__VIEW = view;
