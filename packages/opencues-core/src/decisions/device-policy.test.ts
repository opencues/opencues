import { describe, it, expect } from 'vitest';
import { DEVICE_POLICY, resolveDeviceInvocation, deviceCanonicalCommand, deviceArgWithinFloor } from './device-policy';

const v = (blank: string, value: string) => ({ blank, value, confidence: 0.9, valueConfidence: 0.9, top: '' });

describe('device policy (security-audit row #32, tier 2)', () => {
  it('only the listed built-ins resolve; a user blank never does', () => {
    expect(resolveDeviceInvocation(v('zorb-script', 'up'), 'zorb up _')).toBeNull();
    expect(Object.keys(DEVICE_POLICY).sort()).toEqual(['brightness', 'location', 'model', 'volume', 'weather']);
  });

  it('closed values map to the shape action the blank already takes', () => {
    expect(resolveDeviceInvocation(v('volume', 'up'), 'make it louder _')).toEqual({ blank: 'volume', keyword: 'volume', action: 'step', value: 'up' });
    expect(resolveDeviceInvocation(v('volume', 'mute'), 'silence it _')).toEqual({ blank: 'volume', keyword: 'volume', action: 'set', value: '0' });
    expect(resolveDeviceInvocation(v('location', 'here'), 'where am i _')).toEqual({ blank: 'location', keyword: 'location', action: 'get', value: undefined });
  });

  it('a number is captured from the DRAFT by grammar, 0–100 only; the model never supplies it', () => {
    expect(resolveDeviceInvocation(v('volume', 'number'), 'set the sound to 40 _')).toEqual({ blank: 'volume', keyword: 'volume', action: 'set', value: '40' });
    expect(resolveDeviceInvocation(v('brightness', 'number'), 'screen at 70% please _')).toEqual({ blank: 'brightness', keyword: 'brightness', action: 'set', value: '70' });
    expect(resolveDeviceInvocation(v('volume', 'number'), 'set the sound to 400 _')).toBeNull();
    expect(resolveDeviceInvocation(v('volume', 'number'), 'make it louder _')).toBeNull();
    expect(resolveDeviceInvocation(v('location', 'number'), 'location 40 _')).toBeNull();
  });

  it('a named argument is captured by an anchored grammar and floored', () => {
    expect(resolveDeviceInvocation(v('weather', 'named'), 'is it raining in oslo tomorrow _')).toEqual({ blank: 'weather', keyword: 'weather', action: 'get', value: 'oslo' });
    expect(resolveDeviceInvocation(v('weather', 'named'), 'weather for new york _')).toEqual({ blank: 'weather', keyword: 'weather', action: 'get', value: 'new york' });
    expect(resolveDeviceInvocation(v('weather', 'named'), 'weather in http://x _')).toBeNull();
    expect(deviceArgWithinFloor('oslo')).toBe(true);
    expect(deviceArgWithinFloor('a?b')).toBe(false);
    expect(deviceArgWithinFloor('x'.repeat(61))).toBe(false);
  });

  it('the canonical command is one the blank\'s own shapes accept', () => {
    expect(deviceCanonicalCommand({ blank: 'volume', keyword: 'volume', action: 'set', value: '40' })).toBe('volume 40 _');
    expect(deviceCanonicalCommand({ blank: 'volume', keyword: 'volume', action: 'step', value: 'up' })).toBe('volume up _');
    expect(deviceCanonicalCommand({ blank: 'location', keyword: 'location', action: 'get' })).toBe('location _');
    expect(deviceCanonicalCommand({ blank: 'weather', keyword: 'weather', action: 'get', value: 'oslo' })).toBe('weather oslo _');
    expect(deviceCanonicalCommand({ blank: 'model', keyword: 'model', action: 'get', value: 'cues' })).toBe('model for cues _');
    expect(deviceCanonicalCommand({ blank: 'model', keyword: 'model', action: 'get', value: 'models' })).toBe('models _');
  });
});
