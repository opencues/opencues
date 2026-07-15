/**
 * applyScalarAndPersist — the one shared "flip an OPENCUES.md scalar"
 * pair. Does TWO things, matching what satellite cycling always does
 * together (cycling.ts:cycleSelectorSatellite):
 *
 *   1. ConfigLoader.applyOpenCuesScalar — updates in-memory state +
 *      arms the 2.5s reload suppression.
 *   2. invoke the `opencues` settings blank with `set <setting> <value>`
 *      — actually writes the file. Without this the in-memory flip
 *      reverts the next time reload-suppression expires and
 *      ConfigLoader reads the un-modified file (caught 2026-05-19 via
 *      the agentic harness — `turn on voice mode _` showed
 *      `voice-mode active` for ~2.5s then snapped back to inactive).
 *
 * The file write is AWAITED so back-to-back calls (ConfigIntent's
 * provider verdict writes `<scope>-llm-provider` AND `<scope>-llm-model`
 * sequentially) serialise on disk — fire-and-forget caused a
 * read-modify-write race where the second write clobbered the first.
 *
 * Extracted from the resolver's `applyOpencuesScalar` buildOpts wrapper
 * so the UndoApplier's scalar-write inversion runs the exact same pair
 * (in-memory + persist + suppression) — a hand-copied twin would drift.
 */

import type { HostAdapter } from '../adapter';
import type { ConfigLoader } from '../modules/config-loader';
import { invokeOrSpawnBlank } from './blank-invoke';

export async function applyScalarAndPersist(
  adapter: HostAdapter,
  configLoader: ConfigLoader,
  setting: string,
  value: string,
): Promise<void> {
  configLoader.applyOpenCuesScalar(setting, value);
  // Looked up at call time so a missing blank entry (degraded install)
  // degrades gracefully — the in-memory flip still takes effect, just
  // without persistence.
  const oc = configLoader.lookupBlank('opencues');
  const scriptPath = oc?.blank.blankScript;
  if (!scriptPath && !adapter.blankInvoke) return;
  try {
    const proc = invokeOrSpawnBlank(adapter, 'opencues', 'set', [setting, value], scriptPath, {
      detached: true,
      timeoutMs: 4000,
    });
    if (proc) await proc.result;
  } catch (err) {
    adapter.log('error', `applyScalarAndPersist: file write failed for ${setting}=${value}`, err);
  }
}
