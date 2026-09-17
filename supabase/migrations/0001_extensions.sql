-- 0001_extensions.sql
--
-- Extensions and the one shared trigger function every later migration reuses.
--
-- Requirements: 13.1, 13.2 (this file lays the groundwork; RLS itself starts in 0002)
-- Design: "Data model and migrations" — `updated_at` is maintained by one shared
--         trigger function so no route handler has to remember it.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- Needed for gen_random_uuid(), which every later table uses as its id default.
--
-- On a hosted Supabase project pgcrypto is already installed in the `extensions`
-- schema, so this is a no-op there. Resolution of gen_random_uuid() does not
-- depend on where the extension lands: since PostgreSQL 13 that function is in
-- core (pg_catalog), and pg_catalog is always implicitly searched. So the bare
-- `default gen_random_uuid()` in later migrations resolves regardless.
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger function
-- ---------------------------------------------------------------------------

-- Every table with an `updated_at` column attaches a `before update` trigger to
-- this one function. Defining it once is what keeps `updated_at` correct without
-- any route handler setting it by hand.
--
-- Security context, deliberately:
--   * NOT `security definer`. This function needs no privilege beyond what the
--     statement that fired it already holds — it only assigns to a field of the
--     NEW record. Default `security invoker` is the least-privilege choice, and
--     `security definer` here would be privilege for nothing.
--   * `set search_path = ''` all the same. V5 records that a pinned, empty
--     search_path is required, and the Supabase linter (0011,
--     function_search_path_mutable) flags any function without one. This body is
--     safe under an empty search_path because `now()` lives in `pg_catalog`,
--     which is always implicitly searched, and `new` is a PL/pgSQL record
--     variable rather than a schema object — so there is nothing left to
--     qualify.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end $$;

comment on function public.set_updated_at() is
  'Shared before-update trigger function: stamps updated_at = now(). security invoker, because it needs no elevated privilege. search_path pinned to the empty string per V5.';
