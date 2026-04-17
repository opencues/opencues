import type { HostAdapter } from '../adapter';

export class Statusline {
  constructor(private adapter: HostAdapter) {
    void this.adapter;
  }
}
