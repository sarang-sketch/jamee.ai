-- 0004_disease_knowledge.sql
--
-- The verified knowledge base: the only source of agricultural content a farmer
-- ever reads (Requirements 4.3-4.5). Every symptom, cause, treatment, and
-- prevention sentence is rephrased from a row in this table.
--
-- DEPENDS ON 0001_extensions.sql, which must have run first:
--   * pgcrypto            -> gen_random_uuid() for the primary key default
--   * public.set_updated_at() -> the shared updated_at trigger function
-- This file neither creates nor duplicates either of those.
--
-- Seed rows are NOT inserted here. They land in 0010_seed_disease_knowledge.sql.

create table public.disease_knowledge (
  id               uuid primary key default gen_random_uuid(),

  -- Requirement 4.1: the knowledge base holds *exactly* five entries. That
  -- invariant is deliberately split across two migrations:
  --   * MAXIMUM five  -- this check constraint (no sixth name is insertable)
  --                      plus unique(disease_name) (no name appears twice).
  --   * MINIMUM five  -- 0010_seed_disease_knowledge.sql inserts all five rows.
  -- Neither half is sufficient alone. The deployment check asserts
  -- `select count(*) = 5 from public.disease_knowledge` to confirm both held.
  --
  -- These five string literals are the canonical disease names and are
  -- replicated in exactly two other places: the VERIFIED_CONDITIONS Zod enum in
  -- src/lib/schemas.ts and the diagnoses.disease_name check constraint in
  -- 0005_diagnoses.sql. All three lists must stay character-for-character
  -- identical, capitalisation included; a divergence is a silent correctness bug
  -- that surfaces as an insert failure or a knowledge-base lookup miss.
  disease_name     text not null unique check (disease_name in (
                     'Tomato Early Blight','Tomato Late Blight','Tomato Healthy',
                     'Potato Early Blight','Potato Late Blight')),

  crop             text not null check (crop in ('tomato','potato')),
  scientific_name  text,                       -- null for the healthy entry
  symptoms         text[] not null,
  causes           text[] not null,
  treatment        text[] not null,            -- empty array for the healthy entry
  prevention       text[] not null,
  default_severity text not null check (default_severity in ('none','low','moderate','high')),

  -- Requirement 4.2: provenance is mandatory per row. `not null` is what stops a
  -- row of agricultural advice from existing without a citation behind it.
  source           text not null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Requirement 3.4: a Tomato Healthy diagnosis must carry no treatment content.
  -- Enforcing that here makes the requirement hold *by construction* rather than
  -- by the model's cooperation or the service layer remembering to strip the
  -- field: since every farmer-facing treatment sentence is composed from this
  -- table (Requirement 4.3), an empty treatment array for the healthy row means
  -- there is no treatment text available to render, whatever the model returns.
  -- For any other disease_name the left disjunct is true, so the constraint
  -- permits an arbitrary treatment array on the four disease rows.
  constraint healthy_has_no_treatment check (
    disease_name <> 'Tomato Healthy' or cardinality(treatment) = 0
  )
);

-- No extra index: unique(disease_name) already backs canonical-name lookups, and
-- five rows make any other index noise.

create trigger disease_knowledge_set_updated_at
  before update on public.disease_knowledge
  for each row execute function public.set_updated_at();

alter table public.disease_knowledge enable row level security;

-- Requirement 13.3: every authenticated farmer may read the whole knowledge base.
-- There is nothing farmer-specific in it, so the predicate is unconditional.
create policy dk_select_authenticated on public.disease_knowledge
  for select to authenticated using (true);

-- Requirement 13.4: writes are restricted to migrations run with the service-role
-- key. The MECHANISM IS THE ABSENCE of any insert, update, or delete policy,
-- combined with RLS being enabled above: under RLS a command with no matching
-- permissive policy is denied, and the service role bypasses RLS entirely.
--
-- THE MISSING WRITE POLICIES ARE DELIBERATE. DO NOT "FIX" THIS GAP. Adding an
-- insert/update/delete policy for `authenticated` or `anon` would let a farmer's
-- own token rewrite the verified content that grounds every diagnosis, breaking
-- Requirements 13.4, 4.1, and 4.3 at once. Knowledge-base content changes belong
-- in a new migration, not in a policy.
