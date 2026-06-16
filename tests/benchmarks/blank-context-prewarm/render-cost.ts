// Micro-bench: catalog render wall-clock cost.
//
// Measures how long renderBlankContextCatalog +
// renderBlankContextCatalogForTransform take per call. Pre-PR2
// (baseline) every call rebuilds the ~570-token catalog block from
// scratch. Post-PR2 (memoize), repeated identical-snapshot calls
// return the cached string.
//
// Run:
//   npx tsx tests/benchmarks/blank-context-prewarm/render-cost.ts

import {
  renderBlankContextCatalog,
  type BlankContextSnapshot,
} from '../../../packages/opencues-core/dist';
import { renderBlankContextCatalogForTransform } from '../../../packages/opencues-core/dist/blank-context';
import { renderIdentityContextCatalog, renderIdentityContextCatalogForTransform, type Identity } from '../../../packages/opencues-core/dist/identity-context';

function makeSnapshot(nFields: number): BlankContextSnapshot {
  const fields = Array.from({ length: nFields }, (_, i) => {
    const prefix = ['STOCKS', 'WEATHER', 'CRYPTO', 'HACKERNEWS', 'NEWS'][i % 5];
    const slot = String.fromCharCode(65 + (i % 26)) + (i + 1);
    return {
      token: `[${prefix} ${slot}]`,
      description: `live ${prefix.toLowerCase()} snapshot for ${slot}`,
      value: `value-${i}-${Math.floor(Math.random() * 100000)}`,
    };
  });
  const catalog = new Map<string, string>();
  for (const f of fields) catalog.set(f.token, f.value);
  return { fields, catalog };
}

function timeIt(label: string, fn: () => void, iters: number): number {
  // Warm-up
  for (let i = 0; i < 10; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const elapsed = performance.now() - t0;
  const perCall = elapsed / iters;
  console.log(`  ${label.padEnd(50)} ${perCall.toFixed(3)}ms per call  (${iters} iters in ${elapsed.toFixed(1)}ms)`);
  return perCall;
}

function makeIdentity(nFields: number): Identity {
  const fields = Array.from({ length: nFields }, (_, i) => ({
    key: `field${i}`,
    token: `[FIELD ${i}]`,
    value: `value-${i}`,
    description: `description for field ${i}`,
  }));
  const catalog = new Map<string, string>();
  for (const f of fields) catalog.set(f.token, f.value);
  return { fields, catalog };
}

function main(): void {
  console.log('Catalog render micro-bench\n');

  for (const n of [3, 10, 20]) {
    console.log(`Catalog size: ${n} fields`);
    const snap = makeSnapshot(n);
    const identity = makeIdentity(n);
    timeIt('renderBlankContextCatalog (safe)',                    () => { renderBlankContextCatalog(snap, 'safe'); },                    10_000);
    timeIt('renderBlankContextCatalogForTransform (safe)',        () => { renderBlankContextCatalogForTransform(snap, 'safe'); },        10_000);
    timeIt('renderIdentityContextCatalog (safe)',                 () => { renderIdentityContextCatalog(identity, 'safe'); },             10_000);
    timeIt('renderIdentityContextCatalogForTransform (safe)',     () => { renderIdentityContextCatalogForTransform(identity, 'safe'); }, 10_000);
    console.log('');
  }
}

main();
