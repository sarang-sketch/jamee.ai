import { describe, expect, it } from 'vitest';

import { productCopy } from '@/lib/product-copy';
import { SUPPORTED_LANGUAGES } from '@/lib/schemas';

describe('productCopy', () => {
  it('covers every supported language and every requested product feature', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const copy = productCopy(language);
      expect(copy.features.items).toHaveLength(6);
      expect(copy.how.steps).toHaveLength(4);
      expect(copy.ways.items).toHaveLength(3);
      expect(copy.workspace.suggestions).toHaveLength(4);
      expect(copy.payment.title).toContain('₹20');
      expect(copy.payment.title).toMatch(/7/);
      expect(copy.telegram.body).toMatch(/Telegram|टेलीग्राम|टेलिग्राम/i);
    }
  });

  it('keeps Devanagari copy as reviewable literal characters', () => {
    expect(productCopy('hi').hero.title).toMatch(/[\u0900-\u097F]/);
    expect(productCopy('mr').hero.title).toMatch(/[\u0900-\u097F]/);
    expect(productCopy('hi').hero.title).not.toContain('\\u');
    expect(productCopy('mr').hero.title).not.toContain('\\u');
  });
});
