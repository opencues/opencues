import { loadConfig, saveConfig, resetConfig } from '../adapters/chrome-storage-adapter';

// Popup = SETTINGS only. Cue / blank content lives in
// ~/.cues/ on the host side and flows into the extension via
// `opencues sync chrome`. The popup used to have a `CUES.md` /
// `BLANKS.md` / `OPENCUES.md` textarea but it was a confusing second
// config path — killed Apr 2026. See docs/features/chrome-sync.md.
const fields = ['apiKey', 'model', 'apiUrl', 'targetSelector'] as const;
const advancedFields = ['finnhubApiKey'] as const;

async function init(): Promise<void> {
  const config = await loadConfig();

  for (const id of [...fields, ...advancedFields]) {
    const el = document.getElementById(id) as HTMLInputElement;
    if (el && config[id as keyof typeof config]) el.value = config[id as keyof typeof config] as string;
  }

  const ttsEnabled = document.getElementById('ttsEnabled') as HTMLInputElement;
  const ttsRate = document.getElementById('ttsRate') as HTMLInputElement;
  ttsEnabled.checked = config.ttsEnabled;
  ttsRate.value = String(config.ttsRate);

  document.getElementById('save')!.addEventListener('click', async () => {
    const update: Record<string, unknown> = {};
    for (const id of [...fields, ...advancedFields]) {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) update[id] = el.value;
    }
    update.ttsEnabled = ttsEnabled.checked;
    update.ttsRate = parseInt(ttsRate.value, 10) || 2;

    await saveConfig(update);

    const status = document.getElementById('status')!;
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });

  document.getElementById('reset')!.addEventListener('click', async () => {
    await resetConfig();
    const freshConfig = await loadConfig();
    for (const id of [...fields, ...advancedFields]) {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) el.value = (freshConfig[id as keyof typeof freshConfig] as string) || '';
    }
    ttsEnabled.checked = freshConfig.ttsEnabled;
    ttsRate.value = String(freshConfig.ttsRate);

    const status = document.getElementById('status')!;
    status.textContent = 'Reset to defaults';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}

init();
