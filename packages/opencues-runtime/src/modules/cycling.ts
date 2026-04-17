import type { HostAdapter } from '../adapter';

export class Cycling {
  constructor(private adapter: HostAdapter) {
    void this.adapter;
  }
}
