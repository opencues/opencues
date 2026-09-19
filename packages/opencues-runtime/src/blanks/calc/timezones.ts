/**
 * Timezones — ICU (`Intl.DateTimeFormat`) does the offsets and DST; the
 * only data here is the map from the names people type (a city, a zone
 * abbreviation) to an IANA zone.
 */
import type { Calculator, CalcContext } from './types';

/** city / abbreviation → IANA zone. Lower-case keys, no punctuation. */
export const ZONES: Readonly<Record<string, string>> = {
  utc: 'UTC', gmt: 'UTC', z: 'UTC', zulu: 'UTC',
  // abbreviations (the common ones; ambiguous ones resolve to their usual reading)
  est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York', eastern: 'America/New_York',
  cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago', central: 'America/Chicago',
  mst: 'America/Denver', mdt: 'America/Denver', mt: 'America/Denver', mountain: 'America/Denver',
  pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  akst: 'America/Anchorage', hst: 'Pacific/Honolulu', ast: 'America/Halifax', nst: 'America/St_Johns',
  bst: 'Europe/London', wet: 'Europe/Lisbon', cet: 'Europe/Paris', cest: 'Europe/Paris', eet: 'Europe/Athens', eest: 'Europe/Athens', msk: 'Europe/Moscow',
  ist: 'Asia/Kolkata', pkt: 'Asia/Karachi', gst: 'Asia/Dubai', sgt: 'Asia/Singapore', hkt: 'Asia/Hong_Kong', jst: 'Asia/Tokyo', kst: 'Asia/Seoul', wib: 'Asia/Jakarta', ict: 'Asia/Bangkok',
  aest: 'Australia/Sydney', aedt: 'Australia/Sydney', acst: 'Australia/Adelaide', awst: 'Australia/Perth', nzst: 'Pacific/Auckland', nzdt: 'Pacific/Auckland',
  sast: 'Africa/Johannesburg', wat: 'Africa/Lagos', eat: 'Africa/Nairobi', cat: 'Africa/Maputo',
  brt: 'America/Sao_Paulo', art: 'America/Argentina/Buenos_Aires',
  // cities
  london: 'Europe/London', manchester: 'Europe/London', edinburgh: 'Europe/London', dublin: 'Europe/Dublin', lisbon: 'Europe/Lisbon', porto: 'Europe/Lisbon',
  paris: 'Europe/Paris', berlin: 'Europe/Berlin', munich: 'Europe/Berlin', frankfurt: 'Europe/Berlin', hamburg: 'Europe/Berlin', madrid: 'Europe/Madrid', barcelona: 'Europe/Madrid', rome: 'Europe/Rome', milan: 'Europe/Rome', amsterdam: 'Europe/Amsterdam', brussels: 'Europe/Brussels', zurich: 'Europe/Zurich', geneva: 'Europe/Zurich', vienna: 'Europe/Vienna', prague: 'Europe/Prague', warsaw: 'Europe/Warsaw', budapest: 'Europe/Budapest', copenhagen: 'Europe/Copenhagen', stockholm: 'Europe/Stockholm', oslo: 'Europe/Oslo', helsinki: 'Europe/Helsinki', athens: 'Europe/Athens', istanbul: 'Europe/Istanbul', kyiv: 'Europe/Kyiv', kiev: 'Europe/Kyiv', moscow: 'Europe/Moscow', bucharest: 'Europe/Bucharest', sofia: 'Europe/Sofia', belgrade: 'Europe/Belgrade', zagreb: 'Europe/Zagreb', reykjavik: 'Atlantic/Reykjavik', tallinn: 'Europe/Tallinn', riga: 'Europe/Riga', vilnius: 'Europe/Vilnius',
  'new york': 'America/New_York', nyc: 'America/New_York', ny: 'America/New_York', boston: 'America/New_York', washington: 'America/New_York', dc: 'America/New_York', miami: 'America/New_York', atlanta: 'America/New_York', toronto: 'America/Toronto', montreal: 'America/Toronto', ottawa: 'America/Toronto', philadelphia: 'America/New_York', detroit: 'America/Detroit',
  chicago: 'America/Chicago', houston: 'America/Chicago', dallas: 'America/Chicago', austin: 'America/Chicago', minneapolis: 'America/Chicago', 'mexico city': 'America/Mexico_City', winnipeg: 'America/Winnipeg',
  denver: 'America/Denver', phoenix: 'America/Phoenix', 'salt lake city': 'America/Denver', calgary: 'America/Edmonton', edmonton: 'America/Edmonton',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles', seattle: 'America/Los_Angeles', portland: 'America/Los_Angeles', 'san diego': 'America/Los_Angeles', 'las vegas': 'America/Los_Angeles', vancouver: 'America/Vancouver',
  anchorage: 'America/Anchorage', honolulu: 'Pacific/Honolulu', hawaii: 'Pacific/Honolulu', alaska: 'America/Anchorage',
  'sao paulo': 'America/Sao_Paulo', 'são paulo': 'America/Sao_Paulo', 'rio de janeiro': 'America/Sao_Paulo', rio: 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires', santiago: 'America/Santiago', bogota: 'America/Bogota', bogotá: 'America/Bogota', lima: 'America/Lima', caracas: 'America/Caracas', 'panama city': 'America/Panama', havana: 'America/Havana',
  cairo: 'Africa/Cairo', johannesburg: 'Africa/Johannesburg', 'cape town': 'Africa/Johannesburg', lagos: 'Africa/Lagos', nairobi: 'Africa/Nairobi', accra: 'Africa/Accra', casablanca: 'Africa/Casablanca', addis: 'Africa/Addis_Ababa', 'addis ababa': 'Africa/Addis_Ababa', algiers: 'Africa/Algiers', tunis: 'Africa/Tunis', kampala: 'Africa/Kampala', kinshasa: 'Africa/Kinshasa',
  dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', doha: 'Asia/Qatar', riyadh: 'Asia/Riyadh', jeddah: 'Asia/Riyadh', 'tel aviv': 'Asia/Jerusalem', jerusalem: 'Asia/Jerusalem', tehran: 'Asia/Tehran', baghdad: 'Asia/Baghdad', amman: 'Asia/Amman', beirut: 'Asia/Beirut', muscat: 'Asia/Muscat', kuwait: 'Asia/Kuwait', tbilisi: 'Asia/Tbilisi', yerevan: 'Asia/Yerevan', baku: 'Asia/Baku',
  mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', bangalore: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata', chennai: 'Asia/Kolkata', kolkata: 'Asia/Kolkata', hyderabad: 'Asia/Kolkata', pune: 'Asia/Kolkata', india: 'Asia/Kolkata', karachi: 'Asia/Karachi', lahore: 'Asia/Karachi', islamabad: 'Asia/Karachi', dhaka: 'Asia/Dhaka', kathmandu: 'Asia/Kathmandu', colombo: 'Asia/Colombo', tashkent: 'Asia/Tashkent', almaty: 'Asia/Almaty',
  bangkok: 'Asia/Bangkok', hanoi: 'Asia/Ho_Chi_Minh', 'ho chi minh': 'Asia/Ho_Chi_Minh', saigon: 'Asia/Ho_Chi_Minh', jakarta: 'Asia/Jakarta', bali: 'Asia/Makassar', 'kuala lumpur': 'Asia/Kuala_Lumpur', singapore: 'Asia/Singapore', manila: 'Asia/Manila', 'phnom penh': 'Asia/Phnom_Penh', yangon: 'Asia/Yangon',
  'hong kong': 'Asia/Hong_Kong', shanghai: 'Asia/Shanghai', beijing: 'Asia/Shanghai', shenzhen: 'Asia/Shanghai', guangzhou: 'Asia/Shanghai', china: 'Asia/Shanghai', taipei: 'Asia/Taipei', macau: 'Asia/Macau', tokyo: 'Asia/Tokyo', osaka: 'Asia/Tokyo', kyoto: 'Asia/Tokyo', japan: 'Asia/Tokyo', seoul: 'Asia/Seoul', busan: 'Asia/Seoul', ulaanbaatar: 'Asia/Ulaanbaatar',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', canberra: 'Australia/Sydney', brisbane: 'Australia/Brisbane', perth: 'Australia/Perth', adelaide: 'Australia/Adelaide', darwin: 'Australia/Darwin', hobart: 'Australia/Hobart', auckland: 'Pacific/Auckland', wellington: 'Pacific/Auckland', christchurch: 'Pacific/Auckland', fiji: 'Pacific/Fiji', 'port moresby': 'Pacific/Port_Moresby',
};

export function zoneFor(name: string): string | null {
  const k = name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim().replace(/^(in|at|for|the)\s+/, '').replace(/\s+time$/, '');
  if (ZONES[k]) return ZONES[k];
  // an IANA name typed as-is (`Europe/Paris`)
  if (/^[a-z_]+\/[a-z_/]+$/i.test(name.trim())) { try { new Intl.DateTimeFormat('en', { timeZone: name.trim() }); return name.trim(); } catch { return null; } }
  const m = k.match(/^(?:utc|gmt)\s*([+-]\d{1,2})(?::?(\d{2}))?$/);
  if (m) { const h = Number(m[1]); return `Etc/GMT${h <= 0 ? '+' : '-'}${Math.abs(h)}`; }   // POSIX sign inversion
  return null;
}

const parts = (d: Date, tz: string) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short', day: 'numeric', month: 'short', timeZoneName: 'short' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { clock: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`, day: `${g('weekday')} ${g('day')} ${g('month')}`, abbr: g('timeZoneName') };
};
/** the zone's UTC offset in minutes at instant `d` */
export function offsetMinutes(tz: string, d: Date): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - d.getTime()) / 60_000);
}
const fmtOffset = (min: number): string => `UTC${min >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}:${String(Math.abs(min) % 60).padStart(2, '0')}`;

/** Split `new york tokyo, paris and berlin` into zone names, consuming up to three words per name greedily. */
export function splitZones(s: string): Array<{ name: string; tz: string }> | null {
  const words = s.toLowerCase().replace(/[,/]|\band\b|\bwith\b/g, ' ').split(/\s+/).filter(Boolean);
  const out: Array<{ name: string; tz: string }> = [];
  for (let i = 0; i < words.length;) {
    let took = 0;
    for (let n = Math.min(3, words.length - i); n >= 1; n--) { const name = words.slice(i, i + n).join(' '); const tz = zoneFor(name); if (tz) { out.push({ name, tz }); took = n; break; } }
    if (!took) return null;
    i += took;
  }
  return out.length ? out : null;
}

/** The zone names found anywhere in a phrase, in order (other words skipped). */
export function splitZonesLoose(s: string): Array<{ name: string; tz: string }> {
  const words = s.toLowerCase().replace(/[,/]|\band\b|\bwith\b|\bin\b|\bat\b|\bto\b|\bfor\b|\btime\b|\bmeeting\b|\bcall\b/g, ' ').split(/\s+/).filter(Boolean);
  const out: Array<{ name: string; tz: string }> = [];
  for (let i = 0; i < words.length;) {
    let took = 0;
    for (let n = Math.min(3, words.length - i); n >= 1; n--) { const name = words.slice(i, i + n).join(' '); const tz = zoneFor(name); if (tz) { out.push({ name, tz }); took = n; break; } }
    i += took || 1;
  }
  return out;
}

/** `3pm`, `15:00`, `9.30am`, `noon`, `midnight` → minutes since midnight */
export function parseClock(s: string): number | null {
  const t = s.toLowerCase().replace(/\s+/g, '');
  if (t === 'noon' || t === 'midday') return 12 * 60;
  if (t === 'midnight') return 0;
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] ?? 0);
  if (h > 24 || mi > 59) return null;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (!m[3] && !m[2] && h <= 12 && s.trim().length <= 2) return null;   // a bare `3` is not a time
  return h * 60 + mi;
}

/** The instant at which a wall-clock time falls today in `tz` (today in that zone). */
function instantAt(clockMin: number, tz: string, ctx: CalcContext): Date {
  const now = ctx.now();
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const guess = Date.UTC(g('year'), g('month') - 1, g('day'), Math.floor(clockMin / 60), clockMin % 60);
  const off = offsetMinutes(tz, new Date(guess));
  return new Date(guess - off * 60_000);
}

export const TIMEZONES: readonly Calculator[] = [
  { id: 'time-in', family: 'timezones', keywords: ['time in', 'what time is it in', 'current time in', 'local time in'], arg: 'segment', example: ['time in tokyo', '20:30 Sat 19 Sept (GMT+9, UTC+09:00)'], miss: 'unknown place or zone',
    run(arg, ctx) { const tz = zoneFor(arg); if (!tz) return null; const d = ctx.now(); const p = parts(d, tz); return `${p.clock} ${p.day} (${p.abbr}, ${fmtOffset(offsetMinutes(tz, d))})`; } },
  { id: 'convert-time', family: 'timezones', keywords: ['convert time', 'time convert'], arg: 'segment', phrase: /^(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?|noon|midnight)\s+(?:in\s+|at\s+)?[a-z][a-z .]*?\s+(?:in|to|for)\s+[a-z].*$/i, example: ['convert time 3pm london in tokyo', '23:00 Sat 19 Sept in tokyo (GMT+9, UTC+09:00)'], miss: 'need <time> <zone> in <zone>',
    run(arg, ctx) {
      let m = arg.toLowerCase().match(/^(?:convert time\s+)?(\S+(?:\s?[ap]m)?|noon|midnight)\s+(?:in\s+|at\s+)?(.+?)\s+(?:in|to|for)\s+(.+)$/);
      if (m && (parseClock(m[1]) === null || !zoneFor(m[2]))) m = null;
      if (!m) {
        // `meeting in london 21:30 time in sf`: a clock time anywhere and two zone names in order
        const s = arg.toLowerCase(); const t = s.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?|noon|midnight)\b/);
        const zones = t ? splitZonesLoose(s.replace(t[0], ' ')) : null;
        if (!t || !zones || zones.length !== 2) return null;
        m = [s, t[1], zones[0].name, zones[1].name] as unknown as RegExpMatchArray;
      }
      const clock = parseClock(m[1]); const from = zoneFor(m[2]); const to = splitZones(m[3]);
      if (clock === null || !from || !to) return null;
      const at = instantAt(clock, from, ctx);
      return to.map(({ name, tz }) => { const p = parts(at, tz); return `${p.clock} ${p.day} in ${name} (${p.abbr}, ${fmtOffset(offsetMinutes(tz, at))})`; }).join(' · ');
    } },
  { id: 'utc-offset', family: 'timezones', keywords: ['utc offset of', 'utc offset for', 'timezone of', 'time zone of', 'gmt offset of'], arg: 'segment', example: ['utc offset of tokyo', 'UTC+09:00 (Asia/Tokyo, GMT+9)'], miss: 'unknown place or zone',
    run(arg, ctx) { const tz = zoneFor(arg); if (!tz) return null; const d = ctx.now(); return `${fmtOffset(offsetMinutes(tz, d))} (${tz}, ${parts(d, tz).abbr})`; } },
  { id: 'is-dst', family: 'timezones', keywords: ['is it dst in', 'is it daylight saving in', 'dst in', 'daylight saving in'], arg: 'segment', example: ['is it dst in london', 'yes — BST, UTC+01:00 (standard is UTC+00:00)'], miss: 'unknown place or zone',
    run(arg, ctx) { const tz = zoneFor(arg); if (!tz) return null; const d = ctx.now(); const y = d.getUTCFullYear(); const jan = offsetMinutes(tz, new Date(Date.UTC(y, 0, 1))), jul = offsetMinutes(tz, new Date(Date.UTC(y, 6, 1))); const std = Math.min(jan, jul); const cur = offsetMinutes(tz, d); if (jan === jul) return `no — ${tz} does not observe daylight saving (${fmtOffset(cur)})`; return `${cur !== std ? 'yes' : 'no'} — ${parts(d, tz).abbr}, ${fmtOffset(cur)} (standard is ${fmtOffset(std)})`; } },
  { id: 'overlap', family: 'timezones', keywords: ['overlap between', 'working hours overlap', 'office overlap'], arg: 'segment', example: ['overlap between london and new york', '14:00–17:00 london = 09:00–12:00 new york (3 h of 9–5)'], miss: 'need two places',
    run(arg, ctx) {
      const m = arg.toLowerCase().match(/^(.+?)\s+(?:and|with|,)\s+(.+)$/); if (!m) return null;
      const a = zoneFor(m[1]), b = zoneFor(m[2]); if (!a || !b) return null;
      const ref = ctx.now(); const diff = offsetMinutes(b, ref) - offsetMinutes(a, ref);   // b's clock minus a's clock
      const lo = Math.max(9 * 60, 9 * 60 - diff), hi = Math.min(17 * 60, 17 * 60 - diff);
      if (hi <= lo) return `no overlap of 9–5 (${m[2]} is ${diff >= 0 ? '+' : ''}${diff / 60} h from ${m[1]})`;
      const c = (mi: number) => `${String(Math.floor(mi / 60)).padStart(2, '0')}:${String(mi % 60).padStart(2, '0')}`;
      return `${c(lo)}–${c(hi)} ${m[1]} = ${c(lo + diff)}–${c(hi + diff)} ${m[2]} (${(hi - lo) / 60} h of 9–5)`;
    } },
  { id: 'meeting-at', family: 'timezones', keywords: ['meeting at', 'call at'], arg: 'segment', example: ['meeting at 3pm london for new york tokyo', 'London 15:00 · New York 10:00 · Tokyo 23:00'], miss: 'need <time> <zone> for <zones>',
    run(arg, ctx) {
      const m = arg.toLowerCase().match(/^(\S+(?:\s?[ap]m)?|noon|midnight)\s+(.+?)\s+(?:for|with|and)\s+(.+)$/); if (!m) return null;
      const clock = parseClock(m[1]); const from = zoneFor(m[2]); if (clock === null || !from) return null;
      const rest = splitZones(m[3]); if (!rest) return null;
      const all = [{ name: m[2].replace(/^(in|at)\s+/, ''), tz: from }, ...rest];
      const at = instantAt(clock, from, ctx);
      const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
      return all.map(({ name, tz }) => { const p = parts(at, tz); return `${cap(name)} ${p.clock}${p.day !== parts(at, from).day ? ` (${p.day})` : ''}`; }).join(' · ');
    } },
];
