/**
 * cues-browser/config.ts
 *
 * Browser configuration adapter.
 */

import { ConfigAdapter } from 'cues-core';

/**
 * Browser config adapter that reads from various sources.
 */
export class BrowserConfigAdapter implements ConfigAdapter {
  private values: Record<string, string> = {};

  /**
   * Create a new BrowserConfigAdapter.
   *
   * @param initialValues - Initial configuration values
   */
  constructor(initialValues: Record<string, string> = {}) {
    this.values = { ...initialValues };
  }

  get(key: string): string | undefined {
    return this.values[key];
  }

  getAll(): Record<string, string> {
    return { ...this.values };
  }

  set(key: string, value: string): void {
    this.values[key] = value;
  }

  /**
   * Load configuration from URL query parameters.
   */
  loadFromQueryParams(): void {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of params) {
      this.values[key] = value;
    }
  }

  /**
   * Load configuration from localStorage.
   *
   * @param prefix - Key prefix to look for
   */
  loadFromLocalStorage(prefix: string = 'cues_config_'): void {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        const configKey = key.substring(prefix.length);
        const value = localStorage.getItem(key);
        if (value !== null) {
          this.values[configKey] = value;
        }
      }
    }
  }
}

/**
 * Chrome extension config adapter that reads from chrome.storage.
 */
export class ChromeConfigAdapter implements ConfigAdapter {
  private cache: Record<string, string> = {};
  private loaded: boolean = false;

  get(key: string): string | undefined {
    return this.cache[key];
  }

  getAll(): Record<string, string> {
    return { ...this.cache };
  }

  /**
   * Load configuration from chrome.storage.sync.
   * Call this before using get().
   */
  async load(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.sync.get(null, (items) => {
        for (const [key, value] of Object.entries(items)) {
          if (typeof value === 'string') {
            this.cache[key] = value;
          }
        }
        this.loaded = true;
        resolve();
      });
    });
  }

  /**
   * Set a configuration value.
   */
  async set(key: string, value: string): Promise<void> {
    this.cache[key] = value;
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
}
