import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AuthApiError, AuthError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { ERROR_SPECS } from '@/lib/errors';
import { messages } from '@/lib/messages';
import { SUPPORTED_LANGUAGES } from '@/lib/schemas';

import { E164_PHONE, isE164Phone, normalizePhone, signInErrorCode } from './SignInForm';

/**
 * Unit tests for the two decisions `SignInForm` makes before and after the network:
 * whether a typed number is an E.164 number worth an SMS, and which coded error a failed
 * auth call is.
 *
 * Requirements: 1.1 (E.164 before requesting an OTP), 1.3 (a mismatched or expired code says
 *               the code is incorrect or expired), 15.4 (the retry offered actually works)
 *
 * The DOM half of the component — the two steps, the disabled control, the `role="alert"`
 * region — is left to the manual test plan and to task 26.2's accessibility pass rather than
 * faked here: asserting it would need a stand-in Supabase client, and a stand-in that returns
 * whatever the test wants proves nothing about sign-in.
 */

describe('normalizePhone', () => {
  it('strips the separators people write phone numbers with', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalizePhone(' (+91) 98765 43210 ')).toBe('+919876543210');
    // An en dash is what a phone keyboard's "-" key sometimes produces.
    expect(normalizePhone('+91\u201198765\u201143210')).toBe('+919876543210');
  });

  it('invents nothing — a missing country code stays missing', () => {
    expect(normalizePhone('9876543210')).toBe('9876543210');
    expect(isE164Phone(normalizePhone('9876543210'))).toBe(false);
  });
});

describe('isE164Phone', () => {
  it('accepts an E.164 number', () => {
    expect(isE164Phone('+919876543210')).toBe(true);
    // The E.164 bounds: 8 digits at the short end, 15 at the long end.
    expect(isE164Phone('+12345678')).toBe(true);
    expect(isE164Phone('+123456789012345')).toBe(true);
  });

  it('rejects what the database would also reject', () => {
    expect(isE164Phone('')).toBe(false);
    expect(isE164Phone('919876543210')).toBe(false); // no '+'
    expect(isE164Phone('+09876543210')).toBe(false); // leading zero after '+'
    expect(isE164Phone('+1234567')).toBe(false); // 7 digits
    expect(isE164Phone('+1234567890123456')).toBe(false); // 16 digits
    expect(isE164Phone('+91 98765 43210')).toBe(false); // separators belong to normalize
    expect(isE164Phone('+9198765abcde')).toBe(false);
  });

  /**
   * The browser check and the database check must be the same check. This reads the pattern out
   * of migration 0002 and compares it to the regex the component uses, so the two cannot drift
   * into a number the form accepts and the `profiles` row rejects.
   */
  it('mirrors the profiles_phone_e164 check constraint', () => {
    // `process.cwd()` rather than `import.meta.url`: the unit project runs in jsdom, where
    // `import.meta.url` is not a `file:` URL. Vitest's cwd is the project root.
    const migration = readFileSync(
      resolve(process.cwd(), 'supabase', 'migrations', '0002_profiles.sql'),
      'utf8',
    );
    const match = /check \(phone ~ '([^']+)'\)/.exec(migration);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(E164_PHONE.source);
  });
});

describe('signInErrorCode', () => {
  it('maps an expired or mismatched code to OTP_INVALID (Requirement 1.3)', () => {
    expect(
      signInErrorCode(new AuthApiError('Token has expired', 403, 'otp_expired'), 'code'),
    ).toBe('OTP_INVALID');
    expect(
      signInErrorCode(new AuthApiError('Invalid credentials', 400, 'invalid_credentials'), 'code'),
    ).toBe('OTP_INVALID');
  });

  it('treats an unknown 401/403 from the verify step as a rejected code', () => {
    expect(signInErrorCode(new AuthApiError('nope', 403, 'some_future_code'), 'code')).toBe(
      'OTP_INVALID',
    );
    expect(signInErrorCode(new AuthApiError('nope', 401, undefined), 'code')).toBe('OTP_INVALID');
  });

  it('does not tell a farmer their code is wrong when the SMS never went out', () => {
    // The same statuses on the phone step are not a rejected code, and must not read as one.
    expect(signInErrorCode(new AuthApiError('nope', 403, 'some_future_code'), 'phone')).toBe(
      'INTERNAL_ERROR',
    );
    expect(
      signInErrorCode(new AuthApiError('sms failed', 500, 'sms_send_failed'), 'phone'),
    ).toBe('INTERNAL_ERROR');
    expect(
      signInErrorCode(new AuthApiError('disabled', 422, 'phone_provider_disabled'), 'phone'),
    ).toBe('INTERNAL_ERROR');
  });

  it('reports a rate limit as a rate limit (V2: one request per 60 s)', () => {
    expect(
      signInErrorCode(new AuthApiError('slow down', 429, 'over_sms_send_rate_limit'), 'phone'),
    ).toBe('RATE_LIMITED');
    expect(
      signInErrorCode(new AuthApiError('slow down', 429, 'over_request_rate_limit'), 'code'),
    ).toBe('RATE_LIMITED');
  });

  it('falls back to INTERNAL_ERROR for anything that is not an auth error', () => {
    expect(signInErrorCode(new TypeError('fetch failed'), 'phone')).toBe('INTERNAL_ERROR');
    expect(signInErrorCode(undefined, 'code')).toBe('INTERNAL_ERROR');
    // An AuthError raised before any response has neither a code nor a status.
    expect(signInErrorCode(new AuthError('network down'), 'code')).toBe('INTERNAL_ERROR');
  });

  /**
   * Requirement 15.4 asks for a retry action on a failed operation, and `SignInForm` uses the
   * submit control as that action unconditionally. That is only honest while every code this
   * component can render is retryable in the taxonomy.
   */
  it('only ever produces codes the taxonomy marks retryable', () => {
    for (const code of ['OTP_INVALID', 'RATE_LIMITED', 'INTERNAL_ERROR'] as const) {
      expect(ERROR_SPECS[code].retryable).toBe(true);
    }
  });

  /** The message the farmer reads exists in all three languages, not just English. */
  it('has a rendered message in every supported language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(messages(language).errors.OTP_INVALID.length).toBeGreaterThan(0);
      expect(messages(language).loading.sendingCode.length).toBeGreaterThan(0);
      expect(messages(language).loading.verifyingCode.length).toBeGreaterThan(0);
    }
  });
});
