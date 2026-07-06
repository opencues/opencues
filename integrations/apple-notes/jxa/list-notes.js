#!/usr/bin/env osascript -l JavaScript
// Enumerate ALL notes (every account) as [{id, mod}] via bulk property
// fetch — measured ~90ms for 335 notes (NOTES-PLATFORM.md).
function run() {
  var app = Application('com.apple.Notes');
  var ids = app.notes.id();
  var mods = app.notes.modificationDate();
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    out.push({ id: ids[i], mod: mods[i] ? mods[i].toISOString() : null });
  }
  return JSON.stringify({ notes: out });
}
