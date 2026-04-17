import { describe, expect, it } from 'vitest';
import {
  findKeyDispatcher,
  findInputStateHandler,
  findRenderedValue,
  runSeams,
  assertAllFound,
} from './seams';

describe('S1 findKeyDispatcher', () => {
  it('matches the canonical v2.1.110 shape', () => {
    const src = `function t(O6,k6){switch(O6.key){case"escape":return 1;case"left":return 2}}`;
    const match = findKeyDispatcher(src);
    expect(match).not.toBeNull();
    expect(match!.bindings).toEqual({ funcName: 't', eventParam: 'O6', keyParam: 'k6' });
    expect(match!.method).toBe('regex');
    expect(src.slice(match!.startIndex, match!.startIndex + 8)).toBe('switch(O');
  });

  it('tolerates renamed identifiers (still regex matches — shape is stable)', () => {
    const src = `function abc(ev,rk){switch(ev.key){case"escape":return}}`;
    const match = findKeyDispatcher(src);
    expect(match).not.toBeNull();
    expect(match!.bindings.funcName).toBe('abc');
  });

  it('falls back to AST walk when regex does not match but shape is present', () => {
    const src = `function abc ( ev , rk ) { switch ( ev.key ) { case "escape": return; } }`;
    const match = findKeyDispatcher(src);
    expect(match).not.toBeNull();
    expect(match!.method).toBe('ast');
    expect(match!.bindings.funcName).toBe('abc');
    expect(match!.bindings.eventParam).toBe('ev');
  });

  it('returns null when no switch on .key exists', () => {
    const src = `function abc(ev){return ev.key}`;
    expect(findKeyDispatcher(src)).toBeNull();
  });

  it('returns null when switch lacks an "escape" case', () => {
    const src = `function abc(ev,rk){switch(ev.key){case"enter":return}}`;
    expect(findKeyDispatcher(src)).toBeNull();
  });
});

describe('S2 findInputStateHandler', () => {
  it('matches the canonical v2.1.110 shape and returns return-stmt anchor', () => {
    const src =
      `function Dy8({value:q,onChange:K,a:1,externalOffset:f,onOffsetChange:v,other:1}){` +
      `let x=f,B=v,m=cK.fromText(q,P,x);` +
      `return{handleKeyDown:z6,renderedValue:q}}`;
    const match = findInputStateHandler(src);
    expect(match).not.toBeNull();
    expect(match!.bindings.funcName).toBe('Dy8');
    expect(match!.bindings.valueParam).toBe('q');
    expect(match!.bindings.inputZoneClass).toBe('cK');
    expect(match!.bindings.handleKeyDownName).toBe('z6');
    expect(src.slice(match!.startIndex, match!.startIndex + 20)).toBe('return{handleKeyDown');
  });

  it('returns null if return does not contain handleKeyDown/renderedValue', () => {
    const src =
      `function Dy8({value:q,onChange:K,a:1,externalOffset:f,onOffsetChange:v,b:2}){` +
      `let x=f,B=v,m=cK.fromText(q,P,x);return{onInput:q}}`;
    expect(findInputStateHandler(src)).toBeNull();
  });
});

describe('S3 findRenderedValue', () => {
  it('matches the canonical 5-arg v2.1.110 shape', () => {
    const src = `return{handleKeyDown:z6,renderedValue:m.render(X,H,M,j6,G)}`;
    const match = findRenderedValue(src);
    expect(match).not.toBeNull();
    expect(match!.bindings.kind).toBe('render-5');
    expect(match!.bindings.renderVar).toBe('m');
    expect(match!.bindings.expression).toBe('m.render(X,H,M,j6,G)');
  });

  it('matches 4-arg variant', () => {
    const src = `return{handleKeyDown:z6,renderedValue:m.render(X,H,M,j6)}`;
    const match = findRenderedValue(src);
    expect(match).not.toBeNull();
    expect(match!.bindings.kind).toBe('render-4');
  });

  it('matches 3-arg variant', () => {
    const src = `return{handleKeyDown:z6,renderedValue:m.render(X,H,M)}`;
    const match = findRenderedValue(src);
    expect(match).not.toBeNull();
    expect(match!.bindings.kind).toBe('render-3');
  });

  it('matches rainbow-wrapped IIFE with paren balancing', () => {
    const src = `return{handleKeyDown:z6,renderedValue:(function(){var x=(1+(2));return x+1})(),other:1}`;
    const match = findRenderedValue(src);
    expect(match).not.toBeNull();
    expect(match!.bindings.kind).toBe('rainbow');
    expect(match!.bindings.expression).toBe('(function(){var x=(1+(2));return x+1})()');
  });

  it('returns null when nothing matches', () => {
    expect(findRenderedValue(`return{handleKeyDown:z6,onInput:m.render(X)}`)).toBeNull();
  });
});

describe('runSeams + assertAllFound', () => {
  it('aggregates misses into a helpful error', () => {
    const src = `function noMatch() { return 1; }`;
    const results = runSeams(src, [
      ['S1 KeyDispatcher', findKeyDispatcher],
      ['S2 InputStateHandler', findInputStateHandler],
    ]);
    expect(() => assertAllFound(results)).toThrow(/S1 KeyDispatcher/);
    expect(() => assertAllFound(results)).toThrow(/S2 InputStateHandler/);
  });

  it('passes when all seams are found', () => {
    const src =
      `function t(ev,rk){switch(ev.key){case"escape":return}}\n` +
      `function H({value:q,onChange:K,a:1,externalOffset:f,onOffsetChange:v,b:2}){` +
      `let x=f,B=v,m=cK.fromText(q,P,x);return{handleKeyDown:z6,renderedValue:q};}`;
    const results = runSeams(src, [
      ['S1', findKeyDispatcher],
      ['S2', findInputStateHandler],
    ]);
    expect(() => assertAllFound(results)).not.toThrow();
  });
});
