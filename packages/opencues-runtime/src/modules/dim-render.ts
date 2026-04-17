import type { HostAdapter } from '../adapter';

export class DimRender {
  constructor(private adapter: HostAdapter) {
    void this.adapter;
  }
}
