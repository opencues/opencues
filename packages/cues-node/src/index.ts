/**
 * cues-node
 *
 * Node.js adapters for OpenCues.
 *
 * STATUS: Scaffolding — not yet implemented.
 * The Claude Code integration currently uses the standalone node-http-adapter.js
 * directly. This package is reserved for a future full Node.js adapter layer.
 */

// Storage
export { NodeStorageAdapter } from './storage';

// HTTP
export { NodeHttpAdapter, createHttpAdapter, type NodeHttpAdapterConfig } from './http';

// Config
export {
  NodeConfigAdapter,
  loadCuesConfig,
  type CuesConfig,
} from './config';

// Re-export core types for convenience
export * from 'cues-core';
