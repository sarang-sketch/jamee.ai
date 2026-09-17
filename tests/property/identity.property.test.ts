import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  E164_PHONE,
  ensureProfile,
  toE164,
  type AuthUserLike,
  type ProfileBootstrapRow,
  type ProfileWriterLike,
} from '@/app/auth/callback/ensure-profile';
import {
  DEFAULT_LANGUAGE,
  readProfileSettings,
  saveProfileSettings,
  type ProfileQueryError,
  type ProfileSettingsMutation,
  type ProfileSettingsQuery,
  type ProfileSettingsRow,
  type ProfileSettingsWrite,
} from '@/lib/profile';
import { SUPPORTED_LANGUAGES, type Channel, type Language } from '@/lib/schemas';
import {
  normalizeInboundPhone,
  resolveProfileByPhone,
  type ProfileByPhoneStore,
} from '@/lib/whatsapp-dispatch';
import { conversationStoreFrom, findOrCreateActive } from '@/services/conversation.service';
import type { ConversationRow, Database, ProfileRow, TablesInsert } from '@/types/database';

/**
 * ### Property 1: Identity round-trip across channels
 *
 * *"For any valid E.164 phone number, after a first authenticated session is established for that
 * number, a Profile exists whose id equals the auth user id and whose phone equals that number
 * exactly; resolving that same number the way an inbound WhatsApp message is resolved returns that
 * same Profile; and for any display name and any supported language written to that Profile, reading
 * it back returns the same values."*
 *
 * **Validates: Requirements 1.4, 1.5, 1.8, 10.2**
 *
 * =============================================================================
 * WHAT THE ROUND TRIP ACTUALLY IS, AND WHY IT IS A PROPERTY WORTH HAVING
 * =============================================================================
 *
 * The recorded design decision is that **the E.164 phone is the single cross-channel identity**
 * (Requirement 1.5), established by Supabase phone OTP. Nothing in Jamee links a web account to a
 * WhatsApp account; the two are the same account because the same string is in the same column. So
 * the whole claim rests on **two independently written normalizers agreeing**:
 *
 *  - `toE164()` in `src/app/auth/callback/ensure-profile.ts` turns `auth.users.phone` into the value
 *    written to `profiles.phone`. Its header records *why* it is not a no-op: the format Supabase
 *    Auth stores a phone in is not resolved in `docs/VERIFIED_VALUES.md`, so the value may or may
 *    not carry the leading `+`.
 *  - `normalizeInboundPhone()` in `src/lib/whatsapp-dispatch.ts` turns Meta's `wa_id` into the value
 *    looked up in that same column. V12 records `messages[].from` as **digits with no `+`**, and its
 *    header calls this "the single most likely place for the WhatsApp channel to fail silently" —
 *    the symptom of a mismatch is not an error but *every* farmer being told to sign in on a website
 *    they already signed in on.
 *
 * Two copies of one convention, in two modules, with no shared constant between them. That is
 * exactly the shape of thing a property should hold over: for any valid E.164 number, and any
 * surface form either side may be handed, the write and the lookup have to land on the same string.
 * A single-example test would pass on `+919876543210` and miss the whole class.
 *
 * =============================================================================
 * WHAT THE IN-MEMORY `profiles` TABLE MODELS, STATED SO IT CAN BE JUDGED
 * =============================================================================
 *
 * Every seam here is a function seam in production — `ProfileWriterLike`, `ProfileByPhoneStore`,
 * `ProfileSettingsQuery`, `ProfileSettingsMutation` — so the table below stands where Postgres
 * stands. It is not a Supabase emulator, and it models exactly four database behaviours the round
 * trip depends on, each of them a line in `0002_profiles.sql`:
 *
 *  1. **`.eq('phone', …)` is exact string equality on a `unique` column.** This is the one behaviour
 *     the central claim rides on: it is *why* a `+`-less lookup against a `+`-carrying column
 *     matches nothing, and therefore why the two normalizers have to agree.
 *  2. **`insert … on conflict (id) do update` updates only the columns present in the payload.**
 *     PostgREST builds the conflict clause from the payload's keys, which is what keeps a repeat
 *     sign-in from resetting the display name and language.
 *  3. **`profiles_phone_e164`** — a phone the check constraint would refuse is refused (`23514`).
 *  4. **`unique (phone)`** — a phone already held by a different id is refused (`23505`), which
 *     `ensure-profile.ts` classifies as residual mode two.
 *
 * Nothing else about Postgres is modelled and nothing needs to be: RLS is not part of this property
 * (it is Property 27's), and none of the four seams here is the boundary that RLS enforces. What the
 * table cannot do is prove that a *deployed* Supabase writes `auth.users.phone` in either of the
 * forms generated below — that is a fact about the platform, not about Jamee, and `toE164()`'s header
 * is explicit that it handles both because the fact is unresolved.
 *
 * =============================================================================
 * THE DECOY FARMER
 * =============================================================================
 *
 * Every run seeds a **second** profile with a different phone before the one under test. A lookup
 * that ignored its predicate, or a table that answered "the only row", would return the decoy or
 * pass by accident; the assertions below name the id they expect. The decoy's phone is generated far
 * from the subject's by construction (a different leading digit and a different length), so a
 * generated collision cannot silently turn the decoy into the subject.
 */

/* ========================================================================== */
/* The four surface forms of one number                                        */
/* ========================================================================== */

/**
 * How `auth.users.phone` may reach `toE164()`.
 *
 * `canonical` and `no_plus` are the two forms the module header names as both possible. The other
 * four are the separator classes `SEPARATORS` in that module strips — `[\s()\u2010-\u2015-]` — one
 * form per class, so a narrowing of that character class fails here rather than in production on
 * whichever provider inserts that separator.
 */
const AUTH_PHONE_FORMS = [
  'canonical',
  'no_plus',
  'spaces',
  'hyphens',
  'parentheses',
  'en_dashes',
] as const;

type AuthPhoneForm = (typeof AUTH_PHONE_FORMS)[number];

/**
 * How a `wa_id` may reach `normalizeInboundPhone()`.
 *
 * Only three, and deliberately not the separator forms above: V12 documents `wa_id` as digits, and
 * `normalizeInboundPhone()` trims but does **not** strip interior separators. Generating a spaced
 * `wa_id` would assert a behaviour neither Meta produces nor Jamee claims.
 */
const WA_ID_FORMS = ['bare_digits', 'with_plus', 'whitespace_padded'] as const;

type WaIdForm = (typeof WA_ID_FORMS)[number];

/** What a farmer may type into the display-name field (Requirement 1.8). */
const NAME_SHAPES = ['plain', 'padded', 'devanagari', 'blank'] as const;

type NameShape = (typeof NAME_SHAPES)[number];

/** Digits of `+CCNNN…`, without the `+`. */
function digitsOf(e164: string): string {
  return e164.slice(1);
}

/** `+91` `98765` `43210` — three chunks, so a separator has two interior places to go. */
function chunksOf(e164: string): readonly [string, string, string] {
  const digits = digitsOf(e164);
  const first = Math.max(1, Math.floor(digits.length / 3));
  const second = Math.max(first + 1, Math.floor((digits.length * 2) / 3));
  return [digits.slice(0, first), digits.slice(first, second), digits.slice(second)];
}

/**
 * The number as this surface form would present it. **No digit is added, removed or reordered** by
 * any branch — that is what makes the expected result the same E.164 string for all six.
 */
function renderAuthPhone(e164: string, form: AuthPhoneForm): string {
  const [a, b, c] = chunksOf(e164);
  switch (form) {
    case 'canonical':
      return e164;
    case 'no_plus':
      return digitsOf(e164);
    case 'spaces':
      return `+${a} ${b} ${c}`;
    case 'hyphens':
      return `${a}-${b}-${c}`;
    case 'parentheses':
      return `+${a}(${b})${c}`;
    case 'en_dashes':
      return `+${a}\u2013${b}\u2013${c}`;
  }
}

function renderWaId(e164: string, form: WaIdForm): string {
  switch (form) {
    case 'bare_digits':
      return digitsOf(e164);
    case 'with_plus':
      return e164;
    case 'whitespace_padded':
      return ` \t${digitsOf(e164)}\n `;
  }
}

function renderName(shape: NameShape, seed: string): string {
  switch (shape) {
    case 'plain':
      return `Farmer ${seed}`;
    case 'padded':
      return `  Farmer ${seed}\t `;
    case 'devanagari':
      return `किसान ${seed}`;
    case 'blank':
      return '   ';
  }
}

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/**
 * A valid E.164 number, generated against the constraint rather than against a country: a leading
 * digit 1–9 then 7 to 14 more, which is `^\+[1-9][0-9]{7,14}$` — `profiles_phone_e164` in migration
 * `0002`, the copy of it in `ensure-profile.ts`, and the copy in `whatsapp-dispatch.ts`, all three of
 * which this file asserts the generated value satisfies before using it.
 */
const e164Arb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 7, maxLength: 14 }),
  )
  .map(([lead, rest]) => `+${lead}${rest.join('')}`);

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);
const userIdArb = fc.uuid();

/** Two distinct auth user ids: the farmer under test, and the decoy seeded beside them. */
const twoUserIdsArb = fc.tuple(userIdArb, userIdArb).filter(([a, b]) => a !== b);

interface Scenario {
  readonly userId: string;
  readonly decoyId: string;
  readonly e164: string;
  readonly authForm: AuthPhoneForm;
  readonly waForm: WaIdForm;
  readonly nameShape: NameShape;
  readonly nameSeed: string;
  readonly language: Language;
  /** Whether a second sign-in runs after the settings were saved (the upsert is idempotent). */
  readonly signsInAgain: boolean;
  readonly channel: Channel;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    ids: twoUserIdsArb,
    e164: e164Arb,
    authForm: fc.constantFrom<AuthPhoneForm>(...AUTH_PHONE_FORMS),
    waForm: fc.constantFrom<WaIdForm>(...WA_ID_FORMS),
    nameShape: fc.constantFrom<NameShape>(...NAME_SHAPES),
    nameSeed: fc.integer({ min: 0x100, max: 0xffff }).map((raw) => raw.toString(16).toUpperCase()),
    language: languageArb,
    signsInAgain: fc.boolean(),
    channel: fc.constantFrom<Channel>('web', 'whatsapp'),
  })
  .map(({ ids, ...rest }) => ({ userId: ids[0], decoyId: ids[1], ...rest }));

/**
 * The decoy's number, built from the subject's so it cannot collide: a different leading digit and
 * one more digit than the subject, capped at E.164's 15.
 */
function decoyPhoneFor(e164: string): string {
  const digits = digitsOf(e164);
  const lead = ((Number(digits[0] ?? '1') % 9) + 1).toString();
  const tail = `${digits.slice(1)}7`.slice(0, 14);
  return `+${lead}${tail}`;
}

/* ========================================================================== */
/* The in-memory `profiles` table                                              */
/* ========================================================================== */

/** `0002_profiles.sql`'s constraint, as the table below enforces it. */
const PHONE_CHECK = /^\+[1-9][0-9]{7,14}$/;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

interface ProfilesTable {
  /** Every upsert payload, exactly as `ensureProfile()` composed it. */
  readonly upserts: ProfileBootstrapRow[];
  /** Every settings payload, exactly as `saveProfileSettings()` composed it. */
  readonly updates: ProfileSettingsWrite[];
  /** Every phone the WhatsApp lookup asked for, exactly as `resolveProfileByPhone()` built it. */
  readonly lookups: string[];
  rowFor(id: string): ProfileRow | undefined;
  seed(row: Pick<ProfileRow, 'id' | 'phone'> & Partial<ProfileRow>): void;
  readonly writer: ProfileWriterLike;
  readonly store: ProfileByPhoneStore;
  query(userId: string): ProfileSettingsQuery;
  mutation(userId: string): ProfileSettingsMutation;
}

function profilesTable(): ProfilesTable {
  const rows = new Map<string, ProfileRow>();
  const upserts: ProfileBootstrapRow[] = [];
  const updates: ProfileSettingsWrite[] = [];
  const lookups: string[] = [];
  let clock = 0;

  const stamp = (): string => {
    clock += 1;
    return `2026-09-16T00:${String(clock).padStart(2, '0')}:00.000Z`;
  };

  const seed: ProfilesTable['seed'] = (row) => {
    const created = stamp();
    rows.set(row.id, {
      id: row.id,
      phone: row.phone,
      display_name: row.display_name ?? null,
      // `language not null default 'en'`.
      language: row.language ?? DEFAULT_LANGUAGE,
      created_at: row.created_at ?? created,
      updated_at: row.updated_at ?? created,
    });
  };

  const writer: ProfileWriterLike = {
    from: (table) => {
      if (table !== 'profiles') throw new Error(`the profiles table was asked for "${table}"`);
      return {
        upsert: (values, options) => {
          upserts.push(values);

          if (options.ignoreDuplicates) {
            throw new Error(
              'Requirement 1.5: the bootstrap upsert must UPDATE on conflict, not do nothing — a ' +
                'stale phone silently misroutes the WhatsApp channel (Requirement 10.2)',
            );
          }

          // `profiles_phone_e164`.
          if (values.phone === undefined || !PHONE_CHECK.test(values.phone)) {
            return Promise.resolve({
              error: { code: CHECK_VIOLATION, message: 'profiles_phone_e164' },
            });
          }

          // `unique (phone)` — held by a different id, which `on conflict (id)` does not absorb.
          for (const [id, row] of rows) {
            if (row.phone === values.phone && id !== values.id) {
              return Promise.resolve({
                error: { code: UNIQUE_VIOLATION, message: 'profiles_phone_key' },
              });
            }
          }

          const existing = values.id === undefined ? undefined : rows.get(values.id);
          if (existing === undefined) {
            if (values.id === undefined) throw new Error('an upsert with no id reached the table');
            seed({ id: values.id, phone: values.phone });
            return Promise.resolve({ error: null });
          }

          // `on conflict (id) do update` over the payload's keys only: `display_name` and
          // `language` are not in it, so they survive.
          rows.set(existing.id, { ...existing, phone: values.phone, updated_at: stamp() });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  const store: ProfileByPhoneStore = {
    byPhone: (e164Phone) => {
      lookups.push(e164Phone);
      // `.eq('phone', …)`: exact string equality on a unique column, `maybeSingle()`.
      const found = [...rows.values()].filter((row) => row.phone === e164Phone);
      if (found.length > 1) {
        throw new Error('two rows shared a phone; `unique (phone)` makes that impossible');
      }
      const row = found[0];
      return Promise.resolve({
        data: row === undefined ? null : { id: row.id, language: row.language },
        error: null,
      });
    },
  };

  const slice = (row: ProfileRow): ProfileSettingsRow => ({
    display_name: row.display_name,
    language: row.language,
  });

  const query = (userId: string): ProfileSettingsQuery => () => {
    const row = rows.get(userId);
    return Promise.resolve({ data: row === undefined ? null : slice(row), error: null });
  };

  const mutation = (userId: string): ProfileSettingsMutation => (values) => {
    updates.push(values);
    const row = rows.get(userId);
    if (row === undefined) return Promise.resolve({ data: [], error: null });

    const error: ProfileQueryError | null = (SUPPORTED_LANGUAGES as readonly string[]).includes(
      values.language,
    )
      ? null
      : // `check (language in ('en','hi','mr'))`.
        { code: CHECK_VIOLATION, message: 'profiles_language_check' };
    if (error !== null) return Promise.resolve({ data: null, error });

    const updated: ProfileRow = {
      ...row,
      display_name: values.display_name,
      language: values.language,
      updated_at: stamp(),
    };
    rows.set(userId, updated);
    return Promise.resolve({ data: [slice(updated)], error: null });
  };

  return {
    upserts,
    updates,
    lookups,
    rowFor: (id) => rows.get(id),
    seed,
    writer,
    store,
    query,
    mutation,
  };
}

/* ========================================================================== */
/* The in-memory `conversations` table                                         */
/* ========================================================================== */

/**
 * Enough of a `conversations` table for the **real** `conversationStoreFrom()` to run against, so
 * the `.eq('user_id', …)` predicate that carries the identity into a thread is production's rather
 * than this file's. Same shape as the fake in `persistence.property.test.ts`, narrowed to the two
 * chains that module issues.
 */
interface ConversationsTable {
  readonly inserts: TablesInsert<'conversations'>[];
  readonly client: SupabaseClient<Database>;
}

function conversationsTable(): ConversationsTable {
  const rows: ConversationRow[] = [];
  const inserts: TablesInsert<'conversations'>[] = [];
  let minted = 0;

  const column = (row: ConversationRow, name: string): unknown =>
    (row as unknown as Record<string, unknown>)[name];

  const chain = (
    filters: { column: string; value: unknown }[],
  ): {
    eq: (column: string, value: unknown) => unknown;
    order: (column: string, options: { ascending: boolean }) => unknown;
    limit: (count: number) => unknown;
    maybeSingle: () => Promise<{ data: ConversationRow | null; error: null }>;
  } => {
    const self = {
      eq: (name: string, value: unknown) => {
        filters.push({ column: name, value });
        return self;
      },
      order: () => self,
      limit: () => self,
      maybeSingle: () => {
        const matched = rows.filter((row) =>
          filters.every((filter) => column(row, filter.column) === filter.value),
        );
        // `updated_at desc, id desc`, applied here only so the read is total; the predicates are
        // what this file asserts on.
        const ordered = [...matched].reverse();
        return Promise.resolve({ data: ordered[0] ?? null, error: null });
      },
    };
    return self;
  };

  const client = {
    from(table: string) {
      if (table !== 'conversations') {
        throw new Error(`the conversations table was asked for "${table}"`);
      }
      return {
        select: () => chain([]),
        insert(row: TablesInsert<'conversations'>) {
          inserts.push(row);
          minted += 1;
          const stored: ConversationRow = {
            id: `c0000000-0000-4000-8000-${String(minted).padStart(12, '0')}`,
            user_id: row.user_id,
            channel: row.channel,
            title: row.title ?? null,
            created_at: `2026-09-16T01:${String(minted).padStart(2, '0')}:00.000Z`,
            updated_at: `2026-09-16T01:${String(minted).padStart(2, '0')}:00.000Z`,
          };
          rows.push(stored);
          return {
            select: () => ({ single: () => Promise.resolve({ data: stored, error: null }) }),
          };
        },
      };
    },
  };

  return { inserts, client: client as unknown as SupabaseClient<Database> };
}

/* ========================================================================== */
/* Property 1                                                                  */
/* ========================================================================== */

describe('Property 1: identity round-trips across channels', () => {
  it('writes the E.164 phone once and resolves the same Profile from a wa_id, in every surface form', async () => {
    const authFormsSeen = new Set<AuthPhoneForm>();
    const waFormsSeen = new Set<WaIdForm>();
    const nameShapesSeen = new Set<NameShape>();
    const languagesSeen = new Set<Language>();
    const repeatsSeen = new Set<boolean>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { userId, decoyId, e164, authForm, waForm, nameShape, language } = scenario;

        authFormsSeen.add(authForm);
        waFormsSeen.add(waForm);
        nameShapesSeen.add(nameShape);
        languagesSeen.add(language);
        repeatsSeen.add(scenario.signsInAgain);

        const label = `${authForm} / ${waForm} / ${nameShape} / ${language}`;

        // The generated number really is a value the column would accept. Asserted rather than
        // assumed, because every clause below is about "a valid E.164 phone number".
        expect(E164_PHONE.test(e164), label).toBe(true);

        const table = profilesTable();
        const decoyPhone = decoyPhoneFor(e164);
        expect(decoyPhone, label).not.toBe(e164);
        table.seed({ id: decoyId, phone: decoyPhone, display_name: 'decoy', language: 'hi' });

        /* ================================================================== */
        /* 1. A first session produces the Profile (Requirement 1.4)           */
        /* ================================================================== */

        const authUser: AuthUserLike = { id: userId, phone: renderAuthPhone(e164, authForm) };
        const written = await ensureProfile(table.writer, authUser);

        // `id` equals the auth user id, `phone` equals the number **exactly** — not a re-rendering
        // of it, which is the clause the six surface forms exist to stress.
        expect(written, label).toStrictEqual({ id: userId, phone: e164 });

        const stored = table.rowFor(userId);
        expect(stored, label).toBeDefined();
        expect(stored?.id, label).toBe(userId);
        expect(stored?.phone, label).toBe(e164);

        // Requirement 1.5, first direction: the bootstrap owns `id` and `phone` and touches nothing
        // else. A payload carrying `display_name` or `language` would let a sign-in reset the
        // values the profile screen saves, and PostgREST builds `do update` from these keys.
        expect(table.upserts.map((row) => Object.keys(row).sort()), label).toStrictEqual([
          ['id', 'phone'],
        ]);

        /* ================================================================== */
        /* 2. The WhatsApp resolution finds that same Profile (Req 10.2)        */
        /* ================================================================== */

        const waId = renderWaId(e164, waForm);
        const resolved = await resolveProfileByPhone(waId, table.store);

        expect(resolved, `${label}: an inbound wa_id resolved to no Profile`).not.toBeNull();
        expect(resolved?.userId, label).toBe(userId);
        // Not the decoy — whose phone is in the same table, one digit away.
        expect(resolved?.userId, label).not.toBe(decoyId);

        // The central claim, made visible: the string the lookup asked the column for is the string
        // the bootstrap put in it. The two normalizers are separate copies of one convention, and
        // this is the assertion that fails if either drifts.
        expect(table.lookups, label).toStrictEqual([e164]);
        expect(normalizeInboundPhone(waId), label).toBe(toE164(authUser.phone));

        // A fresh farmer has the column default until the profile screen writes one.
        expect(resolved?.language, label).toBe(DEFAULT_LANGUAGE);

        /* ================================================================== */
        /* 3. Name and language round-trip (Requirement 1.8)                   */
        /* ================================================================== */

        const submitted = renderName(nameShape, scenario.nameSeed);
        const saved = await saveProfileSettings(table.mutation(userId), userId, {
          displayName: submitted,
          language,
        });

        // Trimmed, and a blank name becomes `null` rather than `''` — the two normalizations
        // `normalizeDisplayName()` documents. The expected value is computed here from the
        // submitted string rather than read back from the module, so a change of rule fails.
        const expectedName = submitted.trim() === '' ? null : submitted.trim();
        expect(saved, label).toStrictEqual({ displayName: expectedName, language });

        const readBack = await readProfileSettings(table.query(userId), userId);
        expect(readBack, label).toStrictEqual({ displayName: expectedName, language });

        // Requirement 1.5, other direction: the settings write carries exactly the two columns it
        // owns. `phone` or `id` here would let this screen overwrite the farmer's identity.
        expect(table.updates.map((row) => Object.keys(row).sort()), label).toStrictEqual([
          ['display_name', 'language'],
        ]);
        expect(table.rowFor(userId)?.phone, label).toBe(e164);

        /* ================================================================== */
        /* 4. The round trip survives the next sign-in                         */
        /* ================================================================== */

        if (scenario.signsInAgain) {
          const again = await ensureProfile(table.writer, authUser);
          expect(again, label).toStrictEqual({ id: userId, phone: e164 });

          // Idempotent: one row, same identity, and the settings from step 3 intact.
          expect(await readProfileSettings(table.query(userId), userId), label).toStrictEqual({
            displayName: expectedName,
            language,
          });
        }

        // And the WhatsApp side now reads the saved language — which is what makes "one identity"
        // mean "one set of preferences on both channels" rather than two accounts that agree.
        const resolvedAgain = await resolveProfileByPhone(renderWaId(e164, waForm), table.store);
        expect(resolvedAgain?.userId, label).toBe(userId);
        expect(resolvedAgain?.language, label).toBe(language);

        /* ================================================================== */
        /* 5. One identity, one thread per channel                             */
        /* ================================================================== */

        // The identity that came out of the phone lookup is the one a WhatsApp thread is opened
        // under, through the real `conversationStoreFrom()` adapter. Both channels' rows carry the
        // same `user_id` and are different rows — Requirement 1.5's "single Farmer identity for both
        // channels" at the point where the two channels first diverge. What a conversation *holds*
        // is Property 15's claim, not this one.
        const conversations = conversationsTable();
        const store = conversationStoreFrom(conversations.client);
        const userIdOf = resolved?.userId ?? '';

        const whatsappThread = await findOrCreateActive(userIdOf, 'whatsapp', store);
        const webThread = await findOrCreateActive(userIdOf, 'web', store);

        expect(whatsappThread.user_id, label).toBe(userId);
        expect(webThread.user_id, label).toBe(userId);
        expect(whatsappThread.channel, label).toBe('whatsapp');
        expect(webThread.channel, label).toBe('web');
        expect(whatsappThread.id, label).not.toBe(webThread.id);
        expect(
          conversations.inserts.every((row) => row.user_id === userId),
          label,
        ).toBe(true);

        // The same channel asked for twice finds the thread rather than minting a second one.
        const sameAgain = await findOrCreateActive(userIdOf, scenario.channel, store);
        expect(sameAgain.user_id, label).toBe(userId);
        expect(sameAgain.channel, label).toBe(scenario.channel);
      }),
      // Six auth forms × three wa_id forms × four name shapes is 72 combinations before the
      // language and the repeat flag; 400 runs reaches every one many times over, and the coverage
      // assertions below turn "reaches" into a fact rather than a probability.
      { numRuns: 400 },
    );

    expect([...authFormsSeen].sort()).toStrictEqual([...AUTH_PHONE_FORMS].sort());
    expect([...waFormsSeen].sort()).toStrictEqual([...WA_ID_FORMS].sort());
    expect([...nameShapesSeen].sort()).toStrictEqual([...NAME_SHAPES].sort());
    expect([...languagesSeen].sort()).toStrictEqual([...SUPPORTED_LANGUAGES].sort());
    expect([...repeatsSeen].sort()).toStrictEqual([false, true]);
  });

  /* ======================================================================== */
  /* The other direction: an identity is never invented                        */
  /* ======================================================================== */

  /**
   * "Whose phone equals that number exactly" has a second half: a value that is **not** a valid
   * E.164 number must not be repaired into one. `toE164()` restores a stripped `+` — which chooses
   * nothing — but inventing a country code would choose which country a farmer is in, and a wrong
   * number in the identity column misroutes the WhatsApp channel (Requirement 10.2).
   *
   * So: nothing is written, and the failure is a named, logged `AppError` rather than a row.
   */
  const UNUSABLE_KINDS = [
    'absent',
    'null',
    'empty',
    'separators_only',
    'too_short',
    'too_long',
    'leading_zero',
    'letters',
  ] as const;

  type UnusableKind = (typeof UNUSABLE_KINDS)[number];

  interface Unusable {
    readonly kind: UnusableKind;
    readonly phone: string | null | undefined;
  }

  const unusableArb: fc.Arbitrary<Unusable> = fc.oneof(
    fc.constant<Unusable>({ kind: 'absent', phone: undefined }),
    fc.constant<Unusable>({ kind: 'null', phone: null }),
    fc.constant<Unusable>({ kind: 'empty', phone: '' }),
    fc.constant<Unusable>({ kind: 'separators_only', phone: ' ()- ' }),
    // Seven digits: one short of E.164's minimum for this constraint.
    fc
      .array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 7 })
      .map((digits) => ({ kind: 'too_short' as const, phone: `+1${digits.join('')}`.slice(0, 8) })),
    fc
      .array(fc.integer({ min: 0, max: 9 }), { minLength: 15, maxLength: 20 })
      .map((digits) => ({ kind: 'too_long' as const, phone: `+1${digits.join('')}` })),
    fc
      .array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 13 })
      .map((digits) => ({ kind: 'leading_zero' as const, phone: `+0${digits.join('')}` })),
    fc
      .array(fc.integer({ min: 0, max: 9 }), { minLength: 7, maxLength: 12 })
      .map((digits) => ({ kind: 'letters' as const, phone: `+91X${digits.join('')}` })),
  );

  it('never writes a Profile for a phone the identity column would refuse', async () => {
    const kindsSeen = new Set<UnusableKind>();

    await fc.assert(
      fc.asyncProperty(userIdArb, unusableArb, async (userId, unusable) => {
        kindsSeen.add(unusable.kind);
        const label = `${unusable.kind}: ${String(unusable.phone)}`;

        // The premise: this really is a value the constraint refuses.
        expect(unusable.phone === null || unusable.phone === undefined || !E164_PHONE.test(unusable.phone), label).toBe(true);
        expect(toE164(unusable.phone), label).toBeNull();

        const table = profilesTable();
        const user: AuthUserLike =
          unusable.phone === undefined ? { id: userId } : { id: userId, phone: unusable.phone };

        await expect(ensureProfile(table.writer, user), label).rejects.toThrow();

        // Nothing was attempted and nothing exists: no upsert reached the table, so no invented
        // identity could have been written even by a table that accepted anything.
        expect(table.upserts, label).toStrictEqual([]);
        expect(table.rowFor(userId), label).toBeUndefined();

        // And the WhatsApp side agrees rather than resolving something: the same value that could
        // not be written cannot be looked up either, so Requirement 10.3's branch is what happens.
        if (unusable.phone !== null && unusable.phone !== undefined) {
          expect(normalizeInboundPhone(unusable.phone), label).toBeNull();
          expect(await resolveProfileByPhone(unusable.phone, table.store), label).toBeNull();
          expect(table.lookups, label).toStrictEqual([]);
        }
      }),
      { numRuns: 200 },
    );

    expect([...kindsSeen].sort()).toStrictEqual([...UNUSABLE_KINDS].sort());
  });
});
