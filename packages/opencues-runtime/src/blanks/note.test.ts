import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTE_CAPS,
  NoteBlank,
  parseEntry,
  parseNotesMd,
  searchNotes,
  serialiseNotesMd,
  validateNoteWrite,
} from './note';

// In-memory IO harness — mirrors the sentinel test pattern.
function makeIO(initial: string | null = null) {
  let content = initial;
  const writes: string[] = [];
  return {
    io: {
      readFile: async () => content,
      writeFile: async (c: string) => { content = c; writes.push(c); },
    },
    writes,
    get content() { return content; },
  };
}

const FFMPEG = 'fix mp4: ffmpeg -fflags +genpts -err_detect ignore_err -i input.mp4 -c copy output.mp4';

describe('parseEntry', () => {
  it('splits label on first ": "', () => {
    const e = parseEntry(FFMPEG);
    expect(e.label).toBe('fix mp4');
    expect(e.body).toBe('ffmpeg -fflags +genpts -err_detect ignore_err -i input.mp4 -c copy output.mp4');
  });

  it('no label when no ": " or prefix too long', () => {
    expect(parseEntry('just a note').label).toBeNull();
    const long = 'x'.repeat(80) + ': body';
    expect(parseEntry(long).label).toBeNull();
  });
});

describe('parseNotesMd / serialiseNotesMd round-trip', () => {
  it('preserves hand-written header above the first bullet', () => {
    const file = '# My stuff\n\nsome prose the user wrote\n\n- one: alpha\n- two: beta\n';
    const parsed = parseNotesMd(file);
    expect(parsed.entries.map(e => e.label)).toEqual(['one', 'two']);
    const out = serialiseNotesMd(parsed.prefix, parsed.entries);
    expect(out).toContain('# My stuff');
    expect(out).toContain('some prose the user wrote');
    expect(out).toContain('- one: alpha');
  });

  it('empty/missing file gets the default header', () => {
    const parsed = parseNotesMd('');
    expect(parsed.entries).toEqual([]);
    expect(serialiseNotesMd(parsed.prefix, parsed.entries)).toBe('# Notes\n');
  });
});

describe('validateNoteWrite — the chokepoint', () => {
  it('rejects empty, control chars, over-length, over-capacity', () => {
    expect(validateNoteWrite([], { op: 'add', text: '  ' }).ok).toBe(false);
    expect(validateNoteWrite([], { op: 'add', text: 'ab' }).ok).toBe(false);
    expect(validateNoteWrite([], { op: 'add', text: 'x'.repeat(2000) }).ok).toBe(false);
    const full = Array.from({ length: DEFAULT_NOTE_CAPS.maxEntries }, (_, i) => parseEntry(`n${i}`));
    const r = validateNoteWrite(full, { op: 'add', text: 'one more' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('full');
  });

  it('duplicate add is an idempotent noop', () => {
    const entries = [parseEntry('same text')];
    const r = validateNoteWrite(entries, { op: 'add', text: 'same text' });
    expect(r.ok && r.action === 'noop').toBe(true);
  });

  it('remove drops exactly the indexed entry', () => {
    const entries = ['a', 'b', 'c'].map(parseEntry);
    const r = validateNoteWrite(entries, { op: 'remove', index: 1 });
    expect(r.ok && r.entries.map(e => e.text)).toEqual(['a', 'c']);
  });
});

describe('searchNotes — ranking', () => {
  const entries = [
    parseEntry('deploy: kubectl rollout restart deploy/api'),
    parseEntry('ffmpeg notes are here somewhere'),
    parseEntry(FFMPEG),
  ];

  it('label-prefix beats body substring; newest first within rank', () => {
    const m = searchNotes(entries, 'fix mp4');
    expect(m[0].entry.label).toBe('fix mp4');
  });

  it('all tokens must match', () => {
    expect(searchNotes(entries, 'ffmpeg kubectl')).toEqual([]);
    expect(searchNotes(entries, 'ffmpeg copy').length).toBe(1);
  });

  it('case-insensitive', () => {
    expect(searchNotes(entries, 'FFMPEG').length).toBe(2);
  });
});

describe('NoteBlank.get — verb dispatch', () => {
  it('add → confirmation + persisted bullet', async () => {
    const { io, writes } = makeIO();
    const blank = new NoteBlank(io);
    const out = await blank.get('note', ['add', ...FFMPEG.split(' ')]);
    expect(out).toBe('[note saved: fix mp4 · 1 note]');
    expect(writes.at(-1)).toContain(`- ${FFMPEG}`);
  });

  it('recall → body only (label stripped), ready to tweak', async () => {
    const { io } = makeIO(`# Notes\n\n- ${FFMPEG}\n`);
    const blank = new NoteBlank(io);
    const out = await blank.get('note', ['ffmpeg']);
    expect(out).toBe('ffmpeg -fflags +genpts -err_detect ignore_err -i input.mp4 -c copy output.mp4');
  });

  it('recall with several matches → newline list, best first', async () => {
    const { io } = makeIO('# Notes\n\n- zoom: https://zoom.us/j/1\n- standup zoom: https://zoom.us/j/2\n');
    const blank = new NoteBlank(io);
    const out = await blank.get('note', ['zoom']);
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    // label-prefix "zoom" outranks label-substring "standup zoom"
    expect(lines[0]).toBe('https://zoom.us/j/1');
  });

  it('recall miss → visible inert error', async () => {
    const { io } = makeIO('# Notes\n\n- a: b\n');
    const blank = new NoteBlank(io);
    expect(await blank.get('note', ['nothing', 'here'])).toMatch(/^\[err\] no note matches/);
  });

  it('bare note _ → recent list, labels kept, newest first, capped at 5', async () => {
    const bullets = Array.from({ length: 7 }, (_, i) => `- n${i}: v${i}`).join('\n');
    const { io } = makeIO(`# Notes\n\n${bullets}\n`);
    const blank = new NoteBlank(io);
    const lines = (await blank.get('note', [])).split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe('n6: v6');
  });

  it('delete with unique match → removes + confirms', async () => {
    const { io, writes } = makeIO(`# Notes\n\n- ${FFMPEG}\n- other: thing\n`);
    const blank = new NoteBlank(io);
    const out = await blank.get('note', ['delete', 'fix', 'mp4']);
    expect(out).toBe('[deleted: fix mp4]');
    expect(writes.at(-1)).not.toContain('ffmpeg');
    expect(writes.at(-1)).toContain('- other: thing');
  });

  it('ambiguous delete → refuses, nothing written', async () => {
    const { io, writes } = makeIO('# Notes\n\n- zoom: a\n- standup zoom: b\n');
    const blank = new NoteBlank(io);
    const out = await blank.get('note', ['delete', 'zoom']);
    expect(out).toMatch(/^\[err\] 2 notes match/);
    expect(writes).toEqual([]);
  });

  it('"remove" is a delete synonym', async () => {
    const { io } = makeIO('# Notes\n\n- solo: x\n');
    const blank = new NoteBlank(io);
    expect(await blank.get('note', ['remove', 'solo'])).toBe('[deleted: solo]');
  });

  it('empty store → helpful nudges', async () => {
    const { io } = makeIO();
    const blank = new NoteBlank(io);
    expect(await blank.get('note', [])).toMatch(/no notes yet/);
    expect(await blank.get('note', ['anything'])).toMatch(/save one with/);
  });
});
