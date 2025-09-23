import { describe, expect, it } from 'vitest';

import { buildBackoffDelays } from './retry';

describe('buildBackoffDelays', () => {
  it('builds exponential backoff delays up to the attempt limit', () => {
    const delays = buildBackoffDelays({
      initialDelayMs: 1000,
      maxDelayMs: 16000,
      maxAttempts: 4,
    });

    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it('stops when cumulative delay would exceed the limit', () => {
    const delays = buildBackoffDelays({
      initialDelayMs: 2000,
      maxDelayMs: 30000,
      maxCumulativeDelayMs: 9000,
    });

    expect(delays).toEqual([2000, 4000]);
    expect(delays.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(9000);
  });

  it('returns an empty array when provided non-positive delays', () => {
    expect(buildBackoffDelays({ initialDelayMs: 0 })).toEqual([]);
    expect(buildBackoffDelays({ initialDelayMs: -100 })).toEqual([]);
  });
});
