-- =============================================================================
-- 0014 — link tokens, payment orders, the recharge window, and webhook throttling
-- =============================================================================
--
-- Requirements: 13.1, 13.2 (RLS on every farmer-scoped table), 13.9 (a per-caller bound on the
--               payment webhook route), 21.3, 21.7 (the token is recorded server-side; the bind and
--               the consume are one atomic write), 22.9, 22.11, 22.12, 22.20, 22.22, 22.23
-- Design: decisions D13, D14, D15, D16, and Amendment A2 (weekly recharge)
--
-- =============================================================================
-- THE ROW SHAPE, WHICH AMENDMENT A2 FORCED A CHOICE ABOUT
-- =============================================================================
--
-- A2 turned a one-time unlock into a renewable window, which raised a question the one-time design
-- never had to answer: does an entitlement mean one row per farmer, or one row per payment?
--
-- It is BOTH, split by what each fact is for:
--
--   * `bot_entitlements` holds ONE ROW PER FARMER carrying the current `expires_at`. The gate asks
--     one question — is this farmer's window open — and that should be one indexed lookup on a
--     primary key, not an aggregate over a payment history.
--   * `payment_orders.provider_payment_id` is UNIQUE and is the IDEMPOTENCY CLAIM. One row per
--     payment attempt, so a redelivered webhook conflicts on that column and is recognised as a
--     duplicate before the window is touched.
--
-- Putting the unique claim on the entitlement row instead would not survive A2: a farmer recharges
-- repeatedly, so a single row cannot carry a unique per-payment identifier. Deriving the expiry from
-- the payment history instead would make the gate an aggregate. Splitting them keeps each cheap.
--
-- NOTE FOR ANYONE READING 0013's SIBLING TASK NOTE: Phase 7 task 38.5 and design.md both argued that
-- the entitlement table should have NO `expires_at` column, on the grounds that a nullable expiry
-- invites a future edit quietly converting a purchase into a subscription. Amendment A2 INVERTS that
-- by decision — the product is now a weekly recharge — so the column is required. The original
-- reasoning was correct for a one-time unlock and is superseded, not refuted.

-- -----------------------------------------------------------------------------
-- link_tokens
-- -----------------------------------------------------------------------------
create table if not exists public.link_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  -- THE SHA-256 OF THE TOKEN, NEVER THE TOKEN. A snapshot of this table, in a backup or a support
  -- query, is then not a list of live capabilities someone could redeem.
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  -- A timestamp rather than a boolean, so the audit answers "when" as well as "whether".
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists link_tokens_user_idx
  on public.link_tokens (user_id, created_at desc);

-- Select-own only. NO insert, update, or delete policy exists, so a farmer session cannot mint a
-- token for another farmer, extend an expiry, or un-consume one; every write is service-role.
alter table public.link_tokens enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'link_tokens'
                   and policyname = 'link_tokens_select_own') then
    create policy link_tokens_select_own on public.link_tokens
      for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- The contract the linking service implements, recorded here because the atomicity is the whole
-- point (Requirement 21.7). Two concurrent /start deliveries of one token must not both bind:
--
--   update public.link_tokens
--      set consumed_at = now()
--    where token_hash = $1 and consumed_at is null and expires_at > now()
--   returning user_id;
--
-- The RETURNING row IS the authorization. No row means the token was not valid at the instant of the
-- write, and no binding is attempted. The failure a read-then-write would produce is not a duplicate
-- reply — it is a *different* sender's telegram_user_id landing on the profile.
comment on table public.link_tokens is
  'Single-use expiring capabilities that authorize exactly one Telegram binding (Requirement 21). Stores the sha-256 of the token, never the token. Consume and bind in one conditional update; the RETURNING row is the authorization.';

-- -----------------------------------------------------------------------------
-- payment_orders
-- -----------------------------------------------------------------------------
create table if not exists public.payment_orders (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  provider_order_id   text not null unique,
  -- Nullable until a payment is captured, and UNIQUE: this is the idempotency claim of Requirement
  -- 22.11. Nulls are distinct in Postgres, so any number of uncaptured orders coexist.
  provider_payment_id text unique,
  amount_minor        integer not null check (amount_minor > 0),
  currency            text not null default 'INR',
  status              text not null default 'created',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payment_orders_status_check
    check (status in ('created', 'captured', 'failed', 'cancelled'))
);

create index if not exists payment_orders_user_idx
  on public.payment_orders (user_id, created_at desc);

alter table public.payment_orders enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'payment_orders'
                   and policyname = 'payment_orders_select_own') then
    create policy payment_orders_select_own on public.payment_orders
      for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

drop trigger if exists payment_orders_set_updated_at on public.payment_orders;
create trigger payment_orders_set_updated_at
  before update on public.payment_orders
  for each row execute function public.set_updated_at();

-- Failed and abandoned orders are RETAINED rather than deleted (Requirement 22.22). They grant
-- nothing, and keeping them is what makes a reconciliation query against the provider possible.
comment on table public.payment_orders is
  'One row per intent to pay. Grants nothing on its own (Requirement 22). provider_payment_id is UNIQUE and is the idempotency claim: a redelivered webhook conflicts there and is recognised as a duplicate before any window is extended.';

-- -----------------------------------------------------------------------------
-- bot_entitlements — one row per farmer, holding the current window
-- -----------------------------------------------------------------------------
create table if not exists public.bot_entitlements (
  -- user_id AS THE PRIMARY KEY is how at-most-one-per-farmer is enforced (Requirement 22.12)
  -- without a second constraint.
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  -- Added by Amendment A2, which inverted the earlier decision that this column should not exist.
  -- NOT NULL: a row means a window, and "a row with no window" would be a third state the gate
  -- would have to know about. A farmer with no access simply has no row.
  expires_at  timestamptz not null,
  first_granted_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.bot_entitlements enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'bot_entitlements'
                   and policyname = 'bot_entitlements_select_own') then
    create policy bot_entitlements_select_own on public.bot_entitlements
      for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

drop trigger if exists bot_entitlements_set_updated_at on public.bot_entitlements;
create trigger bot_entitlements_set_updated_at
  before update on public.bot_entitlements
  for each row execute function public.set_updated_at();

-- There is NO telegram_user_id column on either table, and that absence is load-bearing: it is what
-- makes "the entitlement is keyed to the farmer, not to the chat account" structural rather than a
-- convention someone could drift from. Unlinking and re-linking therefore cost nothing (22.20).
comment on table public.bot_entitlements is
  'The current recharge window per farmer (Amendment A2). One row per Auth_User_Id, expires_at NOT NULL; no row means no access. Extended by nextExpiry() = max(now, expires_at) + period, so an early recharge stacks rather than forfeiting paid days.';

-- -----------------------------------------------------------------------------
-- webhook_throttle (Requirement 13.9, decision D16)
-- -----------------------------------------------------------------------------
-- This exists because `counters.user_id` is NOT NULL with a foreign key to profiles, and neither
-- webhook route has a farmer to key on: the payment route has none until a signature verifies, and
-- a caller whose signatures never verify never produces one.
create table if not exists public.webhook_throttle (
  route       text not null,
  -- A hash of the platform-reported client address, never the raw address, so this table retains no
  -- network identifier. It is a cost control and NOT authentication — it is forgeable and NAT
  -- collapses callers together. The real defence is that verification precedes every write.
  caller_hash text not null,
  window_key  text not null,
  used        integer not null default 0 check (used >= 0),
  created_at  timestamptz not null default now(),
  primary key (route, caller_hash, window_key),
  constraint webhook_throttle_route_check check (route in ('payment', 'telegram'))
);

alter table public.webhook_throttle enable row level security;

-- One statement, mirroring counter_try_increment for the same reason: under read committed a check
-- and a write in two statements is a race. Returns the new count, or null at the limit.
create or replace function public.webhook_throttle_try_increment(
  p_route text,
  p_caller_hash text,
  p_window_key text,
  p_limit integer
)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.webhook_throttle (route, caller_hash, window_key, used)
  values (p_route, p_caller_hash, p_window_key, 1)
  on conflict (route, caller_hash, window_key) do update
    set used = public.webhook_throttle.used + 1
    where public.webhook_throttle.used < p_limit
  returning used;
$$;

comment on function public.webhook_throttle_try_increment(text, text, text, integer) is
  'Atomic per-caller webhook bound (Requirement 13.9, D16). Returns the new count, or NULL when the limit is already reached. One statement, because a read followed by a write is a race under read committed.';