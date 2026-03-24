/**
 * cues-browser/storage.ts
 *
 * Browser storage adapters (localStorage, chrome.storage).
 */

import { StorageAdapter } from 'cues-core';

/**
 * Browser localStorage adapter.
 * Works in any browser context.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private prefix: string;

  /**
   * Create a new LocalStorageAdapter.
   *
   * @param prefix - Key prefix for namespacing (default: 'cues:')
   */
  constructor(prefix: string = 'cues:') {
    this.prefix = prefix;
  }

  async read(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    localStorage.setItem(this.prefix + key, value);
  }

  watch(key: string, callback: (value: string) => void): () => void {
    const handler = (event: StorageEvent) => {
      if (event.key === this.prefix + key && event.newValue !== null) {
        callback(event.newValue);
      }
    };

    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.prefix + key);
  }
}

/**
 * Chrome extension storage adapter.
 * Works in Chrome extension contexts.
 */
export class ChromeStorageAdapter implements StorageAdapter {
  private area: 'local' | 'sync';

  /**
   * Create a new ChromeStorageAdapter.
   *
   * @param area - Storage area ('local' or 'sync')
   */
  constructor(area: 'local' | 'sync' = 'local') {
    this.area = area;
  }

  private get storage(): chrome.storage.StorageArea {
    return this.area === 'sync' ? chrome.storage.sync : chrome.storage.local;
  }

  async read(key: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.storage.get(key, (result: { [key: string]: unknown }) => {
        const value = result[key];
        resolve(typeof value === 'string' ? value : null);
      });
    });
  }

  async write(key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.storage.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  watch(key: string, callback: (value: string) => void): () => void {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      const change = changes[key];
      if (areaName === this.area && change?.newValue !== undefined) {
        const value = change.newValue;
        if (typeof value === 'string') {
          callback(value);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  async delete(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.storage.remove(key, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
}

/**
 * In-memory storage adapter for testing.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private data: Map<string, string> = new Map();
  private listeners: Map<string, Set<(value: string) => void>> = new Map();

  async read(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.data.set(key, value);

    // Notify listeners
    const keyListeners = this.listeners.get(key);
    if (keyListeners) {
      for (const callback of keyListeners) {
        callback(value);
      }
    }
  }

  watch(key: string, callback: (value: string) => void): () => void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(callback);

    return () => {
      this.listeners.get(key)?.delete(callback);
    };
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
    this.listeners.clear();
  }
}
