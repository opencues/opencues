#!/usr/bin/env osascript -l JavaScript
// Enumerate LIVE notes (every account) as [{id, mod}] via bulk property
// fetch, EXCLUDING Recently Deleted at the source (user decision
// 2026-07-12: opencues only focuses on notes that exist). Deleted notes
// stay in the app-wide `app.notes` collection for ~30 days, so each
// account's "Recently Deleted" folder is enumerated first and
// subtracted — inside this same osascript call, so a just-deleted note
// vanishes the very tick it's deleted (the old separate 10s exclusion
// refresh left it competing for election for up to 10s).
//
// The deleted [{id, mod}] set is returned too — the daemon warns when
// one CHANGES (typing into a deleted note is otherwise invisible
// silence), but nothing downstream ever tracks or elects one.
//
// Folder lookup is by its English name — on non-English macOS locales
// the lookup misses and `deleted` is empty (degrades to enumerating
// deleted notes as live, the pre-exclusion behaviour; never breaks).
//
// Measured 2026-07-12 (342 live + 63 deleted, 3 accounts): deleted scan
// ~125ms + bulk ids/mods ~95ms ≈ 220ms/call — ~20ms over the old
// live-only bulk fetch, minus the separate deleted-ids.js spawn.
function run() {
  var app = Application('com.apple.Notes');
  var deletedSeen = {};
  var deleted = [];
  var accounts = app.accounts();
  for (var a = 0; a < accounts.length; a++) {
    try {
      var trash = accounts[a].folders.byName('Recently Deleted');
      var dIds = trash.notes.id();
      var dMods = trash.notes.modificationDate();
      for (var i = 0; i < dIds.length; i++) {
        deletedSeen[dIds[i]] = true;
        deleted.push({ id: dIds[i], mod: dMods[i] ? dMods[i].toISOString() : null });
      }
    } catch (e) { /* folder absent (empty trash or non-English locale) */ }
  }
  var ids = app.notes.id();
  var mods = app.notes.modificationDate();
  var out = [];
  for (var j = 0; j < ids.length; j++) {
    if (deletedSeen[ids[j]]) continue;
    out.push({ id: ids[j], mod: mods[j] ? mods[j].toISOString() : null });
  }
  return JSON.stringify({ notes: out, deleted: deleted });
}
