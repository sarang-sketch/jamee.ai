import { describe, expect, it } from 'vitest';

import { GEMINI_GENERATION } from '@/lib/config/verified';

/**
 * Guards the Gemini generation config against a value the live `gemini-3.8-flash` model rejects.
 *
 * The smoke run (worker w7s) hit HTTP 400 from the real API:
 *   "'minimal' is not a supported thinking level for this model. Allowed values are: high, low, medium."
 * The config had `thinkingLevel: 'minimal'`, which every `/api/diagnose` call sent on the vision
 * request, so every diagnosis failed with `PROVIDERS_UNAVAILABLE` (the gateway classifies a 400 as
 * `OTHER`, which does not fall back). This test pins the value to the set the model accepts so the
 * bad value cannot come back, and keeps the "lowest accepted level" intent stated on the constant.
 */
describe('GEMINI_GENERATION.thinkingLevel', () => {
  /** The exact set the live model reports as allowed (from the HTTP 400 message above). */
  const ALLOWED = ['high', 'low', 'medium'] as const;

  it('is a level the live gemini-3.8-flash model accepts', () => {
    expect(ALLOWED).toContain(GEMINI_GENERATION.thinkingLevel);
  });

  it('is never the rejected value "minimal"', () => {
    expect(GEMINI_GENERATION.thinkingLevel).not.toBe('minimal');
  });

  it('is the lowest accepted level, preserving the latency/determinism intent', () => {
    expect(GEMINI_GENERATION.thinkingLevel).toBe('low');
  });
});
