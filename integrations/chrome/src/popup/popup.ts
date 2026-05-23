import { loadConfig, loadUserKeys, saveConfig, saveUserKeys, resetConfig } from '../adapters/chrome-storage-adapter';

// Popup = SETTINGS only. Cue / blank content lives in
// ~/.cues/ on the host side and flows into the extension via
// `opencues sync chrome`. The popup used to have a `CUES.md` /
// `BLANKS.md` / `OPENCUES.md` textarea but it was a confusing second
// config path — killed Apr 2026. See docs/features/chrome-sync.md.
//
// Provider keys live in their own storage area (`opencues_user_keys`)
// and are read/written through `saveUserKeys` / `loadUserKeys`. They
// merge with host-pushed keys (`opencues_host_keys`) at read time;
// user-pasted keys win on collision.
const fields = ['model', 'apiUrl', 'targetSelector'] as const;
const advancedFields = ['finnhubApiKey'] as const;

function providerKeyInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[data-provider-key]'));
}

async function init(): Promise<void> {
  const [config, userKeys] = await Promise.all([loadConfig(), loadUserKeys()]);

  for (const id of [...fields, ...advancedFields]) {
    const el = document.getElementById(id) as HTMLInputElement;
    if (el && config[id as keyof typeof config]) el.value = config[id as keyof typeof config] as string;
  }

  // Prefill per-provider key inputs from the user-keys bag only —
  // never from the host-keys bag (showing the host's keys in the
  // popup would invite the user to "save" them, copying secrets out
  // of the host's env and into popup-owned storage).
  for (const el of providerKeyInputs()) {
    const envName = el.dataset.providerKey!;
    if (userKeys[envName]) el.value = userKeys[envName];
  }

  const ttsEnabled = document.getElementById('ttsEnabled') as HTMLInputElement;
  const ttsRate = document.getElementById('ttsRate') as HTMLInputElement;
  ttsEnabled.checked = config.ttsEnabled;
  ttsRate.value = String(config.ttsRate);

  const dimMix = document.getElementById('dimMix') as HTMLInputElement;
  const dimMixValue = document.getElementById('dimMixValue') as HTMLSpanElement;
  dimMix.value = String(Math.round(config.dimMix * 100));
  dimMixValue.textContent = `${dimMix.value}%`;

  // Live-save on change — fires chrome.storage.onChanged, which
  // content.ts listens for and re-derives from immediately.
  dimMix.addEventListener('input', () => {
    dimMixValue.textContent = `${dimMix.value}%`;
    saveConfig({ dimMix: parseInt(dimMix.value, 10) / 100 });
  });

  document.getElementById('save')!.addEventListener('click', async () => {
    const update: Record<string, unknown> = {};
    for (const id of [...fields, ...advancedFields]) {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) update[id] = el.value;
    }
    update.ttsEnabled = ttsEnabled.checked;
    update.ttsRate = parseInt(ttsRate.value, 10) || 2;

    const keyUpdate: Record<string, string> = {};
    for (const el of providerKeyInputs()) {
      keyUpdate[el.dataset.providerKey!] = el.value;
    }

    await Promise.all([saveConfig(update), saveUserKeys(keyUpdate)]);

    const status = document.getElementById('status')!;
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });

  document.getElementById('reset')!.addEventListener('click', async () => {
    await resetConfig();
    const [freshConfig, freshKeys] = await Promise.all([loadConfig(), loadUserKeys()]);
    for (const id of [...fields, ...advancedFields]) {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) el.value = (freshConfig[id as keyof typeof freshConfig] as string) || '';
    }
    for (const el of providerKeyInputs()) {
      el.value = freshKeys[el.dataset.providerKey!] ?? '';
    }
    ttsEnabled.checked = freshConfig.ttsEnabled;
    ttsRate.value = String(freshConfig.ttsRate);
    dimMix.value = String(Math.round(freshConfig.dimMix * 100));
    dimMixValue.textContent = `${dimMix.value}%`;

    const status = document.getElementById('status')!;
    status.textContent = 'Reset to defaults';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}

init();
