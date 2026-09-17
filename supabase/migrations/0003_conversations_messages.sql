-- 0003_conversations_messages.sql
--
-- Conversation threads and the messages inside them.
--
-- Requirements: 7.1, 7.2 (Conversation_Context is keyed on the conversation identifier),
--               7.4 (the farmer message and the Jamee answer are persisted in the same
--               conversation), 13.1 (RLS enabled), 13.2 (own-row only),
--               16.5 (the channel supplied to the service is recorded on persisted rows)
-- Design: "0003: conversations and messages"; ConversationService.findOrCreateActive
--
-- DEPENDS ON 0001 (set_updated_at) and 0002 (public.profiles).

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------

create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,

  -- Requirement 16.5. The channel is on the CONVERSATION as well as on each message
  -- because Requirement 10.5 resolves an inbound WhatsApp text against "that Farmer's
  -- active WhatsApp Conversation" — a per-channel find-or-create needs a per-channel
  -- column to filter on, and deriving it from the messages inside would make an empty
  -- conversation channel-less.
  --
  -- The consequence is deliberate: a farmer has a `web` thread and a `whatsapp` thread as
  -- SEPARATE rows, so the two never bleed into each other while still sharing one identity
  -- (Requirement 1.5) and one quota (Requirement 14.2).
  channel    text not null check (channel in ('web','whatsapp')),

  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ConversationService.findOrCreateActive(userId, channel) reads "most recently updated
-- conversation for this farmer on this channel". This index serves that ordering directly.
create index conversations_user_recent_idx
  on public.conversations (user_id, updated_at desc);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,

  -- DENORMALIZED from the conversation, on purpose.
  --
  -- RLS runs on every row of every context read. With user_id here, the policy is a
  -- single-column predicate (`auth.uid() = user_id`); without it, every policy evaluation
  -- would join back to conversations. Conversation_Context is read on every chat turn
  -- (Requirement 7.1), so that join would be on the hottest path in the product.
  --
  -- The duplication is safe because a message cannot change conversation: there is no code
  -- path that reparents one, and `on delete cascade` from both sides keeps the two columns
  -- from outliving each other.
  user_id         uuid not null references public.profiles(id) on delete cascade,

  role            text not null check (role in ('farmer','jamee')),
  content         text not null,
  language        text not null check (language in ('en','hi','mr')),
  channel         text not null check (channel in ('web','whatsapp')),

  -- Requirement 8.4: a voice question enters the conversation as a normal farmer message
  -- whose text is the transcript. `input_kind` is what distinguishes it afterwards, which is
  -- what lets the voice scenario tests assert "the transcript was persisted as a message"
  -- rather than inferring it. 'image' exists for the message a diagnosis writes.
  input_kind      text not null default 'text'
                    check (input_kind in ('text','voice','image')),

  -- Storage path of the recording, when input_kind = 'voice'.
  --
  -- Requirement 8.9 deletes that object as soon as this row is committed, so this column is
  -- usually a path to an object that NO LONGER EXISTS. That is intended: it is provenance,
  -- not a reference to fetch. Requirement 8.8 rules out audio playback and nothing in the
  -- requirements reads a recording back, so the transcript in `content` is the durable
  -- artefact and this column records where it came from.
  transcript_of   text,

  created_at      timestamptz not null default now()
);

-- Conversation_Context window (Requirements 7.1, 7.2): the last N messages of ONE
-- conversation, newest first. `conversation_id` leads because the context read is always
-- scoped to a single conversation — Property 15 requires that a message from another
-- conversation cannot enter the window, and scoping the query by this column is how.
create index messages_conversation_idx
  on public.messages (conversation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security (Requirements 13.1, 13.2)
-- ---------------------------------------------------------------------------

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy conversations_select_own on public.conversations
  for select using (auth.uid() = user_id);
create policy conversations_insert_own on public.conversations
  for insert with check (auth.uid() = user_id);
create policy conversations_update_own on public.conversations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy messages_select_own on public.messages
  for select using (auth.uid() = user_id);
create policy messages_insert_own on public.messages
  for insert with check (auth.uid() = user_id);

-- No update or delete policy on `messages`, and that is deliberate rather than an omission.
-- A conversation is an audit of what a farmer asked and what Jamee answered; editing an
-- answer after the fact would make the history screen (Requirement 12.3) unreliable as a
-- record. Nothing in the requirements edits or deletes a message, and Requirement 18.6
-- explicitly forbids the retention sweep from deleting one.
