-- 0006_usage_logs.sql
--
-- The append-only audit trail. NOT the quota source of truth (design D10).
--
-- Requirements: 5.7 (record the rejection reason and exclude rejected content from the
--               response), 3.7 (record a timeout outcome), 14.6 (one row per completed model
--               operation, recording farmer / operation / channel / provider / outcome),
--               14.7 (record when the gateway served from the fallback),
--               13.1 / 13.2 (RLS, own-row read)
-- Design: "0006: usage_logs", D10
--
-- ### Why this is not the quota counter
--
-- D10, stated as arithmetic: these rows are NOT 1:1 with quota units. A provider fallback
-- (14.7) and a validation rejection (5.7) each add a row without adding a billable unit, and a
-- duplicate WhatsApp delivery adds a row while explicitly spending nothing (11.5). Counting
-- rows here would therefore give a different answer from "units reserved", and `count(*)` over
-- a growing audit table cannot be made race-free without an advisory lock. Quota lives in
-- `counters` (0007), which counts exactly one thing.
--
-- The consequence worth stating: pruning old rows here to stay inside the free tier CANNOT
-- silently change a quota answer, because no quota decision reads this table. Retention and
-- quota are independent by construction.
--
-- DEPENDS ON 0001, 0002, 0003, 0005.

create table public.usage_logs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,

  operation        text not null check (operation in ('image','chat','voice')),
  channel          text not null check (channel in ('web','whatsapp')),

  -- 'none' is permitted HERE and not on `diagnoses`, because some audited outcomes never
  -- reached a provider at all: `quota_declined` (Requirement 14.3 forbids the provider call)
  -- and `duplicate_ignored` (Requirement 11.5 forbids the service call). Nullable as well as
  -- 'none'-able so a row written before a provider was selected is honest rather than guessing.
  model_provider   text check (model_provider in ('gemini','groq','none')),

  outcome          text not null check (outcome in (
                     'success',              -- 14.6
                     'inconclusive',         -- 6.1-6.3 — a SUCCESSFUL request, unjudgeable photo
                     'validation_rejected',  -- 5.7 + D2
                     'provider_error',       -- 14.5 — chain exhausted
                     'timeout',              -- 3.7
                     'quota_declined',       -- 14.3
                     'duplicate_ignored'     -- 11.5
                   )),

  used_fallback    boolean not null default false,   -- Req 14.7

  -- Requirement 5.7 + D2's distinguishable reasons. Null on any outcome that is not a
  -- validation rejection. This is the column that makes Property 7 ("every rejection is
  -- attributable") checkable, and it is why validation is two-stage: a single strict schema
  -- would write the same reason for malformed JSON and for a real-but-unsupported disease.
  rejection_reason text check (rejection_reason in (
                     'not_json','missing_field','confidence_out_of_range',
                     'invalid_severity','unverified_condition',
                     'model_unclear','model_no_plant')),

  -- The spend rule, made auditable. The design's rule is one sentence — *a unit is spent if and
  -- only if at least one provider call was attempted for that request* — and this column is how
  -- that claim is checked against the counter table rather than trusted.
  --
  -- Notably `true` on a timeout: a timeout happens after a provider call was issued, so the
  -- call was real and the unit is consumed. Refunding it would let a farmer with a reliably slow
  -- connection spend unlimited provider calls for zero quota.
  quota_spent      boolean not null default true,

  latency_ms       integer check (latency_ms is null or latency_ms >= 0),

  -- Attributes a behavioural change to the prompt revision that produced it. Without this, a
  -- prompt edit and a model change are indistinguishable when reading a week of rows.
  prompt_version   text,

  -- `on delete set null` rather than cascade on both: the audit row must OUTLIVE what it points
  -- at. Cascading would mean deleting a conversation quietly erased the record that a provider
  -- call was made and a unit was spent, which is the opposite of an audit trail.
  conversation_id  uuid references public.conversations(id) on delete set null,
  diagnosis_id     uuid references public.diagnoses(id) on delete set null,

  created_at       timestamptz not null default now()
);

-- Per-farmer audit read, newest first — what a support question or a spend-rule check reads.
create index usage_logs_user_day_idx on public.usage_logs (user_id, created_at desc);

-- Cross-farmer outcome scan: "how many timeouts this week", "how often did the fallback serve".
-- Serves the free-tier sizing note and the fallback-rate question from PROVIDER_CAPABILITIES.
create index usage_logs_outcome_idx on public.usage_logs (outcome, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security (Requirements 13.1, 13.2)
-- ---------------------------------------------------------------------------

alter table public.usage_logs enable row level security;

-- READ ONLY for a farmer, and only their own rows.
--
-- There is deliberately NO insert policy for `authenticated`. Every write here comes from a
-- service that already resolved the outcome, running with the service role, which bypasses RLS.
-- Granting insert would let a client fabricate audit rows — including a `quota_spent = false`
-- row for a call that really spent one, which would corrupt the exact claim this table exists
-- to make checkable.
--
-- No update or delete policy either: "append-only" is enforced by the absence of those policies
-- plus RLS being enabled, the same mechanism 0004 uses to protect the knowledge base.
create policy usage_logs_select_own on public.usage_logs
  for select using (auth.uid() = user_id);
