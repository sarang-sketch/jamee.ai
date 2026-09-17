-- 0008_whatsapp_inbound.sql
--
-- Duplicate suppression for inbound WhatsApp deliveries. The primary key IS the mechanism.
--
-- Requirements: 11.5 (a delivery whose Provider_Message_Id was already processed is
--               acknowledged, invokes no shared service, and leaves the quota unchanged),
--               11.6 (record the Provider_Message_Id for duplicate detection)
-- Design: "0008: WhatsApp inbound idempotency store"; "Inbound processing order" step 2
--
-- DEPENDS ON 0002 (profiles).

create table public.whatsapp_inbound (
  -- THE PRIMARY KEY IS THE IDEMPOTENCY MECHANISM (Requirement 11.5).
  --
  -- The adapter inserts this row BEFORE anything billable, and a unique violation IS the
  -- duplicate signal. There is deliberately no `select`-then-`insert`: two concurrent
  -- deliveries of the same message would both find nothing on the select and both proceed,
  -- which is precisely the race Meta's retry behaviour makes likely rather than theoretical
  -- (V13: on a non-200 Meta retries immediately, then with decreasing frequency over 36 hours).
  --
  -- Because the insert precedes profile resolution, the quota reserve, and every provider call,
  -- a redelivery cannot spend quota, cannot call a provider, and cannot produce a second reply.
  -- It is not that those steps check for a duplicate — it is that they are unreachable.
  --
  -- V12 records this as the WAMID from `entry[].changes[].value.messages[].id`, max 128 chars.
  provider_message_id text primary key,

  -- Farmer PII. The reason RLS below is enabled with NO policies rather than left off.
  from_phone          text not null,

  -- Nullable: step 2 inserts before step 3 resolves the profile, and Requirement 10.3's
  -- unresolvable number never gets one. A `not null` here would force the insert below profile
  -- resolution and break the ordering that makes 11.5 true.
  user_id             uuid references public.profiles(id) on delete set null,

  message_type        text not null,   -- text | image | audio | anything else Meta sent

  -- The status machine, and it is load-bearing for a hazard D11's arithmetic did not cover.
  --
  -- V13 records that Meta may BATCH UP TO 1000 UPDATES in one delivery. A handler that inserted
  -- rows for all N entries and then ran out of budget on entry 3 would have silently discarded
  -- entries 4..N: Meta will not redeliver them (the request was acknowledged) and the primary key
  -- would drop them if it did. So:
  --
  --   * insert as 'received', and transition to 'processed' only AFTER the work completes —
  --     never at insert time;
  --   * entries still 'received' when the budget runs out are a RECOVERABLE BACKLOG, not a
  --     silent drop: the row exists, its state is honest, and an operator can see it.
  --
  -- 'failed' is D11's soft-deadline branch. Marking it failed rather than processed is
  -- deliberate: it keeps the audit honest, and the farmer's next send carries a new
  -- provider_message_id so it processes normally.
  -- 'rejected' is Requirement 10.3 (no profile) and 10.9 (unsupported type) — both acknowledged
  -- with 200, both spending nothing.
  status              text not null default 'received'
                        check (status in ('received','processed','failed','rejected')),

  received_at         timestamptz not null default now(),
  completed_at        timestamptz
);

-- Operator query: "what is still 'received' and how old is it" — the stranded-row check the
-- batching hazard above requires.
create index whatsapp_inbound_received_idx on public.whatsapp_inbound (received_at desc);

-- ---------------------------------------------------------------------------
-- Row level security: ENABLED WITH NO POLICIES AT ALL
-- ---------------------------------------------------------------------------

-- This is not an oversight and it is not a placeholder. It is the correct configuration.
--
-- Under RLS, a command with no matching permissive policy is denied. With RLS enabled and zero
-- policies, this table is unreachable for both `anon` and `authenticated`, while the service role
-- — the only thing that touches it — bypasses RLS by design.
--
-- Why not simply leave RLS OFF? Because a table in the `public` schema with RLS disabled is
-- readable through the data API. `from_phone` is farmer PII: every phone number that has ever
-- messaged Jamee, in one table, with no farmer-scoping column to filter on for most rows.
-- Leaving RLS off here would publish that list to any holder of the anon key.
--
-- DO NOT ADD A POLICY TO "FIX" THIS. There is no farmer-facing use for this table.
alter table public.whatsapp_inbound enable row level security;

comment on table public.whatsapp_inbound is
  'Inbound WhatsApp idempotency store. provider_message_id is the primary key so the unique violation IS the duplicate signal (Req 11.5). RLS enabled with NO policies on purpose: from_phone is farmer PII and a public table with RLS off is readable through the data API. Service role only.';
