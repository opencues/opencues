import type { HostAdapter } from '../adapter';

export class BlankFill {
  constructor(private adapter: HostAdapter) {
    void this.adapter;
  }
}
