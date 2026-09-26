'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import { RECHARGE_PRICE_RUPEES } from '@/lib/config/access';
import { AppError, isAppError, toEnvelope } from '@/lib/errors';
import { interpolate, messages } from '@/lib/messages';
import { razorpayPublicKeyId } from '@/lib/env.public';
import { ERROR_CODES, type ErrorCode, type Language } from '@/lib/schemas';
import {
  paymentOrderResponseSchema,
  profileAccessSchema,
  type EntitlementStatus,
} from '@/lib/access-schemas';

import styles from './BotUnlockCard.module.css';

/**
 * The bot recharge card on the profile screen: the current entitlement window, a recharge button
 * that opens Razorpay Standard Checkout, and a test-mode note.
 *
 * Requirements: 22.2 (the order is created server-side at Jamee's price; the browser sends no
 *               amount), 22.7 (access is NEVER granted from the browser — the webhook grants),
 *               22.18 (the card shows the active window and offers a further recharge), 22.4 (the
 *               price is interpolated from one constant, `RECHARGE_PRICE_RUPEES`), 15.2 (indicators
 *               are bound to observed request states), 15.4 (a failure shows the message + a retry)
 * Design: D14, D15; Amendment A2 (the ₹20 / 7-day recharge), A3 (test mode for all pilot testers)
 *
 * =============================================================================
 * THE BROWSER NEVER GRANTS ACCESS — IT WAITS FOR THE WEBHOOK
 * =============================================================================
 *
 * Standard Checkout's success handler runs in the farmer's browser, and a browser is not a trusted
 * grant source (Requirement 22.7): a tampered page could call it without paying. So the ONLY thing
 * the success handler does is start polling `GET /api/profile/access`, whose entitlement window is
 * written by the verified `payment.captured` webhook (D15) and by nothing the browser can reach.
 * The card shows a "confirming your payment" state while it polls and flips to the active window
 * only when the server reports `isActive` — the grant is the webhook's, observed here, never made
 * here.
 *
 * =============================================================================
 * checkout.js IS LOADED ON DEMAND, NOT ON RENDER
 * =============================================================================
 *
 * `https://checkout.razorpay.com/v1/checkout.js` is injected the first time the farmer presses
 * Recharge, not on mount: a farmer who never recharges pays no third-party script cost, and the
 * script tag carries no order (the order id and the public key id are passed to the `Razorpay(...)`
 * options object once the script has loaded and an order has been created).
 */

const CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** How the card polls the server for the webhook-written window after checkout returns. */
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 20; // ~60s — long enough for a test-mode webhook to land.

export interface BotUnlockCardProps {
  /** The entitlement window from the one server-side access read. */
  entitlement: EntitlementStatus;
  /** The language every label on this card is rendered in — the farmer's saved preference. */
  language: Language;
  /** Ask the server shell to re-read once the webhook-written window is observed. */
  onChanged: () => void;
}

/** The minimal shape of the global Razorpay checkout the loaded script installs. */
interface RazorpayCheckout {
  open(): void;
}
interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  handler?: () => void;
  modal?: { ondismiss?: () => void };
}
type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayCheckout;
declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/** Inject checkout.js once, resolving when it (or an already-present copy) is ready. */
function loadCheckoutScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.Razorpay !== undefined) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT_SRC}"]`);
    if (existing !== null) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('checkout script failed to load')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT_SRC;
    script.async = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('checkout script failed to load')), { once: true });
    document.body.appendChild(script);
  });
}

export function BotUnlockCard({ entitlement, language, onChanged }: BotUnlockCardProps) {
  const { access } = messages(language);

  /** The window the card currently believes is true — starts from the server read, updated by polling. */
  const [window_, setWindow] = useState<EntitlementStatus>(entitlement);
  /** `true` while an order is being created or checkout is open. */
  const [pending, setPending] = useState(false);
  /** `true` while the card is polling for the webhook-written window after checkout returned. */
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ErrorBannerError | null>(null);

  /** Cleared on unmount so a poll cannot set state after the card is gone. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Follow the server-supplied window if the shell re-reads and hands a new one down. This is the
  // React-recommended "adjust state during render" pattern rather than a prop-sync effect: when the
  // `entitlement` prop changes (the server shell re-read after a grant), adopt it immediately in
  // render — no cascading effect, no extra commit. Local polling still owns `window_` between reads.
  const [lastEntitlement, setLastEntitlement] = useState(entitlement);
  if (lastEntitlement !== entitlement) {
    setLastEntitlement(entitlement);
    setWindow(entitlement);
  }

  /**
   * Poll `GET /api/profile/access` until the server reports an active window (the webhook landed)
   * or the attempt budget runs out. The grant is the webhook's; this only observes it (22.7).
   */
  const pollForGrant = useCallback(async (): Promise<void> => {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (!alive.current) return;
      try {
        const response = await fetch('/api/profile/access', { cache: 'no-store' });
        if (!response.ok) continue;
        const parsed = profileAccessSchema.safeParse(await response.json());
        if (!parsed.success) continue;
        if (parsed.data.entitlement.isActive) {
          if (!alive.current) return;
          setWindow(parsed.data.entitlement);
          setConfirming(false);
          onChanged();
          return;
        }
      } catch {
        /* transient — keep polling within the budget */
      }
    }
    // Budget exhausted without an observed grant: stop confirming and let the farmer retry.
    if (alive.current) setConfirming(false);
  }, [onChanged]);

  /**
   * Ask the SERVER to confirm the order with Razorpay directly — the webhook-free path (D20, 22.7).
   *
   * Razorpay cannot deliver a webhook to `localhost`, so the checkout success handler cannot rely on
   * a webhook having landed. It posts the order id to `/api/payment/confirm`, whose SERVER checks
   * Razorpay's Orders API for a captured payment and grants through the same transaction the webhook
   * uses. The browser's success report is never the proof — the order id only triggers the check.
   *
   * When the server reports an active window, the shown expiry is refreshed from the server's own
   * answer and confirming stops. Otherwise (still pending, or the confirm request failed) the
   * polling fallback keeps running against `/api/profile/access`, so a real webhook that does land —
   * or a slightly-later capture — is still observed.
   */
  const confirmPayment = useCallback(
    async (orderId: string): Promise<boolean> => {
      try {
        const response = await fetch('/api/payment/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderId }),
          cache: 'no-store',
        });
        if (!response.ok) return false;
        const parsed = profileAccessSchema
          .pick({ entitlement: true })
          .safeParse(await response.json());
        if (!parsed.success) return false;
        if (parsed.data.entitlement.isActive) {
          if (!alive.current) return true;
          setWindow(parsed.data.entitlement);
          setConfirming(false);
          onChanged();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [onChanged],
  );

  async function onRecharge(): Promise<void> {
    if (pending || confirming) return;
    setPending(true);
    setError(null);
    try {
      // 1. Create the order server-side. The browser sends no amount (22.2).
      const response = await fetch('/api/payment/order', { method: 'POST' });
      if (!response.ok) throw await errorFromResponse(response);
      const order = paymentOrderResponseSchema.parse(await response.json());

      // 2. Load checkout.js and open Standard Checkout with the returned identifiers.
      await loadCheckoutScript();
      if (window.Razorpay === undefined) throw new AppError('INTERNAL_ERROR');

      const checkout = new window.Razorpay({
        key: order.keyId || razorpayPublicKeyId(),
        order_id: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        // The success handler grants NOTHING — it triggers the server-side confirm (D20, 22.7) and
        // keeps the polling fallback in case the confirm is still pending or a webhook lands later.
        handler: () => {
          setConfirming(true);
          void (async () => {
            const confirmed = await confirmPayment(order.orderId);
            if (!confirmed && alive.current) void pollForGrant();
          })();
        },
        modal: {
          ondismiss: () => {
            /* The farmer closed checkout without paying — nothing to confirm. */
          },
        },
      });
      checkout.open();
    } catch (cause) {
      setError(bannerError(cause, language));
    } finally {
      setPending(false);
    }
  }

  const stateText = confirming
    ? access.rechargeConfirming
    : window_.isActive && window_.expiresAt !== null
      ? interpolate(access.rechargeActiveUntil, { expiry: formatExpiry(window_.expiresAt, language) })
      : access.rechargeInactive;

  return (
    <section className={styles.card} aria-busy={pending || confirming}>
      <h2 className={styles.heading}>{access.rechargeHeading}</h2>

      <p className={styles.state} role="status" lang={language}>
        {stateText}
      </p>

      <p className={styles.testNote} lang={language}>
        {access.rechargeTestModeNote}
      </p>

      {error !== null ? <ErrorBanner error={error} retry={{ kind: 'control' }} className={styles.errorSlot} /> : null}

      <button className={styles.primary} type="button" onClick={onRecharge} disabled={pending || confirming}>
        {interpolate(access.rechargeButton, { price: RECHARGE_PRICE_RUPEES })}
      </button>
    </section>
  );
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/** Format an ISO expiry in the farmer's language for the active-window sentence. */
function formatExpiry(iso: string, language: Language): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

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
