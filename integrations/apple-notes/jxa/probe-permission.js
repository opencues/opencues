#!/usr/bin/env osascript -l JavaScript
// Cheap Automation-permission probe: one Apple Event (folder count).
// Success → {ok:true, running, folders}. A cached TCC deny exits 1
// with "(-1743)" on stderr — the caller classifies that (silent-deny
// trap documented in NOTES-PLATFORM.md).
function run() {
  var app = Application('com.apple.Notes');
  var running = app.running();
  var count = app.folders.length;
  return JSON.stringify({ ok: true, running: running, folders: count });
}
