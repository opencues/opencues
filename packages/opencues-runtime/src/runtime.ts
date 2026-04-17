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
    adapter.log('info', 'OpenCues runtime starting', {
      host: adapter.hostName,
      hostVersion: adapter.hostVersion,
      capabilities: adapter.capabilities,
    });
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
