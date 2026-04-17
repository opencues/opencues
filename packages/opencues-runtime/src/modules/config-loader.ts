import type { HostAdapter } from '../adapter';

export class ConfigLoader {
  constructor(private adapter: HostAdapter) {
    void this.adapter;
  }
}
