#!/usr/bin/env osascript -l JavaScript
// Compare-and-swap body write. Reads JSON from STDIN (bodies exceed
// argv limits): {noteId, expectedBody, newBody}.
//
// Re-reads the note and byte-compares body against expectedBody INSIDE
// this single osascript invocation, keeping the iCloud race window to
// ~150ms. On mismatch → {ok:false, conflict:'body-changed'}; the daemon
// drops the fill and resyncs on the next poll. Never writes on conflict.
ObjC.import('Foundation');

function readStdin() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
}

function run() {
  var payload = JSON.parse(readStdin());
  var app = Application('com.apple.Notes');
  var n = app.notes.byId(payload.noteId);
  var current = n.body();
  if (current !== payload.expectedBody) {
    return JSON.stringify({ ok: false, conflict: 'body-changed' });
  }
  n.body = payload.newBody;
  return JSON.stringify({ ok: true, plaintext: n.plaintext() });
}
