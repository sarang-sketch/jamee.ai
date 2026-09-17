-- 0005_diagnoses.sql
--
-- One row per completed image analysis. The table the history screen reads and the retention
-- sweep drives from.
--
-- Requirements: 3.3 (persist with the owning farmer, the conversation, the storage reference
--               and the channel), 6.4 / 6.5 (the single inconclusive shape carries no disease
--               name and no treatment reference), 12.1 (reverse-chronological history),
--               13.1 / 13.2 (RLS, own-row), 16.5 (channel recorded),
--               18.3 / 18.7 (the sweep finds its work here and stamps the deletion instant)
-- Design: "0005: diagnoses"; "How the sweep finds its work" (scan 1)
--
-- DEPENDS ON 0001 (gen_random_uuid), 0002 (profiles), 0003 (conversations),
--            0004 (disease_knowledge — the knowledge_id foreign key resolves against it).

create table public.diagnoses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,

  -- Requirement 7.5: a diagnosis submitted without a conversation identifier causes one to be
  -- CREATED and the diagnosis attached to it. So this column is `not null` — there is no such
  -- thing as a conversation-less diagnosis, which is what lets Requirement 7.3's subject-less
  -- follow-up always have something to resolve against.
  conversation_id uuid not null references public.conversations(id) on delete cascade,

  status          text not null check (status in ('identified','unknown')),

  -- The same five literals as VERIFIED_CONDITIONS in src/lib/schemas.ts and the check
  -- constraint in 0004. All three lists must stay character-for-character identical.
  -- Nullable, because Requirement 6.5 requires an inconclusive result to carry no name.
  disease_name    text check (disease_name in (
                    'Tomato Early Blight','Tomato Late Blight','Tomato Healthy',
                    'Potato Early Blight','Potato Late Blight')),

  knowledge_id    uuid references public.disease_knowledge(id),

  -- Requirement 5.4's closed interval, enforced a second time in the database. numeric(4,3)
  -- holds 0.000 through 1.000 exactly, so a confidence cannot be stored at a precision the
  -- schema did not validate.
  confidence      numeric(4,3) check (confidence >= 0 and confidence <= 1),

  severity        text not null check (severity in ('none','low','moderate','high')),
  explanation     text not null,
  language        text not null check (language in ('en','hi','mr')),
  needs_expert    boolean not null default false,
  channel         text not null check (channel in ('web','whatsapp')),   -- Req 16.5

  -- Requirement 2.5 verifies the bucket before analysis; this constraint means a row cannot
  -- record an image from anywhere else, so the history view and the sweep both know which
  -- bucket to address without carrying the knowledge in code.
  image_bucket    text not null check (image_bucket = 'crop-images'),
  image_path      text not null,

  -- Requirement 18.7: stamped by the retention sweep when the Full_Size_Image is deleted.
  --
  -- Two things this column buys, both load-bearing:
  --
  --  1. The history view can distinguish "deleted by policy" (Requirement 12.9/12.10 copy)
  --     from "missing unexpectedly" with a COLUMN READ instead of a storage probe per list
  --     row. Probing would cost one storage call per history entry on every render, which is
  --     exactly the egress-and-invocation cost the media-lifecycle amendment set out to
  --     remove.
  --  2. It makes the sweep idempotent by construction (Requirement 18.10): scan 1's
  --     `where full_image_deleted_at is null` predicate excludes anything a previous run
  --     already stamped. V21 records that the platform's cron delivery can invoke the same
  --     scheduled run more than once, so this is the platform's documented contract, not
  --     defensive over-engineering.
  --
  -- Nullable and deliberately NOT tied to `image_path` by any constraint: `image_path` is left
  -- INTACT after deletion, because the thumbnail path is derived from it (Requirement 2.13),
  -- so erasing it would take the surviving thumbnail with it (Requirement 18.5).
  full_image_deleted_at timestamptz,

  -- Requirement 14.6. 'none' is absent here on purpose: a row in this table means a
  -- classification happened, and a classification always had a provider. `usage_logs`
  -- allows 'none' because a quota decline is logged there without one.
  model_provider  text not null check (model_provider in ('gemini','groq')),

  created_at      timestamptz not null default now(),

  -- =========================================================================
  -- The two shape constraints. These are why Requirements 6.4 and 6.5 hold in the
  -- DATABASE and not only in TypeScript.
  --
  -- `inconclusiveResultSchema` already pins diseaseName/confidence/knowledge to null and
  -- needsExpert to true, so the compiler stops a UI from rendering treatment text for an
  -- inconclusive result. These constraints stop a BUG in the service layer from persisting
  -- one: an insert that tried would fail rather than reach a farmer's history.
  --
  -- Two independent boundaries for the same rule, neither relying on the other.
  -- =========================================================================

  constraint diagnoses_unknown_shape check (
    status <> 'unknown' or
    (disease_name is null and knowledge_id is null
     and needs_expert = true and severity = 'none')
  ),

  constraint diagnoses_identified_shape check (
    status <> 'identified' or (disease_name is not null and knowledge_id is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Requirement 12.1: the history list, reverse-chronological, for one farmer, across BOTH
-- channels (Requirement 12.2). No channel column in the index, because the list is not
-- filtered by channel — it is labelled by it.
create index diagnoses_user_recent_idx on public.diagnoses (user_id, created_at desc);

-- Requirement 7.3 / 10.8: "the most recent Diagnosis_Result in this conversation", which is
-- what a subject-less follow-up resolves against.
create index diagnoses_conversation_idx on public.diagnoses (conversation_id, created_at desc);

-- Retention sweep candidate scan (Requirement 18.3): rows whose original has not yet been
-- deleted, oldest first.
--
-- PARTIAL, and that is the interesting part: the index only contains rows the sweep still has
-- work for, so it SHRINKS as the sweep does its job rather than growing with the table. At the
-- steady state of a pilot it holds roughly one retention window's worth of rows regardless of
-- how long the pilot has run.
create index diagnoses_retention_idx on public.diagnoses (created_at)
  where full_image_deleted_at is null;

-- ---------------------------------------------------------------------------
-- Row level security (Requirements 13.1, 13.2)
-- ---------------------------------------------------------------------------

alter table public.diagnoses enable row level security;

create policy diagnoses_select_own on public.diagnoses
  for select using (auth.uid() = user_id);
create policy diagnoses_insert_own on public.diagnoses
  for insert with check (auth.uid() = user_id);

-- No update policy for `authenticated`, deliberately.
--
-- The only column anything updates is `full_image_deleted_at`, and Requirement 18.9 requires
-- every retention deletion to run from a server-side module using the Service_Role_Key — which
-- bypasses RLS. So a farmer session needs no update grant, and giving one would let a client
-- mark its own images deleted and permanently mislead its own history view.
--
-- No delete policy either: Requirement 18.6 forbids the sweep from deleting a row here, and
-- nothing else in the requirements deletes a diagnosis.
