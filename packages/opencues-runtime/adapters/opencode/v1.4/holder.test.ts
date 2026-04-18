// Unit-test the singleton holder pattern that the OpenCode patch uses
// to bridge the Prompt component's TextareaRenderable ref to the
// boot()-time host bindings.
//
// Note: this test imports the runtime side ONLY (boot.ts). The holder
// itself lives in the patch file (opencuesBootstrap.ts) shipped to the
// fork; the runtime doesn't see it. We model the same lazy-binding
// pattern locally to verify it works.

import { describe, expect, it } from 'vitest';

interface PromptInputAccess {
  read(): string;
  write(text: string): void;
  cursor(): number;
  setCursor(offset: number): void;
}

function makeHolder() {
  let current: PromptInputAccess | null = null;
  return {
    publish: (a: PromptInputAccess | null) => { current = a; },
    backed: (): PromptInputAccess => ({
      read: () => current?.read() ?? '',
      write: (t) => current?.write(t),
      cursor: () => current?.cursor() ?? 0,
      setCursor: (c) => current?.setCursor(c),
    }),
  };
}

describe('OpenCode v1.4 holder-backed prompt access', () => {
  it('reads return defaults before publish', () => {
    const h = makeHolder();
    const a = h.backed();
    expect(a.read()).toBe('');
    expect(a.cursor()).toBe(0);
    a.write('ignored'); // no-op pre-publish
    expect(a.read()).toBe('');
  });

  it('reads route to live functions after publish', () => {
    const h = makeHolder();
    const a = h.backed();
    let text = 'hello';
    let cur = 5;
    h.publish({
      read: () => text,
      write: (t) => { text = t; },
      cursor: () => cur,
      setCursor: (c) => { cur = c; },
    });
    expect(a.read()).toBe('hello');
    expect(a.cursor()).toBe(5);
    a.write('world');
    expect(text).toBe('world');
    a.setCursor(2);
    expect(cur).toBe(2);
  });

  it('publish(null) reverts to defaults', () => {
    const h = makeHolder();
    const a = h.backed();
    h.publish({
      read: () => 'x', write: () => {}, cursor: () => 7, setCursor: () => {},
    });
    expect(a.read()).toBe('x');
    h.publish(null);
    expect(a.read()).toBe('');
    expect(a.cursor()).toBe(0);
  });
});
