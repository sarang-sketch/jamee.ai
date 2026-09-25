-- =============================================================================
-- 0013 — telegram_inbound, and the channel vocabulary becomes ('web','telegram')
-- =============================================================================
--
-- Requirements: 11.5, 11.6, 11.7, 11.8 (claim the delivery before anything billable, and
--               deduplicate on the Update_Id), 14.2 (one shared quota across channels),
--               16.5 (every persisted row records its channel), 21.17, 22.13 (an unlinked sender
--               and a gated farmer are both handled deliberately rather than dropped)
-- Design: Amendment A1, decisions D11, D12, D14
--
-- Forward migration, for the reason 0012 gives: once a hosted project exists its migration history
-- is the source of truth, so corrections arrive forward rather than by rewriting an applied file.
-- Every statement is idempotent.

-- -----------------------------------------------------------------------------
-- The inbound claim table, keyed on Telegram's own update_id
-- -----------------------------------------------------------------------------
-- update_id is a bigint Telegram assigns per bot, which is a narrower and cheaper key than the
-- 128-character WAMID it replaces, and it needs no format validation.
--
-- THE PRIMARY KEY IS THE IDEMPOTENCY MECHANISM. The insert happens before anything billable, and a
-- unique violation on it *is* the duplicate signal (Requirement 11.8) — there is no select-then-
-- insert anywhere, because under read committed a check followed by a write is a race.
create table if not exists public.telegram_inbound (
  update_id       bigint primary key,
  telegram_user_id bigint,
  user_id         uuid references public.profiles (id) on delete set null,
  message_type    text not null,
  status          text not null default 'received',
  received_at     timestamptz not null default now(),
  completed_at    timestamptz,
  constraint telegram_inbound_message_type_check
    check (message_type in ('start', 'text', 'photo', 'voice', 'other')),
  -- 'unlinked' and 'not_entitled' exist because both outcomes produce a reply and no billable
  -- operation, so there is nothing for usage_logs to record. This column is then the only trace
  -- that the delivery was handled deliberately rather than silently dropped.
  constraint telegram_inbound_status_check
    check (status in ('received', 'processed', 'failed', 'rejected', 'unlinked', 'not_entitled'))
);

-- user_id is nullable and ON DELETE SET NULL on purpose: the claim precedes profile resolution
-- (Requirement 11.7), so at insert time there may be no profile, and an inbound row must survive a
-- farmer deletion as an audit record rather than cascading away.
create index if not exists telegram_inbound_received_idx
  on public.telegram_inbound (received_at desc);

-- The operator query for a recoverable backlog: entries still 'received' when an invocation ran out
-- of budget. D11 depends on this being findable.
create index if not exists telegram_inbound_open_idx
  on public.telegram_inbound (received_at desc) where status = 'received';

-- RLS ON WITH NO POLICIES AT ALL, which is deliberate and not an omission. telegram_user_id is
-- farmer PII and nothing in the product needs to read this table through the data API; every access
-- is server-side under the service role. No policy means no role matches, which is the strongest
-- available statement.
alter table public.telegram_inbound enable row level security;

comment on table public.telegram_inbound is
  'One row per inbound Telegram update, claimed on update_id before any billable work (Requirement 11.7). RLS is enabled with no policies: this table holds sender PII and is read only by server-side modules under the service role.';

-- -----------------------------------------------------------------------------
-- Retire whatsapp_inbound, refusing to destroy anything
-- -----------------------------------------------------------------------------
-- Dropped rather than left behind, because a dead table holding phone numbers is a standing privacy
-- liability. But the drop REFUSES if the table has rows: this project is pre-pilot and that table
-- should be empty, and if it is not then something reached it that this migration does not know
-- about, and losing it silently would be worse than failing loudly here.
do $$
declare
  n bigint;
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'whatsapp_inbound') then
    execute 'select count(*) from public.whatsapp_inbound' into n;
    if n > 0 then
      raise exception
        'whatsapp_inbound holds % row(s); refusing to drop it. Export or inspect those rows, then drop the table by hand.', n;
    end if;
    drop table public.whatsapp_inbound;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- The channel vocabulary
-- -----------------------------------------------------------------------------
-- Any check constraint whose definition still mentions 'whatsapp' is replaced by one naming
-- ('web','telegram'). Located by definition rather than by name, so this works regardless of what
-- the original constraints were called.
do $$
declare
  t text;
  c record;
begin
  foreach t in array array['conversations', 'messages', 'diagnoses', 'usage_logs'] loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t and column_name = 'channel') then
      continue;
    end if;

    for c in
      select conname from pg_constraint
      where conrelid = format('public.%I', t)::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%whatsapp%'
    loop
      execute format('alter table public.%I drop constraint %I', t, c.conname);
    end loop;

    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', t)::regclass
        and conname = format('%s_channel_check', t)
    ) then
      execute format(
        'alter table public.%I add constraint %I check (channel in (''web'', ''telegram''))',
        t, format('%s_channel_check', t));
    end if;
  end loop;
end $$;

-- counters deliberately gets no edit: it has no channel column, which is precisely why
-- Requirement 14.2's cross-channel quota sharing is structural rather than a rule to remember.