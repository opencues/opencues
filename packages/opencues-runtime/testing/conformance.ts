import { describe, expect, it } from 'vitest';
import {
  HOST_ADAPTER_INTERFACE_VERSION,
  type HostAdapter,
} from '../src/adapter';

export type AdapterFactory = () => HostAdapter;

/**
 * Conformance suite — runs against any HostAdapter implementation.
 * Asserts the invariants documented in refactor.md §2.3.
 */
export function adapterConformanceSuite(factory: AdapterFactory): void {
  describe('HostAdapter conformance', () => {
    describe('metadata', () => {
      it('interfaceVersion matches runtime', () => {
        const a = factory();
        expect(a.interfaceVersion).toBe(HOST_ADAPTER_INTERFACE_VERSION);
      });
      it('exposes hostName, hostVersion, capabilities, cwd', () => {
        const a = factory();
        expect(typeof a.hostName).toBe('string');
        expect(typeof a.hostVersion).toBe('string');
        expect(Array.isArray(a.capabilities)).toBe(true);
        expect(typeof a.cwd).toBe('string');
      });
    });

    describe('getters never throw', () => {
      it('returns sensible defaults', () => {
        const a = factory();
        expect(() => a.getText()).not.toThrow();
        expect(() => a.getCursorOffset()).not.toThrow();
        expect(() => a.getSelection()).not.toThrow();
        expect(typeof a.getText()).toBe('string');
        expect(typeof a.getCursorOffset()).toBe('number');
      });
    });

    describe('setters never throw', () => {
      it('setText + setCursorOffset', () => {
        const a = factory();
        expect(() => a.setText('hello')).not.toThrow();
        expect(() => a.setCursorOffset(3)).not.toThrow();
      });
      it('setCursorOffset out-of-range clamps silently', () => {
        const a = factory();
        a.setText('abc');
        expect(() => a.setCursorOffset(-100)).not.toThrow();
        const afterLow = a.getCursorOffset();
        expect(afterLow).toBeGreaterThanOrEqual(0);
        expect(() => a.setCursorOffset(1000)).not.toThrow();
        const afterHigh = a.getCursorOffset();
        expect(afterHigh).toBeLessThanOrEqual(a.getText().length);
      });
    });

    describe('forceRender', () => {
      it('is no-op when force-render capability missing, else non-throwing', () => {
        const a = factory();
        expect(() => a.forceRender()).not.toThrow();
      });
    });

    describe('subscriptions', () => {
      it('onKey returns working Unsubscribe', () => {
        const a = factory();
        const unsub = a.onKey(null, () => false);
        expect(typeof unsub).toBe('function');
        expect(() => unsub()).not.toThrow();
        expect(() => unsub()).not.toThrow(); // idempotent from caller's view
      });
      it('onTextChange returns working Unsubscribe', () => {
        const a = factory();
        const unsub = a.onTextChange(() => {});
        expect(typeof unsub).toBe('function');
        unsub();
      });
      it('onRender returns working Unsubscribe', () => {
        const a = factory();
        const unsub = a.onRender(() => null);
        expect(typeof unsub).toBe('function');
        unsub();
      });
    });

    describe('file I/O capability gating', () => {
      it('readFile resolves to null when file-read capability present and file missing', async () => {
        const a = factory();
        if (a.capabilities.includes('file-read')) {
          await expect(a.readFile('/nonexistent/path/xyz')).resolves.toBeNull();
        }
      });
      it('writeFile rejects when capability absent', async () => {
        const a = factory();
        if (!a.capabilities.includes('file-write')) {
          await expect(a.writeFile('/tmp/x', 'y')).rejects.toBeInstanceOf(Error);
        }
      });
    });

    describe('log', () => {
      it('accepts all levels without throwing', () => {
        const a = factory();
        expect(() => {
          a.log('debug', 'd');
          a.log('info', 'i');
          a.log('warn', 'w');
          a.log('error', 'e', { k: 1 });
        }).not.toThrow();
      });
    });

    describe('lifecycle', () => {
      it('dispose is idempotent', () => {
        const a = factory();
        expect(() => a.dispose()).not.toThrow();
        expect(() => a.dispose()).not.toThrow();
      });
      it('getters still return sensible values after dispose', () => {
        const a = factory();
        a.dispose();
        expect(() => a.getText()).not.toThrow();
        expect(() => a.getCursorOffset()).not.toThrow();
      });
    });

    describe('re-entrancy', () => {
      it('setText from inside onTextChange does not infinite-loop', () => {
        const a = factory();
        let calls = 0;
        const unsub = a.onTextChange(() => {
          calls += 1;
          if (calls > 10) throw new Error('apparent infinite loop');
          if (calls === 1) a.setText('guard');
        });
        a.setText('hello');
        unsub();
        expect(calls).toBeLessThanOrEqual(10);
      });
    });

    describe('handler errors do not propagate', () => {
      it('throwing onTextChange handler does not crash setText', () => {
        const a = factory();
        a.onTextChange(() => {
          throw new Error('boom');
        });
        expect(() => a.setText('trigger')).not.toThrow();
      });
    });
  });
}
