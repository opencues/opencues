// Config/keys/status go through the host port — chrome.storage in the
// extension, the daemon's localhost config API when the same popup is
// served by a native host (Windows tray WebView2 / browser). See
// adapters/host-port.ts.
import {
  loadConfig, loadUserKeys, saveConfig, saveUserKeys, resetConfig, clearChromeHostState,
  getVersion, getHostStatus, PORT_KIND,
} from '../adapters/host-port';

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
const fields = ['model', 'apiUrl', 'targetSelector', 'provider'] as const;
// Boolean-shaped settings whose persistence needs explicit Boolean
// coercion (saveConfig stores them as the literal value, not as the
// input.value string).
const booleanFields = ['deferToChromeHost'] as const;

// Models offered per provider. First entry = default (bench-recommended).
// Subsequent entries are alternates the user may pick for different
// pipelines (e.g. Sonnet for higher-accuracy fluid-blank answers,
// chat-latest when subscription-economic). Models that benchmark
// catastrophically (gpt-5.4-nano @ 20-27% on both pipelines) are
// excluded — picking one would be a guaranteed bad experience.
const PROVIDER_DEFAULTS: Record<string, { endpoint: string; model: string; envKey: string; models: readonly string[] }> = {
  groq:       { endpoint: 'https://api.groq.com/openai/v1/chat/completions',                                  model: 'openai/gpt-oss-120b',       envKey: 'GROQ_API_KEY',       models: ['openai/gpt-oss-120b'] },
  cerebras:   { endpoint: 'https://api.cerebras.ai/v1/chat/completions',                                      model: 'gpt-oss-120b',              envKey: 'CEREBRAS_API_KEY',   models: ['gpt-oss-120b'] },
  openai:     { endpoint: 'https://api.openai.com/v1/chat/completions',                                       model: 'gpt-5.4-mini',              envKey: 'OPENAI_API_KEY',     models: ['gpt-5.4-mini', 'chat-latest'] },
  anthropic:  { endpoint: 'https://api.anthropic.com/v1/messages',                                            model: 'claude-haiku-4-5-20251001', envKey: 'ANTHROPIC_API_KEY',  models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20250514'] },
  gemini:     { endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', model: 'gemini-3.5-flash-lite',     envKey: 'GEMINI_API_KEY',     models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions',                                    model: 'openai/gpt-oss-120b:free',  envKey: 'OPENROUTER_API_KEY', models: ['openai/gpt-oss-120b:free'] },
};

function populateModelDropdown(providerId: string, currentModel: string): void {
  const select = document.getElementById('modelSelect') as HTMLSelectElement;
  select.innerHTML = '';
  const def = PROVIDER_DEFAULTS[providerId];
  if (!def) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— pick a provider first —';
    select.appendChild(opt);
    select.title = 'Pick a provider above — the model list is bench-validated per provider.';
    return;
  }
  for (const m of def.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  select.value = (currentModel && def.models.includes(currentModel)) ? currentModel : def.models[0];
  // Hover indicates the curated nature of the list. Without this users
  // assume the dropdown shows EVERY model the provider supports — it
  // doesn't. We only expose bench-validated entries (see
  // tests/benchmarks/BENCHMARKS.md). The first option is the
  // recommended default for the chosen provider.
  const providerName = providerId.charAt(0).toUpperCase() + providerId.slice(1);
  select.title = `Bench-validated models for ${providerName} (${def.models.length} option${def.models.length === 1 ? '' : 's'}). First entry is the recommended default. Models that scored badly in tests/benchmarks/BENCHMARKS.md aren't listed — picking one would be a guaranteed bad experience.`;
  const hidden = document.getElementById('model') as HTMLInputElement;
  hidden.value = select.value;
}

function providerKeyInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[data-provider-key]'));
}

// Probe a single key — returns true iff the provider returned 2xx.
// Used by refreshProviderDropdown to validate before exposing the
// provider as a pickable option. Per-provider endpoint table mirrors
// runKeyProbe's PROBE_ENDPOINTS (which is defined later in the file).
async function isKeyValid(envName: string, key: string): Promise<boolean> {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const def = PROBE_ENDPOINTS[envName];
  if (!def) return false;
  let url = def.url;
  if (url.includes('__KEY__')) url = url.replace('__KEY__', encodeURIComponent(trimmed));
  try {
    const r = await fetch(url, { method: 'GET', headers: def.headers(trimmed) });
    return r.ok;
  } catch {
    return false;
  }
}

// Probe every entered key in parallel; populate the Provider dropdown
// with only those whose probe returned 2xx. Eliminates the wrong-key /
// wrong-provider combo entirely — users literally can't pick a broken
// provider. Empty state = clear "paste a key above" hint.
async function refreshProviderDropdown(preferred: string, currentModel: string): Promise<void> {
  const providerEl = document.getElementById('provider') as HTMLSelectElement;
  const hint = document.getElementById('providerHint');

  // Map envKey → providerId for the dropdown rebuild.
  const ENV_TO_PROVIDER: Record<string, string> = {};
  for (const [id, def] of Object.entries(PROVIDER_DEFAULTS)) ENV_TO_PROVIDER[def.envKey] = id;

  // Probe each entered key in parallel.
  const probes: Array<Promise<{ providerId: string; valid: boolean }>> = [];
  for (const el of providerKeyInputs()) {
    const envName = el.dataset.providerKey!;
    const providerId = ENV_TO_PROVIDER[envName];
    if (!providerId || !el.value) continue;
    probes.push(isKeyValid(envName, el.value).then(valid => ({ providerId, valid })));
  }
  const results = await Promise.all(probes);
  const validProviders = results.filter(r => r.valid).map(r => r.providerId);

  // Rebuild the <select> options.
  providerEl.innerHTML = '';
  if (validProviders.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no verified keys —';
    providerEl.appendChild(opt);
    providerEl.title = 'Paste an API key above — verified providers appear here automatically.';
    if (hint) hint.textContent = '';
    populateModelDropdown('', currentModel);
    return;
  }

  providerEl.title = `${validProviders.length} verified provider${validProviders.length === 1 ? '' : 's'} available. Pick one — model auto-fills.`;
  if (hint) hint.textContent = '';
  // Sort: preferred first (if valid), then alphabetical.
  const sorted = validProviders.slice().sort((a, b) => {
    if (a === preferred) return -1;
    if (b === preferred) return 1;
    return a.localeCompare(b);
  });
  for (const providerId of sorted) {
    const def = PROVIDER_DEFAULTS[providerId];
    const opt = document.createElement('option');
    opt.value = providerId;
    opt.textContent = providerId.charAt(0).toUpperCase() + providerId.slice(1);
    providerEl.appendChild(opt);
    if (!def) continue;
  }
  // Apply preferred if valid; otherwise default to first.
  const chosen = sorted[0];
  providerEl.value = (preferred && validProviders.includes(preferred)) ? preferred : chosen;
  populateModelDropdown(providerEl.value, currentModel);
  // Match apiUrl to the chosen provider on first populate so saving
  // doesn't persist a stale URL from a now-removed provider.
  const apiUrlEl = document.getElementById('apiUrl') as HTMLInputElement;
  const def = PROVIDER_DEFAULTS[providerEl.value];
  if (def && (!apiUrlEl.value || Object.values(PROVIDER_DEFAULTS).some(p => p.endpoint === apiUrlEl.value))) {
    apiUrlEl.value = def.endpoint;
  }
}

async function init(): Promise<void> {
  // Banner — mirrors the CLI's `banner({ version, tagline })` shape.
  // Version comes from manifest.json so a single source of truth.
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = `v${await getVersion()}`;

  const [config, userKeys] = await Promise.all([loadConfig(), loadUserKeys()]);

  for (const id of fields) {
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

  const providerEl = document.getElementById('provider') as HTMLSelectElement;
  const modelEl = document.getElementById('model') as HTMLInputElement;
  const apiUrlEl = document.getElementById('apiUrl') as HTMLInputElement;
  const modelSelectEl = document.getElementById('modelSelect') as HTMLSelectElement;

  providerEl.addEventListener('change', () => {
    const def = PROVIDER_DEFAULTS[providerEl.value];
    if (!def) { populateModelDropdown('', ''); return; }
    if (!apiUrlEl.value || Object.values(PROVIDER_DEFAULTS).some(p => p.endpoint === apiUrlEl.value)) {
      apiUrlEl.value = def.endpoint;
    }
    populateModelDropdown(providerEl.value, modelEl.value);
  });

  modelSelectEl.addEventListener('change', () => {
    modelEl.value = modelSelectEl.value;
  });

  await refreshProviderDropdown(config.provider, config.model);

  const ttsEnabled = document.getElementById('ttsEnabled') as HTMLInputElement;
  const ttsRate = document.getElementById('ttsRate') as HTMLInputElement;
  ttsEnabled.checked = config.ttsEnabled;
  ttsRate.value = String(config.ttsRate);

  // Defer-to-chrome-host toggle. Hidden by default; only shown once
  // the SW confirms `connected: true`. A hostless user has no way to
  // benefit from the toggle (defer-to-bundle when there's no bundle =
  // empty config), so showing it greyed-out was footgun affordance.
  // When the host comes up mid-session the toggle appears without a
  // popup-reopen.
  const deferEl = document.getElementById('deferToChromeHost') as HTMLInputElement;
  const deferLabel = document.querySelector('label.defer-toggle') as HTMLLabelElement;
  deferEl.checked = !!config.deferToChromeHost;
  deferLabel.style.display = 'none';
  void getHostStatus().then((reply: unknown) => {
    const connected = !!(reply && (reply as { connected?: boolean }).connected);
    if (!connected) {
      if (deferEl.checked) {
        // Defer is ON but the port is down at this instant. That is
        // routinely transient — the SW retries connectNative every 30s
        // and MV3 workers wake cold — so force-writing defer OFF here
        // (the pre-0.2.183 behaviour) turned a blip into a persistently
        // disabled integration: the SW then ignored every future host
        // push and the next Save wiped the host bags. Keep the toggle
        // visible and checked; the user unticks it themselves if the
        // host is genuinely gone.
        deferLabel.style.display = '';
        deferEl.disabled = false;
        deferLabel.title = 'chrome-host is not connected right now (the extension retries every 30s). Config from its last push stays active. Untick only if you no longer run chrome-host.';
      } else {
        // Hostless user with defer OFF — keep the toggle hidden.
        // Deferring to a nonexistent source = empty config, so showing
        // it would be footgun affordance.
        deferLabel.style.display = 'none';
      }
      return;
    }
    deferLabel.style.display = '';
    deferEl.disabled = false;
    deferLabel.title = 'When ON, the popup\'s Provider / Model / API URL fields are ignored — your ~/.cues/OPENCUES.md (pushed by `opencues install chrome-host`) drives config instead. Matches how CC / OC / gemini-cli work.';
  }).catch(() => { /* no SW response — treat as disconnected; toggle stays hidden */ });
  const applyDeferUI = (): void => {
    const provEl = document.getElementById('provider') as HTMLSelectElement;
    const modSel = document.getElementById('modelSelect') as HTMLSelectElement;
    const apiEl = document.getElementById('apiUrl') as HTMLInputElement;
    [provEl, modSel, apiEl].forEach(el => {
      if (!el) return;
      el.disabled = deferEl.checked;
      el.style.opacity = deferEl.checked ? '0.4' : '';
    });
  };
  applyDeferUI();
  deferEl.addEventListener('change', applyDeferUI);

  // Auto-verify keys as they're entered so the Provider / Model
  // dropdowns populate WITHOUT a Save round-trip first. Previously the
  // dropdowns only repopulated on init() (from saved keys) and on Save,
  // so a freshly-pasted key left Provider showing "— no verified keys —"
  // until the user clicked Save — which sits BELOW provider/model. That
  // made the action order (paste → save → pick provider → pick model →
  // save) contradict the visual top-to-bottom order. Auto-verifying here
  // means the layout reads in execution order and Save is purely
  // "persist my final choices". Debounced so we probe each provider's
  // /models endpoint once after typing/paste settles, not per keystroke.
  let verifyTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleKeyVerify = (): void => {
    if (deferEl.checked) return; // provider/model ignored in defer mode
    if (verifyTimer !== undefined) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      void refreshProviderDropdown(
        providerEl.value || config.provider || '',
        modelEl.value || config.model || '',
      );
    }, 600);
  };
  for (const el of providerKeyInputs()) {
    el.addEventListener('input', scheduleKeyVerify);
  }

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
    const status = document.getElementById('status')!;
    status.textContent = 'saving + verifying keys…';

    const update: Record<string, unknown> = {};
    for (const id of fields) {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) update[id] = el.value;
    }
    update.ttsEnabled = ttsEnabled.checked;
    update.ttsRate = parseInt(ttsRate.value, 10) || 2;
    update.deferToChromeHost = (document.getElementById('deferToChromeHost') as HTMLInputElement).checked;

    const keyUpdate: Record<string, string> = {};
    for (const el of providerKeyInputs()) {
      keyUpdate[el.dataset.providerKey!] = el.value;
    }

    await Promise.all([saveConfig(update), saveUserKeys(keyUpdate)]);

    // Toggle OFF means "I'm not using chrome-host" — wipe every
    // storage surface the host can write into. See
    // `clearChromeHostState` for the full layer list + rationale.
    if (update.deferToChromeHost === false) {
      await clearChromeHostState();
    }

    // Re-validate every entered key against its provider's /v1/models
    // endpoint AND rebuild the Provider + Model dropdowns from the
    // verified set. Without this, a user who pastes a fresh key +
    // clicks save sees the dropdown stuck on the previous state.
    const providerEl = document.getElementById('provider') as HTMLSelectElement;
    const modelEl = document.getElementById('model') as HTMLInputElement;
    const beforeProvider = providerEl.value;
    const beforeModel = modelEl.value;

    // Pass the saved (just-written) provider/model as the preferred
    // selection so the post-refresh state reflects what the user just
    // saved, not whatever the dropdown happened to show before save.
    await refreshProviderDropdown(
      (update.provider as string) || providerEl.value || '',
      (update.model as string) || modelEl.value || '',
    );

    const afterProvider = providerEl.value;
    const afterModel = modelEl.value;
    if (afterProvider && afterProvider !== beforeProvider) {
      status.textContent = `saved — provider auto-set to ${afterProvider}, model to ${afterModel}`;
    } else if (afterProvider) {
      status.textContent = `saved — verified ${afterProvider} (${afterModel})`;
    } else {
      status.textContent = 'saved — no verified keys yet, paste a working api key';
    }
    setTimeout(() => { status.textContent = ''; }, 3000);
  });

  document.getElementById('reset')!.addEventListener('click', async () => {
    await resetConfig();
    const [freshConfig, freshKeys] = await Promise.all([loadConfig(), loadUserKeys()]);
    for (const id of fields) {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) el.value = (freshConfig[id as keyof typeof freshConfig] as string) || '';
    }
    for (const el of providerKeyInputs()) {
      el.value = freshKeys[el.dataset.providerKey!] ?? '';
    }
    ttsEnabled.checked = freshConfig.ttsEnabled;
    (document.getElementById('deferToChromeHost') as HTMLInputElement).checked = !!freshConfig.deferToChromeHost;
    applyDeferUI();
    ttsRate.value = String(freshConfig.ttsRate);
    dimMix.value = String(Math.round(freshConfig.dimMix * 100));
    dimMixValue.textContent = `${dimMix.value}%`;

    const status = document.getElementById('status')!;
    status.textContent = 'Reset — re-validating keys…';
    // Reset cleared the user-keys bag — re-run validation so the
    // Provider/Model dropdowns reflect the new state (likely empty
    // since reset wipes saved keys).
    await refreshProviderDropdown(freshConfig.provider, freshConfig.model);
    status.textContent = 'Reset to defaults';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}

// Escape user-controlled text before inserting it into innerHTML so a
// quirky API response body can't break out of the diagnostic pane.
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Classify a diagnostic line by its leading glyph so we can colour-code
// it. Look PAST leading whitespace so probe lines that indent their
// glyph (`  ● CEREBRAS_API_KEY — 200 OK`) still classify correctly.
// Deep-indent lines (≥4 spaces) without a glyph are treated as
// continuation detail.
function classifyDiagLine(line: string): string {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;
  if (trimmed.startsWith('●')) return 'diag-ok';
  if (trimmed.startsWith('✗')) return 'diag-err';
  if (trimmed.startsWith('⚠')) return 'diag-warn';
  if (trimmed.startsWith('·')) return 'diag-info';
  if (trimmed.startsWith('└')) return 'diag-detail';
  if (trimmed.startsWith('—') || trimmed.endsWith('—')) return 'diag-section';
  if (indent >= 2) return 'diag-detail';
  return 'diag-line';
}

function renderDiagLines(out: HTMLElement, lines: readonly string[]): void {
  out.innerHTML = lines.map(line => {
    const cls = classifyDiagLine(line);
    // Strip leading spaces — visual indent comes from the CSS class
    // (diag-detail has left padding) so the raw text doesn't double up.
    const trimmed = line.replace(/^\s+/, '');
    return `<div class="${cls}">${escHtml(trimmed) || '&nbsp;'}</div>`;
  }).join('');
}

// Diagnostic self-check — answers "is this extension actually wired up?"
// without the user having to open devtools. Pings the content script
// on the active tab, reads storage for keys, sanity-checks the LLM
// provider config, and renders a pass/fail checklist.
async function runDiagnostic(): Promise<void> {
  const out = document.getElementById('diag-out') as HTMLPreElement;
  out.style.display = 'block';
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); renderDiagLines(out, lines); };

  log('Running self-check…');

  // Native host (Windows tray / browser served by the daemon): there's
  // no active tab or content script to ping. Report the daemon's status
  // + config instead, then stop before the chrome-only tab checks.
  if (PORT_KIND !== 'chrome') {
    const status = await getHostStatus();
    if (!status || !status.connected) {
      log('✗ OpenCues daemon not reachable — is the tray running / oc-windows started?');
      return;
    }
    log(`● daemon connected${status.attached ? ` (attached: ${status.app ?? 'a text field'})` : ' (idle — focus a text field)'}`);
    const [cfg, keys] = await Promise.all([loadConfig(), loadUserKeys()]);
    const keyNames = Object.keys(keys).filter((k) => keys[k]);
    if (keyNames.length === 0) log('✗ no LLM API keys set — paste one above and Save');
    else log(`● API keys present: ${keyNames.join(', ')}`);
    if (cfg.provider) log(`● provider: ${cfg.provider}${cfg.model ? `  model: ${cfg.model}` : ''}`);
    else log('  provider: (none picked — paste a verified key, then pick one)');
    return;
  }

  // 1. Active tab.
  let tab: chrome.tabs.Tab | undefined;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (err) {
    log(`✗ chrome.tabs.query failed: ${(err as Error).message}`);
    return;
  }
  if (!tab?.id) { log('✗ no active tab'); return; }
  log(`● active tab: ${tab.url?.slice(0, 60) ?? '(no url)'}`);

  const restricted = !tab.url || /^(chrome|chrome-extension|edge|about|view-source):/.test(tab.url);
  if (restricted) {
    log('✗ active tab is a restricted URL — content scripts can NOT inject on chrome://, chrome-extension://, etc. Test on a real https:// page (try wikipedia.org).');
    return;
  }

  // 2. Content script alive on this tab?
  let pingOk = false;
  let pingInfo: Record<string, unknown> | null = null;
  try {
    const response: unknown = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'opencues:diagnostic-ping' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    if (response && typeof response === 'object') {
      pingOk = true;
      pingInfo = response as Record<string, unknown>;
    }
  } catch (err) {
    log(`✗ content script not responding on this tab (${(err as Error).message})`);
    log('  → hard-refresh the tab (Ctrl+Shift+R) after reloading the extension');
  }
  if (pingOk && pingInfo) {
    log(`● content script alive — bootVersion=${pingInfo.bootVersion ?? '?'}`);
    log(`  currentTarget: ${pingInfo.currentTarget ?? '(none focused — click into a contenteditable, then re-run)'}`);
    log(`  attachStatus: ${pingInfo.attachStatus ?? '(unknown)'}`);
    if (pingInfo.targetAttachable === false && pingInfo.currentTarget) {
      log('  ⚠ focused field is not attachable — OpenCues will not answer in this field');
    }
    log(`  trustGateInstalled: ${pingInfo.trustGateInstalled ? 'yes' : 'no'}`);

    // Surface what provider the live runtime is resolved to — catches
    // "I picked Groq in the popup but the runtime is still on Cerebras
    // because I didn't hard-refresh".
    const runtimeProvider = (pingInfo.runtimeProvider ?? '(unset — auto-routing)') as string;
    log(`  runtimeProvider (what the runtime is actually using): ${runtimeProvider}`);
    const runtimeModel = (pingInfo.runtimeModel ?? '(unset)') as string;
    log(`  runtimeModel: ${runtimeModel}`);
    const providerEl = document.getElementById('provider') as HTMLSelectElement;
    const modelEl = document.getElementById('model') as HTMLInputElement;
    if (providerEl.value && runtimeProvider !== providerEl.value && !runtimeProvider.includes(providerEl.value)) {
      log(`  ⚠ provider mismatch: popup picked "${providerEl.value}" but runtime is on "${runtimeProvider}" — click Save, then HARD-refresh the page (Ctrl+Shift+R)`);
    }
    if (modelEl.value && runtimeModel !== modelEl.value && !runtimeModel.includes(modelEl.value)) {
      log(`  ⚠ model mismatch: popup typed "${modelEl.value}" but runtime is on "${runtimeModel}" — click Save, then HARD-refresh the page (Ctrl+Shift+R)`);
    }

    // Runtime keys — show what the LIVE runtime has, vs what the user
    // has currently typed in the popup inputs. Mismatch = "you didn't
    // Save" or "you didn't hard-refresh the page". Fingerprints are
    // first-8 + last-4 chars so secrets don't fully leak into the log.
    const runtimeKeys = (pingInfo.runtimeKeys ?? {}) as Record<string, string>;
    const runtimeNames = Object.keys(runtimeKeys);
    if (runtimeNames.length === 0) {
      log('  runtimeKeys: (none — runtime has zero keys loaded)');
    } else {
      log('  runtimeKeys (what the runtime is actually sending — first8…last4):');
      for (const name of runtimeNames) {
        log(`    ${name} → ${runtimeKeys[name]}`);
      }
    }
    // Compare to currently-typed values so the user sees the mismatch.
    for (const el of providerKeyInputs()) {
      const envName = el.dataset.providerKey!;
      const typed = el.value;
      if (!typed) continue;
      const typedFp = typed.length > 12 ? `${typed.slice(0, 8)}…${typed.slice(-4)}` : `${typed.length}-char short key`;
      const runtimeFp = runtimeKeys[envName];
      if (!runtimeFp) {
        log(`  ⚠ ${envName}: typed (${typedFp}) but runtime DOES NOT HAVE this key — click Save, then hard-refresh the test page`);
      } else if (!runtimeFp.startsWith(typed.slice(0, 8))) {
        log(`  ⚠ ${envName}: typed (${typedFp}) MISMATCHES runtime (${runtimeFp}) — click Save, then hard-refresh the test page`);
      }
    }
  }

  // 3. Live chrome-host port status. The storage reads below persist
  // from PAST connections — without this line a dead host still looks
  // healthy in the self-check (keys present, bundle present) and the
  // hidden defer toggle / failing spawns have no visible cause.
  try {
    const hostStatus = await getHostStatus();
    if (hostStatus?.connected) {
      log('● chrome-host: connected (live native-messaging port)');
    } else {
      log('⚠ chrome-host: NOT connected (the extension retries every 30s)');
      log('  → host keys / bundle below persist from a previous session — they do not prove the host is running');
      log('  → check the service-worker console at chrome://extensions; reinstall via `opencues install chrome-host` if it never connects');
    }
  } catch {
    log('⚠ chrome-host: status query failed (service worker unreachable)');
  }

  // 4. Storage check — provider keys.
  try {
    const storage = await chrome.storage.local.get(['opencues_user_keys', 'opencues_host_keys', 'opencues_bundle']);
    const userKeys = (storage.opencues_user_keys ?? {}) as Record<string, string>;
    const hostKeys = (storage.opencues_host_keys ?? {}) as Record<string, string>;
    const merged: Record<string, string> = { ...hostKeys, ...userKeys };
    const present = Object.entries(merged).filter(([_, v]) => v && v.length > 0).map(([k]) => k);
    if (present.length === 0) {
      log('✗ no LLM API keys set — substitutions will fail');
      log('  → paste a key into one of the fields above and Save');
    } else {
      log(`● API keys present in storage: ${present.join(', ')}`);
      // Surface host_keys vs user_keys separately so the user can see
      // when a stale chrome-host push is shadowing their popup paste.
      const userNames = Object.keys(userKeys).filter(k => userKeys[k]);
      const hostNames = Object.keys(hostKeys).filter(k => hostKeys[k]);
      if (userNames.length) log(`    opencues_user_keys (popup-pasted): ${userNames.join(', ')}`);
      if (hostNames.length) log(`    opencues_host_keys (chrome-host pushed): ${hostNames.join(', ')}`);
      // Flag the collision case explicitly — user keys win on read but
      // it's worth showing so a stale host_keys entry doesn't confuse.
      const collisions = userNames.filter(n => hostKeys[n]);
      if (collisions.length) {
        log(`    ⚠ both bags have: ${collisions.join(', ')} — popup wins on read but consider clearing the host bag if you don't run chrome-host`);
      }
    }

    if (!storage.opencues_bundle) {
      log('· no config bundle pushed by chrome-host (running on bake-time defaults — that\'s OK)');
    } else {
      const bundle = storage.opencues_bundle as Record<string, unknown>;
      const files = Object.keys((bundle.files ?? {}) as Record<string, unknown>);
      log(`● bundle pushed by host: ${files.length} files`);
    }
  } catch (err) {
    log(`✗ storage read failed: ${(err as Error).message}`);
  }

  log('— done —');
}

document.getElementById('diag-run')?.addEventListener('click', () => {
  void runDiagnostic();
});

// Per-provider live key probe. Hits the provider's lightest read-only
// endpoint (models list) with the CURRENTLY-TYPED key (NOT the saved
// one — so the user can test a key before clicking Save). Surfaces the
// raw HTTP status + first 200 chars of the response body so a 401's
// reason is visible rather than just "rejected".
const PROBE_ENDPOINTS: Record<string, { url: string; headers: (k: string) => Record<string, string> }> = {
  GROQ_API_KEY:       { url: 'https://api.groq.com/openai/v1/models',                                                                                  headers: k => ({ Authorization: `Bearer ${k}` }) },
  CEREBRAS_API_KEY:   { url: 'https://api.cerebras.ai/v1/models',                                                                                      headers: k => ({ Authorization: `Bearer ${k}` }) },
  OPENAI_API_KEY:     { url: 'https://api.openai.com/v1/models',                                                                                       headers: k => ({ Authorization: `Bearer ${k}` }) },
  ANTHROPIC_API_KEY:  { url: 'https://api.anthropic.com/v1/models',                                                                                    headers: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  OPENROUTER_API_KEY: { url: 'https://openrouter.ai/api/v1/models',                                                                                    headers: k => ({ Authorization: `Bearer ${k}` }) },
  GEMINI_API_KEY:     { url: 'https://generativelanguage.googleapis.com/v1beta/models',                                                                headers: k => ({ 'x-goog-api-key': k }) }, // INFOSEC F8: header not URL
};

async function probeOneKey(envName: string, key: string, out: (line: string) => void, origin: 'typed' | 'host' = 'typed'): Promise<void> {
  const label = origin === 'host' ? `${envName} (host)` : envName;
  const trimmed = key.trim();
  if (trimmed !== key) {
    out(origin === 'host'
      ? `  ⚠ ${label} has leading/trailing whitespace — fix it in the shell env chrome-host reads and let it re-push.`
      : `  ⚠ ${label} has leading/trailing whitespace (saved as-typed — whitespace breaks auth headers). Re-paste without spaces and Save.`);
  }
  if (!trimmed) { out(`  · ${label} not set`); return; }
  const def = PROBE_ENDPOINTS[envName];
  if (!def) { out(`  ? ${label} — no probe wired`); return; }

  let url = def.url;
  if (url.includes('__KEY__')) url = url.replace('__KEY__', encodeURIComponent(trimmed));
  const headers = def.headers(trimmed);

  try {
    const r = await fetch(url, { method: 'GET', headers });
    const body = await r.text().catch(() => '');
    const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim();
    if (r.ok) {
      out(`  ● ${label} — ${r.status} OK (provider accepted the key)`);
    } else if (r.status === 401 || r.status === 403) {
      out(`  ✗ ${label} — ${r.status} ${r.statusText}: provider REJECTED the key`);
      if (snippet) out(`    └─ body: ${snippet}`);
      out(`    Possible causes: key was revoked, wrong account, key typed wrong, or this provider requires billing setup.`);
    } else {
      out(`  ✗ ${label} — ${r.status} ${r.statusText}`);
      if (snippet) out(`    └─ body: ${snippet}`);
    }
  } catch (err) {
    out(`  ✗ ${label} — network error: ${(err as Error).message}`);
    out(`    Possible causes: extension's host-permission missing for this provider, CORS, or no internet.`);
  }
}

async function runKeyProbe(): Promise<void> {
  const out = document.getElementById('diag-out') as HTMLPreElement;
  out.style.display = 'block';
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); renderDiagLines(out, lines); };

  log('Probing each entered key against its provider…');

  // Read the CURRENTLY-TYPED values from the inputs (not the saved
  // storage values) so the user can test before saving.
  const fields: Array<{ envName: string; el: HTMLInputElement }> = [];
  for (const el of providerKeyInputs()) {
    fields.push({ envName: el.dataset.providerKey!, el });
  }

  let anyProbed = false;
  for (const { envName, el } of fields) {
    if (el.value && el.value.length > 0) {
      anyProbed = true;
      await probeOneKey(envName, el.value, log);
    }
  }

  // Host-pushed keys (chrome-host forwarding the user's shell env) are
  // deliberately never prefilled into the inputs above — but for most
  // chrome-host users they're the ONLY keys, which used to make this
  // button report "no API keys entered" against a fully working runtime.
  // Probe them too; values never render (probeOneKey prints only the
  // env name + HTTP status).
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['opencues_host_keys']);
      const hostKeys = (stored.opencues_host_keys ?? {}) as Record<string, string>;
      const typedNames = new Set(fields.filter(f => f.el.value).map(f => f.envName));
      const hostOnly = Object.entries(hostKeys)
        .filter(([name, v]) => v && !typedNames.has(name) && PROBE_ENDPOINTS[name]);
      if (hostOnly.length > 0) {
        log('Probing chrome-host-pushed keys (values are never shown)…');
        for (const [envName, key] of hostOnly) {
          anyProbed = true;
          await probeOneKey(envName, key, log, 'host');
        }
      }
    } catch { /* storage unreadable — typed-input probing above already ran */ }
  }

  if (!anyProbed) {
    log('✗ no API keys entered (and none pushed by chrome-host)');
    log('  paste a key into one of the fields above, then click save (or test api key again).');
  }
  log('— done —');
}

document.getElementById('diag-probe')?.addEventListener('click', () => {
  void runKeyProbe();
});

init();
