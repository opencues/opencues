#!/usr/bin/env osascript -l JavaScript
// argv[0]: JSON array of note ids → {notes: [{id, mod, plaintext} | {id, error}]}
// Per-id try/catch: a deleted or locked note must not fail the batch.
function run(argv) {
  var app = Application('com.apple.Notes');
  var ids = JSON.parse(argv[0]);
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    try {
      var n = app.notes.byId(ids[i]);
      out.push({
        id: ids[i],
        mod: n.modificationDate().toISOString(),
        plaintext: n.plaintext(),
      });
    } catch (e) {
      out.push({ id: ids[i], error: String(e) });
    }
  }
  return JSON.stringify({ notes: out });
}
