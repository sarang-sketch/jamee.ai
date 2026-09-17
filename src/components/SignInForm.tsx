'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isAuthError } from '@supabase/supabase-js';

import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import { AppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import type { ErrorCode, Language } from '@/lib/schemas';
import { createClient } from '@/lib/supabase/client';

import styles from './SignInForm.module.css';

/**
 * Phone OTP sign-in: number, then code.
 *
 * Requirements: 1.1 (an E.164 submission requests an OTP by SMS), 1.2 (a matching code
 *               establishes a session), 1.3 (a mismatched or expired code says the code is
 *               incorrect or expired), 15.2 (every indicator comes from an observed request
 *               state), 15.4 (the returned message is shown and a retry is offered)
 * Design: "Frontend" (screens and component boundaries, honest loading states, mobile layout
 *          and accessibility), "Error taxonomy"
 * Depends on: V2 — phone auth enabled in the Supabase dashboard with an SMS provider
 *             configured; `signInWithOtp({ phone })` then `verifyOtp(...)`
 *
 * ### U-V2, resolved here
 *
 * The `type` value for verifying a **sign-in** OTP was unresolved in `docs/VERIFIED_VALUES.md`
 * (the phone-login page only names `phone_change`, which is the phone-*update* flow). It is
 * resolved from the pinned SDK's own types, which are authoritative:
 *
 *   `node_modules/@supabase/auth-js/dist/module/lib/types.d.ts` (re-exported by
 *   `@supabase/supabase-js` 2.116.0 via `export * from '@supabase/auth-js'`) declares
 *
 *     interface VerifyMobileOtpParams { phone: string; token: string; type: MobileOtpType; … }
 *     type MobileOtpType = 'sms' | 'phone_change' | (string & {})
 *
 * Two named literals, and V2 already records `phone_change` as the phone-update flow — so the
 * sign-in value is **`'sms'`**, which is what `verifyOtp` is called with below. The
 * `(string & {})` arm of that union is the SDK's escape hatch for server-side additions; it
 * widens the type but adds no second candidate for this flow, so nothing here is a guess.
 *
 * ### What this component deliberately does not do
 *
 * No profile write (Requirement 1.4 / task 6.2 owns it), no auth gate (task 6.3), no language
 * switcher (task 12.3). The language arrives as a prop so the switcher can supply it later
 * without this file changing.
 */

/* ========================================================================== */
/* E.164, checked before the network is touched                                */
/* ========================================================================== */

/**
 * The same shape the database enforces: `profiles_phone_e164` in migration 0002 is
 * `check (phone ~ '^\+[1-9][0-9]{7,14}$')`. Kept identical on purpose — a number this
 * component accepted but the profile row rejected would sign a farmer in and then fail their
 * first write, which is a worse failure than a rejection at the input.
 */
export const E164_PHONE = /^\+[1-9][0-9]{7,14}$/;

/**
 * Where a verified code leads: the callback route (task 6.2), carrying the screen task 6.1
 * specifies as its onward destination. `%2F` because the value is a query parameter, and the route
 * validates it as a same-origin path before redirecting.
 */
export const AFTER_SIGN_IN_PATH = '/auth/callback?next=%2Fdiagnose';

/**
 * Spaces, dashes and brackets are how people write phone numbers; none of them carry meaning.
 * Stripping them is not a guess about the number, so it happens before validation and the
 * normalized form is what is sent.
 *
 * A missing `+` is NOT invented here. `+91…` and `91…` differ, and prefixing a country code
 * for a farmer would be Jamee choosing which country they are in.
 */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s()\u2010-\u2015-]/g, '');
}

export function isE164Phone(value: string): boolean {
  return E164_PHONE.test(value);
}

/* ========================================================================== */
/* Auth failures, mapped onto the taxonomy                                     */
/* ========================================================================== */

type Step = 'phone' | 'code';

/**
 * Which coded error a failed auth call is. The mapping matters more than it looks: every branch
 * that is not genuinely a bad code must NOT render "that code is incorrect", because a farmer
 * who reads that will keep retyping a correct code while the real problem is an unconfigured
 * SMS provider or a rate limit.
 *
 * `error.code` values are the GoTrue codes in `@supabase/auth-js`'s `ErrorCode` union
 * (`lib/error-codes.d.ts`); the union carries `(string & {})`, so an unrecognized code is
 * possible and lands on the honest default rather than on a guess.
 */
export function signInErrorCode(error: unknown, step: Step): ErrorCode {
  if (!isAuthError(error)) return 'INTERNAL_ERROR';

  switch (error.code) {
    /** Requirement 1.3 — expired, and mismatched, are one message to a farmer. */
    case 'otp_expired':
    case 'invalid_credentials':
      return 'OTP_INVALID';

    /** V2: one OTP request per 60 s per user is the documented default. */
    case 'over_sms_send_rate_limit':
    case 'over_request_rate_limit':
      return 'RATE_LIMITED';

    default:
      /**
       * A mismatched sign-in token comes back as a 4xx from the verify endpoint, and the code
       * string on it has changed across GoTrue releases. On the verify step a 401/403 is a
       * rejected code by construction — there is nothing else being authorized — so it maps to
       * Requirement 1.3's message even when the code string is one this build does not know.
       *
       * The same statuses on the *send* step are not that, and are not treated as that.
       */
      if (step === 'code' && (error.status === 401 || error.status === 403)) {
        return 'OTP_INVALID';
      }
      return 'INTERNAL_ERROR';
  }
}

/**
 * What the banner renders, plus the one thing only this component needs: which code it was, so the
 * right field can carry `aria-invalid`. `ErrorBannerError` supplies the rest, so the message, its
 * language and its retryable flag are the same three values every other screen passes.
 */
interface Shown extends ErrorBannerError {
  /** The coded failure, or `null` for the E.164 check that never reaches the network. */
  code: ErrorCode | null;
}

/**
 * The farmer-facing text for a code, in the active language, taken from the one place that
 * renders coded errors (`toEnvelope`) rather than from a second copy of the mapping. The real
 * cause never passes through here — same leak boundary as the API layer (Requirement 15.6).
 *
 * Every code reachable from this component — `OTP_INVALID`, `RATE_LIMITED`, `INTERNAL_ERROR` —
 * is `retryable: true` in `ERROR_SPECS`, which is why the submit control is unconditionally the
 * retry action Requirement 15.4 asks for. The flag is carried through rather than assumed, so a
 * future taxonomy change reaches the banner instead of leaving a farmer with a control that cannot
 * work; `SignInForm.test.tsx` pins the three codes as retryable today.
 */
function shown(code: ErrorCode, language: Language): Shown {
  const { error } = toEnvelope(new AppError(code), language);
  return { code, message: error.message, language, retryable: error.retryable };
}

/* ========================================================================== */
/* Component                                                                   */
/* ========================================================================== */

export interface SignInFormProps {
  /** The active language. Task 12.3's switcher becomes the source of this value. */
  language: Language;
}

export function SignInForm({ language }: SignInFormProps) {
  const { ui, loading } = messages(language);

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  /** `null` when idle. The open request, when there is one — this is the whole loading model. */
  const [pending, setPending] = useState<'send' | 'verify' | null>(null);
  const [error, setError] = useState<Shown | null>(null);

  const headingId = useId();
  const phoneFieldId = useId();
  const phoneHintId = useId();
  const codeFieldId = useId();
  const codeHintId = useId();

  const codeInput = useRef<HTMLInputElement | null>(null);

  /**
   * The browser client is built on first use, not during render.
   *
   * `publicEnv()` throws when `NEXT_PUBLIC_SUPABASE_URL` is absent, and this component is
   * server-rendered before it hydrates — building the client in render would turn a missing
   * env var into a 500 on the sign-in screen instead of a failure at the call that needs it.
   */
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  function supabase(): ReturnType<typeof createClient> {
    supabaseRef.current ??= createClient();
    return supabaseRef.current;
  }

  /** The code arrives by SMS; the field it goes in should already be focused when it does. */
  useEffect(() => {
    if (step === 'code') codeInput.current?.focus();
  }, [step]);

  async function requestCode(destination: string): Promise<boolean> {
    setPending('send');
    setError(null);

    /**
     * Requirement 1.1 says by SMS, so the channel is stated rather than left to the project
     * default — V2 records that WhatsApp is the other possible delivery channel for the same
     * call. `shouldCreateUser` is left at its documented default of `true`: a farmer's first
     * sign-in is a sign-up, and that first `auth.users` row is what the profile trigger fires
     * on (Requirement 1.4, migration 0002).
     */
    const { error: authError } = await supabase().auth.signInWithOtp({
      phone: destination,
      options: { channel: 'sms' },
    });

    if (authError !== null) {
      setError(shown(signInErrorCode(authError, 'phone'), language));
      setPending(null);
      return false;
    }

    setPending(null);
    return true;
  }

  async function onSubmitPhone(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending !== null) return;

    const destination = normalizePhone(phone);
    if (!isE164Phone(destination)) {
      /**
       * No `PHONE_INVALID` exists in the taxonomy, and inventing a code for a check that never
       * leaves the browser would put a farmer-facing string outside the catalog. The hint text
       * is the right message anyway: it states the exact shape expected, with an example.
       */
      setError({
        code: null,
        message: ui.phoneHint,
        language,
        /**
         * `false`, and it is not a taxonomy value: the number that was submitted is the thing that
         * is wrong, so the same submission cannot succeed. The submit control is still the way
         * forward once the number is corrected, which is what `retry: 'control'` records — but no
         * retry control is *offered*, because pressing one unchanged would do nothing.
         */
        retryable: false,
      });
      return;
    }

    setPhone(destination);
    if (await requestCode(destination)) {
      setSentTo(destination);
      setCode('');
      setStep('code');
    }
  }

  async function onSubmitCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending !== null) return;

    const token = code.trim();
    if (token === '') return;

    setPending('verify');
    setError(null);

    /** U-V2: `type: 'sms'` — see the file header for the types this was read from. */
    const { error: authError } = await supabase().auth.verifyOtp({
      phone: sentTo,
      token,
      type: 'sms',
    });

    if (authError !== null) {
      setError(shown(signInErrorCode(authError, 'code'), language));
      setPending(null);
      return;
    }

    /**
     * Requirement 1.2 is satisfied by the call above: the session cookies are written by the
     * browser client, so the very next server render sees a signed-in farmer.
     *
     * The farmer goes to `/diagnose`, which is what task 6.1 specifies, **by way of**
     * `/auth/callback` (task 6.2). That route is D8's defensive half: it verifies the session
     * server-side and upserts the Profile row Requirement 1.4 attributes to the Web_App, then
     * redirects onward. Navigating straight to `/diagnose` would leave that route uncalled and the
     * profile bootstrap resting entirely on the database trigger — which V5 records as a mechanism
     * that can fail in the signup path, not a guarantee.
     *
     * `/diagnose` DOES NOT EXIST YET — task 12.2 owns that route, so the callback's redirect 404s
     * until 12.2 lands. Stubbing the page here would make a missing screen look like a built one.
     *
     * A document request rather than `router.replace`: the destination is a **Route Handler**, not
     * a page, so there is no RSC payload for the client router to fetch — it would fall back to a
     * hard navigation and run the callback twice. That is also why the lint rule below is
     * suppressed; it reads this as a page navigation and its premise does not hold here.
     *
     * `pending` is deliberately left set: the request finished, the navigation has not, and
     * re-enabling the button for that gap would invite a second `verifyOtp` on a consumed code.
     */
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(AFTER_SIGN_IN_PATH);
  }

  const busy = pending !== null;

  /**
   * The one loading string, derived from the one piece of loading state. Empty when idle —
   * the `role="status"` region below is rendered either way, because a polite live region that
   * appears at the same moment as its text is not reliably announced, and because reserving its
   * line keeps the submit button from moving under a farmer's thumb when the text arrives.
   */
  let statusText = '';
  if (pending === 'send') statusText = loading.sendingCode;
  else if (pending === 'verify') statusText = loading.verifyingCode;

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h2 className={styles.heading} id={headingId}>
        {ui.signInHeading}
      </h2>

      {step === 'phone' ? (
        <form className={styles.form} onSubmit={onSubmitPhone} aria-busy={busy}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={phoneFieldId}>
              {ui.phoneLabel}
            </label>
            <input
              className={styles.input}
              id={phoneFieldId}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              /* The country code is part of what E.164 means, so the field starts at `+`. */
              placeholder="+91"
              aria-describedby={phoneHintId}
              /* Only the E.164 check says anything about this field. A failed SMS send does not. */
              aria-invalid={error?.code === null}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={busy}
              required
            />
            <p className={styles.hint} id={phoneHintId}>
              {ui.phoneHint}
            </p>
          </div>

          {/* Requirement 15.4: the message, and the submit control below as the retry for it. */}
          {error !== null ? <ErrorBanner error={error} retry={{ kind: 'control' }} /> : null}

          <button className={styles.primary} type="submit" disabled={busy}>
            {ui.sendCode}
          </button>

          {/* Requirement 15.2: real text, bound to the open request, never to a timer. */}
          <p className={styles.status} role="status">
            {statusText}
          </p>
        </form>
      ) : (
        <form className={styles.form} onSubmit={onSubmitCode} aria-busy={busy}>
          <p className={styles.sentTo}>
            <span className={styles.number}>{sentTo}</span>
            <button
              className={styles.secondary}
              type="button"
              onClick={() => {
                setStep('phone');
                setCode('');
                setError(null);
              }}
              disabled={busy}
            >
              {ui.changeNumber}
            </button>
          </p>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={codeFieldId}>
              {ui.otpLabel}
            </label>
            <input
              className={`${styles.input} ${styles.code}`}
              id={codeFieldId}
              name="one-time-code"
              /**
               * `type="text"` with a numeric keypad and `autocomplete="one-time-code"`, which is
               * what lets a phone offer the SMS code for autofill. Not `type="number"`: it
               * strips leading zeros and shows spinners for something that is not a quantity.
               *
               * No `maxLength`. The code length is a Supabase project setting, and truncating a
               * longer code in the browser would surface a configuration change as an
               * unexplainable "incorrect code".
               */
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-describedby={codeHintId}
              aria-invalid={error?.code === 'OTP_INVALID'}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={busy}
              ref={codeInput}
              required
            />
            <p className={styles.hint} id={codeHintId}>
              {ui.otpHint}
            </p>
          </div>

          {/*
           * Requirement 1.3 renders here: OTP_INVALID's message, in the active language. The retry
           * is the verify control below for a mistyped code, and the resend control under it for an
           * expired one — both already on screen, so the banner adds no third button.
           */}
          {error !== null ? <ErrorBanner error={error} retry={{ kind: 'control' }} /> : null}

          <button className={styles.primary} type="submit" disabled={busy}>
            {ui.verifyCode}
          </button>

          {/**
           * The retry for an expired code is a new code, not a resend of the same request, so
           * it is its own control. No countdown sits on it: V2's 60 s is a documented default,
           * not something this component can observe, and a timer that disagreed with the
           * server would either block a farmer who could send or promise one who cannot. The
           * attempt is made, and a real rate limit is reported as one.
           */}
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void requestCode(sentTo)}
            disabled={busy}
          >
            {ui.resendCode}
          </button>

          <p className={styles.status} role="status">
            {statusText}
          </p>
        </form>
      )}
    </section>
  );
}
