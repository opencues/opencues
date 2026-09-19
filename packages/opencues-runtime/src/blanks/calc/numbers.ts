/**
 * Number formatting & number theory — words, roman numerals, bases,
 * fractions, rounding, primes, combinatorics, descriptive statistics.
 */
import type { Calculator } from './types';
import { fmt, withCommas, NUM, num } from './types';

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALE = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion'];
export function toWords(n: number): string | null {
  if (!Number.isFinite(n) || Math.abs(n) >= 1e21) return null;
  if (n === 0) return 'zero';
  const neg = n < 0; n = Math.abs(n);
  const int = Math.floor(n); const frac = n - int;
  const chunk = (x: number): string => { const h = Math.floor(x / 100), r = x % 100; const parts: string[] = []; if (h) parts.push(`${ONES[h]} hundred`); if (r < 20) { if (r) parts.push(ONES[r]); } else parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : '')); return parts.join(' and '); };
  const groups: string[] = []; let x = int, i = 0;
  while (x > 0) { const g = x % 1000; if (g) groups.unshift(`${chunk(g)}${SCALE[i] ? ` ${SCALE[i]}` : ''}`); x = Math.floor(x / 1000); i++; }
  let out = groups.join(', ');
  if (frac > 0) { const digits = String(n).split('.')[1] ?? ''; out += ` point ${[...digits].map((d) => d === '0' ? 'zero' : ONES[Number(d)]).join(' ')}`; }
  return (neg ? 'minus ' : '') + out;
}
const ROMAN: Array<[number, string]> = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function toRoman(n: number): string | null { if (!Number.isInteger(n) || n <= 0 || n >= 4000) return null; let out = ''; for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; } return out; }
export function fromRoman(s: string): number | null { const t = s.toUpperCase(); if (!/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(t) || !t) return null; let i = 0, n = 0; for (const [v, r] of ROMAN) while (t.startsWith(r, i)) { n += v; i += r.length; } return n; }
const gcd = (a: number, b: number): number => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
export function toFraction(x: number, maxDen = 10000): [number, number] {
  // continued fractions
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1, b = x;
  for (let i = 0; i < 64; i++) { const a = Math.floor(b); const h2 = a * h1 + h0, k2 = a * k1 + k0; if (k2 > maxDen) break; h0 = h1; h1 = h2; k0 = k1; k1 = k2; if (Math.abs(x - h1 / k1) < 1e-12) break; b = 1 / (b - a); if (!Number.isFinite(b)) break; }
  return [sign * h1, k1];
}
const isPrime = (n: number): boolean => { if (n < 2 || !Number.isInteger(n)) return false; if (n % 2 === 0) return n === 2; for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false; return true; };
const factors = (n: number): number[] => { const out: number[] = []; let x = n; for (let p = 2; p * p <= x; p++) while (x % p === 0) { out.push(p); x /= p; } if (x > 1) out.push(x); return out; };
const nums = (s: string): number[] => (s.match(new RegExp(NUM, 'g')) ?? []).map(num).filter(Number.isFinite);
const ordinal = (n: number): string => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const bigFact = (n: number): bigint => { let r = 1n; for (let i = 2n; i <= BigInt(n); i++) r *= i; return r; };
const choose = (n: number, k: number): number => { if (k < 0 || k > n) return 0; k = Math.min(k, n - k); let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); };
const one = (s: string): number | null => { const m = s.match(new RegExp(`^\\s*(${NUM})`)); return m ? num(m[1]) : null; };

export const NUMBERS: readonly Calculator[] = [
  { id: 'in-words', family: 'numbers', keywords: ['in words', 'spell out', 'number to words'], arg: 'segment', example: ['in words 1234567', 'one million, two hundred and thirty-four thousand, five hundred and sixty-seven'], miss: 'not a number',
    run(arg) { const n = one(arg.replace(/\bin words\b/, '')); if (n === null) return null; return toWords(n); } },
  { id: 'to-roman', family: 'numbers', keywords: ['in roman numerals', 'roman numeral for', 'to roman', 'roman'], arg: 'segment', example: ['in roman numerals 2024', 'MMXXIV'], miss: 'roman numerals cover 1–3999',
    run(arg) { const n = one(arg); if (n === null) return null; return toRoman(n); } },
  { id: 'from-roman', family: 'numbers', keywords: ['from roman', 'roman numeral', 'in numbers', 'in arabic'], arg: 'segment', example: ['from roman MCMXCIV', 'MCMXCIV = 1994'], miss: 'not a roman numeral',
    run(arg) { const m = arg.match(/\b([MDCLXVI]+)\b/i); if (!m) return null; const n = fromRoman(m[1]); return n === null ? null : `${m[1].toUpperCase()} = ${n}`; } },
  { id: 'to-base', family: 'numbers', keywords: ['in hex', 'in binary', 'in octal', 'to hex', 'to binary', 'to octal', 'in base'], arg: 'segment', keywordIsArg: true, example: ['in hex 255', '0xff (binary 11111111, octal 377)'], miss: 'need an integer',
    run(arg) { const s = arg.toLowerCase(); const m = s.match(new RegExp(String.raw`(-?\d+)`)); if (!m) return null; const n = Number(m[1]); if (!Number.isSafeInteger(n)) return null; const b = /hex/.test(s) ? 16 : /bin/.test(s) ? 2 : /oct/.test(s) ? 8 : Number((s.match(/base\s*(\d+)/) ?? [])[1] ?? 10); if (b < 2 || b > 36) return null; const sign = n < 0 ? '-' : ''; const a = Math.abs(n); const pre = b === 16 ? '0x' : b === 2 ? '0b' : b === 8 ? '0o' : `base${b} `; const main = `${sign}${pre}${a.toString(b)}`; return b === 10 ? String(n) : `${main}${b === 16 ? ` (binary ${a.toString(2)}, octal ${a.toString(8)})` : b === 2 ? ` (hex 0x${a.toString(16)}, octal ${a.toString(8)})` : ` (decimal ${n})`}`; } },
  { id: 'from-base', family: 'numbers', keywords: ['in decimal', 'to decimal', 'from hex', 'from binary', 'from octal', 'decimal of'], arg: 'segment', keywordIsArg: true, example: ['in decimal 0b1011', '11'], miss: 'need a 0x / 0b / 0o number',
    run(arg) { const m = arg.toLowerCase().match(/\b(?:0x([0-9a-f]+)|0b([01]+)|0o([0-7]+)|([0-9a-f]+)\s*(?:hex|h)|([01]{4,})\s*(?:binary|b)?)\b/); if (!m) return null; const n = m[1] ? parseInt(m[1], 16) : m[2] ? parseInt(m[2], 2) : m[3] ? parseInt(m[3], 8) : m[4] ? parseInt(m[4], 16) : parseInt(m[5], 2); return Number.isFinite(n) ? String(n) : null; } },
  { id: 'as-decimal', family: 'numbers', keywords: ['as a decimal', 'as decimal', 'to decimal fraction'], arg: 'segment', example: ['as a decimal 3/8', '0.375'], miss: 'need a fraction like 3/8',
    run(arg) { const m = arg.match(new RegExp(String.raw`(${NUM})\s*/\s*(${NUM})`)); if (!m) return null; const d = num(m[2]); if (d === 0) return null; return fmt(num(m[1]) / d); } },
  { id: 'as-fraction', family: 'numbers', keywords: ['as a fraction', 'as fraction', 'to fraction'], arg: 'segment', example: ['as a fraction 0.375', '3/8'], miss: 'not a number',
    run(arg) { const n = one(arg); if (n === null) return null; const [p, q] = toFraction(n); const whole = Math.trunc(p / q), rem = Math.abs(p % q); return q === 1 ? String(p) : Math.abs(p) > q ? `${whole} ${rem}/${q} (${p}/${q})` : `${p}/${q}`; } },
  { id: 'as-percent', family: 'numbers', keywords: ['as a percent', 'as percent', 'as a percentage', 'to percent'], arg: 'segment', example: ['as a percent 0.375', '37.5%'], miss: 'not a number or fraction',
    run(arg) { const f = arg.match(new RegExp(String.raw`(${NUM})\s*/\s*(${NUM})`)); const v = f ? num(f[1]) / num(f[2]) : one(arg); if (v === null || !Number.isFinite(v)) return null; return `${fmt(v * 100)}%`; } },
  { id: 'scientific', family: 'numbers', keywords: ['in scientific notation', 'scientific notation', 'in standard form'], arg: 'segment', example: ['in scientific notation 123456', '1.23456e5 (1.23456 × 10^5)'], miss: 'not a number',
    run(arg) { const n = one(arg); if (n === null) return null; const e = n.toExponential(); const [m, x] = e.split('e'); return `${m}e${Number(x)} (${m} × 10^${Number(x)})`; } },
  { id: 'round', family: 'numbers', keywords: ['round', 'rounded'], arg: 'segment', example: ['round 3.14159 to 2 decimals', '3.14'], miss: 'need <number> to <n> decimals',
    run(arg) { const m = arg.toLowerCase().match(new RegExp(String.raw`(${NUM})\s+to\s+(?:the\s+)?(?:(\d+)\s*(?:decimals?|dp|decimal places?|places?)|nearest\s+(${NUM}|ten|hundred|thousand|integer|whole))`)); if (!m) return null; const n = num(m[1]); if (m[2] !== undefined) return n.toFixed(Number(m[2])); const unit = m[3] === 'ten' ? 10 : m[3] === 'hundred' ? 100 : m[3] === 'thousand' ? 1000 : m[3] === 'integer' || m[3] === 'whole' ? 1 : num(m[3]); return fmt(Math.round(n / unit) * unit); } },
  { id: 'sig-figs', family: 'numbers', keywords: ['significant figures', 'sig figs', 'to sf'], arg: 'segment', example: ['significant figures 0.00123456 to 3', '0.00123'], miss: 'need <number> to <n>',
    run(arg) { const m = arg.match(new RegExp(String.raw`(${NUM}).*?(\d+)\s*$`)); if (!m) return null; const sf = Number(m[2]); if (sf < 1 || sf > 21) return null; return Number(num(m[1]).toPrecision(sf)).toString(); } },
  { id: 'ordinal', family: 'numbers', keywords: ['ordinal for', 'ordinal of', 'ordinal'], arg: 'segment', example: ['ordinal for 22', '22nd'], miss: 'need a whole number',
    run(arg) { const n = one(arg); if (n === null || !Number.isInteger(n) || n < 0) return null; return ordinal(n); } },
  { id: 'with-commas', family: 'numbers', keywords: ['with commas', 'with thousands separators', 'format number'], arg: 'segment', example: ['with commas 1234567', '1,234,567'], miss: 'not a number',
    run(arg) { const m = arg.match(/-?\d+(?:\.\d+)?/); if (!m) return null; return withCommas(m[0]); } },
  { id: 'in-millions', family: 'numbers', keywords: ['in millions', 'in billions', 'in thousands', 'in lakhs', 'in crores', 'short form'], arg: 'segment', keywordIsArg: true, example: ['in millions 2500000', '2.5 million'], miss: 'not a number',
    run(arg) { const n = nums(arg)[0] ?? null; if (n === null) return null; const s = arg.toLowerCase(); if (/lakh/.test(s)) return `${fmt(n / 1e5)} lakh`; if (/crore/.test(s)) return `${fmt(n / 1e7)} crore`; if (/thousand/.test(s)) return `${fmt(n / 1e3)} thousand`; if (/billion/.test(s)) return `${fmt(n / 1e9)} billion`; const a = Math.abs(n); const [d, w] = a >= 1e12 ? [1e12, 'trillion'] : a >= 1e9 ? [1e9, 'billion'] : a >= 1e6 ? [1e6, 'million'] : [1e3, 'thousand']; return `${fmt(n / d)} ${w}`; } },
  { id: 'factorial', family: 'numbers', keywords: ['factorial of', 'factorial'], arg: 'segment', example: ['factorial of 10', '3,628,800'], miss: 'need a whole number up to 170',
    run(arg) { const n = one(arg); if (n === null || !Number.isInteger(n) || n < 0 || n > 170) return null; const r = bigFact(n).toString(); return r.length > 30 ? `${r.slice(0, 12)}… (${r.length} digits)` : withCommas(r); } },
  { id: 'is-prime', family: 'numbers', keywords: ['is prime', 'is it prime', 'prime check'], arg: 'segment', example: ['is prime 97', '97 is prime'], miss: 'need a whole number',
    run(arg) { const n = nums(arg)[0] ?? null; if (n === null || !Number.isInteger(n) || n > 1e15) return null; if (isPrime(n)) return `${n} is prime`; const f = factors(n); return `${n} is not prime${n > 1 ? ` (${f.join(' × ')})` : ''}`; } },
  { id: 'prime-factors', family: 'numbers', keywords: ['prime factors of', 'factorise', 'factorize', 'factors of'], arg: 'segment', example: ['prime factors of 360', '2 × 2 × 2 × 3 × 3 × 5 (2³ · 3² · 5)'], miss: 'need a whole number > 1',
    run(arg) { const n = one(arg); if (n === null || !Number.isInteger(n) || n < 2 || n > 1e15) return null; const f = factors(n); const counts = new Map<number, number>(); for (const p of f) counts.set(p, (counts.get(p) ?? 0) + 1); const sup = (k: number) => k === 1 ? '' : String(k).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]); return `${f.join(' × ')}${f.length > 1 ? ` (${[...counts].map(([p, k]) => `${p}${sup(k)}`).join(' · ')})` : ' (prime)'}`; } },
  { id: 'gcd', family: 'numbers', keywords: ['gcd of', 'gcd', 'hcf of', 'greatest common divisor of', 'highest common factor of'], arg: 'segment', example: ['gcd of 48 and 180', '12'], miss: 'need two or more whole numbers',
    run(arg) { const xs = nums(arg).filter(Number.isInteger); if (xs.length < 2) return null; return String(xs.reduce(gcd)); } },
  { id: 'lcm', family: 'numbers', keywords: ['lcm of', 'lcm', 'lowest common multiple of', 'least common multiple of'], arg: 'segment', example: ['lcm of 4 and 6', '12'], miss: 'need two or more whole numbers',
    run(arg) { const xs = nums(arg).filter((x) => Number.isInteger(x) && x !== 0); if (xs.length < 2) return null; return fmt(xs.reduce((a, b) => Math.abs(a * b) / gcd(a, b))); } },
  { id: 'fibonacci', family: 'numbers', keywords: ['fibonacci', 'fib'], arg: 'segment', example: ['fibonacci 20', '6,765'], miss: 'need n up to 1000',
    run(arg) { const n = one(arg); if (n === null || !Number.isInteger(n) || n < 0 || n > 1000) return null; let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; const s = a.toString(); return s.length > 30 ? `${s.slice(0, 12)}… (${s.length} digits)` : withCommas(s); } },
  { id: 'nth-root', family: 'numbers', keywords: ['cube root of', 'nth root', 'root of'], arg: 'segment', keywordIsArg: true, example: ['cube root of 27', '3'], miss: 'need <n>th root of <x>',
    run(arg) { const s = arg.toLowerCase(); let m = s.match(new RegExp(String.raw`^(?:(\d+)(?:st|nd|rd|th)?\s+root of|cube root of|square root of)\s+(${NUM})$`)); if (!m) { m = s.match(new RegExp(String.raw`^root of\s+(${NUM})$`)); if (m) m = [m[0], '2', m[1]]; } if (!m) return null; const k = /cube/.test(s) ? 3 : /square/.test(s) ? 2 : Number(m[1] ?? 2); const x = num(m[2]); if (x < 0 && k % 2 === 0) return null; const r = Math.sign(x) * Math.pow(Math.abs(x), 1 / k); return fmt(Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : r); } },
  { id: 'log', family: 'numbers', keywords: ['log base', 'log of', 'log', 'ln of', 'ln'], arg: 'segment', keywordIsArg: true, example: ['log base 2 of 1024', '10'], miss: 'need log base <b> of <x>, log <x>, or ln <x>',
    run(arg) { const s = arg.toLowerCase(); let m = s.match(new RegExp(String.raw`^log(?:\s*base)?\s*(${NUM})\s+of\s+(${NUM})$`)); let r: number; if (m) r = Math.log(num(m[2])) / Math.log(num(m[1])); else if ((m = s.match(new RegExp(String.raw`^(?:log(?:10)?(?:\s+of)?)\s+(${NUM})$`)))) r = Math.log10(num(m[1])); else if ((m = s.match(new RegExp(String.raw`^ln(?:\s+of)?\s+(${NUM})$`)))) r = Math.log(num(m[1])); else return null; if (!Number.isFinite(r)) return null; return fmt(Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : r); } },
  { id: 'stats', family: 'numbers', keywords: ['mean of', 'median of', 'mode of', 'stdev of', 'standard deviation of', 'average of', 'stats of', 'variance of', 'range of'], arg: 'segment', keywordIsArg: true, example: ['stats of 3 5 8 13', 'mean 7.25 · median 6.5 · sd 4.35 · min 3 · max 13 · n 4'], miss: 'need two or more numbers',
    run(arg) { const s = arg.toLowerCase(); const xs = nums(arg); if (xs.length < 1) return null; const n = xs.length; const mean = xs.reduce((a, b) => a + b, 0) / n; const sorted = [...xs].sort((a, b) => a - b); const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1); const sd = Math.sqrt(variance); const counts = new Map<number, number>(); for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1); const maxC = Math.max(...counts.values()); const modes = [...counts].filter(([, c]) => c === maxC).map(([v]) => v); if (/^(mean|average)/.test(s)) return fmt(mean); if (/^median/.test(s)) return fmt(median); if (/^mode/.test(s)) return maxC === 1 ? 'no mode' : modes.map(fmt).join(', '); if (/^(stdev|standard)/.test(s)) return `${fmt(sd)} (sample sd; population ${fmt(Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n))})`; if (/^variance/.test(s)) return fmt(variance); if (/^range/.test(s)) return `${fmt(sorted[n - 1] - sorted[0])} (${fmt(sorted[0])} to ${fmt(sorted[n - 1])})`; return `mean ${fmt(mean)} · median ${fmt(median)} · sd ${fmt(Math.round(sd * 100) / 100)} · min ${fmt(sorted[0])} · max ${fmt(sorted[n - 1])} · n ${n}`; } },
  { id: 'sum-of', family: 'numbers', keywords: ['sum of', 'total of', 'add up'], arg: 'segment', example: ['sum of 1 to 100', '5050'], miss: 'need numbers, or <a> to <b>',
    run(arg) { const m = arg.match(new RegExp(String.raw`(${NUM})\s+(?:to|through|\.\.)\s+(${NUM})`)); if (m) { const a = num(m[1]), b = num(m[2]); if (!Number.isInteger(a) || !Number.isInteger(b)) return null; return fmt((b - a + 1) * (a + b) / 2); } const xs = nums(arg); if (xs.length < 2) return null; return fmt(xs.reduce((a, b) => a + b, 0)); } },
  { id: 'choose', family: 'numbers', keywords: ['choose', 'combinations', 'permutations', 'ncr', 'npr'], arg: 'segment', keywordIsArg: true, phrase: /^\d+\s*(?:choose|ncr|npr|c|p)\s*\d+$/i, example: ['5 choose 2', '10 combinations (20 permutations)'], miss: 'need <n> choose <k>',
    run(arg) { const s = arg.toLowerCase(); const m = s.match(/(\d+)\s*(?:choose|c|ncr|combinations of|combinations|p|npr|permutations of|permutations)\s*(\d+)/) ?? s.match(/(?:combinations|permutations)\s+(?:of\s+)?(\d+)\s+(?:from|of|out of)\s+(\d+)/); if (!m) return null; let n = Number(m[1]), k = Number(m[2]); if (/\b(from|of|out of)\b/.test(s) && !/choose/.test(s)) [n, k] = [k, n]; if (k > n || n > 1000) return null; const c = choose(n, k); const p = c * Number(bigFact(k) > 1e15 ? NaN : bigFact(k)); return /perm|npr|\bp\b/.test(s) ? `${withCommas(p)} permutations` : `${withCommas(c)} combinations${Number.isFinite(p) ? ` (${withCommas(p)} permutations)` : ''}`; } },
  { id: 'probability', family: 'numbers', keywords: ['probability of', 'chance of', 'odds of'], arg: 'segment', example: ['probability of 3 heads in 5 flips', '31.25% (10/32) exactly · 50% at least 3'], miss: 'need <k> heads in <n> flips, or <k> sixes in <n> rolls',
    run(arg) { const m = arg.toLowerCase().match(/(\d+)\s+(heads?|tails?|sixes|ones|twos|threes|fours|fives)\s+(?:in|out of|from)\s+(\d+)/); if (!m) return null; const k = Number(m[1]), n = Number(m[3]); const p = /head|tail/.test(m[2]) ? 0.5 : 1 / 6; if (k > n || n > 1000) return null; const exact = choose(n, k) * p ** k * (1 - p) ** (n - k); let atLeast = 0; for (let i = k; i <= n; i++) atLeast += choose(n, i) * p ** i * (1 - p) ** (n - i); const frac = p === 0.5 ? ` (${choose(n, k)}/${2 ** n})` : ''; return `${fmt(Math.round(exact * 10000) / 100)}%${frac} exactly · ${fmt(Math.round(atLeast * 10000) / 100)}% at least ${k}`; } },
];
