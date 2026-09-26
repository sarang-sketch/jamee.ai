'use client';

import { useState } from 'react';

import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import { AppError, isAppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import { ERROR_CODES, type ErrorCode, type Language } from '@/lib/schemas';
import { linkTokenResponseSchema } from '@/lib/access-schemas';

import styles from './TelegramLinkCard.module.css';

/**
 * The Telegram link card on the profile screen: link this Telegram account, or unlink it.
 *
 * Requirements: 21.1 (the link is an action — the token is minted on the button press, never on
 *               render), 21.6 (the deep link opens Telegram), 21.15 (unlink), 21.20 (the card
 *               renders from the link state and offers link/unlink), 15.2 (every indicator is bound
 *               to an observed request state), 15.4 (a failure shows the message and offers a retry)
 * Design: D13; "Frontend — Mobile layout and accessibility" — visible labels, `role="status"`
 *          / `role="alert"`, tap targets ≥ 44×44 px in relative units
 *
 * =============================================================================
 * THE TOKEN IS MINTED ON THE PRESS, AND THE DEEP LINK OPENS TELEGRAM
 * =============================================================================
 *
 * `POST /api/link/token` mints one single-use, time-bounded token and returns the deep link
 * (Requirement 21.1: minting is an action, never a page render, so opening this screen litters no
 * table with unused capabilities). The card then opens that deep link — `window.open` in a new tab
 * so the profile screen is not navigated away from mid-flow — which hands the token to Telegram's
 * `/start`. The bind itself happens in the bot, so this card never learns the outcome directly; the
 * farmer re-opens the profile screen (or the server shell re-reads) to see the linked state.
 *
 * Unlink (`DELETE /api/link/token`) clears the Telegram id and invalidates outstanding tokens while
 * keeping the entitlement and every conversation (21.15), then asks the parent to re-read so the
 * card flips to the not-linked state.
 */

export interface TelegramLinkCardProps {
  /** Whether a Telegram account is currently linked — from the one server-side access read. */
  isLinked: boolean;
  /** The language every label on this card is rendered in — the farmer's saved preference. */
  language: Language;
  /** Ask the server shell to re-read the access state after a link opens or an unlink completes. */
  onChanged: () => void;
}

export function TelegramLinkCard({ isLinked, language, onChanged }: TelegramLinkCardProps) {
  const { access } = messages(language);

  /** `true` for exactly as long as a mint or an unlink request is open (Requirement 15.2). */
  const [pending, setPending] = useState(false);
  /** What `ErrorBanner` renders and nothing more — the cause never reaches this state (15.6). */
  const [error, setError] = useState<ErrorBannerError | null>(null);

  async function onLink(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/link/token', { method: 'POST' });
      if (!response.ok) throw await errorFromResponse(response);
      const parsed = linkTokenResponseSchema.parse(await response.json());
      // A new tab so the profile screen stays put; the bot performs the bind on the /start.
      window.open(parsed.deepLink, '_blank', 'noopener,noreferrer');
      // The link is not confirmed here (the bot confirms it); re-read so a completed bind shows.
      onChanged();
    } catch (cause) {
      setError(bannerError(cause, language));
    } finally {
      setPending(false);
    }
  }

  async function onUnlink(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/link/token', { method: 'DELETE' });
      if (!response.ok) throw await errorFromResponse(response);
      onChanged();
    } catch (cause) {
      setError(bannerError(cause, language));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.card} aria-busy={pending}>
      <h2 className={styles.heading}>{access.linkHeading}</h2>

      <p className={styles.state} role="status" lang={language}>
        {isLinked ? access.linkedState : access.notLinkedState}
      </p>

      {error !== null ? <ErrorBanner error={error} retry={{ kind: 'control' }} className={styles.errorSlot} /> : null}

      {isLinked ? (
        <button className={styles.secondary} type="button" onClick={onUnlink} disabled={pending}>
          {access.unlinkButton}
        </button>
      ) : (
        <button className={styles.primary} type="button" onClick={onLink} disabled={pending}>
          {access.linkButton}
        </button>
      )}
    </section>
  );
}

/* ========================================================================== */
/* Shared error handling — the same envelope the API layer produces           */
/* ========================================================================== */

/** Turn a non-2xx response into an `AppError`, reading the coded envelope when the body carries one. */
async function errorFromResponse(response: Response): Promise<AppError> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    const code = body?.error?.code;
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      return new AppError(code as ErrorCode);
    }
  } catch {
    /* no coded body — fall through to a generic internal error */
  }
  return new AppError('INTERNAL_ERROR');
}

/** The localized banner shape for any thrown cause, rendered in the farmer's saved language. */
function bannerError(cause: unknown, language: Language): ErrorBannerError {
  const appError = isAppError(cause) ? cause : new AppError('INTERNAL_ERROR', { cause });
  return toEnvelope(appError, language).error;
}
