/**
 * cues-node/storage.ts
 *
 * Node.js storage adapter using the file system.
 */

import * as fs from 'fs';
import * as path from 'path';
import { StorageAdapter } from 'cues-core';

/**
 * Node.js storage adapter that uses the file system.
 */
export class NodeStorageAdapter implements StorageAdapter {
  private basePath: string;
  private watchers: Map<string, fs.FSWatcher> = new Map();

  /**
   * Create a new NodeStorageAdapter.
   *
   * @param basePath - Base directory for storage (e.g., '~/.claude')
   */
  constructor(basePath: string) {
    // Expand ~ to home directory
    if (basePath.startsWith('~')) {
      basePath = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        basePath.slice(1)
      );
    }
    this.basePath = basePath;
  }

  /**
   * Read a file from storage.
   *
   * @param key - Filename relative to base path
   * @returns File contents or null if not found
   */
  async read(key: string): Promise<string | null> {
    const filePath = path.join(this.basePath, key);
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Read a file synchronously (for startup/initialization).
   *
   * @param key - Filename relative to base path
   * @returns File contents or null if not found
   */
  readSync(key: string): string | null {
    const filePath = path.join(this.basePath, key);
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Write a file to storage.
   *
   * @param key - Filename relative to base path
   * @param value - Content to write
   */
  async write(key: string, value: string): Promise<void> {
    const filePath = path.join(this.basePath, key);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, value, 'utf8');
  }

  /**
   * Write a file synchronously.
   *
   * @param key - Filename relative to base path
   * @param value - Content to write
   */
  writeSync(key: string, value: string): void {
    const filePath = path.join(this.basePath, key);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
  }

  /**
   * Watch a file for changes.
   *
   * @param key - Filename relative to base path
   * @param callback - Called when file changes
   * @returns Function to stop watching
   */
  watch(key: string, callback: (value: string) => void): () => void {
    const filePath = path.join(this.basePath, key);

    // Close existing watcher if any
    const existing = this.watchers.get(key);
    if (existing) {
      existing.close();
    }

    let debounceTimer: NodeJS.Timeout | null = null;

    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        // Debounce rapid changes
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(async () => {
          try {
            const content = await this.read(key);
            if (content !== null) {
              callback(content);
            }
          } catch {
            // File might be in middle of write, ignore
          }
        }, 100);
      }
    });

    this.watchers.set(key, watcher);

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      watcher.close();
      this.watchers.delete(key);
    };
  }

  /**
   * Check if a file exists.
   *
   * @param key - Filename relative to base path
   * @returns true if file exists
   */
  async exists(key: string): Promise<boolean> {
    const filePath = path.join(this.basePath, key);
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file modification time.
   *
   * @param key - Filename relative to base path
   * @returns Modification time in ms, or null if file doesn't exist
   */
  async getModTime(key: string): Promise<number | null> {
    const filePath = path.join(this.basePath, key);
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Delete a file.
   *
   * @param key - Filename relative to base path
   */
  async delete(key: string): Promise<void> {
    const filePath = path.join(this.basePath, key);
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Get the full path for a key.
   */
  getPath(key: string): string {
    return path.join(this.basePath, key);
  }

  /**
   * Clean up all watchers.
   */
  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
