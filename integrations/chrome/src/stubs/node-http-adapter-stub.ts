// Bundle-time stub for opencues-core/node-http-adapter — that module uses
// node:https which esbuild can't resolve in a browser bundle. The
// runtime's Resolver.rebuildResolver() wraps the require in try/catch
// and falls back to the host-supplied httpAdapter (FetchHttpAdapter
// for the chrome extension), so a throw here is the expected path.
//
// Throwing rather than returning an empty object is intentional: it
// surfaces in /tmp/opencues.log style as "NodeHttpAdapter load
// failed", which the host can grep for to confirm the chrome path
// went through.

export class NodeHttpAdapter {
  constructor() {
    throw new Error('NodeHttpAdapter not available in chrome extension — use host.httpAdapter');
  }
}
