// Side-effect module: runs before opencues-bootstrap is imported, so
// the bootstrap's module-load references to `chrome.storage` /
// `chrome.runtime` find a stub instead of a ReferenceError.

(globalThis as unknown as { chrome?: unknown }).chrome ??= {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    onChanged: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
  },
  runtime: {
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener: () => undefined },
    connect: () => ({
      postMessage: () => undefined,
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined },
    }),
  },
};
