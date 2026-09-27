import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';
import type { Channel } from '@/lib/schemas';
import {
  findOrCreateActive,
  type Conversation,
  type ConversationStore,
} from '@/services/conversation.service';

/**
 * Unit tests for `src/services/conversation.service.ts` with the database stubbed at the
 * `ConversationStore` seam — two plain async functions, so nothing here reproduces a query
 * builder chain or casts its way past a client type.
 *
 * Requirements: 7.5, 10.5, 10.8
 *
 * `conversationStoreFrom()` is deliberately not exercised: it is the one place a real database
 * client is touched, and whether the find and the order behave is a question about a live database
 * and its index, not about logic. The fake below **mirrors** that query — the same two predicates
 * and the same total order — so these tests pin the find-or-create decision that sits on top of it.
 * The integration project is where the real query and `conversations_user_recent_idx` get checked.
 */

/* ========================================================================== */
/* A fake conversations table                                                  */
/* ========================================================================== */

const FARMER = '11111111-1111-4111-8111-111111111111';
const OTHER_FARMER = '22222222-2222-4222-8222-222222222222';

interface FakeStore extends ConversationStore {
  /** Every row currently in the fake table, in insertion order. */
  readonly rows: readonly Conversation[];
  /** How many inserts happened, so "did not create" is an assertion rather than an inference. */
  readonly created: number;
}

/**
 * An in-memory `conversations` table applying exactly what the real query applies: filter on
 * `user_id` and `channel`, order by `updated_at desc, id desc`, take one.
 *
 * Inserted rows get a strictly increasing `updated_at`, which is what a fresh `now()` gives two
 * sequential inserts. Ids are `c1`, `c2`, … so the `id desc` tiebreak is legible.
 */
function fakeStore(seed: readonly Conversation[] = []): FakeStore {
  const rows: Conversation[] = [...seed];
  let clock = 0;
  let created = 0;

  return {
    get rows() {
      return rows;
    },
    get created() {
      return created;
    },

    async mostRecent(userId, channel) {
      const matching = rows
        .filter((row) => row.user_id === userId && row.channel === channel)
        .sort((a, b) =>
          a.updated_at === b.updated_at
            ? b.id.localeCompare(a.id)
            : b.updated_at.localeCompare(a.updated_at),
        );
      return matching[0] ?? null;
    },

    async create(userId, channel) {
      created += 1;
      clock += 1;
      const stamp = at(clock);
      const row: Conversation = {
        id: `c${String(created)}`,
        user_id: userId,
        channel,
        title: null,
        created_at: stamp,
        updated_at: stamp,
      };
      rows.push(row);
      return row;
    },
  };
}

/** An ISO instant that sorts lexicographically with its neighbours, like a timestamptz does. */
function at(minute: number): string {
  return `2026-09-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

function conversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  const stamp = overrides.updated_at ?? at(0);
  return {
    user_id: FARMER,
    channel: 'telegram',
    title: null,
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

/* ========================================================================== */
/* The most recently updated conversation for the requested channel             */
/* ========================================================================== */

describe('findOrCreateActive', () => {
  it('returns the most recently updated conversation for the channel without creating one', async () => {
    const store = fakeStore([
      conversation({ id: 'older', updated_at: at(10) }),
      conversation({ id: 'newest', updated_at: at(30) }),
      conversation({ id: 'middle', updated_at: at(20) }),
    ]);

    const found = await findOrCreateActive(FARMER, 'telegram', store);

    expect(found.id).toBe('newest');
    // Requirement 10.8: a follow-up must resolve inside the existing thread, so the create path
    // must not run when a thread is already there.
    expect(store.created).toBe(0);
    expect(store.rows).toHaveLength(3);
  });

  it('breaks a tie on updated_at deterministically, so two callers agree on one thread', async () => {
    const store = fakeStore([
      conversation({ id: 'c1', updated_at: at(10) }),
      conversation({ id: 'c2', updated_at: at(10) }),
    ]);

    const [first, second] = await Promise.all([
      findOrCreateActive(FARMER, 'telegram', store),
      findOrCreateActive(FARMER, 'telegram', store),
    ]);

    expect(first?.id).toBe('c2');
    expect(second?.id).toBe('c2');
  });

  /* ------------------------------------------------------------------------ */
  /* The two channels are separate threads (Requirements 10.5, 16.5)           */
  /* ------------------------------------------------------------------------ */

  it("ignores the other channel's rows even when they are more recent", async () => {
    const store = fakeStore([
      conversation({ id: 'telegram-thread', channel: 'telegram', updated_at: at(10) }),
      conversation({ id: 'web-thread', channel: 'web', updated_at: at(50) }),
    ]);

    // The web row is the most recently updated row this farmer has, and it must still not be the
    // answer for Telegram — otherwise the two threads bleed into each other.
    const telegram = await findOrCreateActive(FARMER, 'telegram', store);
    expect(telegram.id).toBe('telegram-thread');
    expect(telegram.channel).toBe('telegram');

    const web = await findOrCreateActive(FARMER, 'web', store);
    expect(web.id).toBe('web-thread');
    expect(web.channel).toBe('web');

    expect(store.created).toBe(0);
  });

  it('creates a separate row when the farmer has a thread on the other channel only', async () => {
    const store = fakeStore([conversation({ id: 'web-thread', channel: 'web', updated_at: at(50) })]);

    const telegram = await findOrCreateActive(FARMER, 'telegram', store);

    expect(telegram.id).not.toBe('web-thread');
    expect(telegram.channel).toBe('telegram');
    expect(store.created).toBe(1);
    // The web thread is untouched: a Telegram message cannot land in it.
    expect(store.rows.filter((row) => row.channel === 'web')).toHaveLength(1);
  });

  /* ------------------------------------------------------------------------ */
  /* Creating one when none exists (Requirement 7.5)                           */
  /* ------------------------------------------------------------------------ */

  it('creates a conversation for the farmer and channel when none exists', async () => {
    const store = fakeStore();

    const created = await findOrCreateActive(FARMER, 'web', store);

    expect(store.created).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(created.user_id).toBe(FARMER);
    expect(created.channel).toBe('web');
    expect(created.title).toBeNull();
  });

  it('returns the same conversation on the next call instead of creating a second one', async () => {
    const store = fakeStore();

    const first = await findOrCreateActive(FARMER, 'telegram', store);
    const second = await findOrCreateActive(FARMER, 'telegram', store);

    // The single long-running Telegram thread of Requirement 10.8: a second message appends to the
    // thread the first one created.
    expect(second.id).toBe(first.id);
    expect(store.created).toBe(1);
  });

  /* ------------------------------------------------------------------------ */
  /* Tenant isolation                                                          */
  /* ------------------------------------------------------------------------ */

  it("never returns another farmer's conversation", async () => {
    const store = fakeStore([
      conversation({ id: 'theirs', user_id: OTHER_FARMER, updated_at: at(50) }),
      conversation({ id: 'ours', user_id: FARMER, updated_at: at(10) }),
    ]);

    const found = await findOrCreateActive(FARMER, 'telegram', store);

    expect(found.id).toBe('ours');
    expect(found.user_id).toBe(FARMER);
  });

  it("creates a thread rather than borrowing another farmer's when the farmer has none", async () => {
    const store = fakeStore([
      conversation({ id: 'theirs', user_id: OTHER_FARMER, updated_at: at(50) }),
    ]);

    const found = await findOrCreateActive(FARMER, 'telegram', store);

    expect(found.id).not.toBe('theirs');
    expect(found.user_id).toBe(FARMER);
    expect(store.created).toBe(1);
  });

  it('rejects a row from a store that ignored the predicates rather than returning it', async () => {
    // The Data_Access_Layer scopes reads by farmer id rather than a database policy, so a store
    // that dropped a predicate must fail loudly instead of becoming a cross-tenant read.
    const leaky: ConversationStore = {
      mostRecent: async () =>
        conversation({ id: 'theirs', user_id: OTHER_FARMER, updated_at: at(50) }),
      create: async () => {
        throw new Error('create must not be reached');
      },
    };

    await expect(findOrCreateActive(FARMER, 'telegram', leaky)).rejects.toBeInstanceOf(AppError);
    await expect(findOrCreateActive(FARMER, 'telegram', leaky)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  });

  it('rejects a row on the wrong channel rather than returning it', async () => {
    const wrongChannel: ConversationStore = {
      mostRecent: async () => conversation({ id: 'web-thread', channel: 'web' }),
      create: async () => {
        throw new Error('create must not be reached');
      },
    };

    await expect(findOrCreateActive(FARMER, 'telegram', wrongChannel)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The race, and the residual that was accepted                              */
  /* ------------------------------------------------------------------------ */

  it('converges two concurrent first-message callers onto one thread', async () => {
    const store = fakeStore();

    const [first, second] = await Promise.all([
      findOrCreateActive(FARMER, 'telegram', store),
      findOrCreateActive(FARMER, 'telegram', store),
    ]);

    // Both callers read "no thread" and both inserted, so a duplicate row exists — that is the
    // residual the module documents rather than a constraint it does not have.
    expect(store.created).toBe(2);
    // What matters for Requirement 10.8 is that the two messages do NOT split across threads: the
    // read-back makes both callers agree, so the diagnosis history a follow-up resolves against
    // stays in one conversation and the loser row stays empty.
    expect(first?.id).toBe(second?.id);
  });

  it('keeps the loser row out of every later lookup', async () => {
    const store = fakeStore();

    const [winner] = await Promise.all([
      findOrCreateActive(FARMER, 'telegram', store),
      findOrCreateActive(FARMER, 'telegram', store),
    ]);
    const later = await findOrCreateActive(FARMER, 'telegram', store);

    expect(later.id).toBe(winner?.id);
    expect(store.created).toBe(2);
  });

  /* ------------------------------------------------------------------------ */
  /* Read and write failures                                                   */
  /* ------------------------------------------------------------------------ */

  it('propagates a read failure instead of creating a second thread', async () => {
    let creates = 0;
    const failingRead: ConversationStore = {
      mostRecent: async () => {
        throw new AppError('INTERNAL_ERROR', { context: { reason: 'conversation_read_failed' } });
      },
      create: async () => {
        creates += 1;
        throw new Error('unreachable');
      },
    };

    await expect(findOrCreateActive(FARMER, 'telegram', failingRead)).rejects.toBeInstanceOf(
      AppError,
    );
    // A failed read must not be read as "no thread exists": creating one then would split the
    // history of a farmer who already had a thread.
    expect(creates).toBe(0);
  });

  it('returns the inserted row when the read-back finds nothing', async () => {
    const inserted = conversation({ id: 'inserted', updated_at: at(1) });
    let reads = 0;
    const blindStore: ConversationStore = {
      mostRecent: async () => {
        reads += 1;
        return null;
      },
      create: async () => inserted,
    };

    const found = await findOrCreateActive(FARMER, 'telegram', blindStore);

    expect(found).toEqual(inserted);
    expect(reads).toBe(2);
  });
});

/* ========================================================================== */
/* Channel coverage                                                            */
/* ========================================================================== */

describe.each<Channel>(['web', 'telegram'])('findOrCreateActive on the %s channel', (channel) => {
  it('records the requested channel on the created row', async () => {
    const store = fakeStore();

    const created = await findOrCreateActive(FARMER, channel, store);

    // Requirement 16.5: the channel supplied to the service reaches the persisted row.
    expect(created.channel).toBe(channel);
    expect(store.rows.every((row) => row.channel === channel)).toBe(true);
  });
});
