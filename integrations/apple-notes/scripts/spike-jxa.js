#!/usr/bin/env osascript -l JavaScript
// Phase 0 spike payload for the apple-notes integration.
// Subcommands (first argv): status | setup | read | enumerate | changed
//                         | write-body | cas-fill | attachment-check | cleanup
// Every command prints a single JSON object on stdout.
// Writes are restricted to notes inside the "OpenCues Spike" folder.

ObjC.import('stdlib');

var SPIKE_FOLDER = 'OpenCues Spike';

function out(obj) {
  return JSON.stringify(obj);
}

function notesApp() {
  return Application('Notes');
}

function findSpikeFolder(app) {
  var folders = app.folders.whose({ name: SPIKE_FOLDER });
  return folders.length > 0 ? folders[0] : null;
}

function requireSpikeNote(app, noteId) {
  var folder = findSpikeFolder(app);
  if (!folder) throw new Error('spike folder missing');
  var notes = folder.notes();
  for (var i = 0; i < notes.length; i++) {
    if (notes[i].id() === noteId) return notes[i];
  }
  throw new Error('note not in spike folder: refusing to touch it');
}

function run(argv) {
  var cmd = argv[0];
  var app;

  if (cmd === 'status') {
    // .running() is a property read on the app object; must not launch Notes.
    var running = Application('Notes').running();
    return out({ ok: true, running: running });
  }

  app = notesApp();

  if (cmd === 'setup') {
    var folder = findSpikeFolder(app);
    if (!folder) {
      folder = app.Folder({ name: SPIKE_FOLDER });
      app.folders.push(folder);
      folder = findSpikeFolder(app);
    }
    var bodyLines = [
      'spike test note',
      'plain ascii line',
      'entities: <tag> & "quotes" \'single\' — dash',
      'emoji: 😀 éèü',
      'what is the capital of france _',
      '',
      'line after blank line'
    ];
    var html = bodyLines
      .map(function (l) {
        return '<div>' + l
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;') + '</div>';
      })
      .join('');
    var note = app.Note({ body: html });
    folder.notes.push(note);
    // re-find to get a stable id
    var created = folder.notes()[folder.notes().length - 1];
    return out({ ok: true, noteId: created.id(), name: created.name() });
  }

  if (cmd === 'read') {
    var n = requireSpikeNote(app, argv[1]);
    return out({
      ok: true,
      id: n.id(),
      name: n.name(),
      plaintext: n.plaintext(),
      body: n.body(),
      modified: n.modificationDate().toISOString()
    });
  }

  if (cmd === 'enumerate') {
    // Bulk-fetch across ALL notes (all accounts) — the all-notes-scope cost probe.
    var t0 = Date.now();
    var ids = app.notes.id();
    var t1 = Date.now();
    var mods = app.notes.modificationDate();
    var t2 = Date.now();
    return out({
      ok: true,
      count: ids.length,
      idsMs: t1 - t0,
      modsMs: t2 - t1,
      sampleId: ids.length ? ids[0] : null
    });
  }

  if (cmd === 'changed') {
    // Enumerate + return plaintext ONLY for notes modified after the given ISO date.
    var since = new Date(argv[1]);
    var t0c = Date.now();
    var idsC = app.notes.id();
    var modsC = app.notes.modificationDate();
    var changed = [];
    for (var j = 0; j < idsC.length; j++) {
      if (modsC[j] > since) changed.push(j);
    }
    var texts = [];
    for (var k = 0; k < changed.length && k < 5; k++) {
      var idx = changed[k];
      var noteRef = app.notes[idx];
      try {
        texts.push({ id: idsC[idx], plaintext: noteRef.plaintext() });
      } catch (e) {
        texts.push({ id: idsC[idx], error: String(e) });
      }
    }
    return out({ ok: true, total: idsC.length, changedCount: changed.length, texts: texts, ms: Date.now() - t0c });
  }

  if (cmd === 'write-body') {
    var wn = requireSpikeNote(app, argv[1]);
    wn.body = argv[2];
    return out({ ok: true });
  }

  if (cmd === 'cas-fill') {
    // The D6 shape: re-read, verify fragment appears exactly once, splice, write.
    var cn = requireSpikeNote(app, argv[1]);
    var oldFrag = argv[2];
    var newFrag = argv[3];
    var body = cn.body();
    var first = body.indexOf(oldFrag);
    if (first === -1) return out({ ok: false, conflict: 'zero-match' });
    if (body.indexOf(oldFrag, first + 1) !== -1) return out({ ok: false, conflict: 'multi-match' });
    cn.body = body.slice(0, first) + newFrag + body.slice(first + oldFrag.length);
    return out({ ok: true, plaintextAfter: cn.plaintext() });
  }

  if (cmd === 'attachment-check') {
    // Report body HTML of a note the user manually added an attachment to.
    var an = requireSpikeNote(app, argv[1]);
    return out({ ok: true, body: an.body(), attachments: an.attachments().length });
  }

  if (cmd === 'cleanup') {
    var f = findSpikeFolder(app);
    if (!f) return out({ ok: true, deleted: 0 });
    var count = f.notes().length;
    app.delete(f);
    return out({ ok: true, deleted: count });
  }

  return out({ ok: false, error: 'unknown command: ' + cmd });
}
