import type { BrowserControl } from './types';
import { VolumeControl } from './volume';
import { StocksControl } from './stocks';
import { WeatherControl } from './weather';
import { HackerNewsControl } from './hackernews';
import { PromptImproverControl, type PromptImproverConfig } from './prompt-improver';

export type { BrowserControl } from './types';
export { PromptImproverControl, type PromptImproverConfig } from './prompt-improver';

/** Control keyword config for auto-populate matching */
export interface ControlKeywordConfig {
  controlName: string;
  /** Keywords that trigger this control's blank (e.g. ["rddt", "nvda", "aapl"]) */
  keywords: string[];
  /** Keyword → display name expansion (e.g. {"rddt": "Reddit"}) */
  expansions: Record<string, string>;
  /** Remove matching keywords from text after blank fill */
  clearKeywords: boolean;
  /** Consume entire input (prompt improver mode) */
  consumeAll: boolean;
  /** Proximity: how many words around `_` to search for keywords */
  proximity: number;
  /** Read-only control (no set/up/down) */
  readOnly: boolean;
}

/** Default keyword configs for built-in controls */
const CONTROL_KEYWORDS: ControlKeywordConfig[] = [
  {
    controlName: 'stocks',
    keywords: [
      'reddit stock', 'rddt', 'nvidia stock', 'nvda', 'apple stock', 'aapl',
      'google stock', 'googl', 'microsoft stock', 'msft', 'amazon stock', 'amzn',
      'tesla stock', 'tsla', 'meta stock', 'netflix stock', 'nflx', 'spotify stock', 'spot',
    ],
    expansions: {
      rddt: 'Reddit', nvda: 'Nvidia', aapl: 'Apple', googl: 'Alphabet',
      msft: 'Microsoft', amzn: 'Amazon', tsla: 'Tesla',
    },
    clearKeywords: false,
    consumeAll: false,
    proximity: 2,
    readOnly: true,
  },
  {
    controlName: 'weather',
    keywords: ['weather', 'forecast', 'temp', 'temperature'],
    expansions: {},
    clearKeywords: false,
    consumeAll: false,
    proximity: 3,
    readOnly: true,
  },
  {
    controlName: 'hackernews',
    keywords: ['hackernews', 'hacker news', 'hn'],
    expansions: {},
    clearKeywords: false,
    consumeAll: false,
    proximity: 1,
    readOnly: true,
  },
  {
    controlName: 'prompt',
    keywords: ['improve prompt', 'enhance prompt', 'refine prompt'],
    expansions: {},
    clearKeywords: true,
    consumeAll: true,
    proximity: 999, // consume-all uses entire text
    readOnly: false,
  },
];

export function getControlKeywords(): ControlKeywordConfig[] {
  return CONTROL_KEYWORDS;
}

/** Registry of all available browser-native controls */
export function createControls(options?: {
  finnhubApiKey?: string;
  customTickers?: Record<string, string>;
  llmConfig?: PromptImproverConfig;
}): Map<string, BrowserControl> {
  const controls = new Map<string, BrowserControl>();

  controls.set('volume', new VolumeControl());
  controls.set('stocks', new StocksControl(options?.finnhubApiKey, options?.customTickers));
  controls.set('weather', new WeatherControl());
  controls.set('hackernews', new HackerNewsControl());

  if (options?.llmConfig) {
    controls.set('prompt', new PromptImproverControl(options.llmConfig));
  }

  return controls;
}
