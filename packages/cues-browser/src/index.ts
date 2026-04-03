/**
 * cues-browser
 *
 * Browser adapters for OpenCues.
 *
 * STATUS: Scaffolding — not yet implemented.
 * This package is reserved for a future browser integration layer
 * (Chrome extensions, web apps, etc.).
 */

// Storage
export {
  LocalStorageAdapter,
  ChromeStorageAdapter,
  MemoryStorageAdapter,
} from './storage';

// HTTP
export {
  BrowserHttpAdapter,
  createHttpAdapter,
  type BrowserHttpAdapterConfig,
} from './http';

// Config
export { BrowserConfigAdapter, ChromeConfigAdapter } from './config';

// Re-export core types for convenience
export * from 'cues-core';
