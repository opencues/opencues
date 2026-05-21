import {
  HOST_ADAPTER_INTERFACE_VERSION,
  type Capability,
  type HostAdapter,
  type Unsubscribe,
} from './adapter';

export interface RuntimeConfig {
  readonly configDir?: string;
}

const REQUIRED_CAPABILITIES: readonly Capability[] = ['file-read'];

export class Runtime {
  private _disposed = false;
  private _subscriptions: Unsubscribe[] = [];

  private constructor(
    public readonly adapter: HostAdapter,
    public readonly config: RuntimeConfig,
  ) {}

  static async create(adapter: HostAdapter, config: RuntimeConfig = {}): Promise<Runtime> {
    if (adapter.interfaceVersion !== HOST_ADAPTER_INTERFACE_VERSION) {
      throw new Error(
        `HostAdapter interface version mismatch: runtime expects ` +
          `${HOST_ADAPTER_INTERFACE_VERSION}, adapter reports ${adapter.interfaceVersion}`,
      );
    }
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!adapter.capabilities.includes(cap)) {
        throw new Error(`HostAdapter missing required capability: ${cap}`);
      }
    }
    // Boot log is owned by the per-adapter boot.ts — it knows the band
    // version ("Chrome v1", "OpenCode v1.14", "Gemini CLI v0.41") which
    // is more useful for triage than `adapter.hostVersion` alone.
    // Runtime.create deliberately does NOT log here. Previously it did,
    // producing a duplicate ~4ms before the per-adapter line; consolidated
    // to the per-adapter line in May 2026.
    return new Runtime(adapter, config);
  }

  hasCapability(cap: Capability): boolean {
    return this.adapter.capabilities.includes(cap);
  }

  _trackSubscription(unsub: Unsubscribe): void {
    this._subscriptions.push(unsub);
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    for (const unsub of this._subscriptions) {
      try { unsub(); } catch { /* adapter invariant: never propagate */ }
    }
    this._subscriptions = [];
  }

  get disposed(): boolean { return this._disposed; }
}
