-- 0007_counters_and_quota_fn.sql
--
-- The quota source of truth: one row per (farmer, operation, window), and three functions that
-- are the ONLY way it is written.
--
-- Requirements: 14.1 (20 image / 50 chat / 20 voice per Quota_Window),
--               14.2 (web and WhatsApp share one per-farmer limit per operation),
--               14.3 (a request past the limit is declined and invokes no provider),
--               13.8 (burst rate limiting, a different control on the same table)
-- Design: "Quota enforcement — Choice: a dedicated counter table, not counted usage_logs rows"
--
-- DEPENDS ON 0002 (profiles).

create table public.counters (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  operation   text not null check (operation in ('image','chat','voice')),

  -- Requirement 13.8's burst limiter and Requirement 14.1's daily quota are DIFFERENT controls,
  -- and this column is what lets them share one table without sharing a number. The burst
  -- ceiling is set independently of the daily quota — chosen so a farmer cannot loop faster
  -- than a human works — and is checked at the step BEFORE the daily reserve, so a refused
  -- burst request never increments the daily counter (Property 28).
  window_kind text not null check (window_kind in ('day','minute')),

  -- 'YYYY-MM-DD' (Asia/Kolkata) for 'day', 'YYYY-MM-DDTHH:MM' for 'minute'.
  --
  -- Derived per request by src/lib/time.ts, which is why NOTHING RESETS AT MIDNIGHT: a new
  -- Kolkata day produces a new key, and a key with no row starts at zero. There is no reset job
  -- to fail, no cron to miss, and no window to be half-open during a deploy.
  window_key  text not null,

  used        integer not null default 0 check (used >= 0),
  updated_at  timestamptz not null default now(),

  -- THE PRIMARY KEY IS THE CONCURRENCY CONTROL.
  --
  -- `counter_try_increment` below is one `insert ... on conflict do update`, and it is this
  -- primary key that makes the conflict detectable. Postgres locks the conflicting row for the
  -- duration of the statement, so a second concurrent writer sees the FIRST writer's `used`
  -- value rather than the value it read a moment ago. That is what closes the boundary race
  -- without an advisory lock or a serializable transaction.
  --
  -- Note what is NOT in this key: `channel`. Requirement 14.2's cross-channel sharing is
  -- therefore automatic rather than a rule someone has to remember — a web request and a
  -- WhatsApp request land on the same row because there is no column that could separate them.
  primary key (user_id, operation, window_kind, window_key)
);

-- ---------------------------------------------------------------------------
-- Atomic reserve
-- ---------------------------------------------------------------------------

-- Returns the new count on success, NULL when already at the limit.
--
-- The whole race-freedom argument is in one statement, so it is worth reading closely:
--
--   * `insert ... values (..., 1)` handles the first request in a window. No row, no read, no
--     window to lose.
--   * `on conflict (...) do update set used = used + 1` handles every later request. Postgres
--     takes a row lock on the conflicting row before evaluating the SET, so two concurrent
--     callers serialize on it and the second sees the first's increment.
--   * `where public.counters.used < p_limit` is evaluated against that LOCKED, CURRENT value.
--     A `count(*)`-then-insert under read committed would let two callers at `used = 19` both
--     observe 19 and both pass; here the second observes 20 and the WHERE fails.
--   * A failed WHERE on `on conflict do update` updates nothing and returns NO ROW, so
--     `returning used` yields NULL. That NULL is the at-limit signal — the function does not
--     need to compare anything itself.
--
-- The limit is a PARAMETER rather than a table of limits, deliberately: Requirement 14.1 fixes
-- the numbers, they live in src/lib/config/verified.ts next to everything else a farmer-facing
-- message quotes, and a second copy in the database would be a second thing to keep in step.
create or replace function public.counter_try_increment(
  p_user uuid, p_operation text, p_window_kind text, p_window_key text, p_limit int
) returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.counters (user_id, operation, window_kind, window_key, used)
  values (p_user, p_operation, p_window_kind, p_window_key, 1)
  on conflict (user_id, operation, window_kind, window_key) do update
    set used = public.counters.used + 1,
        updated_at = now()
    where public.counters.used < p_limit
  returning used;
$$;

comment on function public.counter_try_increment(uuid, text, text, text, int) is
  'Atomic quota reserve. Returns the new count, or NULL when already at the limit. Race-free in one statement: the primary key locks the conflicting row so the WHERE sees the current value. security definer because counters has no insert/update policy for authenticated.';

-- ---------------------------------------------------------------------------
-- Refund
-- ---------------------------------------------------------------------------

-- Used ONLY for a failure that occurred BEFORE the first provider call was attempted —
-- a signed-URL failure, an unreadable object, a knowledge-base read failure. The design's spend
-- rule is a biconditional: a unit is spent if and only if at least one provider call was
-- attempted, so anything after that point is NOT refunded (a timeout included).
--
-- `and used > 0` is what makes the `used >= 0` check constraint unreachable rather than merely
-- present. Without the guard, a double refund would attempt `used = -1` and raise a constraint
-- violation — turning a harmless duplicate into a 500. With it, the second refund matches no row
-- and returns NULL, which the service treats as "already at zero".
create or replace function public.counter_decrement(
  p_user uuid, p_operation text, p_window_kind text, p_window_key text
) returns integer
language sql
security definer
set search_path = ''
as $$
  update public.counters
     set used = used - 1, updated_at = now()
   where user_id = p_user and operation = p_operation
     and window_kind = p_window_kind and window_key = p_window_key
     and used > 0
  returning used;
$$;

comment on function public.counter_decrement(uuid, text, text, text) is
  'Quota refund, for a failure before the first provider call only. Never drives used below zero: the used > 0 guard makes a double refund a no-op instead of a constraint violation.';

-- ---------------------------------------------------------------------------
-- Read
-- ---------------------------------------------------------------------------

-- `stable`, and `coalesce(..., 0)` so an absent row reads as zero rather than NULL. That is what
-- lets the quota status in a successful response envelope be written without a special case for
-- a farmer's first request of the day.
create or replace function public.counter_used(
  p_user uuid, p_operation text, p_window_kind text, p_window_key text
) returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select used from public.counters
    where user_id = p_user and operation = p_operation
      and window_kind = p_window_kind and window_key = p_window_key), 0);
$$;

comment on function public.counter_used(uuid, text, text, text) is
  'Stable read of a counter. Returns 0 for an absent row so a first request of the day needs no special case.';

-- ---------------------------------------------------------------------------
-- Prune (Requirement 13.8's periodic minute-row cleanup)
-- ---------------------------------------------------------------------------

-- Minute rows accumulate one per farmer per operation per active minute and are never read again
-- after their minute passes. At the 6-tester scale this prune is a convenience rather than a
-- requirement, which is why it is a function to be called rather than a trigger: a trigger would
-- put a delete on the hot path of every reserve to reclaim rows nobody is waiting on.
--
-- Day rows are NOT pruned here. Deleting one would silently grant a farmer a fresh daily
-- allowance, so anything that removes them has to be a deliberate, separate decision.
create or replace function public.counter_prune_minute_windows(p_older_than_minutes int default 60)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.counters
   where window_kind = 'minute'
     and updated_at < now() - make_interval(mins => p_older_than_minutes);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.counter_prune_minute_windows(int) is
  'Deletes stale minute-window rows. Never touches day rows: deleting one would grant a fresh daily allowance.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.counters enable row level security;

-- Read own rows, so a farmer's client can show remaining quota without an endpoint.
create policy counters_select_own on public.counters
  for select using (auth.uid() = user_id);

-- NO insert, update, or delete policy for `authenticated`. That absence is the enforcement:
-- under RLS a command with no matching permissive policy is denied, so the only writes possible
-- are through the three `security definer` functions above, which is why they carry that clause.
--
-- A farmer with insert or update on this table could set `used = 0` and have unlimited provider
-- calls, which would defeat Requirement 14.1 entirely and, at the free-tier scale Jamee runs on,
-- take the deployment down for every other farmer with it.
