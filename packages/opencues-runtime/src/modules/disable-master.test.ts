/**
 * Tests for `disable:` parity across CUES.md / BLANKS.md / AUDITORS.md.
 *
 * The composition rule: each master file's `disable: [<source-id>]` SUBTRACTs
 * the named source from this layer's composition without modifying other
 * layers. The runtime UNIONs disable lists across user + project layers and
 * applies them at source-construction time.
 */
import { describe, it, expect } from 'vitest';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

describe('master-file disable: parity', () => {
  it('CUES.md disable: [<id>] surfaces as folderConfigs.cuesConfig.disableCues', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/CUES.md':
          `---\nname: project\ndisable: [legal]\n---\n`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    expect(loader.folderConfigs?.cuesConfig?.disableCues).toEqual(['legal']);
  });

  it('BLANKS.md disable: [<id>] surfaces as folderConfigs.blanksConfig.disableBlanks', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/BLANKS.md':
          `---\nname: project\ndisable: [stocks, weather]\n---\n`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    expect(loader.folderConfigs?.blanksConfig?.disableBlanks?.sort()).toEqual(['stocks', 'weather']);
  });

  it('AUDITORS.md disable: [<id>] surfaces as folderConfigs.auditorsConfig.disableAuditors', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/AUDITORS.md':
          `---\nname: project\ndisable: [grammar]\n---\n`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    expect(loader.folderConfigs?.auditorsConfig?.disableAuditors).toEqual(['grammar']);
  });

  it('three masters can each disable independently in one project', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/CUES.md':       `---\nname: p\ndisable: [legal]\n---\n`,
        '/proj/.cues/BLANKS.md':     `---\nname: p\ndisable: [stocks]\n---\n`,
        '/proj/.cues/AUDITORS.md':   `---\nname: p\ndisable: [grammar]\n---\n`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    expect(loader.folderConfigs?.cuesConfig?.disableCues).toEqual(['legal']);
    expect(loader.folderConfigs?.blanksConfig?.disableBlanks).toEqual(['stocks']);
    expect(loader.folderConfigs?.auditorsConfig?.disableAuditors).toEqual(['grammar']);
  });

  it('absent disable: yields undefined fields (no false-positives)', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/CUES.md': `---\nname: p\n---\n`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    // No disable list → cuesConfig either absent or has no disableCues.
    expect(loader.folderConfigs?.cuesConfig?.disableCues ?? null).toBeNull();
  });
});
