-- 0002_profiles.sql
--
-- The Farmer identity table. One row per auth user, keyed by the same uuid, with
-- the E.164 phone as the single cross-channel identity.
--
-- Requirements: 1.4 (a first session for a phone with no Profile produces a
--               Profile whose id references auth.users and whose phone holds the
--               E.164 number), 1.5 (phone is the single identity for web and
--               WhatsApp), 13.1 (RLS enabled on profiles), 13.2 (each
--               authenticated Farmer restricted to their own rows)
-- Design: D8 (profile creation = auth.users trigger + idempotent server-side
--         upsert); depends on V5.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,

  -- The unique constraint on `phone` is load-bearing, not hygiene:
  --   * Requirement 1.5 makes the phone the single cross-channel Farmer
  --     identity, used by both the Web_App and the WhatsApp channel.
  --   * Requirement 10.2 resolves an inbound WhatsApp sender to a Farmer through
  --     this column.
  -- Two profiles sharing a phone would make that resolution ambiguous — there
  -- would be no defined answer to "whose conversation is this message part of".
  -- The uniqueness is what makes the lookup a function rather than a guess.
  phone        text not null unique,                        -- E.164, single identity (Req 1.5)

  display_name text,
  language     text not null default 'en'
                 check (language in ('en','hi','mr')),      -- Req 9.1
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- E.164: a leading '+', a nonzero country-code digit, then 7 to 14 more
  -- digits — 8 to 15 digits total, which is the E.164 maximum of 15. Anchored at
  -- both ends with ^ and $ so no substring match slips through.
  --
  -- On the single backslash: with standard_conforming_strings on (the default,
  -- and what Supabase runs), '\+' in this literal is a backslash followed by a
  -- plus, and in a Postgres advanced regular expression a backslash before a
  -- non-alphanumeric character means that character literally. So this matches a
  -- literal '+' at position one, which is what E.164 requires.
  constraint profiles_phone_e164 check (phone ~ '^\+[1-9][0-9]{7,14}$')
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- WhatsApp resolution (Req 10.2): every inbound message arrives with a sender
-- phone and nothing else, so this lookup is on the hot path of that channel.
create index profiles_phone_idx on public.profiles (phone);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- D8: bootstrap on first session
-- ---------------------------------------------------------------------------

-- Writes the Profile row the moment Auth_Service creates the auth user, so
-- Requirement 1.4 holds even if the browser never comes back.
--
-- `security definer` (resolves U-V5): the trigger fires on an insert into
-- `auth.users`, and the function must insert into `public.profiles`. The role
-- performing the signup does not necessarily hold insert privilege on
-- `public.profiles` — and RLS on that table (below) is written against
-- auth.uid(), which is not yet established during signup. So the function has to
-- run with the privileges of its owner for this pattern to work at all.
-- `security definer` is not decoration here; without it the trigger fails.
--
-- `set search_path = ''` is required (V5). That makes EVERY object reference in
-- this body schema-qualified, deliberately:
--   * `public.profiles` — the insert target.
--   * `new.id` / `new.phone` — PL/pgSQL record fields, not schema objects, so
--     there is nothing to qualify.
--   * no unqualified function calls at all.
-- An unqualified reference under an empty search_path is a runtime failure, and
-- a failing trigger on auth.users BLOCKS SIGNUPS entirely (V5). That is not a
-- degraded mode; it is the front door refusing to open.
--
-- Which is also exactly why D8 pairs this trigger with a defensive server-side
-- upsert after sign-in: the trigger is the primary mechanism, not the sole
-- guarantee. Residual failure modes it cannot cover on its own — an auth user
-- created without a phone (null violates `phone not null`), or a phone already
-- present on another profile (the `on conflict (id)` clause below does not catch
-- a unique violation on `phone`) — surface as signup errors. The upsert in the
-- post-sign-in server action is what keeps Requirement 1.4 observable when they
-- do.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, phone)
  values (new.id, new.phone)
  on conflict (id) do nothing;
  return new;
end $$;

comment on function public.handle_new_user() is
  'D8 profile bootstrap on auth.users insert. security definer because the signup role does not necessarily hold insert privilege on public.profiles. search_path pinned to the empty string per V5, so every object reference in the body is schema-qualified.';

-- V5: a trigger on auth.users is the documented Supabase bootstrap pattern.
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security (Req 13.1, 13.2)
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

-- Own-row only, in all three directions. `auth.uid()` is the authenticated
-- user's uuid and is null for an anonymous request, so `auth.uid() = id`
-- evaluates to null — not true — and the row is denied. The comparison is
-- against `id`, the primary key that references auth.users(id), because that is
-- the column auth.uid() is the same value as. Comparing against `phone` would
-- not typecheck and would not mean anything.
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = id);
