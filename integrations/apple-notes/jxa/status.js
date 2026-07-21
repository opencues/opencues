#!/usr/bin/env osascript -l JavaScript
// {running: boolean} — MUST NOT launch Notes (property read only).
function run() {
  return JSON.stringify({ running: Application('com.apple.Notes').running() });
}
