#!/usr/bin/env osascript -l JavaScript
// argv[0]: note id → {id, name, mod, plaintext, body}
function run(argv) {
  var app = Application('com.apple.Notes');
  var n = app.notes.byId(argv[0]);
  return JSON.stringify({
    id: argv[0],
    name: n.name(),
    mod: n.modificationDate().toISOString(),
    plaintext: n.plaintext(),
    body: n.body(),
  });
}
