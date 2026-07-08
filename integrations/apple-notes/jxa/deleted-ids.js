#!/usr/bin/env osascript -l JavaScript
// Ids of notes in every account's "Recently Deleted" folder (~90ms,
// dominated by osascript spawn). Deleted notes stay in the app-wide
// `app.notes` enumeration for ~30 days; without this exclusion set a
// tracked note that gets deleted keeps competing for the active slot
// whenever sync bumps its modificationDate (observed live 2026-07-08:
// a deleted note stole the active buffer mid-resolution and the
// pending answer was discarded). Folder lookup is by its English name
// — on non-English macOS locales the lookup misses and the set is
// empty (behaviour degrades to the pre-exclusion state, never breaks).
function run() {
  var app = Application('com.apple.Notes');
  var out = [];
  var accounts = app.accounts();
  for (var a = 0; a < accounts.length; a++) {
    try {
      var ids = accounts[a].folders.byName('Recently Deleted').notes.id();
      for (var i = 0; i < ids.length; i++) out.push(ids[i]);
    } catch (e) { /* folder absent (empty trash or non-English locale) */ }
  }
  return JSON.stringify({ ids: out });
}
