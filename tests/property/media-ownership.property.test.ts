import { Buffer } from 'node:buffer';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { errorResponse, isAppError, type AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import type { Language, MediaRef, VerifiedCondition } from '@/lib/schemas';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import type { CounterRpc } from '@/services/quota.service';

/**
 * ### Property 5: Ownership is proven before anything is spent
 *
 * *"For any Media_Reference and any authenticated caller, analysis begins only if the
 * Data_Access_Layer confirms the reference names a GridFS file whose `metadata.kind` is the expected
 * kind and whose `metadata.ownerId` equals the caller's Auth_User_Id; otherwise the response is HTTP
 * 403, the caller's quota counter is unchanged, and no provider call is made. Because `fileId` is an
 * opaque GridFS id and the owner is read from the stored file metadata rather than from anything in
 * the reference, a caller cannot craft a reference into another farmer's data."*
 *
 * **Validates: Requirements 2.5, 2.6**
 *
 * =============================================================================
 * AMENDMENT A3 — THE OWNER CHECK MOVED FROM A PATH PREFIX TO GridFS METADATA
 * =============================================================================
 *
 * Under Supabase the gate was `assertOwnershipInBucket()`: it compared a storage path's first
 * segment against the caller's id and probed the bucket for the object. Under A3 there is no bucket
 * and no path — a Media_Reference is `{ fileId, kind }` where `fileId` is an OPAQUE 24-hex GridFS
 * `_id`, and the owner is `metadata.ownerId` on the stored file. The gate is step 1 of `diagnose()`:
 *
 * ```
 * const image = await readMedia(userId, input.image);   // readMediaBytesForOwner
 * if (image === null) throw new AppError('STORAGE_REF_FORBIDDEN', …);   // 403, before the reserve
 * ```
 *
 * `readMediaBytesForOwner(userId, ref)` scopes the GridFS lookup by `{ _id, 'metadata.ownerId' }`
 * (`src/lib/db/media.ts`), so a file owned by another farmer and a file that does not exist BOTH
 * return `null`, indistinguishably (Requirement 2.6) — and a caller cannot craft a reference into
 * another farmer's data, because the owner is read from the STORED metadata, never from the
 * reference. The service maps that one `null` to 403 `STORAGE_REF_FORBIDDEN` before the reserve, so
 * a foreign or missing image costs no quota unit and makes no provider call.
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED, AND WHY IT IS NOT THE ROUTE
 * =============================================================================
 *
 * The gate is at step 1 of `diagnose()` — ahead of the burst check, the reserve, and the
 * classification. `/api/diagnose` adds a session and an envelope on top; it holds no second copy of
 * the check. So the property is exercised through `diagnose()` with every seam injected, which keeps
 * this a unit-level run with no MongoDB, no GridFS, and no provider. `readMedia` is the injected
 * seam standing in for `readMediaBytesForOwner`: it returns the bytes for an OWNED reference and
 * `null` for a foreign/missing one, exactly as the owner-scoped GridFS read does.
 *
 * The HTTP half is still observed rather than assumed: the refusal's `AppError` is passed through
 * `errorResponse()` — the same function `withErrorHandling()` uses for every route — and the
 * resulting `Response.status` is asserted 403.
 *
 * =============================================================================
 * "NOTHING IS SPENT" IS COUNTED, NOT INFERRED
 * =============================================================================
 *
 * Every seam a spend could pass through is a counting stub, and each refused case asserts the count
 * is exactly zero:
 *
 *  - **`CounterRpc.tryIncrement`** — the only thing that takes a quota unit (`quota.service.ts`).
 *    `decrement` and `used` are counted too, because a refusal that reserved and then refunded would
 *    leave `tryIncrement` at one and is NOT what Requirement 2.6 asks for — it asks for unchanged.
 *  - **`CapabilityRunner.classify` / `.generate`** — the two provider calls a diagnosis can make.
 *  - **`DiagnosisStore.insertDiagnosis` / `.insertUsageLog`** — a refused-at-step-1 request writes
 *    no row at all: the ownership refusal throws before `log()` is ever called.
 *  - **`readMedia`** — counted to prove the gate ran exactly once, and that an owned reference is
 *    the one case where analysis proceeds.
 *
 * An "only if" claim needs both halves, so there are two properties: an unowned/missing reference is
 * refused and costs zero, and an owned one is accepted (the pipeline reaches exactly one provider
 * call and exactly one reserve). A gate that refused everything would satisfy the first alone.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CONDITION: VerifiedCondition = 'Tomato Early Blight';

const CONVERSATION_ID = '444444444444444444444444';
const DIAGNOSIS_ID = '555555555555555555555555';
const KNOWLEDGE_ID = '666666666666666666666666';

/** 2026-09-15T19:30:00Z is 2026-09-16T01:00 in Asia/Kolkata — the far side of the +05:30 offset. */
const NOW_MS = Date.parse('2026-09-15T19:30:00.000Z');

const KNOWLEDGE_ROW: KnowledgeEntry = {
  id: KNOWLEDGE_ID,
  disease_name: CONDITION,
  crop: 'tomato',
  scientific_name: null,
  symptoms: [`${CONDITION} symptom one`],
  causes: [`${CONDITION} cause one`],
  treatment: [`${CONDITION} treatment one`],
  prevention: [`${CONDITION} prevention one`],
  default_severity: 'moderate',
  source: `${CONDITION} extension bulletin`,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const CLASSIFICATION_JSON = JSON.stringify({
  status: 'identified',
  disease_name: CONDITION,
  confidence: 0.87,
  severity: 'moderate',
});

/* ========================================================================== */
/* Arbitraries                                                                 */
/* ========================================================================== */

/** An Auth_User_Id, as the auth library assigns it (Better Auth ids are opaque strings). */
const farmerIdArb = fc
  .uuid()
  .map((uuid) => `user-${uuid}`);

/** Two *distinct* farmers, so a cross-tenant reference is really cross-tenant. */
const twoFarmersArb = fc.tuple(farmerIdArb, farmerIdArb).filter(([a, b]) => a !== b);

/** A 24-hex GridFS ObjectId, the wire shape of a Media_Reference `fileId`. */
const fileIdArb = fc
  .uuid()
  .map((uuid) => uuid.replace(/-/g, '').slice(0, 24).padEnd(24, '0'));

const languageArb = fc.constantFrom<Language>('en', 'hi', 'mr');
const channelArb = fc.constantFrom<'web' | 'telegram'>('web', 'telegram');

/** A `crop-image` Media_Reference for `fileId`. */
function cropRef(fileId: string): MediaRef {
  return { fileId, kind: 'crop-image' };
}

/**
 * The adversarial classes, enumerated so the run can prove it exercised every one — a `oneof` whose
 * branch never generated would leave its expectation green rather than absent.
 *
 * All of them resolve to the SAME `readMedia` answer under A3: `null`. That is the point of the
 * substrate change — there is no path shape to get wrong, no bucket to name, no traversal to smuggle.
 * The owner is metadata, so "another farmer's file" and "a file that does not exist" are one
 * indistinguishable refusal (Requirement 2.6). The classes below are the *situations* that produce
 * that `null`, kept distinct so coverage is a fact.
 */
const REFUSAL_KINDS = [
  /** The reference names a real file owned by ANOTHER farmer — `metadata.ownerId` mismatch. */
  'other_farmer_file',
  /** The reference names no file at all — a fabricated or already-deleted `fileId`. */
  'missing_file',
] as const;

type RefusalKind = (typeof REFUSAL_KINDS)[number];

/* ========================================================================== */
/* The seams, each one counting                                                */
/* ========================================================================== */

interface Tallies {
  /** The owner-scoped media read — the gate itself. */
  reads: number;
  /** The quota unit. */
  increments: number;
  decrements: number;
  used: number;
  /** The two provider calls. */
  classifies: number;
  generates: number;
  /** Persistence. */
  diagnosisRows: number;
  usageRows: number;
}

interface Harness {
  readonly deps: DiagnosisDeps;
  readonly tallies: Tallies;
}

/**
 * `options.ownedBytes` is non-null when the caller owns the referenced file (the gate lets analysis
 * through) and `null` for a foreign/missing one (the gate refuses). Everything a spend could pass
 * through is counted.
 */
function harness(options: { ownedBytes: Buffer | null }): Harness {
  const tallies: Tallies = {
    reads: 0,
    increments: 0,
    decrements: 0,
    used: 0,
    classifies: 0,
    generates: 0,
    diagnosisRows: 0,
    usageRows: 0,
  };

  const readMedia: NonNullable<DiagnosisDeps['readMedia']> = () => {
    tallies.reads += 1;
    return Promise.resolve(
      options.ownedBytes === null ? null : { bytes: options.ownedBytes, mimeType: 'image/jpeg' },
    );
  };

  const rpc: CounterRpc = {
    tryIncrement: () => {
      tallies.increments += 1;
      return Promise.resolve(1);
    },
    decrement: () => {
      tallies.decrements += 1;
      return Promise.resolve(0);
    },
    used: () => {
      tallies.used += 1;
      return Promise.resolve(0);
    },
  };

  const models: CapabilityRunner = {
    classify: () => {
      tallies.classifies += 1;
      return Promise.resolve({ value: CLASSIFICATION_JSON, provider: 'gemini' as const, usedFallback: false });
    },
    generate: () => {
      tallies.generates += 1;
      return Promise.resolve({
        value: `${CONDITION}: ${KNOWLEDGE_ROW.symptoms[0] ?? ''}`,
        provider: 'gemini' as const,
        usedFallback: false,
      });
    },
  };

  const store: DiagnosisStore = {
    insertDiagnosis: () => {
      tallies.diagnosisRows += 1;
      return Promise.resolve(DIAGNOSIS_ID);
    },
    insertUsageLog: () => {
      tallies.usageRows += 1;
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const conversations: ConversationStore = {
    mostRecent: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
    create: (userId, channel) => Promise.resolve(conversationFor(userId, channel)),
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(names.includes(CONDITION) ? [KNOWLEDGE_ROW] : []);

  return {
    tallies,
    deps: {
      store,
      conversations,
      knowledge,
      models,
      readMedia,
      quota: { rpc, now: new Date(NOW_MS) },
      now: () => NOW_MS,
      // `getDeadline()` answers `undefined` outside a platform invocation; stating it keeps the run
      // independent of whether `@vercel/functions` happens to be inside one.
      platformDeadline: () => undefined,
    },
  };
}

function conversationFor(userId: string, channel: Conversation['channel']): Conversation {
  return {
    id: CONVERSATION_ID,
    user_id: userId,
    channel,
    title: null,
    created_at: '2026-09-16T00:59:00.000Z',
    updated_at: '2026-09-16T00:59:00.000Z',
  };
}

/** The `AppError` a refusal must be. Anything else — including success — fails the property. */
async function refusalOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('the reference was accepted; Property 5 requires a refusal');
}

/* ========================================================================== */
/* Property 5, first direction: an unowned/missing reference is refused, zero  */
/* ========================================================================== */

describe('Property 5: ownership is proven before anything is spent', () => {
  it('refuses every unowned or missing reference with 403, spending no unit and calling no provider', async () => {
    const exercised = new Set<RefusalKind>();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<RefusalKind>(...REFUSAL_KINDS),
        twoFarmersArb,
        fileIdArb,
        languageArb,
        channelArb,
        async (kind, [caller], fileId, language, channel) => {
          exercised.add(kind);

          // Both classes are the same `readMedia` answer under A3: `null`. `other_farmer_file` is a
          // real file whose `metadata.ownerId` is not the caller's — the owner-scoped read simply
          // does not match it; `missing_file` names no file. The store cannot tell them apart, and
          // neither can a caller (Requirement 2.6).
          const test = harness({ ownedBytes: null });

          const error = await refusalOf(
            diagnose({ userId: caller, image: cropRef(fileId), language, channel }, test.deps),
          );

          // The refusal, and the HTTP status a route would send. `errorResponse()` is the function
          // `withErrorHandling()` calls, so this is the real status.
          expect(error.code, kind).toBe('STORAGE_REF_FORBIDDEN');
          expect(error.status, kind).toBe(403);
          expect(errorResponse(error, language).status, kind).toBe(403);

          // Requirement 2.6 — the quota counter is unchanged. Not reserved-then-refunded: untouched,
          // in all three directions it can be touched.
          expect(test.tallies.increments, kind).toBe(0);
          expect(test.tallies.decrements, kind).toBe(0);
          expect(test.tallies.used, kind).toBe(0);

          // Requirement 2.5 — analysis never began. Neither provider call was attempted.
          expect(test.tallies.classifies, kind).toBe(0);
          expect(test.tallies.generates, kind).toBe(0);

          // A refused request persists nothing — no diagnosis row, and no audit row: the ownership
          // refusal throws before the pipeline reaches a step that writes one.
          expect(test.tallies.diagnosisRows, kind).toBe(0);
          expect(test.tallies.usageRows, kind).toBe(0);

          // The gate ran exactly once — the owner-scoped read is the single ownership check.
          expect(test.tallies.reads, kind).toBe(1);
        },
      ),
      { numRuns: 300 },
    );

    expect([...exercised].sort()).toStrictEqual([...REFUSAL_KINDS].sort());
  });

  /* ======================================================================== */
  /* Second direction: an owned reference is accepted                          */
  /* ======================================================================== */

  it('accepts a reference the caller owns, spending exactly one unit and one provider call', async () => {
    await fc.assert(
      fc.asyncProperty(
        farmerIdArb,
        fileIdArb,
        languageArb,
        channelArb,
        async (caller, fileId, language, channel) => {
          const test = harness({ ownedBytes: Buffer.from('a-real-owned-image') });

          const outcome = await diagnose(
            { userId: caller, image: cropRef(fileId), language, channel },
            test.deps,
          );

          // Analysis began: the gate let it through and the pipeline ran to a result.
          expect(outcome.result.status).toBe('identified');
          expect(test.tallies.reads).toBe(1);

          // Exactly one unit, never handed back — and exactly one classification attempt, which is
          // the other half of "only if": a gate that refused an owned reference would spend none.
          expect(test.tallies.increments).toBe(1);
          expect(test.tallies.decrements).toBe(0);
          expect(test.tallies.classifies).toBe(1);

          // The reference that was proven owned is the one that got persisted.
          expect(test.tallies.diagnosisRows).toBe(1);
          expect(test.tallies.usageRows).toBe(1);
        },
      ),
    );
  });
});
