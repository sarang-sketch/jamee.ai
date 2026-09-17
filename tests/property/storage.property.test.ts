import type { SupabaseClient } from '@supabase/supabase-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapabilityRunner } from '@/lib/ai/capabilities';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/config/verified';
import { errorResponse, isAppError, type AppError } from '@/lib/errors';
import type { KnowledgeEntry, KnowledgeReader } from '@/lib/knowledge';
import type { Language, StorageRef, VerifiedCondition } from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';
import type { Conversation, ConversationStore } from '@/services/conversation.service';
import { diagnose, type DiagnosisDeps, type DiagnosisStore } from '@/services/diagnosis.service';
import type { CounterRpc } from '@/services/quota.service';
import type { Database, DiagnosisRow, TablesInsert } from '@/types/database';

/**
 * ### Property 5: Ownership is proven before anything is spent
 *
 * *"For any storage reference and any authenticated caller, analysis begins only if the reference
 * names the expected bucket and its first path segment equals the caller's user id; otherwise the
 * response is HTTP 403, the caller's quota counter is unchanged, and no provider call is made."*
 *
 * **Validates: Requirements 2.5, 2.6**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED, AND WHY IT IS NOT THE ROUTE
 * =============================================================================
 *
 * The gate is `assertOwnershipInBucket()` (`src/lib/storage.ts`) called from **step 1** of
 * `diagnose()` — ahead of the burst check, the reserve, the signed URL, and the classification.
 * `/api/diagnose` adds a session and an envelope on top; it holds no second copy of the check. So
 * the property is exercised through `diagnose()` with every seam injected, which is what keeps this
 * a unit-level run with no Supabase stack, no provider, and no clock of its own.
 *
 * The HTTP half of the statement is still observed rather than assumed: the refusal's `AppError` is
 * passed through `errorResponse()` — the same function `withErrorHandling()` uses for every route —
 * and the resulting `Response.status` is asserted. A refusal that carried the wrong status would
 * fail here even though no route ran.
 *
 * =============================================================================
 * "NOTHING IS SPENT" IS COUNTED, NOT INFERRED
 * =============================================================================
 *
 * Every seam a spend could pass through is a counting stub, and each refused case asserts the count
 * is exactly zero:
 *
 *  - **`CounterRpc.tryIncrement`** — the only thing in Jamee that takes a quota unit
 *    (`quota.service.ts`). `decrement` and `used` are counted too, because a refusal that reserved
 *    and then refunded would leave `tryIncrement` at one and is *not* what Requirement 2.6 asks for.
 *  - **`CapabilityRunner.classify` / `.generate`** — the two provider calls a diagnosis can make.
 *  - **`DiagnosisStore.insertDiagnosis` / `.insertUsageLog`** — a refused request writes no row.
 *  - **`storage.exists`** — counted for a different reason: `assertOwnership()` compares the prefix
 *    *before* it probes, so a cross-tenant reference must never reach the network at all. On the
 *    service-role client the probe bypasses RLS, and confirming another farmer's object exists
 *    before refusing to act on it would be a worse gate that still returned 403.
 *
 * =============================================================================
 * BOTH DIRECTIONS, AND ONE DISCREPANCY WITH THE DESIGN SENTENCE
 * =============================================================================
 *
 * An "only if" claim needs both halves, so there are two properties: unowned references are
 * refused, and owned ones are accepted (the pipeline reaches exactly one provider call and exactly
 * one reserve). A gate that refused everything would satisfy the first alone.
 *
 * The design says the refusal is HTTP 403 for every reference that fails the gate. The
 * implementation splits that into two codes, and this file asserts the exact code per class rather
 * than a union of them:
 *
 *  - **403 `STORAGE_REF_FORBIDDEN`** for the classes Requirement 2.6 names — another bucket,
 *    another farmer's prefix — plus a conforming path under the caller's own prefix that resolves to
 *    no object, which `storage.ts` documents as the same conjunctive failure of Requirement 2.5.
 *  - **400 `STORAGE_REF_INVALID`** for a reference whose *shape* is not Jamee's path convention:
 *    traversal segments, no owner segment, an empty path. Requirement 2.2 owns that code, and
 *    `storage.ts` orders the schema re-parse first precisely so the prefix comparison can trust that
 *    a first segment exists.
 *
 * That split is a strengthening, not a gap, and one generated case shows why the design sentence
 * needs it: `{caller}/../{other}/2026/09/{uuid}.jpg` has a first path segment that **equals the
 * caller's user id** and names the expected bucket, so the design's literal predicate would let
 * analysis begin on it. The schema refuses it instead. Both classes are refusals, both spend zero,
 * and every case below asserts which one it is.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const CROP_IMAGES = STORAGE_BUCKETS.cropImages;
const CONDITION: VerifiedCondition = 'Tomato Early Blight';

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';
const KNOWLEDGE_ID = '66666666-6666-4666-8666-666666666666';

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

/**
 * A farmer id, in the alphabet `storageRefSchema` accepts for a path's first segment
 * (`[0-9a-f-]{36}`). `auth.users.id` is a real uuid, so this is the same value space the ownership
 * comparison sees in production rather than a widened one.
 */
const farmerIdArb = fc.uuid();

/**
 * Two *distinct* farmers. The filter is what makes the cross-tenant cases actually cross-tenant: a
 * generated pair that collided would turn "another farmer's prefix" into the caller's own and assert
 * a refusal against a reference that ought to be accepted.
 */
const twoFarmersArb = fc.tuple(farmerIdArb, farmerIdArb).filter(([a, b]) => a !== b);

const yearArb = fc.integer({ min: 2024, max: 2099 }).map(String);
const monthArb = fc.integer({ min: 1, max: 12 }).map((month) => String(month).padStart(2, '0'));

/** The four extensions `imageMimeTypeOf()` maps onto an `ACCEPTED_IMAGE_TYPES` member. */
const extensionArb = fc.constantFrom('jpg', 'jpeg', 'png', 'webp');

const languageArb = fc.constantFrom<Language>('en', 'hi', 'mr');
const channelArb = fc.constantFrom<'web' | 'whatsapp'>('web', 'whatsapp');

interface PathParts {
  readonly owner: string;
  readonly year: string;
  readonly month: string;
  readonly objectId: string;
  readonly extension: string;
}

/** `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` — the one convention `buildStorageRef()` emits. */
function conformingPath(parts: PathParts): string {
  return `${parts.owner}/${parts.year}/${parts.month}/${parts.objectId}.${parts.extension}`;
}

const pathPartsArb = fc.record({
  year: yearArb,
  month: monthArb,
  objectId: farmerIdArb,
  extension: extensionArb,
});

/* -------------------------------------------------------------------------- */
/* The refused classes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The adversarial classes, enumerated so the run can prove it exercised every one of them.
 *
 * A property over a `oneof` can pass while one branch never generates, and then a mis-stated
 * expectation for that branch is green rather than absent. The predicate records the kind it saw and
 * the test asserts the set afterwards, which turns "these classes are covered" into an assertion.
 */
const REFUSAL_KINDS = [
  'other_farmer_prefix',
  'other_bucket',
  'unknown_bucket',
  'traversal_under_caller',
  'traversal_under_other',
  'absent_owner_segment',
  'empty_path',
  'root_slash_path',
  'prefix_only_path',
  'object_absent',
] as const;

type RefusalKind = (typeof REFUSAL_KINDS)[number];

interface Refusal {
  readonly kind: RefusalKind;
  /** Which class this is, so a shrunk counterexample names itself. */
  readonly label: string;
  /** The authenticated caller. */
  readonly caller: string;
  /** The reference the caller submitted. */
  readonly ref: StorageRef;
  /** What the storage probe would answer, if it were ever reached. */
  readonly objectPresent: boolean;
  readonly expectedCode: 'STORAGE_REF_FORBIDDEN' | 'STORAGE_REF_INVALID';
  readonly expectedStatus: 400 | 403;
  /** How many times `exists()` may be called before the refusal. */
  readonly expectedProbes: 0 | 1;
}

/** Requirement 2.6, first clause: the reference resolves under a different farmer's prefix. */
const otherFarmerPrefixArb: fc.Arbitrary<Refusal> = fc
  .record({ farmers: twoFarmersArb, parts: pathPartsArb })
  .map(({ farmers, parts }) => {
    const [caller, other] = farmers;
    return {
      kind: 'other_farmer_prefix',
      label: 'another farmer’s prefix',
      caller,
      ref: { bucket: CROP_IMAGES, path: conformingPath({ ...parts, owner: other }) },
      // Present in the bucket, and it makes no difference: the prefix comparison refuses first.
      objectPresent: true,
      expectedCode: 'STORAGE_REF_FORBIDDEN',
      expectedStatus: 403,
      expectedProbes: 0,
    } satisfies Refusal;
  });

/**
 * Requirement 2.6, second clause: the reference names another bucket.
 *
 * `voice-messages` is the *real* other bucket and the interesting one — the path is well-formed and
 * sits under the caller's own prefix, so nothing but the bucket is wrong.
 */
const otherBucketArb: fc.Arbitrary<Refusal> = fc
  .record({ caller: farmerIdArb, parts: pathPartsArb })
  .map(({ caller, parts }) => ({
    kind: 'other_bucket' as const,
    label: 'the caller’s own prefix in the wrong bucket',
    caller,
    ref: {
      bucket: STORAGE_BUCKETS.voiceMessages,
      path: conformingPath({ ...parts, owner: caller }),
    },
    objectPresent: true,
    expectedCode: 'STORAGE_REF_FORBIDDEN',
    expectedStatus: 403,
    expectedProbes: 0,
  }));

/**
 * A bucket name outside the two Jamee has.
 *
 * `diagnoseRequestSchema` would refuse this at the edge, which is exactly why it is worth generating
 * here: `assertOwnershipInBucket()` is the service-level half of the same gate (its own header calls
 * this defence in depth), and a service reached from anywhere other than that route still has to
 * refuse it. The cast is deliberate — the point is a value the type system says cannot arrive.
 */
const unknownBucketArb: fc.Arbitrary<Refusal> = fc
  .record({
    caller: farmerIdArb,
    parts: pathPartsArb,
    bucket: fc.constantFrom('crop-images-public', 'CROP-IMAGES', 'public', 'crop_images', ''),
  })
  .map(({ caller, parts, bucket }) => ({
    kind: 'unknown_bucket' as const,
    label: `a bucket outside the two Jamee has: "${bucket}"`,
    caller,
    ref: {
      bucket: bucket as StorageBucket,
      path: conformingPath({ ...parts, owner: caller }),
    },
    objectPresent: true,
    expectedCode: 'STORAGE_REF_FORBIDDEN',
    expectedStatus: 403,
    expectedProbes: 0,
  }));

/**
 * Traversal segments, generated in **both** directions.
 *
 * `underCaller` is the case that shows why the schema re-parse has to run before the prefix
 * comparison: its first path segment *is* the caller's user id, so the design's literal predicate
 * would admit it. It is refused as a malformed reference instead (400, Requirement 2.2), and no unit
 * is spent either way.
 */
const traversalArb: fc.Arbitrary<Refusal> = fc
  .record({
    farmers: twoFarmersArb,
    parts: pathPartsArb,
    underCaller: fc.boolean(),
  })
  .map(({ farmers, parts, underCaller }) => {
    const [caller, other] = farmers;
    const [first, second] = underCaller ? [caller, other] : [other, caller];
    return {
      kind: underCaller ? 'traversal_under_caller' : 'traversal_under_other',
      label: `traversal segments, first segment ${underCaller ? 'is' : 'is not'} the caller`,
      caller,
      ref: {
        bucket: CROP_IMAGES,
        path: `${first}/../${conformingPath({ ...parts, owner: second })}`,
      },
      objectPresent: true,
      expectedCode: 'STORAGE_REF_INVALID',
      expectedStatus: 400,
      expectedProbes: 0,
    } satisfies Refusal;
  });

/** No owner segment at all — the date folders sit at the root of the bucket. */
const absentPrefixArb: fc.Arbitrary<Refusal> = fc
  .record({ caller: farmerIdArb, parts: pathPartsArb })
  .map(({ caller, parts }) => ({
    kind: 'absent_owner_segment' as const,
    label: 'no owner segment',
    caller,
    ref: {
      bucket: CROP_IMAGES,
      path: `${parts.year}/${parts.month}/${parts.objectId}.${parts.extension}`,
    },
    objectPresent: true,
    expectedCode: 'STORAGE_REF_INVALID',
    expectedStatus: 400,
    expectedProbes: 0,
  }));

/** An empty path, and the near-misses around it: a bare prefix, a bare slash. */
const emptyPathArb: fc.Arbitrary<Refusal> = fc
  .record({
    caller: farmerIdArb,
    shape: fc.constantFrom<RefusalKind>('empty_path', 'root_slash_path', 'prefix_only_path'),
  })
  .map(({ caller, shape }) => {
    const path = shape === 'empty_path' ? '' : shape === 'root_slash_path' ? '/' : `${caller}/`;
    return {
      kind: shape,
      label: `an empty or truncated path: "${path}"`,
      caller,
      ref: { bucket: CROP_IMAGES, path },
      objectPresent: true,
      expectedCode: 'STORAGE_REF_INVALID',
      expectedStatus: 400,
      expectedProbes: 0,
    } satisfies Refusal;
  });

/**
 * A conforming path under the caller's **own** prefix that resolves to nothing.
 *
 * Requirement 2.5 is one conjunctive gate — the expected bucket *and* an object owned by the
 * requesting farmer — so a reference that names no object fails it as squarely as a cross-tenant
 * one, and `storage.ts` collapses both onto 403 rather than building an existence oracle. This is
 * the one refused class where the probe is *expected* to run, which is why `expectedProbes` is a
 * per-case fact rather than a constant.
 */
const objectAbsentArb: fc.Arbitrary<Refusal> = fc
  .record({ caller: farmerIdArb, parts: pathPartsArb })
  .map(({ caller, parts }) => ({
    kind: 'object_absent' as const,
    label: 'the caller’s own prefix, but no such object',
    caller,
    ref: { bucket: CROP_IMAGES, path: conformingPath({ ...parts, owner: caller }) },
    objectPresent: false,
    expectedCode: 'STORAGE_REF_FORBIDDEN',
    expectedStatus: 403,
    expectedProbes: 1,
  }));

const refusalArb: fc.Arbitrary<Refusal> = fc.oneof(
  otherFarmerPrefixArb,
  otherBucketArb,
  unknownBucketArb,
  traversalArb,
  absentPrefixArb,
  emptyPathArb,
  objectAbsentArb,
);

/* ========================================================================== */
/* The seams, each one counting                                                */
/* ========================================================================== */

interface Tallies {
  /** The quota unit. */
  increments: number;
  decrements: number;
  reads: number;
  /** The two provider calls. */
  classifies: number;
  generates: number;
  /** The storage probe, and the signed URL that only a proven-owned reference gets. */
  probes: number;
  signings: number;
  /** Persistence. */
  diagnosisRows: number;
  usageRows: number;
}

/**
 * A tripwire, not a stand-in. Every seam is injected below, so a read of the request client means
 * the service reached past its dependencies — which would make every count above meaningless.
 */
const unreachableSupabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `the request client was used (read of "${String(property)}"); every seam must be injected`,
      );
    },
  },
) as unknown as SupabaseClient<Database>;

interface Harness {
  readonly deps: DiagnosisDeps;
  readonly tallies: Tallies;
}

function harness(options: { objectPresent: boolean }): Harness {
  const tallies: Tallies = {
    increments: 0,
    decrements: 0,
    reads: 0,
    classifies: 0,
    generates: 0,
    probes: 0,
    signings: 0,
    diagnosisRows: 0,
    usageRows: 0,
  };

  const storage: StorageClientLike = {
    storage: {
      from: () => ({
        exists: () => {
          tallies.probes += 1;
          return Promise.resolve({ data: options.objectPresent, error: null });
        },
        createSignedUrl: (path: string) => {
          tallies.signings += 1;
          return Promise.resolve({
            data: { signedUrl: `https://storage.test/${path}?token=abc` },
            error: null,
          });
        },
      }),
    },
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
      tallies.reads += 1;
      return Promise.resolve(0);
    },
  };

  const models: CapabilityRunner = {
    classify: () => {
      tallies.classifies += 1;
      return Promise.resolve({
        value: CLASSIFICATION_JSON,
        provider: 'gemini' as const,
        usedFallback: false,
      });
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
    insertDiagnosis: (row: TablesInsert<'diagnoses'>) => {
      tallies.diagnosisRows += 1;
      const stored: DiagnosisRow = {
        id: DIAGNOSIS_ID,
        user_id: row.user_id,
        conversation_id: row.conversation_id,
        status: row.status,
        disease_name: row.disease_name ?? null,
        knowledge_id: row.knowledge_id ?? null,
        confidence: row.confidence ?? null,
        severity: row.severity,
        explanation: row.explanation,
        language: row.language,
        needs_expert: row.needs_expert ?? false,
        channel: row.channel,
        image_bucket: row.image_bucket,
        image_path: row.image_path,
        full_image_deleted_at: null,
        model_provider: row.model_provider,
        created_at: '2026-09-16T01:00:00.000Z',
      };
      return Promise.resolve(stored);
    },
    insertUsageLog: () => {
      tallies.usageRows += 1;
      return Promise.resolve();
    },
    ownsConversation: () => Promise.resolve(true),
  };

  const conversations: ConversationStore = {
    mostRecent: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
    create: (userId: string, channel: Conversation['channel']) =>
      Promise.resolve(conversationFor(userId, channel)),
  };

  const knowledge: KnowledgeReader = (names) =>
    Promise.resolve(names.includes(CONDITION) ? [KNOWLEDGE_ROW] : []);

  return {
    tallies,
    deps: {
      supabase: unreachableSupabase,
      storage,
      store,
      conversations,
      knowledge,
      models,
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
/* Property 5, first direction: an unowned reference is refused, and costs zero */
/* ========================================================================== */

describe('Property 5: ownership is proven before anything is spent', () => {
  it('refuses every unowned reference with the coded status, spending no unit and calling no provider', async () => {
    const exercised = new Set<RefusalKind>();

    await fc.assert(
      fc.asyncProperty(
        refusalArb,
        languageArb,
        channelArb,
        async (refusal, language, channel) => {
          exercised.add(refusal.kind);
          const test = harness({ objectPresent: refusal.objectPresent });

          const error = await refusalOf(
            diagnose(
              { userId: refusal.caller, storageRef: refusal.ref, language, channel },
              test.deps,
            ),
          );

          // The refusal itself, and the HTTP status a route would send for it. `errorResponse()` is
          // the function `withErrorHandling()` calls, so this is the real status rather than a
          // restatement of the taxonomy table.
          expect(error.code, refusal.label).toBe(refusal.expectedCode);
          expect(error.status, refusal.label).toBe(refusal.expectedStatus);
          expect(errorResponse(error, language).status, refusal.label).toBe(refusal.expectedStatus);

          // Requirement 2.6 — the quota counter is unchanged. Not "reserved then refunded":
          // untouched, in all three directions the counter can be touched.
          expect(test.tallies.increments, refusal.label).toBe(0);
          expect(test.tallies.decrements, refusal.label).toBe(0);
          expect(test.tallies.reads, refusal.label).toBe(0);

          // Requirement 2.5 — analysis never began. Neither provider call was attempted, and no
          // signed URL was minted for a reference whose ownership was not proven.
          expect(test.tallies.classifies, refusal.label).toBe(0);
          expect(test.tallies.generates, refusal.label).toBe(0);
          expect(test.tallies.signings, refusal.label).toBe(0);

          // A refused request persists nothing — no diagnosis row, and no audit row either: the
          // ordered pipeline has not reached a step that writes one.
          expect(test.tallies.diagnosisRows, refusal.label).toBe(0);
          expect(test.tallies.usageRows, refusal.label).toBe(0);

          // The prefix comparison precedes the probe, so a cross-tenant or malformed reference
          // never reaches storage at all.
          expect(test.tallies.probes, refusal.label).toBe(refusal.expectedProbes);
        },
      ),
      // 300 runs over seven branches, so every adversarial class below is reached many times over
      // rather than probably. The coverage assertion after this call is what makes that a fact.
      { numRuns: 300 },
    );

    expect([...exercised].sort()).toStrictEqual([...REFUSAL_KINDS].sort());
  });

  /* ======================================================================== */
  /* Second direction: an owned reference is accepted                          */
  /* ======================================================================== */

  it('accepts a reference under the caller’s own prefix, spending exactly one unit and one provider call', async () => {
    await fc.assert(
      fc.asyncProperty(
        farmerIdArb,
        pathPartsArb,
        languageArb,
        channelArb,
        async (caller, parts, language, channel) => {
          const ref: StorageRef = {
            bucket: CROP_IMAGES,
            path: conformingPath({ ...parts, owner: caller }),
          };
          const test = harness({ objectPresent: true });

          const outcome = await diagnose(
            { userId: caller, storageRef: ref, language, channel },
            test.deps,
          );

          // Analysis began: the gate let it through and the pipeline ran to a result.
          expect(outcome.result.status).toBe('identified');
          expect(test.tallies.probes).toBe(1);
          expect(test.tallies.signings).toBe(1);

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
