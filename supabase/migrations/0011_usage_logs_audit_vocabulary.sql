-- 0011_usage_logs_audit_vocabulary.sql
--
-- Two values added to the audit vocabulary of `usage_logs`, so that two outcomes Jamee already
-- produces stop being unrecordable.
--
-- Requirements: 5.7 (record the rejection reason for every Validation_Layer rejection),
--               13.8 (per-Farmer request rate limiting — the glossary defines a Usage_Log as a row
--               recording "one billable OR RATE-LIMITED operation"), 14.6 (one row per completed
--               model operation)
-- Design: D10 (`usage_logs` is the append-only audit trail), D2 (distinguishable rejection reasons)
--
-- DEPENDS ON 0006. Migration 0006 is NOT edited: an applied migration is history, and rewriting one
-- would leave a deployed database and the repository disagreeing about what was ever run.
--
-- ### Why `outcome` grew: 'rate_limited'
--
-- Requirement 13.8's burst refusal (`src/lib/rate-limit.ts`) had no honest outcome value. The
-- normative criterion, 14.6, is satisfied without a row at all — a refused request completes no
-- model operation — but the glossary's definition of the table is wider than 14.6, and it names
-- rate-limited operations explicitly. Closing that with an existing value was not available:
--
--   * `quota_declined` is Requirement 14.3's DAILY decline. Reusing it would make the audit trail
--     claim a farmer reached their 20-a-day image limit when they had in fact sent four photos in
--     ten seconds. `usage_logs_outcome_idx` exists so an operator can count that exact question,
--     and a shared value would make the answer wrong rather than coarse.
--   * `provider_error` would claim a failure that never happened; no provider was reached.
--
-- The two controls are already separate everywhere else — separate `counters.window_kind`, separate
-- error code, opposite `retryable` flags — so sharing one audit value would have been the only
-- place they were conflated.
--
-- ### Why `rejection_reason` grew: 'rephrase_rejected'
--
-- Requirement 5.7 is unconditional: when the Validation_Layer rejects a response, the API layer
-- records THE REJECTION REASON. `validateRephrased()`'s post-generation checks are the
-- Validation_Layer applied to rephrased text, and when they refuse the model's prose the row was
-- being written as `outcome = 'validation_rejected'` with `rejection_reason = null` — a rejection
-- recorded without its reason, which is the letter of 5.7 unmet.
--
-- None of 0006's seven values described it: all seven are D2's VISION-stage reasons, each mapping to
-- one acceptance criterion about a diagnosis response. A rejected rephrase is a different stage of a
-- different response, so it gets its own value rather than the closest-looking one.
--
-- This value is deliberately absent from `MessageCatalog.inconclusive` (see
-- `usageRejectionReasonSchema` in `src/lib/schemas.ts`): a rejected rephrase is served as the
-- knowledge-base static template, so the farmer reads grounded content and there is no inconclusive
-- sentence to localize. Audit-only, by construction.
--
-- ### The two constraints are replaced, not relaxed
--
-- Both remain closed enumerations. `drop` then `add` is the only way to widen a check constraint in
-- Postgres, and the new lists are supersets of the old ones, so no existing row can fail validation
-- — the `add` re-validates the table and would fail loudly if that were untrue.
--
-- The names are the ones Postgres generated for 0006's inline column checks (`{table}_{column}_check`).
-- `if exists` covers a database whose 0006 predates that naming, so re-running this file is safe.

-- ---------------------------------------------------------------------------
-- outcome: seven values become eight
-- ---------------------------------------------------------------------------

alter table public.usage_logs
  drop constraint if exists usage_logs_outcome_check;

alter table public.usage_logs
  add constraint usage_logs_outcome_check check (outcome in (
    'success',              -- 14.6
    'inconclusive',         -- 6.1-6.3, 8.7 — a SUCCESSFUL request Jamee could not judge
    'validation_rejected',  -- 5.7 + D2
    'provider_error',       -- 14.5 — chain exhausted
    'timeout',              -- 3.7 — a budget expiry, pre-flight or in-flight
    'quota_declined',       -- 14.3 — the DAILY limit
    'rate_limited',         -- 13.8 — the MINUTE burst ceiling. New in 0011.
    'duplicate_ignored'     -- 11.5
  ));

-- ---------------------------------------------------------------------------
-- rejection_reason: seven values become eight
-- ---------------------------------------------------------------------------

alter table public.usage_logs
  drop constraint if exists usage_logs_rejection_reason_check;

alter table public.usage_logs
  add constraint usage_logs_rejection_reason_check check (rejection_reason in (
    -- D2's vision-stage set (Requirements 5.2-5.6, 6.2, 6.3). Each has farmer-facing copy.
    'not_json',
    'missing_field',
    'confidence_out_of_range',
    'invalid_severity',
    'unverified_condition',
    'model_unclear',
    'model_no_plant',
    -- Audit-only (Requirement 5.7). No farmer-facing copy: the farmer receives the
    -- knowledge-base static template instead. New in 0011.
    'rephrase_rejected'
  ));
