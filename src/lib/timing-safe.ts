import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * The one constant-time string comparison in the codebase, and the ONLY caller of
 * `crypto.timingSafeEqual`.
 *
 * **Why a bearer credential needs this.** The two callers — the Telegram webhook's
 * `secret_token` (Requirement 11.2) and the retention-sweep route's `CRON_SECRET`
 * (Requirement 18.12) — both compare a Jamee-generated secret on a public, infinitely
 * retriable endpoint. A byte-at-a-time comparison that returned early would answer "how many
 * leading characters did I get right?", which turns guessing the secret from one infeasible
 * search into many short ones. One comparison, in one place, removes that oracle for both.
 *
 * **An absent value takes the same time as a wrong one.** `presented === null | undefined` is
 * compared against a fixed-length dummy so a missing header does not short-circuit to a faster
 * `false` than a mismatch would — the timing of the two cases must not differ either. The length
 * guard that `timingSafeEqual` requires still returns early on a length mismatch, and that is
 * fine: the only fact it leaks is the length of a value the caller itself supplied.
 */
export function timingSafeEqualStrings(
  presented: string | null | undefined,
  configured: string,
): boolean {
  // A dummy of the configured length keeps the absent-value path from being observably faster
  // than a wrong-value path; the boolean is discarded, only the work matters.
  if (presented === null || presented === undefined) {
    const dummy = 'x'.repeat(configured.length);
    timingSafeEqualStrings(dummy, configured);
    return false;
  }
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(configured, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
