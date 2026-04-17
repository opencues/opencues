import type { HostAdapter } from '../adapter';

export class TTS {
  constructor(private adapter: HostAdapter) {
    void this.adapter;
  }
}
