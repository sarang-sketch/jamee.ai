-- =============================================================================
-- 0012 — Google identity, the Telegram link column, and phone demoted
-- =============================================================================
--
-- Requirements: 1.4 (the bootstrap writes id and email and stores no phone), 1.5 (the Auth_User_Id
--               is the single cross-channel identity), 1.9 (profiles.phone is nullable optional
--               contact information taking part in no resolution), 10.2 (an inbound Telegram sender
--               resolves through telegram_user_id), 21.16 (telegram_user_id is UNIQUE)
-- Design: Amendment A1, decision D8
--
-- WHY THIS IS A FORWARD MIGRATION AND NOT AN EDIT TO 0002
--
-- design.md argues for amending 0002 in place, on the grounds that nothing had been deployed, so a
-- corrective migration would leave the original phone-identity schema readable as though it had
-- once been real. That reasoning held while the only database was a local stack somebody could
-- reset at will. It stops holding the moment a hosted project exists: the remote migration history
-- becomes the source of truth, rewriting an applied migration desynchronises it, and a rewritten
-- 0002 would also fail against a project that already has the old columns. So the correction
-- arrives forward, which is additionally the one form that is correct whether the target database
-- is fresh or already carries the old shape.
--
-- Everything here is idempotent. This migration has to be safe to apply to a database built from
-- the old 0002 and to one where an earlier attempt got partway.

-- -----------------------------------------------------------------------------
-- The Google email
-- -----------------------------------------------------------------------------
-- Nullable deliberately. The trigger below copies the email from the new auth.users row, and a
-- Google account that returns no email claim would otherwise turn a sign-up into a row that cannot
-- be inserted — a hard constraint here converts a missing optional claim into a farmer who cannot
-- use Jamee at all. An absent email is a profile without an email; that is recoverable.
alter table public.profiles add column if not exists email text;

-- -----------------------------------------------------------------------------
-- The Telegram link
-- -----------------------------------------------------------------------------
-- bigint because Telegram user ids are 64-bit integers, not uuids and not text.
--
-- The UNIQUE constraint is the load-bearing one now. Requirement 21.16 puts the at-most-one-Profile
-- rule in the database rather than in application code, so the /start handler does not defend that
-- rule — it handles the unique violation and reports "already linked to another Jamee account"
-- (21.13). Nulls are distinct in Postgres, so any number of unlinked profiles coexist.
--
-- No separate index is declared: the UNIQUE constraint already creates the one the sender lookup in
-- 10.2 uses, and a second index on the same column would be dead weight on every write.
alter table public.profiles add column if not exists telegram_user_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_telegram_user_id_key'
  ) then
    alter table public.profiles add constraint profiles_telegram_user_id_key unique (telegram_user_id);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Phone stops being an identity
-- -----------------------------------------------------------------------------
-- The column survives as optional contact information (Requirement 1.9) and loses everything that
-- made it an identity: NOT NULL, UNIQUE, and the E.164 check.
--
-- The E.164 check is dropped rather than relaxed, and that is the end of a real defect rather than
-- a loosening. Supabase Auth stores auth.users.phone with the leading '+' stripped, while this
-- constraint required it, and inbound WhatsApp senders arrived as a bare wa_id — three places
-- disagreeing about the format of one value, which made every phone-touching path carry a
-- normalizer. Identity is now a uuid the database generates and the trigger copies verbatim, so
-- there is no format left to reconcile. See D8.
alter table public.profiles alter column phone drop not null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_phone_e164'
  ) then
    alter table public.profiles drop constraint profiles_phone_e164;
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_phone_key'
  ) then
    alter table public.profiles drop constraint profiles_phone_key;
  end if;
end $$;

drop index if exists public.profiles_phone_idx;

comment on column public.profiles.email is
  'The Google email reported by the Auth_Service. Nullable: an absent claim must not block a sign-up.';
comment on column public.profiles.telegram_user_id is
  'The linked Telegram user id, written only by the /start binding of Requirement 21. UNIQUE enforces the at-most-one-Profile rule of 21.16, so the adapter handles the violation rather than policing it.';
comment on column public.profiles.phone is
  'Optional contact information only (Requirement 1.9). Takes part in no identity resolution, no session establishment, and no channel resolution. Deliberately unconstrained.';

-- -----------------------------------------------------------------------------
-- The bootstrap trigger copies the email and no phone
-- -----------------------------------------------------------------------------
-- The obligation of D8 is unchanged: this trigger writes the row and an idempotent server-side
-- upsert runs on every sign-in as the defensive half, because a purely client-driven insert can be
-- skipped when a farmer closes the tab on the callback, and a farmer with no profiles row has no
-- preferred language, no linking state, and nothing for an entitlement to hang off.
--
-- What changed is only what gets copied: (id, email), never a phone. The E.164 normalization the
-- previous version carried is deleted rather than ported — it is unnecessary, not lost.
--
-- security definer with a pinned empty search_path per V5, so every reference below is qualified.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

comment on function public.handle_new_user() is
  'D8 profile bootstrap on auth.users insert. Copies id and email only; stores no phone (Requirement 1.4). Amendment A1 removed the E.164 normalization the phone-identity version needed, because the identity is now a uuid with no format to reconcile. security definer because the signup role does not necessarily hold insert privilege on public.profiles; search_path pinned empty per V5.';