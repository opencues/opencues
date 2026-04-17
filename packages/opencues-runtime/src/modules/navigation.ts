import type { HostAdapter } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';

export class Navigation {
  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
  ) {
    void this.adapter;
    void this.hlState;
    void this.dynDefs;
  }
}
