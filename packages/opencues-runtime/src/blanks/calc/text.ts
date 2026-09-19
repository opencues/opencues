/**
 * Text metrics & transforms over the text BEFORE the command (`arg:
 * 'buffer'`), or over an inline argument when one is written (`slug for My
 * Blog Post _`). A metric fills after the text; a transform replaces it
 * (the same gesture as a rewrite request, deterministic, `undo _` reverts).
 * The reading speed is the `reading-wpm` scalar (default 238).
 */
import type { Calculator, CalcContext } from './types';
import { fmt, withCommas } from './types';

const words = (s: string): string[] => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const sentences = (s: string): number => (s.match(/[^.!?…]+[.!?…]+(?=\s|$)/g) ?? []).length || (s.trim() ? 1 : 0);
const wpm = (ctx: CalcContext, key: string, dflt: number): number => { const v = Number(ctx.setting(key) ?? dflt); return Number.isFinite(v) && v > 0 ? v : dflt; };
const minutes = (n: number): string => n < 1 ? `${Math.max(1, Math.round(n * 60))} s` : `${Math.round(n)} min`;
const tokens = (s: string): string[] => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'vs', 'via', 'per']);
const n = (s: string, dflt: number): number => { const m = s.match(/\d+/); return m ? Number(m[0]) : dflt; };
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');

export const TEXT: readonly Calculator[] = [
  // ── metrics (fill after the text) ──
  { id: 'word-count', family: 'text', keywords: ['word count', 'words in', 'how many words', 'count words'], arg: 'buffer', example: ['word count', '12 words · 60 chars · 2 sentences · ~3 s read'], miss: 'nothing before the command to count',
    run(arg, ctx) { const w = words(arg).length; if (!arg.trim()) return null; return `${withCommas(w)} words · ${withCommas(arg.trim().length)} chars · ${sentences(arg)} sentence${sentences(arg) === 1 ? '' : 's'} · ~${minutes(w / wpm(ctx, 'reading-wpm', 238))} read`; } },
  { id: 'character-count', family: 'text', keywords: ['character count', 'char count', 'characters in', 'how many characters', 'letter count'], arg: 'buffer', example: ['character count', '60 chars (49 without spaces, 12 words)'], miss: 'nothing before the command to count',
    run(arg) { const t = arg.trim(); if (!t) return null; return `${withCommas(t.length)} chars (${withCommas(t.replace(/\s/g, '').length)} without spaces, ${withCommas(words(t).length)} words)`; } },
  { id: 'sentence-count', family: 'text', keywords: ['sentence count', 'how many sentences', 'sentences in'], arg: 'buffer', example: ['sentence count', '2 sentences (avg 6 words)'], miss: 'nothing before the command to count',
    run(arg) { if (!arg.trim()) return null; const s = sentences(arg); return `${s} sentence${s === 1 ? '' : 's'} (avg ${fmt(Math.round(words(arg).length / s * 10) / 10)} words)`; } },
  { id: 'line-count', family: 'text', keywords: ['line count', 'how many lines', 'lines in'], arg: 'buffer', example: ['line count', '1 line (1 non-empty)'], miss: 'nothing before the command to count',
    run(arg) { if (!arg.trim()) return null; const all = arg.replace(/\n$/, '').split('\n'); const ne = all.filter((l) => l.trim()).length; return `${all.length} line${all.length === 1 ? '' : 's'} (${ne} non-empty)`; } },
  { id: 'reading-time', family: 'text', keywords: ['reading time', 'time to read', 'how long to read', 'read time'], arg: 'buffer', example: ['reading time', '~3 s (12 words at 238 wpm)'], miss: 'nothing before the command to time',
    run(arg, ctx) { const w = words(arg).length; if (!w) return null; const r = wpm(ctx, 'reading-wpm', 238); return `~${minutes(w / r)} (${withCommas(w)} words at ${r} wpm)`; } },
  { id: 'speaking-time', family: 'text', keywords: ['speaking time', 'time to say', 'how long to say', 'speech time', 'talk time'], arg: 'buffer', example: ['speaking time', '~5 s (12 words at 150 wpm)'], miss: 'nothing before the command to time',
    run(arg, ctx) { const w = words(arg).length; if (!w) return null; const r = wpm(ctx, 'speaking-wpm', 150); return `~${minutes(w / r)} (${withCommas(w)} words at ${r} wpm)`; } },
  { id: 'longest-word', family: 'text', keywords: ['longest word', 'longest word in'], arg: 'buffer', example: ['longest word', 'sleeps (6)'], miss: 'nothing before the command',
    run(arg) { const ws = words(arg).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')); if (!ws.length) return null; const best = ws.reduce((a, b) => b.length > a.length ? b : a); return `${best} (${best.length})`; } },
  { id: 'most-common-word', family: 'text', keywords: ['most common word', 'most frequent word', 'top words', 'word frequency'], arg: 'buffer', example: ['most common word', 'the ×3 · dog ×2 · brown ×1'], miss: 'nothing before the command',
    run(arg) { const counts = new Map<string, number>(); for (const w of words(arg)) { const k = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); } if (!counts.size) return null; return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([w, c]) => `${w} ×${c}`).join(' · '); } },
  { id: 'count-of', family: 'text', keywords: ['count of', 'occurrences of', 'how many times does'], arg: 'buffer', example: ['count of the', 'the ×3'], miss: 'need a word to count (`count of the _`)',
    run(arg, ctx) { const needle = ctx.command.replace(/^["'“]|["'”]$/g, '').replace(/\s+(appear|occur)s?$/i, '').trim(); if (!needle || !arg.trim()) return null; const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu'); const c = (arg.match(re) ?? []).length; return `${needle} ×${c}`; } },
  // ── transforms (replace the text; with an inline argument, a normal fill) ──
  { id: 'reverse', family: 'text', keywords: ['reverse', 'reversed', 'backwards'], arg: 'buffer', inlineArg: true, transform: true, example: ['reverse for hello world', 'dlrow olleh'], miss: 'nothing to reverse',
    run(arg) { const t = arg.replace(/\n$/, ''); if (!t) return null; return [...t].reverse().join(''); } },
  { id: 'reverse-words', family: 'text', keywords: ['reverse words', 'words reversed', 'reverse word order'], arg: 'buffer', inlineArg: true, transform: true, example: ['reverse words for hello big world', 'world big hello'], miss: 'nothing to reverse',
    run(arg) { const t = arg.trim(); if (!t) return null; return t.split(/\s+/).reverse().join(' '); } },
  { id: 'slug', family: 'text', keywords: ['slug', 'slugify', 'slug for', 'url slug for'], arg: 'buffer', inlineArg: true, transform: true, example: ['slug for My Blog Post Part 2', 'my-blog-post-part-2'], miss: 'nothing to slugify',
    run(arg) { const s = arg.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); return s || null; } },
  { id: 'title-case', family: 'text', keywords: ['title case', 'titlecase', 'capitalize words', 'capitalise words'], arg: 'buffer', inlineArg: true, transform: true, example: ['title case for the lord of the rings', 'The Lord of the Rings'], miss: 'nothing to case',
    run(arg) { const t = arg.replace(/\n$/, ''); if (!t.trim()) return null; const ws = t.split(/(\s+)/); let first = true; return ws.map((w) => { if (/^\s+$/.test(w) || !w) return w; const lower = w.toLowerCase(); const out = (first || !SMALL.has(lower)) ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower; first = false; return out; }).join(''); } },
  { id: 'sentence-case', family: 'text', keywords: ['sentence case', 'sentencecase'], arg: 'buffer', inlineArg: true, transform: true, example: ['sentence case for HELLO WORLD how ARE you', 'Hello world how are you'], miss: 'nothing to case',
    run(arg) { const t = arg.replace(/\n$/, ''); if (!t.trim()) return null; return t.toLowerCase().replace(/(^\s*[a-z])|([.!?]\s+[a-z])/g, (m) => m.toUpperCase()).replace(/\bi\b/g, 'I'); } },
  { id: 'upper-case', family: 'text', keywords: ['upper case', 'uppercase', 'in caps', 'all caps', 'to upper', 'capitalize', 'capitalise'], arg: 'buffer', inlineArg: true, transform: true, example: ['upper case for hello world', 'HELLO WORLD'], miss: 'nothing to case',
    run(arg) { const t = arg.replace(/\n$/, ''); return t.trim() ? t.toUpperCase() : null; } },
  { id: 'lower-case', family: 'text', keywords: ['lower case', 'lowercase', 'to lower', 'in lowercase'], arg: 'buffer', inlineArg: true, transform: true, example: ['lower case for HELLO World', 'hello world'], miss: 'nothing to case',
    run(arg) { const t = arg.replace(/\n$/, ''); return t.trim() ? t.toLowerCase() : null; } },
  { id: 'snake-case', family: 'text', keywords: ['snake case', 'snake_case', 'snakecase', 'to snake'], arg: 'buffer', inlineArg: true, transform: true, example: ['snake case for userFirstName', 'user_first_name'], miss: 'nothing to case',
    run(arg) { const t = tokens(arg); return t.length ? t.map((w) => w.toLowerCase()).join('_') : null; } },
  { id: 'camel-case', family: 'text', keywords: ['camel case', 'camelcase', 'camelCase', 'to camel'], arg: 'buffer', inlineArg: true, transform: true, example: ['camel case for user first name', 'userFirstName'], miss: 'nothing to case',
    run(arg) { const t = tokens(arg); return t.length ? t.map((w, i) => i ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('') : null; } },
  { id: 'pascal-case', family: 'text', keywords: ['pascal case', 'pascalcase', 'PascalCase', 'to pascal'], arg: 'buffer', inlineArg: true, transform: true, example: ['pascal case for user first name', 'UserFirstName'], miss: 'nothing to case',
    run(arg) { const t = tokens(arg); return t.length ? t.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('') : null; } },
  { id: 'kebab-case', family: 'text', keywords: ['kebab case', 'kebab-case', 'kebabcase', 'to kebab', 'dash case'], arg: 'buffer', inlineArg: true, transform: true, example: ['kebab case for userFirstName', 'user-first-name'], miss: 'nothing to case',
    run(arg) { const t = tokens(arg); return t.length ? t.map((w) => w.toLowerCase()).join('-') : null; } },
  { id: 'constant-case', family: 'text', keywords: ['constant case', 'screaming snake', 'upper snake', 'to constant'], arg: 'buffer', inlineArg: true, transform: true, example: ['constant case for userFirstName', 'USER_FIRST_NAME'], miss: 'nothing to case',
    run(arg) { const t = tokens(arg); return t.length ? t.map((w) => w.toUpperCase()).join('_') : null; } },
  { id: 'strip-whitespace', family: 'text', keywords: ['strip whitespace', 'collapse whitespace', 'trim whitespace', 'remove extra spaces', 'single spaces'], arg: 'buffer', inlineArg: true, transform: true, example: ['strip whitespace for  hello   big\t world ', 'hello big world'], miss: 'nothing to strip',
    run(arg) { const t = arg.split('\n').map((l) => l.trim().replace(/[ \t]+/g, ' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim(); return t || null; } },
  { id: 'dedupe-lines', family: 'text', keywords: ['dedupe lines', 'deduplicate lines', 'unique lines', 'remove duplicate lines', 'dedupe'], arg: 'buffer', transform: true, exampleBuffer: 'b\na\nb\n', example: ['dedupe lines', 'b\na'], miss: 'no lines to dedupe',
    run(arg) { const ls = arg.replace(/\n$/, '').split('\n'); if (!ls.filter((l) => l.trim()).length) return null; const seen = new Set<string>(); return ls.filter((l) => { const k = l.trim(); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; }).join('\n'); } },
  { id: 'sort-lines', family: 'text', keywords: ['sort lines', 'sort lines desc', 'sort lines descending', 'sort lines reverse', 'sort alphabetically', 'sort lines numerically', 'sort'], arg: 'buffer', transform: true, exampleBuffer: 'b\nc\na\n', example: ['sort lines', 'a\nb\nc'], miss: 'no lines to sort',
    run(arg, ctx) { const ls = arg.replace(/\n$/, '').split('\n').filter((l) => l.trim()); if (ls.length < 2) return null; const cmd = ctx.command.toLowerCase(); const numeric = /numer/.test(cmd) || ls.every((l) => /^\s*-?\d/.test(l)); const sorted = [...ls].sort(numeric ? (a, b) => parseFloat(a) - parseFloat(b) : (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })); if (/desc|reverse|z to a|z-a/.test(cmd)) sorted.reverse(); return sorted.join('\n'); } },
  { id: 'number-lines', family: 'text', keywords: ['number the lines', 'number lines', 'numbered list', 'add line numbers'], arg: 'buffer', transform: true, exampleBuffer: 'a\nb\n', example: ['number the lines', '1. a\n2. b'], miss: 'no lines to number',
    run(arg) { const ls = arg.replace(/\n$/, '').split('\n').filter((l) => l.trim()); if (!ls.length) return null; return ls.map((l, i) => `${i + 1}. ${l.trim()}`).join('\n'); } },
  { id: 'bullet-lines', family: 'text', keywords: ['bullet the lines', 'bullet lines', 'bullet list', 'as bullets'], arg: 'buffer', transform: true, exampleBuffer: 'a\nb\n', example: ['bullet the lines', '- a\n- b'], miss: 'no lines to bullet',
    run(arg) { const ls = arg.replace(/\n$/, '').split('\n').filter((l) => l.trim()); if (!ls.length) return null; return ls.map((l) => `- ${l.trim().replace(/^[-*•]\s*|^\d+[.)]\s*/, '')}`).join('\n'); } },
  { id: 'wrap-at', family: 'text', keywords: ['wrap at', 'wrap to', 'hard wrap at', 'rewrap at'], arg: 'buffer', transform: true, example: ['wrap at 20', 'The quick brown fox\njumps over the lazy\ndog. The dog sleeps.'], miss: 'need a column (`wrap at 80 _`)',
    run(arg, ctx) { const col = n(ctx.command, 80); const t = arg.trim(); if (!t || col < 10) return null; return t.split(/\n\s*\n/).map((p) => { const out: string[] = []; let line = ''; for (const w of p.split(/\s+/)) { if (line && (line + ' ' + w).length > col) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; } if (line) out.push(line); return out.join('\n'); }).join('\n\n'); } },
  { id: 'truncate-to', family: 'text', keywords: ['truncate to', 'truncate at', 'cut to', 'first n chars', 'shorten to'], arg: 'buffer', transform: true, example: ['truncate to 11', 'The quick b…'], miss: 'need a length (`truncate to 140 _`)',
    run(arg, ctx) { const len = n(ctx.command, 140); const t = arg.trim(); if (!t) return null; if (/words?/.test(ctx.command)) { const ws = t.split(/\s+/); return ws.length <= len ? t : `${ws.slice(0, len).join(' ')}…`; } return t.length <= len ? t : `${t.slice(0, len).trimEnd()}…`; } },
  { id: 'initials', family: 'text', keywords: ['initials of', 'initials for', 'initials'], arg: 'buffer', inlineArg: true, example: ['initials of Ada King Lovelace', 'A.K.L.'], miss: 'nothing to abbreviate',
    run(arg) { const ws = words(arg); if (!ws.length) return null; return ws.map((w) => w[0].toUpperCase()).join('.') + '.'; } },
  { id: 'acronym', family: 'text', keywords: ['acronym for', 'acronym of', 'acronym'], arg: 'buffer', inlineArg: true, example: ['acronym for portable network graphics', 'PNG'], miss: 'nothing to abbreviate',
    run(arg) { const ws = words(arg).filter((w) => !SMALL.has(w.toLowerCase()) || words(arg).length <= 2); if (!ws.length) return null; return ws.map((w) => w[0].toUpperCase()).join(''); } },
  { id: 'repeat', family: 'text', keywords: ['repeat', 'repeated', 'times'], arg: 'buffer', transform: true, example: ['repeat 3 times for ab', 'ababab'], miss: 'need <text> and a count (`repeat 3 times _`)',
    run(arg, ctx) { const times = n(ctx.command, 2); const inline = ctx.command.match(/\bfor\s+(.+)$/); const t = (inline ? inline[1] : arg).replace(/\n$/, ''); if (!t || times < 1 || times > 1000) return null; return t.length * times > 20000 ? null : Array(times).fill(t).join(t.includes('\n') ? '\n' : ''); } },
  { id: 'pad-to', family: 'text', keywords: ['pad to', 'left pad', 'zero pad', 'pad left', 'pad right'], arg: 'buffer', transform: true, example: ['pad to 8 with 0 for 42', '00000042'], miss: 'need a width (`pad to 8 with 0 _`)',
    run(arg, ctx) { const width = n(ctx.command.replace(/\bfor\s+.+$/, ''), 0); const inline = ctx.command.match(/\bfor\s+(.+)$/); const t = (inline ? inline[1] : arg).trim(); if (!t || width < 1 || width > 200) return null; const ch = (ctx.command.match(/with\s+(\S)/) ?? [])[1] ?? (/zero/.test(ctx.command) ? '0' : ' '); return /right/.test(ctx.command) ? t.padEnd(width, ch) : t.padStart(width, ch); } },
  { id: 'lorem', family: 'text', keywords: ['lorem', 'lorem ipsum', 'placeholder text', 'dummy text'], arg: 'segment', optionalArg: true, generator: true, example: ['lorem 5 words', 'Lorem ipsum dolor sit amet.'], miss: '',
    run(arg) { const s = arg.toLowerCase(); const count = Math.min(500, n(s, 40)); if (/paragraph/.test(s)) { const paras = Math.min(10, count); return Array.from({ length: paras }, (_, i) => cap(LOREM.slice((i * 13) % LOREM.length).concat(LOREM).slice(0, 40).join(' ')) + '.').join('\n\n'); } const out: string[] = []; for (let i = 0; i < count; i++) out.push(LOREM[i % LOREM.length]); return cap(out.join(' ')) + '.'; } },
];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
