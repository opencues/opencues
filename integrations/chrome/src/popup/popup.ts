import { loadConfig, saveConfig, resetConfig } from '../adapters/chrome-storage-adapter';

const fields = ['apiKey', 'model', 'apiUrl', 'targetSelector', 'cuesMd', 'blanksMd', 'opencuesMd'] as const;
const advancedFields = ['finnhubApiKey', 'tipsJson'] as const;

async function init(): Promise<void> {
  const config = await loadConfig();

  // Populate fields
  for (const id of [...fields, ...advancedFields]) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
    if (el && config[id as keyof typeof config]) el.value = config[id as keyof typeof config] as string;
  }

  const ttsEnabled = document.getElementById('ttsEnabled') as HTMLInputElement;
  const ttsRate = document.getElementById('ttsRate') as HTMLInputElement;
  // Sync TTS checkbox with voice-mode from opencues.md
  const voiceActive = !config.opencuesMd?.includes('voice-mode: inactive');
  ttsEnabled.checked = voiceActive;
  ttsRate.value = String(config.ttsRate);

  // Save handler
  document.getElementById('save')!.addEventListener('click', async () => {
    const update: Record<string, any> = {};
    for (const id of [...fields, ...advancedFields]) {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
      if (el) update[id] = el.value;
    }
    update.ttsEnabled = ttsEnabled.checked;
    update.ttsRate = parseInt(ttsRate.value, 10) || 2;

    // Sync TTS checkbox → voice-mode in opencues.md
    const opencuesMd = (update.opencuesMd || '') as string;
    const newVoiceMode = ttsEnabled.checked ? 'active' : 'inactive';
    if (opencuesMd.includes('voice-mode:')) {
      update.opencuesMd = opencuesMd.replace(/voice-mode:\s*\S+/, `voice-mode: ${newVoiceMode}`);
    }

    await saveConfig(update);

    const status = document.getElementById('status')!;
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });

  // Reset handler
  document.getElementById('reset')!.addEventListener('click', async () => {
    await resetConfig();
    const freshConfig = await loadConfig();
    for (const id of [...fields, ...advancedFields]) {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
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
