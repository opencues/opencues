import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The shell copies @opencues/runtime's built dist into node_modules/@opencues/runtime/
// rather than installing it as a package, so nothing installs the runtime's own
// dependencies. Every one Bun needs has to be declared in the shell's package.json.
// When this was missing, every JS user blank failed to load on the shell
// ("Cannot find package 'acorn'").

// Not needed on the shell:
//   @opencues/core — staged next to the runtime by bin/install.cjs
//   isolated-vm    — Node-only native module; on Bun the runtime uses the
//                    subprocess loader instead and never loads it
const NOT_NEEDED_ON_SHELL = new Set(['@opencues/core', 'isolated-vm']);

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const shell = readJson(join(__dirname, '..', 'package.json'));
const runtime = readJson(join(__dirname, '..', '..', '..', 'packages', 'opencues-runtime', 'package.json'));

describe('shell declares the copied runtime\'s dependencies', () => {
  const needed = Object.entries(runtime.dependencies as Record<string, string>).filter(
    ([name]) => !NOT_NEEDED_ON_SHELL.has(name),
  );

  it('covers at least acorn and acorn-walk', () => {
    expect(needed.map(([n]) => n)).toEqual(expect.arrayContaining(['acorn', 'acorn-walk']));
  });

  it.each(needed)('%s is declared with the runtime\'s range', (name, range) => {
    expect(shell.dependencies[name]).toBe(range);
  });
});

// The installer runs `bun install` in this package, which resolves from bun.lock
// and never sees the root pnpm overrides. Without a mirror, every security pin
// in the root (seroval, zod, jimp, file-type, ...) silently missed the shell
// users actually run.
describe('shell mirrors the root security overrides for Bun', () => {
  const root = readJson(join(__dirname, '..', '..', '..', 'package.json'));

  it('overrides equal the root package.json pnpm.overrides', () => {
    expect(shell.overrides).toEqual(root.pnpm.overrides);
  });
});
