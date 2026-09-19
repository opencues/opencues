/**
 * Device blanks on the decision layer — the runtime's policy half
 * (security-audit.md row #32).
 *
 * A decision leg may name WHICH registered blank a `_` asks for and which
 * of its CLOSED values. This file decides what may be invoked on the back
 * of such a verdict, and turns it into the same `{ action, value }` a
 * shape match produces, so the fill runs through the shape path unchanged:
 *
 *   - tier 2 only: the shipped built-ins listed here, by name; a user
 *     `impl:` / `blankScript:` blank is never selectable this way;
 *   - the value is a member of the blank's closed list, or a regex capture
 *     over the draft (a level `\d{1,3}`, a place name), never a model
 *     string — a model can only pick an id;
 *   - a captured argument passes the same floor an AI-callable arg does
 *     (length, control / URL-structure chars) before it reaches a script.
 *
 * What a package ASKS to get here is the package's; what is invocable is
 * product policy and lives here.
 */

export type DeviceAction = 'get' | 'set' | 'step';

export interface DeviceVerdict {
  /** the registered blank's name */
  readonly blank: string;
  /** the option the leg chose: a closed value (`up`, `today`, `here`) or `number` / `named` meaning "captured from the draft" */
  readonly value: string;
  readonly confidence: number;
  readonly valueConfidence: number;
  readonly top: string;
}

export interface DevicePolicyEntry {
  /** the blank's leading keyword, as its shapes accept it */
  readonly keyword: string;
  /** closed values → the shape action + value the blank's own shapes take */
  readonly values: Readonly<Record<string, { action: DeviceAction; value?: string }>>;
  /** a numeric level captured from the draft (`\d{1,3}`), as `set` */
  readonly number?: boolean;
  /** a named argument captured from the draft after the keyword-ish phrase, as `get <arg>`; the pattern must be anchored */
  readonly named?: RegExp;
}

/** Tier 2: shipped built-ins whose invocation grammar is closed or numeric. Never a user blank. */
export const DEVICE_POLICY: Readonly<Record<string, DevicePolicyEntry>> = {
  volume: { keyword: 'volume', values: { up: { action: 'step', value: 'up' }, down: { action: 'step', value: 'down' }, mute: { action: 'set', value: '0' }, current: { action: 'get' } }, number: true },
  brightness: { keyword: 'brightness', values: { up: { action: 'step', value: 'up' }, down: { action: 'step', value: 'down' }, current: { action: 'get' } }, number: true },
  // the place is what follows the last `in` / `for` / `at` before the `_` (the leg has already said a place is written)
  weather: { keyword: 'weather', values: { here: { action: 'get' }, today: { action: 'get' } }, named: /\b(?:in|for|at)\s+(?:the\s+)?([\p{L}][\p{L}\s.'-]{1,40}?)\s*(?:today|tomorrow|tonight|this week|right now)?\s*\??\s*_$/iu },
  location: { keyword: 'location', values: { here: { action: 'get' } }, named: /\b(?:of|for|to)\s+(?:the\s+)?([\p{L}][\p{L}\s.'-]{1,40}?)\s*\??\s*_$/iu },
  // the model blank's shapes capture whole phrases; the canonical commands below are ones its shapes accept verbatim
  model: { keyword: 'model', values: { current: { action: 'get', value: 'model' }, list: { action: 'get', value: 'models' }, cues: { action: 'get', value: 'cues' }, auditors: { action: 'get', value: 'auditors' }, blanks: { action: 'get', value: 'blanks' } } },
};

export const DEVICE_ARG_MAX = 60;
/** the AI-callable arg floor (security-audit #23), applied to every captured argument */
export function deviceArgWithinFloor(arg: string): boolean {
  if (!arg || arg.length > DEVICE_ARG_MAX) return false;
  if (/[\u0000-\u001f\u007f]/.test(arg)) return false;
  if (/[&?#/\\@%<>"`{}|^]/.test(arg)) return false;
  return true;
}

/** The invocation a verdict resolves to under the policy, or null when it resolves to nothing invocable. */
export function resolveDeviceInvocation(v: DeviceVerdict, draft: string): { blank: string; keyword: string; action: DeviceAction; value?: string } | null {
  const entry = DEVICE_POLICY[v.blank];
  if (!entry) return null;
  const closed = entry.values[v.value];
  if (closed) return { blank: v.blank, keyword: entry.keyword, action: closed.action, value: closed.value };
  if (v.value === 'number' && entry.number) {
    const m = draft.match(/(?:^|\D)(\d{1,3})\s*%?\s*(?:\D[^_]*)?_\s*$/);
    const n = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return { blank: v.blank, keyword: entry.keyword, action: 'set', value: String(n) };
  }
  if (v.value === 'named' && entry.named) {
    const m = draft.match(entry.named);
    const arg = m?.[1]?.trim();
    if (!arg || !deviceArgWithinFloor(arg)) return null;
    return { blank: v.blank, keyword: entry.keyword, action: 'get', value: arg };
  }
  return null;
}

/** The canonical command the blank's own shapes accept for an invocation: `volume 40 _`, `volume up _`, `weather oslo _`, `location _`, `model for cues _`. */
export function deviceCanonicalCommand(inv: { blank: string; keyword: string; action: DeviceAction; value?: string }): string {
  if (inv.blank === 'model') {
    if (inv.value === 'models') return 'models _';
    if (inv.value === 'cues' || inv.value === 'auditors' || inv.value === 'blanks') return `model for ${inv.value} _`;
    return 'model _';
  }
  return inv.value !== undefined && inv.value !== '' ? `${inv.keyword} ${inv.value} _` : `${inv.keyword} _`;
}
