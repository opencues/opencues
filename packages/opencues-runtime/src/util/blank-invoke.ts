/**
 * invokeOrSpawnBlank — the one shared dispatch for invoking a blank's
 * get/set action. Try host-native `blankInvoke` first (sandboxed hosts
 * like Chrome implement it; CLI hosts route it to the registry blank);
 * fall back to spawning the configured script. Returns null when
 * neither path is viable (no blankInvoke + no spawn capability + no
 * scriptPath).
 *
 * Extracted from Cycling's private `invokeOrSpawn` so the UndoApplier
 * can run the exact same dispatch for os-set / file-write inversions —
 * a hand-copied twin would drift (see CLAUDE.md's copied-guard bug
 * class).
 */

import type { HostAdapter, ProcessHandle } from '../adapter';

export function invokeOrSpawnBlank(
  adapter: HostAdapter,
  blankName: string,
  action: string,
  args: readonly string[],
  scriptPath: string | undefined,
  options: { detached?: boolean; timeoutMs?: number } = {},
): ProcessHandle | null {
  const native = adapter.blankInvoke?.({
    blankName,
    action,
    args,
    timeoutMs: options.timeoutMs,
  });
  if (native) return native;
  if (!scriptPath) return null;
  if (!adapter.capabilities.includes('spawn-process')) return null;
  return adapter.spawnProcess({
    command: 'bash',
    args: [scriptPath, action, ...args],
    detached: options.detached,
    timeoutMs: options.timeoutMs,
  });
}
