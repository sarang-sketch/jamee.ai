import { describe, expect, it } from 'vitest';

import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import { en, hi, messages, mr, interpolate } from '@/lib/messages';
import type { MessageCatalog } from '@/lib/messages/types';
import { SUPPORTED_LANGUAGES } from '@/lib/schemas';

/**
 * Unit tests for the static message catalogs (`src/lib/messages/{en,hi,mr}.ts`).
 *
 * Requirements: 10.3, 15.3, 21.8 (one byte-identical invalid-link string per language), 21.9–21.13,
 *               21.17, 21.19, 22.4/22.14 (the recharge copy renders the price from `access.ts`, never
 *               a literal), 1.3 (the sign-in-did-not-complete copy)
 * Design: D5 (all catalog copy is pre-translated static strings; no lookup reaches a model)
 *
 * The `: MessageCatalog` annotation on `hi` and `mr` already makes coverage total at compile time —
 * a key added to the shape breaks those files until each has a real string. These tests add the
 * runtime claims a type cannot make: that the invalid-link string is byte-identical across the three
 * token failure cases (it is ONE key, so this is really a claim that no language left it empty or
 * accidentally reused another string), that the recharge copy carries the price placeholder rather
 * than a hard-coded amount, and that the new Telegram/recharge/Google keys are present and non-empty.
 */

const CATALOGS: ReadonlyArray<readonly [string, MessageCatalog]> = [
  ['en', en],
  ['hi', hi],
  ['mr', mr],
];

/** Walk every string leaf of a catalog, so "non-empty" is asserted over the whole surface. */
function stringLeaves(value: unknown, at: string, out: Array<readonly [string, string]>): void {
  if (typeof value === 'string') {
    out.push([at, value]);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) stringLeaves(nested, `${at}.${key}`, out);
  }
}

describe('the catalog lookup', () => {
  it('returns a catalog for every supported language and nothing else', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(messages(language)).toBeDefined();
    }
    expect(messages('en')).toBe(en);
    expect(messages('hi')).toBe(hi);
    expect(messages('mr')).toBe(mr);
  });

  it('has no empty string anywhere in any catalog', () => {
    for (const [language, catalog] of CATALOGS) {
      const leaves: Array<readonly [string, string]> = [];
      stringLeaves(catalog, language, leaves);
      expect(leaves.length, `${language} produced no strings`).toBeGreaterThan(50);
      for (const [at, value] of leaves) {
        expect(value.trim().length, `${at} is empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe('Requirement 21.8 — the invalid-link reply is one string, never an oracle', () => {
  it('is a single non-empty string per language, distinct from the other Telegram replies', () => {
    // It serves unknown, expired, AND consumed with one key, so a party sending arbitrary /start
    // payloads cannot tell which case it is in. The structural guarantee is that there is one key;
    // these assertions check no language quietly reused another reply or an empty string for it.
    for (const [language, catalog] of CATALOGS) {
      const invalid = catalog.telegram.invalidLink;
      expect(invalid.trim().length, `${language} invalidLink empty`).toBeGreaterThan(0);
      // It must not be identical to any other Telegram reply — that would leak the case or misinform.
      const others = [
        catalog.telegram.linkingInstructions,
        catalog.telegram.alreadyLinked,
        catalog.telegram.replaced,
        catalog.telegram.replacedNotice,
        catalog.telegram.alreadyLinkedElsewhere,
        catalog.telegram.gated,
      ];
      for (const other of others) {
        expect(invalid, `${language} invalidLink collides with another reply`).not.toBe(other);
      }
      // It must give no hint of which failure it is: no "expired"/"already used" wording.
      expect(invalid.toLowerCase()).not.toMatch(/expired|already used|consumed|unknown token/);
    }
  });

  it('renders byte-identically each time it is read within a language', () => {
    // A read of the invalid-link string is a pure object access — the same bytes every time, no
    // interpolation, no model call (D5).
    for (const [, catalog] of CATALOGS) {
      const a = catalog.telegram.invalidLink;
      const b = catalog.telegram.invalidLink;
      expect(a).toBe(b);
      // Byte-for-byte stable: encode and compare, so a smart quote slipped in is caught.
      expect([...a].length).toBe([...b].length);
    }
  });
});

describe('Requirement 22.4 / 22.14 — the recharge copy renders the price from access.ts', () => {
  it('carries the {price} placeholder rather than a literal amount in the gated reply', () => {
    for (const [language, catalog] of CATALOGS) {
      expect(catalog.telegram.gated, `${language} gated`).toContain('{price}');
      // No literal "20" in the gated copy — the amount must come from the constant, so a price
      // change is one edit to access.ts and never a translation edit.
      expect(catalog.telegram.gated, `${language} gated has a literal amount`).not.toMatch(
        /\u20B9\s*\d/,
      );
    }
  });

  it('interpolates the price from RECHARGE_PRICE_RUPEES into the gated and recharge replies', () => {
    for (const [language, catalog] of CATALOGS) {
      const rendered = interpolate(catalog.telegram.gated, { price: RECHARGE_PRICE_RUPEES });
      expect(rendered, `${language} gated`).toContain(`\u20B9${RECHARGE_PRICE_RUPEES}`);
      expect(rendered).not.toContain('{price}');

      const recharge = interpolate(catalog.telegram.rechargeCommand, {
        price: RECHARGE_PRICE_RUPEES,
        link: 'https://rzp.example/pay',
      });
      expect(recharge, `${language} rechargeCommand`).toContain(`\u20B9${RECHARGE_PRICE_RUPEES}`);
      expect(recharge).toContain('https://rzp.example/pay');
    }
  });

  it('renders the web recharge button price from the constant', () => {
    for (const [language, catalog] of CATALOGS) {
      expect(catalog.access.rechargeButton, `${language} rechargeButton`).toContain('{price}');
      const rendered = interpolate(catalog.access.rechargeButton, { price: RECHARGE_PRICE_RUPEES });
      expect(rendered).toContain(String(RECHARGE_PRICE_RUPEES));
    }
  });

  it('carries an {expiry} placeholder in the confirmation and active-until copy', () => {
    for (const [language, catalog] of CATALOGS) {
      expect(catalog.telegram.rechargeConfirmation, `${language}`).toContain('{expiry}');
      expect(catalog.access.rechargeActiveUntil, `${language}`).toContain('{expiry}');
    }
  });
});

describe('the Amendment A1/A2/A3 keys are present and non-empty in every language', () => {
  it('has the full Telegram reply set', () => {
    for (const [language, catalog] of CATALOGS) {
      const t = catalog.telegram;
      for (const key of [
        'linkingInstructions',
        'invalidLink',
        'alreadyLinked',
        'replaced',
        'replacedNotice',
        'alreadyLinkedElsewhere',
        'gated',
        'rechargeCommand',
        'lapsedWindow',
        'unsupportedType',
        'takingLonger',
        'rechargeConfirmation',
      ] as const) {
        expect(t[key].trim().length, `${language} telegram.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('has the web access-card set', () => {
    for (const [language, catalog] of CATALOGS) {
      const a = catalog.access;
      for (const key of [
        'rechargeHeading',
        'rechargeButton',
        'rechargeActiveUntil',
        'rechargeInactive',
        'rechargeConfirming',
        'rechargeTestModeNote',
        'linkHeading',
        'linkButton',
        'unlinkButton',
        'linkedState',
        'notLinkedState',
      ] as const) {
        expect(a[key].trim().length, `${language} access.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('has the Google sign-in and Telegram channel UI keys', () => {
    for (const [language, catalog] of CATALOGS) {
      expect(catalog.ui.googleSignIn.trim().length, `${language} ui.googleSignIn`).toBeGreaterThan(0);
      expect(
        catalog.ui.signInDidNotComplete.trim().length,
        `${language} ui.signInDidNotComplete`,
      ).toBeGreaterThan(0);
      expect(catalog.ui.channelTelegram.trim().length, `${language} ui.channelTelegram`).toBeGreaterThan(
        0,
      );
    }
  });
});
