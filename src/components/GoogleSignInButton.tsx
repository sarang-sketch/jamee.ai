'use client';

import { useState } from 'react';

import { authClient } from '@/lib/auth/auth-client';
import { messages } from '@/lib/messages';
import type { Language } from '@/lib/schemas';

import styles from './GoogleSignInButton.module.css';

/**
 * The Google sign-in control — one button, one provider.
 *
 * Requirements: 1.1 (activating the control starts authentication through the auth library with
 *               Google as the provider), 1.3 (a sign-in that does not complete shows the
 *               "sign-in did not complete" message and offers to try again), 15.2 (the indicator
 *               is bound to the real request state, not a timer)
 * Design: "Frontend" — `/` is a server component, this is its client half; D8, D18a; V30
 *         (`authClient.signIn.social({ provider: 'google' })`)
 *
 * =============================================================================
 * WHAT signIn.social DOES, AND WHERE THE CALLBACK LANDS
 * =============================================================================
 *
 * `authClient.signIn.social({ provider: 'google', callbackURL: '/diagnose' })` starts the OAuth
 * redirect. Google returns to Better Auth's own callback at `/api/auth/callback/google` (the
 * catch-all handler, V30), which establishes the session, runs the D8 databaseHooks that write the
 * `profiles` document, and then redirects the browser to `callbackURL` — `/diagnose`, the screen a
 * signed-in farmer belongs on. There is no hand-written callback route in Jamee for this anymore.
 *
 * The happy path is a full-page redirect, so the button shows a "signing in" state and does not
 * expect to render a result. `signIn.social` can still resolve locally with an error (the SDK
 * could not start the flow) or the farmer can cancel and return without a session — Requirement
 * 1.3's cases. Both surface the same localized `ui.signInDidNotComplete` message with the button
 * still available to try again, because the farmer's next action is identical in every case and
 * naming Google's internals would help no one (this mirrors the single `OAUTH_INCOMPLETE` code).
 *
 * `language` arrives as a prop from the `/` server shell, so the button's text and its failure
 * message are in the farmer's chosen language without this client component reading a cookie.
 */

export interface GoogleSignInButtonProps {
  language: Language;
}

/** The Better Auth client surface this button uses — the seam a unit test drives with a stub. */
export interface SocialSignInClient {
  signIn: {
    social: (input: {
      provider: 'google';
      callbackURL: string;
      errorCallbackURL?: string;
    }) => Promise<{ error?: unknown } | undefined>;
  };
}

/**
 * Start Google sign-in through the given client. Extracted from the component so the "calls
 * `signIn.social` exactly once with provider google" contract is unit-testable without a DOM
 * renderer — the same decision-extraction pattern `SignInForm` uses for `signInErrorCode`.
 *
 * Returns `'ok'` when the flow started (the happy path is a full-page redirect, so control usually
 * does not return here at all) and `'failed'` when it could not start or resolved with an error —
 * both of Requirement 1.3's local cases.
 */
export async function startGoogleSignIn(client: SocialSignInClient): Promise<'ok' | 'failed'> {
  try {
    const result = await client.signIn.social({
      provider: 'google',
      callbackURL: '/diagnose',
      errorCallbackURL: '/',
    });
    return result?.error ? 'failed' : 'ok';
  } catch {
    return 'failed';
  }
}

export function GoogleSignInButton({ language }: GoogleSignInButtonProps): React.JSX.Element {
  const { ui } = messages(language);

  /** `idle` → the button; `pending` → "signing in", the button disabled; `failed` → 1.3's message. */
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle');

  async function onClick(): Promise<void> {
    setState('pending');
    const outcome = await startGoogleSignIn(authClient);
    /**
     * On success the SDK performs a full-page redirect, so control usually does not return here.
     * If it resolves locally as 'failed', the flow did not start or errored — treat it as 1.3's
     * "did not complete".
     */
    if (outcome === 'failed') setState('failed');
  }

  return (
    <div className={styles.form}>
      <button
        type="button"
        className={styles.submit}
        disabled={state === 'pending'}
        onClick={() => {
          void onClick();
        }}
      >
        {ui.googleSignIn}
      </button>

      {state === 'failed' ? (
        /* Requirement 1.3 — role="alert" so a screen reader announces it; the button stays usable. */
        <p role="alert" className={styles.error}>
          {ui.signInDidNotComplete}
        </p>
      ) : null}
    </div>
  );
}
