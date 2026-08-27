/**
 * fluid-blank-replace — detection case suite.
 *
 * The question this suite answers: given a buffer with `_`, can a model
 * accurately DETECT when the ask is replacement-shaped (the answer should
 * replace an exact existing substring of the buffer) versus a plain fill
 * (splice at the `_` slot) versus no action (UI placeholder)?
 *
 * Labels:
 *   fill    — plain lookup; the existing fused SPAN/ANSWER path handles it.
 *   replace — the answer must replace `target`, an exact contiguous
 *             substring of the input that is NOT the query phrase itself.
 *   none    — `_` is a placeholder; no action.
 *
 * `targetAlternates` admits defensible target boundaries (with/without
 * trailing punctuation, wider phrase containing the value).
 * `values` is informational-only grading (headline metrics are CLASS and
 * TARGET) — deliberately synthetic-leaning where possible per the repo's
 * fixture rule; realistic values appear only where the detection task
 * requires a plausible wrong-value in the buffer.
 */

export interface ReplaceDetectCase {
  id: string;
  category: string;
  input: string;
  expected: {
    cls: 'fill' | 'replace' | 'none';
    target?: string;
    targetAlternates?: string[];
    values?: string[];
  };
}

export const CASES: ReplaceDetectCase[] = [
  // ── replace / spelling-fix ────────────────────────────────────────────
  {
    id: 'r-spell-1', category: 'replace/spelling',
    input: 'her name is Sarha fix the spelling _',
    expected: { cls: 'replace', target: 'Sarha', values: ['Sarah'] },
  },
  {
    id: 'r-spell-2', category: 'replace/spelling',
    input: 'we visited the resteraunt yesterday, fix that word _',
    expected: { cls: 'replace', target: 'resteraunt', values: ['restaurant'] },
  },
  {
    id: 'r-spell-3', category: 'replace/spelling',
    input: 'the package is called lodahs correct the typo _ then install it',
    expected: { cls: 'replace', target: 'lodahs', values: ['lodash'] },
  },
  {
    id: 'r-spell-4', category: 'replace/spelling',
    input: 'dear Mr Thmopson, spell his name right _',
    expected: { cls: 'replace', target: 'Thmopson', values: ['Thompson'] },
  },
  {
    id: 'r-spell-5', category: 'replace/spelling',
    input: 'meet me on Wendesday fix spelling _',
    expected: { cls: 'replace', target: 'Wendesday', values: ['Wednesday'] },
  },

  // ── replace / fact-correction ─────────────────────────────────────────
  {
    id: 'r-fact-1', category: 'replace/fact',
    input: 'the capital of germany is munich, fix that _',
    expected: { cls: 'replace', target: 'munich', values: ['Berlin', 'berlin'] },
  },
  {
    id: 'r-fact-2', category: 'replace/fact',
    input: 'water boils at 90 degrees celsius. correct the number _',
    expected: { cls: 'replace', target: '90', values: ['100'] },
  },
  {
    id: 'r-fact-3', category: 'replace/fact',
    input: 'the moon landing was in 1972, put the right year _',
    expected: { cls: 'replace', target: '1972', values: ['1969'] },
  },
  {
    id: 'r-fact-4', category: 'replace/fact',
    input: 'notes: HTTP 402 means not found. fix the code _',
    expected: { cls: 'replace', target: '402', values: ['404'] },
  },
  {
    id: 'r-fact-5', category: 'replace/fact',
    input: 'a hexagon has five sides — correct that _',
    expected: { cls: 'replace', target: 'five', values: ['six', '6'] },
  },

  // ── replace / format-case ─────────────────────────────────────────────
  {
    id: 'r-fmt-1', category: 'replace/format',
    input: 'the ticker is aapl uppercase it _',
    expected: { cls: 'replace', target: 'aapl', values: ['AAPL'] },
  },
  {
    id: 'r-fmt-2', category: 'replace/format',
    input: 'color is FF0000 make it lowercase _ for the linter',
    expected: { cls: 'replace', target: 'FF0000', values: ['ff0000'] },
  },
  {
    id: 'r-fmt-3', category: 'replace/format',
    input: 'the date 3/14/2026 — write that in ISO format _',
    expected: { cls: 'replace', target: '3/14/2026', values: ['2026-03-14'] },
  },
  {
    id: 'r-fmt-4', category: 'replace/format',
    input: 'phone is 5551234567 add dashes _',
    expected: { cls: 'replace', target: '5551234567', values: ['555-123-4567'] },
  },

  // ── replace / unit-in-place ───────────────────────────────────────────
  {
    id: 'r-unit-1', category: 'replace/unit',
    input: 'oven at 425F — make that celsius _',
    expected: { cls: 'replace', target: '425F', targetAlternates: ['425'], values: ['218C', '220C', '218', '220', '218°C', '220°C'] },
  },
  {
    id: 'r-unit-2', category: 'replace/unit',
    input: 'the trail is 5 miles long, convert to km _',
    expected: { cls: 'replace', target: '5 miles', targetAlternates: ['5'], values: ['8 km', '8km', '8.05 km', '8'] },
  },
  {
    id: 'r-unit-3', category: 'replace/unit',
    input: 'weight limit 50 lbs — switch that to kg _',
    expected: { cls: 'replace', target: '50 lbs', targetAlternates: ['50'], values: ['22.7 kg', '23 kg', '22.68 kg', '22.7'] },
  },
  {
    id: 'r-unit-4', category: 'replace/unit',
    input: 'budget is 200 dollars put it in euros _ roughly',
    expected: { cls: 'replace', target: '200 dollars', targetAlternates: ['200'], values: ['euros', 'EUR'] },
  },

  // ── replace / value-update ────────────────────────────────────────────
  {
    id: 'r-upd-1', category: 'replace/update',
    input: 'meeting at 3pm — push it an hour _',
    expected: { cls: 'replace', target: '3pm', values: ['4pm', '4 pm'] },
  },
  {
    id: 'r-upd-2', category: 'replace/update',
    input: 'version 2.4.0 in the header, bump the minor _',
    expected: { cls: 'replace', target: '2.4.0', values: ['2.5.0'] },
  },
  {
    id: 'r-upd-3', category: 'replace/update',
    input: 'the recipe serves 4, double it _',
    expected: { cls: 'replace', target: '4', values: ['8'] },
  },
  {
    id: 'r-upd-4', category: 'replace/update',
    input: 'deadline friday, move it to the next business day _',
    expected: { cls: 'replace', target: 'friday', values: ['monday', 'Monday'] },
  },
  {
    id: 'r-upd-5', category: 'replace/update',
    input: 'quantity: 12 — knock off a quarter _',
    expected: { cls: 'replace', target: '12', values: ['9'] },
  },

  // ── replace / math-fix ────────────────────────────────────────────────
  {
    id: 'r-math-1', category: 'replace/math',
    input: 'so 7 x 8 = 54, fix the result _',
    expected: { cls: 'replace', target: '54', values: ['56'] },
  },
  {
    id: 'r-math-2', category: 'replace/math',
    input: 'split: 120 / 4 = 40 per person. correct that _',
    expected: { cls: 'replace', target: '40', values: ['30'] },
  },
  {
    id: 'r-math-3', category: 'replace/math',
    input: 'the total 15 + 27 comes to 32 — fix the sum _',
    expected: { cls: 'replace', target: '32', values: ['42'] },
  },

  // ── replace / word-swap ───────────────────────────────────────────────
  {
    id: 'r-swap-1', category: 'replace/swap',
    input: 'we welcome all the kids — swap kids for the formal word _',
    expected: { cls: 'replace', target: 'kids', values: ['children'] },
  },
  {
    id: 'r-swap-2', category: 'replace/swap',
    input: 'the report was very good, replace very good with one stronger word _',
    expected: { cls: 'replace', target: 'very good', values: ['excellent', 'outstanding', 'exceptional'] },
  },

  // ── fill / classic lookups with chatter ───────────────────────────────
  {
    id: 'f-classic-1', category: 'fill/classic',
    input: 'unicode for ampersand _ where do i put it',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-classic-2', category: 'fill/classic',
    input: 'writing some css. _ hex for blue. neat.',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-classic-3', category: 'fill/classic',
    input: 'the cube root of 27 is _ that is all i need',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-classic-4', category: 'fill/classic',
    input: 'capital of france _ for the quiz tomorrow',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-classic-5', category: 'fill/classic',
    input: 'art project. 8 in roman numerals _ for the title page.',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-classic-6', category: 'fill/classic',
    input: 'year apollo 11 landed _ checking my notes',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-classic-7', category: 'fill/classic',
    input: 'atomic number of oxygen _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-classic-8', category: 'fill/classic',
    input: 'convert 100 celsius to fahrenheit _ wonder if that is hot',
    expected: { cls: 'fill' },
  },

  // ── fill / correction-adjacent vocabulary (must NOT flip to replace) ──
  {
    id: 'f-fixword-1', category: 'fill/fix-vocab',
    input: 'i fixed the bug this morning. http status for not found _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-fixword-2', category: 'fill/fix-vocab',
    input: 'need to correct the essay later, word count of hamlet _ first',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-fixword-3', category: 'fill/fix-vocab',
    input: 'the fix ships friday. unicode for em dash _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-fixword-4', category: 'fill/fix-vocab',
    input: 'she corrected me twice today lol. capital of portugal _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-fixword-5', category: 'fill/fix-vocab',
    input: 'typo hunting all day. ascii code for tab _ for my parser',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-fixword-6', category: 'fill/fix-vocab',
    input: 'update: the demo went fine. square root of 144 _',
    expected: { cls: 'fill' },
  },

  // ── fill / plausible-target bait (wrong-looking text present, but the
  //     ask is a plain lookup — must NOT touch the bait) ─────────────────
  {
    id: 'f-bait-1', category: 'fill/bait',
    input: 'capital of germany _ munich trip next week btw',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-bait-2', category: 'fill/bait',
    input: 'flight lands at 3pm. current time in tokyo _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-bait-3', category: 'fill/bait',
    input: 'grandma turns 90 in june. boiling point of water in fahrenheit _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-bait-4', category: 'fill/bait',
    input: 'i wrote 1972 words today. year of the moon landing _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-bait-5', category: 'fill/bait',
    input: 'the old logo was FF0000 red. hex for forest green _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-bait-6', category: 'fill/bait',
    input: 'she said 54 people rsvp’d. what is 7 times 8 _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-bait-7', category: 'fill/bait',
    input: 'my sister sarah is visiting. spanish word for library _',
    expected: { cls: 'fill' },
  },
  {
    id: 'f-bait-8', category: 'fill/bait',
    input: 'v2.4.0 shipped clean. latest stable node version _',
    expected: { cls: 'fill' },
  },

  // ── fused-boundary: imperative asks that MUST NOT verify as a splice —
  //     the right outcome is the fused whole-buffer path. Grading treats
  //     REPLACE-that-verifies as the failure; NONE, FILL, or a
  //     verification rejection all count as correct (they all reach
  //     fused/lookup). This is the boundary the whole-body bug lived on
  //     (agentic scenario 129 block 2). ─────────────────────────────────
  {
    id: 'b-tone-1', category: 'boundary/tone',
    input: 'thanks for the update, see you tomorrow. make this formal _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-tone-2', category: 'boundary/tone',
    input: 'the product broke twice this week. rewrite it politely _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-alltypos-1', category: 'boundary/all-typos',
    input: 'teh meetign is tomorow at ten. fix all the typos _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-alltypos-2', category: 'boundary/all-typos',
    input: 'i beleive the packge arives thursday, fix the spelling _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-translate-1', category: 'boundary/translate',
    input: 'the office is closed on friday. translate to french _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-caps-short-1', category: 'boundary/whole-body-format',
    input: 'hello world please make it all caps _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-caps-short-2', category: 'boundary/whole-body-format',
    input: 'ship it friday make this uppercase _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-shorten-1', category: 'boundary/shorten',
    input: 'we are writing to inform you that the delivery has unfortunately been delayed. shorten this _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-tense-1', category: 'boundary/tense',
    input: 'she walks to the office and buys a coffee. make it past tense _',
    expected: { cls: 'none' },
  },
  {
    id: 'b-generative-1', category: 'boundary/generative',
    input: 'write a short poem about rain _',
    expected: { cls: 'none' },
  },

  // ── none / placeholders ───────────────────────────────────────────────
  {
    id: 'n-1', category: 'none',
    input: 'click _ to continue',
    expected: { cls: 'none' },
  },
  {
    id: 'n-2', category: 'none',
    input: 'TODO fill _ in later',
    expected: { cls: 'none' },
  },
  {
    id: 'n-3', category: 'none',
    input: 'dear _ , hope you are well',
    expected: { cls: 'none' },
  },
  {
    id: 'n-4', category: 'none',
    input: 'the blank _ goes right here in the template',
    expected: { cls: 'none' },
  },
  {
    id: 'n-5', category: 'none',
    input: 'insert name _ and sign below',
    expected: { cls: 'none' },
  },
  {
    id: 'n-6', category: 'none',
    input: 'chapter _ draft outline',
    expected: { cls: 'none' },
  },
];
