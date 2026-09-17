import { describe, expect, it } from 'vitest';

import { severitySchema, type Severity } from '@/lib/schemas';
import { SEVERITY_SCALE_LENGTH, severityIndicator } from '@/lib/severity';

/**
 * Unit tests for the non-colour severity indicator.
 *
 * Requirements: 15.4
 * Design: "Frontend — Mobile layout and accessibility" — *severity is conveyed by label text and
 *          icon, never colour alone*
 *
 * The three properties worth pinning are the three that make the indicator honest rather than
 * decorative: it is ordinal, it is the same width at every level, and it is built out of ordinary
 * text characters with no colour in it. Whether the circles *render* as circles in the Devanagari
 * families a given handset resolves is a device question and belongs to task 30.1.
 */

const LEVELS = severitySchema.options;

describe('severityIndicator', () => {
  /**
   * Ordinal, which is the one thing a pictogram would not say: more filled circles means worse,
   * readable without knowing which word is which.
   */
  it('fills one more dot at each step up the scale', () => {
    const filled = (severity: Severity) => [...severityIndicator(severity)]
      .filter((character) => character === '\u25CF')
      .length;

    expect(filled('none')).toBe(0);
    expect(filled('low')).toBe(1);
    expect(filled('moderate')).toBe(2);
    expect(filled('high')).toBe(3);
  });

  /**
   * The same width at every level, `none` included. A fixed width is what keeps a column of these
   * comparable down a twenty-entry history list and stops the label text beside it from shifting.
   */
  it('is the same width at every level, including none', () => {
    for (const severity of LEVELS) {
      expect([...severityIndicator(severity)]).toHaveLength(SEVERITY_SCALE_LENGTH);
    }
  });

  /**
   * Every `Severity` the schema admits has an indicator — so a fifth level added to
   * `severitySchema` cannot render as an empty span while its label text carries on working.
   */
  it('covers every severity the schema admits, with no empty output', () => {
    expect(LEVELS.length).toBeGreaterThan(0);
    for (const severity of LEVELS) {
      expect(severityIndicator(severity)).not.toBe('');
    }
  });

  /**
   * Two characters, both from Geometric Shapes, and nothing else. No markup, no entity, and above
   * all nothing that could carry a colour: the icon differs from level to level by *count* only,
   * which is what keeps the design's "never colour alone" rule true for the icon half as well.
   */
  it('is plain text built from exactly two characters', () => {
    for (const severity of LEVELS) {
      expect(severityIndicator(severity)).toMatch(/^[\u25CF\u25CB]+$/u);
    }
  });
});
