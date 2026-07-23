// Chrome user-blank proxy. Custom user-blanks run on the host (Node
// process the extension connects to via native-messaging), NOT in a
// content-script Worker. Two reasons:
//
//   1. CSP — strict pages (Gmail, banks) refuse blob: Workers from
//      content scripts. Running on the host bypasses page CSP entirely.
//   2. Sandbox — Node's `vm` with permission proxy is the same
//      isolation CC/OC/gemini already use. The browser Worker was a
//      weaker model.
//
// The chrome-host is a HARD dependency for custom JS user-blanks
// (those declaring `impl: ./blank.js` in BLANK.md). Shipped TS-class
// blanks (weather, stocks, …) still register upstream in createBlanks
// and don't need this path. If the host isn't installed / connected,
// invokes fail with "native host not connected" — same fail-shape as
// scripted blanks without the host (exitCode 127).

import type { Blank } from '@opencues/runtime/dist/src/blanks';
import { sanitizeBlankOutput } from '@opencues/runtime/dist/src/user-blanks/sanitize';

export interface ChromeUserBlankOptions {
  /** Output mode for sanitization at the host→content trust boundary.
   *  'safe' (default) strips HTML / zero-width / bidi overrides;
   *  'rich' bypasses. The host also sanitizes on its end with the
   *  same setting baked into the wrapped Blank — defence in depth. */
  readonly output?: 'safe' | 'rich';
}

interface UserBlankInvokeReply {
  ok: boolean;
  output?: string;
  error?: string;
}

/**
 * Thin proxy. Each method round-trips to the chrome-host:
 *   content → browser.runtime.sendMessage → SW → native port → host
 *   host → SW → sendResponse → here
 *
 * Capability enforcement (network allow-list, secret bindings, quota,
 * storage namespace) lives on the host — it loads the blank source
 * from disk and uses @opencues/runtime's buildUserBlankRegistry, the
 * same loader CC/OC/gemini use. We just relay invocation args + apply
 * the sanitizer at the trust boundary on the way back.
 */
export class ChromeUserBlank implements Blank {
  readonly name: string;
  // readOnly is unknown until the first invoke; defaulting to false
  // lets cycling attempt `set()` — the host returns an error when the
  // module didn't export `set`, which the runtime treats as a no-op
  // for that direction. Plumbing the actual flag would require a
  // host-side describe round-trip; not worth the latency given the
  // error path already degrades gracefully.
  readonly readOnly = false;

  constructor(name: string, private opts: ChromeUserBlankOptions = {}) {
    this.name = name;
  }

  async get(keyword?: string, context?: string[]): Promise<string> {
    return this.invoke('get', [keyword ?? '', ...(context ?? [])]);
  }

  async set(value: string, keyword?: string): Promise<void> {
    await this.invoke('set', [value, keyword ?? '']);
  }

  private async invoke(method: 'get' | 'set', args: readonly string[]): Promise<string> {
    let reply: UserBlankInvokeReply;
    try {
      reply = await browser.runtime.sendMessage({
        type: 'opencues:user-blank-invoke',
        name: this.name,
        method,
        args: Array.from(args),
      });
    } catch (err) {
      throw new Error(`user-blank "${this.name}" relay failed: ${String(err)}`);
    }
    if (!reply || !reply.ok) {
      // When chrome-host isn't connected the background SW returns a
      // known error string. Translate to a user-visible substitute
      // string so BlankFill paints it in-buffer instead of the user
      // seeing nothing. `set` callers ignore the return value, but a
      // throw on `set` would also bubble silently — return a no-op
      // marker the runtime won't render.
      if (reply?.error && /native host not connected/i.test(reply.error)) {
        if (method === 'set') return '';
        return `[OpenCues: user-blank "${this.name}" requires chrome-host — install via \`opencues install chrome-host\`]`;
      }
      throw new Error(reply?.error ?? `user-blank "${this.name}" invoke failed`);
    }
    // Sanitize at the host→content trust boundary. The host's loader
    // already applies the same sanitizer on its end, but defence in
    // depth — the chrome adapter is the last line before the DOM.
    return sanitizeBlankOutput(reply.output ?? '', { allowRich: this.opts.output === 'rich' });
  }

  dispose(): void {
    // Host owns lifecycle; nothing to clean up on this side.
  }
}
