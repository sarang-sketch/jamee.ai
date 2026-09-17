import { QUOTA_TIME_ZONE } from '@/lib/time';
import {
  signedUrlOrNull,
  thumbRefFor,
  type StorageClientLike,
} from '@/lib/storage';
import type {
  Channel,
  KnowledgePayload,
  Language,
  Severity,
  StorageRef,
  VerifiedCondition,
} from '@/lib/schemas';
import type { DiagnosisRow, MessageRow } from '@/types/database';

/**
 * Everything the diagnosis detail screen decides, separated from how it renders.
 *
 * Requirements: 12.3 (the detail view carries the crop image, the reported condition or the
 *               inconclusive label, the confidence value, the Severity_Value, the full
 *               explanation, and the related Conversation messages), 12.5 (a stored image or
 *               thumbnail is loaded through a Signed_URL), 12.8 / 12.9 / 12.10 (which image, and
 *               what to say when it is gone), 12.11 (every remaining field still renders),
 *               6.5 (an inconclusive result carries no disease name and no treatment content),
 *               9.4 (the Canonical_Disease_Name is never translated)
 * Design: "Media lifecycle and retention"; "Frontend" — `diagnosis/[id]/page.tsx`
 *
 * ### Why this is a module and not the page body
 *
 * Three of the four decisions here are worth asserting directly, and none of them needs React to
 * be true: which of the row's two shapes it is, which image to read, and how a confidence value
 * reads to a farmer. An `async` server component is not a unit-testable function — so the page
 * awaits two queries and hands the rows to `toDiagnosisDetail`, and `detail.test.ts` covers the
 * branches without a request, a cookie store, or a Supabase client.
 *
 * It lives in `src/app/diagnosis/` rather than `src/lib/` because nothing outside this screen
 * consumes it, and because `[id]/` is a dynamic-segment directory whose brackets are a character
 * class to a glob — the test runner's `src/**` pattern reaches this path without that hazard.
 */

/* ========================================================================== */
/* The two reads, as column lists                                              */
/* ========================================================================== */

/**
 * The `diagnoses` columns this screen reads.
 *
 * Enumerated rather than `*` for the reason `profile.ts` gives about `PROFILE_SETTINGS_SELECT`:
 * PostgREST parses the select string at the **type** level, so this literal is what makes the row
 * type below checkable — and a screen that never selects `knowledge_id` or `model_provider`
 * cannot leak Jamee's internals into a rendered page.
 *
 * `full_image_deleted_at` is the load-bearing one. The design chose a column read over a storage
 * probe precisely so "deleted by policy" is distinguishable from "missing unexpectedly", and
 * Requirements 12.8–12.10 turn on that distinction.
 */
export const DIAGNOSIS_DETAIL_SELECT =
  'id, user_id, conversation_id, status, disease_name, confidence, severity, explanation, language, needs_expert, channel, image_bucket, image_path, full_image_deleted_at, created_at' as const;

export type DiagnosisDetailRow = Pick<
  DiagnosisRow,
  | 'id'
  | 'user_id'
  | 'conversation_id'
  | 'status'
  | 'disease_name'
  | 'confidence'
  | 'severity'
  | 'explanation'
  | 'language'
  | 'needs_expert'
  | 'channel'
  | 'image_bucket'
  | 'image_path'
  | 'full_image_deleted_at'
  | 'created_at'
>;

/**
 * The `messages` columns the thread needs. `transcript_of` is a storage path, so it stays out.
 *
 * `as const` for the same reason as above: PostgREST derives the row type from this literal, and
 * a widened `string` makes the call site stop compiling rather than silently returning `any`.
 */
export const DIAGNOSIS_MESSAGES_SELECT =
  'id, role, content, language, input_kind, created_at' as const;

export type DiagnosisMessageRow = Pick<
  MessageRow,
  'id' | 'role' | 'content' | 'language' | 'input_kind' | 'created_at'
>;

/**
 * How many messages of the conversation the detail view renders, newest-first at the read and
 * chronological on the page.
 *
 * Requirement 12.3 says "the related Conversation messages" and does not bound them, but a
 * WhatsApp conversation is one long-running thread per farmer (`conversation.service.ts`), so the
 * row count grows without limit while the screen's usefulness does not. At 50 chat messages a day
 * (Requirement 14.1) this is several days of continuous conversation, and the messages a farmer
 * came back for are the recent ones — so the bound drops the oldest rather than truncating the
 * end a farmer is reading toward.
 */
export const DETAIL_MESSAGE_LIMIT = 200;

/* ========================================================================== */
/* The view model — one discriminated union, mirroring `diagnosisResultSchema`  */
/* ========================================================================== */

interface DiagnosisDetailCommon {
  readonly id: string;
  readonly conversationId: string;
  readonly severity: Severity;
  /** Requirement 12.3's "full explanation": the stored, already-grounded, already-localized text. */
  readonly explanation: string;
  /** The language the explanation was written in, which is not necessarily today's selection. */
  readonly language: Language;
  readonly channel: Channel;
  readonly createdAt: string;
  readonly needsExpert: boolean;
}

/**
 * The detail view of one diagnosis, in the same two shapes the domain result takes.
 *
 * **The union is what enforces Requirement 6.5 at the UI layer**, and it is the reason this
 * function exists at all rather than the page reading `row.disease_name` directly:
 *
 *  - `diseaseName: null` and `confidence: null` are *literal* `null` on the inconclusive branch,
 *    so `detail.diseaseName.toUpperCase()` and `formatConfidence(detail.confidence)` are compile
 *    errors there. The rejected model's name and confidence were discarded when the row was
 *    written (`diagnoses_unknown_shape` in migration `0005`); this keeps them un-renderable too.
 *  - `knowledge: null` on the inconclusive branch means **the compiler refuses treatment text for
 *    an inconclusive result.** There is no cast that reaches it and no optional chain that
 *    survives it — `null` is not an empty payload, which is exactly the point `schemas.ts` makes
 *    about `inconclusiveResultSchema`.
 *
 * `knowledge` is `KnowledgePayload | null` on the *identified* branch rather than required,
 * because the row and the knowledge base are two reads: a deployment whose seed migration has not
 * run returns `{ found: false }` from `lookupCondition`, and Requirement 12.11 still wants every
 * other field on the screen. So a missing entry costs the grounded sections and nothing else.
 */
export type DiagnosisDetail =
  | (DiagnosisDetailCommon & {
      readonly status: 'identified';
      /** Canonical, Latin script, never translated (Requirements 4.6, 9.4). */
      readonly diseaseName: VerifiedCondition;
      readonly confidence: number;
      readonly knowledge: KnowledgePayload | null;
    })
  | (DiagnosisDetailCommon & {
      readonly status: 'unknown';
      readonly diseaseName: null;
      readonly confidence: null;
      readonly knowledge: null;
    });

/**
 * A `diagnoses` row as the screen sees it, or `null` when the row contradicts its own status.
 *
 * `null` rather than a thrown error, and rather than a cast. The two check constraints in
 * migration `0005` already make an identified row without a `disease_name` unwritable, so
 * reaching that branch means the database and this code disagree about the shape of a row — and
 * the honest answer to "show me a row Jamee cannot interpret" is the same 404 as "show me a row
 * that is not yours" (the page calls `notFound()` on both). Reporting it as a 500 would tell a
 * farmer Jamee is broken about a row nobody can act on; asserting past it with
 * `row.disease_name as VerifiedCondition` would put `null` on the screen where a condition name
 * belongs.
 *
 * `confidence` is checked the same way. It is `numeric(4,3)` and nullable, and Requirement 12.3
 * lists it as a field of the detail view, so an identified row that lost it is the same kind of
 * contradiction as one that lost its name.
 */
export function toDiagnosisDetail(
  row: DiagnosisDetailRow,
  knowledge: KnowledgePayload | null,
): DiagnosisDetail | null {
  const common: DiagnosisDetailCommon = {
    id: row.id,
    conversationId: row.conversation_id,
    severity: row.severity,
    explanation: row.explanation,
    language: row.language,
    channel: row.channel,
    createdAt: row.created_at,
    needsExpert: row.needs_expert,
  };

  if (row.status === 'unknown') {
    // Requirement 6.5. The row cannot carry these (`diagnoses_unknown_shape`), and pinning them
    // to `null` here is what stops the render from reintroducing them.
    if (row.disease_name !== null || row.confidence !== null) return null;
    return { ...common, status: 'unknown', diseaseName: null, confidence: null, knowledge: null };
  }

  if (row.disease_name === null || row.confidence === null) return null;

  return {
    ...common,
    status: 'identified',
    diseaseName: row.disease_name,
    confidence: row.confidence,
    knowledge,
  };
}

/* ========================================================================== */
/* Which image to show (Requirements 12.5, 12.8, 12.9, 12.10)                  */
/* ========================================================================== */

/**
 * The three states Requirements 12.8, 12.9 and 12.10 enumerate, and nothing else.
 *
 * `kind` carries the copy decision rather than a boolean pair, so a caller cannot render a
 * thumbnail without the sentence that explains why it is small, or omit an image without saying
 * the photo is gone.
 */
export type DetailImage =
  /** 12.8 — the Full_Size_Image is present. */
  | { readonly kind: 'full'; readonly url: string }
  /** 12.9 — the original is absent, the Thumbnail_Derivative survives. */
  | { readonly kind: 'thumbnail'; readonly url: string }
  /** 12.10 — neither derivative is present. */
  | { readonly kind: 'none' };

type ImageRowFields = Pick<
  DiagnosisDetailRow,
  'image_bucket' | 'image_path' | 'full_image_deleted_at'
>;

/**
 * Resolve the one image this screen shows, preferring the full-size original.
 *
 * ### The order, and what each step is allowed to conclude
 *
 * 1. **`full_image_deleted_at !== null` skips the original entirely.** The sweep stamped it
 *    (Requirement 18.7), so the object is gone by policy and probing for it would be a round trip
 *    spent confirming what the row already states. This is the column read the design chose over
 *    a probe.
 * 2. **Otherwise the original is probed, then signed.** The probe is `exists()`, whose three-way
 *    behaviour `storage.ts` documents against the pinned SDK. It is here because
 *    `createSignedUrl` signs a *path*: V3 does not say it fails for a missing object, and a URL
 *    minted over nothing renders as a broken-image icon instead of Requirement 12.10's sentence.
 *    One probe per detail render is affordable — the design's objection to probing was about
 *    paying it per row on the history *list*.
 * 3. **The thumbnail is the fallback, and it is derived, never stored.** `thumbRefFor()` is the
 *    single source of that convention (Requirement 2.13), which is why `image_path` is left
 *    intact after the sweep.
 * 4. **Absent thumbnail is a real, ordinary state.** A WhatsApp-originated diagnosis never had
 *    one — the derivative is produced in the browser (Requirement 2.13) — so past the retention
 *    window those entries land on 12.10 rather than on 12.9. The same is true for a web upload
 *    whose thumbnail upload failed after the original succeeded (Requirement 2.14).
 *
 * A signing failure while the row says the object is present collapses into the absent branch, on
 * the same reasoning `signedUrlOrNull` gives for returning `null`: the view's question is "can
 * this be shown", and it already has honest copy for "no". The alternative would be a fourth
 * state with a fourth sentence in three catalogs, for a transport failure a reload fixes.
 */
export async function resolveDetailImage(
  row: ImageRowFields,
  client: StorageClientLike,
): Promise<DetailImage> {
  const original: StorageRef = { bucket: row.image_bucket, path: row.image_path };

  if (row.full_image_deleted_at === null && (await objectExists(original, client))) {
    const url = await signedUrlOrNull(original, client);
    if (url !== null) return { kind: 'full', url };
  }

  const thumbnail = thumbnailRefOrNull(original);
  if (thumbnail !== null && (await objectExists(thumbnail, client))) {
    const url = await signedUrlOrNull(thumbnail, client);
    if (url !== null) return { kind: 'thumbnail', url };
  }

  return { kind: 'none' };
}

/**
 * `thumbRefFor` throws on a path with no extension, which every stored path has by
 * `storageRefSchema`. A row that somehow does not is a corrupt row, not a reason to fail the
 * render — it simply has no derivable thumbnail, which is Requirement 12.10's state.
 */
function thumbnailRefOrNull(ref: StorageRef): StorageRef | null {
  try {
    return thumbRefFor(ref);
  } catch {
    return null;
  }
}

/**
 * Present, as far as the storage service will say.
 *
 * `{ data: false }` is what the pinned SDK returns for 400 and 404, so absence arrives as a value
 * rather than as a throw. Anything that does throw — a transport failure, a misconfigured policy —
 * is not evidence of presence either, and this view has copy for absence, so it is reported as
 * absent rather than escalated. `assertOwnership()` in `storage.ts` makes the opposite choice for
 * the same call, because there a failed probe must not be reported as "you do not own this".
 */
async function objectExists(ref: StorageRef, client: StorageClientLike): Promise<boolean> {
  try {
    const { data } = await client.storage.from(ref.bucket).exists(ref.path);
    return data;
  } catch {
    return false;
  }
}

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

/**
 * A stored confidence — `numeric(4,3)`, so `0` to `1` — as a whole-number percentage.
 *
 * A percentage rather than `0.87`, because a farmer reads "87%" and does not read a decimal
 * fraction. Rounded to a whole number for the same reason: the third decimal place of a model's
 * self-reported confidence is not information, and printing it would suggest it is.
 *
 * Deliberately **not** `Intl.NumberFormat`. Its percent style inserts locale-specific spacing and
 * can select a non-Latin numbering system, and this string is rendered on the server for a farmer
 * whose locale Jamee tracks as a *language* choice, not a formatting one. A plain `%` is what the
 * three catalogs' own numeric copy already uses.
 *
 * The clamp is not defensive noise about the database: `diagnoses.confidence` has a
 * `between 0 and 1` check, so a value outside it means a caller passed something that is not a
 * stored confidence, and reading "1400%" as a confidence would be worse than reading "100%".
 */
export function formatConfidence(confidence: number): string {
  const clamped = Math.min(1, Math.max(0, confidence));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * A stored `timestamptz` as a date and time a farmer can place, in Asia/Kolkata.
 *
 * The zone is `QUOTA_TIME_ZONE` from `time.ts` rather than a second literal — not because a
 * rendered date participates in quota accounting (it does not), but because Jamee has exactly one
 * answer to "what clock is a farmer on", and two spellings of `Asia/Kolkata` would be two answers.
 * A server render has no access to the browser's zone, so a fixed regional zone is the honest
 * choice over UTC, which would show a 5.5-hour-old timestamp as the wrong day after 18:30 local.
 *
 * `language` picks the locale so month names and digit order follow the text around them. An
 * unparseable value returns the input unchanged: a detail view is not the place to fail over a
 * timestamp, and Requirement 12.11's "present every remaining field" applies to the rest of the
 * screen regardless.
 */
export function formatTimestamp(iso: string, language: Language): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: QUOTA_TIME_ZONE,
  }).format(parsed);
}

/**
 * ### What is deliberately NOT here
 *
 * **No retention arithmetic, and no import of `MEDIA_RETENTION_DAYS`.** The screen never computes
 * whether an image *should* be gone; it reads whether it *is*. A view that recomputed the cutoff
 * would disagree with the sweep the first time the constant changed, and the row's
 * `full_image_deleted_at` is the record of what actually happened (Requirement 18.7). The window
 * lives in `src/lib/config/media.ts`, which is where a reader should go for it.
 *
 * **No `DiagnosisResult` construction.** Building the domain union from a row would mean
 * re-validating stored content through `diagnosisResultSchema`, and its `knowledge` field is
 * required on the identified branch — which would turn an unseeded knowledge base into a render
 * failure instead of a screen missing its grounded sections. The union above carries the same
 * guarantee for the field that matters (`knowledge: null` on the inconclusive branch) without
 * making the knowledge read load-bearing.
 */
