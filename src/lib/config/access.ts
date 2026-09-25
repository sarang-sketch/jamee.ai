/**
 * Access constants: what a recharge costs, how long it lasts, and how long a link token lives.
 *
 * Requirements: 21.4 (the Link_Token expiry is a compile-time constant, read from no environment
 *               variable), 22.4 (the recharge price is a compile-time constant in exactly one
 *               place, recorded in the Deployment_Package, read from no environment variable)
 * Design: D13 (the linking token bounds its exposure in time as well as in count), D14 (the
 *         entitlement gate), Amendment A2 (weekly recharge replaces the one-time unlock)
 *
 * =============================================================================
 * WHY THESE ARE CONSTANTS AND NOT ENVIRONMENT VARIABLES
 * =============================================================================
 *
 * The same reasoning `src/lib/config/verified.ts` applies to model identifiers applies here, and
 * criteria 21.4 and 22.4 make it a requirement rather than a preference: a price or a validity
 * period in an environment variable is an unversioned, unreviewable change to what Jamee charges
 * and what a farmer receives for it. Changing either should be a diff someone approves, visible in
 * `git log`, not a value edited in a hosting dashboard where no review happens and no history is
 * kept. Neither value appears in `.env.example` and neither is in the `serverEnv` schema.
 */

/**
 * The recharge price in whole rupees, for farmer-facing copy.
 *
 * Amendment A2 set this to 20 and resolved open question O22-1. It was previously undecided, and
 * the constant was specified to ship as a marker whose accessor threw rather than defaulting to a
 * guessed figure — that guard is no longer needed because the figure exists.
 */
export const RECHARGE_PRICE_RUPEES = 20;

/**
 * The same price in paise, which is what the Payment_Provider's order API takes.
 *
 * Derived rather than written as a second literal, so the two cannot drift. A provider that is
 * handed rupees where it expects minor units charges one hundredth of the intended amount, and
 * that failure is silent — the payment succeeds.
 */
export const RECHARGE_PRICE_PAISE = RECHARGE_PRICE_RUPEES * 100;

/** ISO 4217. The Payment_Provider requires an explicit currency on every order. */
export const RECHARGE_CURRENCY = 'INR' as const;

/** How many days one recharge buys. Amendment A2 decision 1. */
export const RECHARGE_PERIOD_DAYS = 7;

/**
 * How long a Link_Token stays usable (Requirement 21.4).
 *
 * D13's reasoning: the deep link travels through whatever the farmer used to open it — a browser
 * history entry, a screenshot, a forwarded message — so the token's lifetime is the window in which
 * a leaked link is still a binding. Expiry bounds that window in time; single use bounds it in
 * count. Fifteen minutes is long enough to open a link on the same device and short enough that a
 * leaked screenshot is usually already spent.
 */
export const LINK_TOKEN_TTL_MINUTES = 15;

/** Milliseconds in one day. Named so the arithmetic below reads as intent rather than as a number. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The new expiry after a recharge: `max(now, currentExpiry) + RECHARGE_PERIOD_DAYS`.
 *
 * Amendment A2 decision 3, expressed as a pure function so a property test can check the arithmetic
 * directly instead of inferring it from a service.
 *
 * **Why the maximum rather than simply adding to `now`.** A farmer who recharges three days early
 * would otherwise forfeit the four days already paid for, which is a silent partial refund of their
 * own money and exactly the kind of thing that erodes trust in a paid product. Taking the later of
 * the two instants means an early recharge stacks and a late one starts from the payment.
 *
 * `currentExpiry` is `null` for a farmer who has never recharged, and may be in the past for one
 * whose window lapsed; both collapse into `now` through the same comparison, so neither is a special
 * case anywhere else in the codebase.
 */
export function nextExpiry(now: Date, currentExpiry: Date | null): Date {
  const from = currentExpiry !== null && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  return new Date(from.getTime() + RECHARGE_PERIOD_DAYS * MS_PER_DAY);
}

/**
 * Whether an entitlement expiry still grants access at `now`.
 *
 * One predicate, used by the Telegram gate and by the web app's status display, so "unexpired"
 * cannot come to mean two different things on two surfaces. A `null` expiry is not access: a farmer
 * with no entitlement row and a farmer whose row has no expiry are both unentitled.
 */
export function isEntitlementActive(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}