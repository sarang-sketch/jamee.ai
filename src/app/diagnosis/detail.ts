import type { DiagnosisDoc } from '@/lib/db/collections';
import type { DiagnosisRecord, FarmerReads, MessageRecord } from '@/lib/db/reads';
import { mediaUrl } from '@/lib/media/url';
import type {
  Channel,
  InputKind,
  KnowledgePayload,
  Language,
  MessageRole,
  Severity,
  VerifiedCondition,
} from '@/lib/schemas';
import { QUOTA_TIME_ZONE } from '@/lib/time';

/**
 * Everything the diagnosis detail screen decides, separated from how it renders.
 *
 * Requirements: 12.3 (the detail view carries the crop image, the reported condition or the
 *               inconclusive label, the confidence value, the Severity_Value, the full
 *               explanation, and the related Conversation messages), 12.5 (a stored image or
 *               thumbnail is loaded through the Media_Endpoint, Amendment A3), 12.8 / 12.9 / 12.10
 *               (which image, and what to say when it is gone), 12.11 (every remaining field still
 *               renders), 6.5 (an inconclusive result carries no disease name and no treatment
 *               content), 9.4 (the Canonical_Disease_Name is never translated)
 * Design: "Media lifecycle and retention"; "Frontend" — `diagnosis/[id]/page.tsx`; D17, D18,
 *          Amendment A3 (the browser reads a file through the Media_Endpoint, not a Signed_URL)
 *
 * ### Why this is a module and not the page body
 *
 * Three of the four decisions here are worth asserting directly, and none needs React to be true:
 * which of the row's two shapes it is, which image to read, and how a confidence value reads to a
 * farmer. An `async` server component is not a unit-testable function — so the page awaits two
 * reads and hands the documents to `toDiagnosisDetail` / `resolveDetailImage`, and `detail.test.ts`
 * covers the branches without a request, a cookie store, or a database.
 *
 * It lives in `src/app/diagnosis/` rather than `src/lib/` because nothing outside this screen
 * consumes it, and because `[id]/` is a dynamic-segment directory whose brackets are a character
 * class to a glob — the test runner's `src/**` pattern reaches this path without that hazard.
 *
 * =============================================================================
 * AMENDMENT A3 — THE DATA_ACCESS_LAYER AND THE MEDIA_ENDPOINT REPLACE THE RETIRED STORE
 * =============================================================================
 *
 * The retired design took PostgREST select strings and a storage client, minted a
 * Signed_URL, derived the thumbnail path by convention and probed storage for presence. Under A3
 * there is neither PostgREST nor a separate object store: the page reads the diagnosis and its
 * messages through the owner-scoped Data_Access_Layer, so this module takes the layer's DOCUMENTS,
 * and the image is the constant `/api/media/<fileId>` from `mediaUrl` (no minting, no expiry, no
 * probe). Thumbnail presence is a stored link — the derivative's `metadata.sourceRef` — resolved by
 * `FarmerReads.thumbnailFileIdFor`, not a derived path plus an `exists()` call.
 */

/* ========================================================================== */
/* How many messages the thread renders                                        */
/* ========================================================================== */

/**
 * How many messages of the conversation the detail view renders, newest-first at the read and
 * chronological on the page.
 *
 * Requirement 12.3 says "the related Conversation messages" and does not bound them, but a
 * conversation is one long-running thread per farmer per channel (`conversation.service.ts`), so
 * the row count grows without limit while the screen's usefulness does not. At 50 chat messages a
 * day (Requirement 14.1) this is several days of continuous conversation, and the messages a farmer
 * came back for are the recent ones — so the bound drops the oldest rather than truncating the end
 * a farmer is reading toward. `CHAT_MESSAGE_LIMIT` in `ChatThread.tsx` happens to carry the same
 * number for its own screen; they are separate bounds on separate reads.
 */
export const DETAIL_MESSAGE_LIMIT = 200;

/* ========================================================================== */
/* The message view row                                                        */
/* ========================================================================== */

/**
 * One conversation message as the detail thread renders it — an Amendment A3 view row, mapped from
 * a `MessageDoc` by the page. `transcriptOf` stays out: a reference to a recording this screen
 * never loads has no business in a page's props.
 */
export interface DiagnosisMessageRow {
  id: string;
  role: MessageRole;
  content: string;
  language: Language;
  inputKind: InputKind;
  /** ISO-8601 — `messages.createdAt` rendered by `formatTimestamp`. */
  createdAt: string;
}

/** Map a Data_Access_Layer message document to the detail thread's view row. */
export function toDiagnosisMessageRow(doc: MessageRecord): DiagnosisMessageRow {
  return {
    id: doc._id.toHexString(),
    role: doc.role,
    content: doc.content,
    language: doc.language,
    inputKind: doc.inputKind,
    createdAt: doc.createdAt.toISOString(),
  };
}

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
 * function exists at all rather than the page reading `doc.diseaseName` directly:
 *
 *  - `diseaseName: null` and `confidence: null` are *literal* `null` on the inconclusive branch,
 *    so `detail.diseaseName.toUpperCase()` and `formatConfidence(detail.confidence)` are compile
 *    errors there. The rejected model's name and confidence were discarded when the row was
 *    written (`diagnoses_unknown_shape`); this keeps them un-renderable too.
 *  - `knowledge: null` on the inconclusive branch means **the compiler refuses treatment text for
 *    an inconclusive result.**
 *
 * `knowledge` is `KnowledgePayload | null` on the *identified* branch rather than required, because
 * the row and the knowledge base are two reads: a deployment whose seed has not run returns
 * `{ found: false }` from `lookupCondition`, and Requirement 12.11 still wants every other field.
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
 * A `diagnoses` document as the screen sees it, or `null` when the row contradicts its own status.
 *
 * `null` rather than a thrown error, and rather than a cast. The setup validator makes an
 * identified row without a `diseaseName` unwritable, so reaching that branch means the database and
 * this code disagree about the shape of a row — and the honest answer to "show me a row Jamee
 * cannot interpret" is the same 404 as "show me a row that is not yours" (the page calls
 * `notFound()` on both).
 */
export function toDiagnosisDetail(
  doc: DiagnosisRecord,
  knowledge: KnowledgePayload | null,
): DiagnosisDetail | null {
  const common: DiagnosisDetailCommon = {
    id: doc._id.toHexString(),
    conversationId: doc.conversationId.toHexString(),
    severity: doc.severity,
    explanation: doc.explanation,
    language: doc.language,
    channel: doc.channel,
    createdAt: doc.createdAt.toISOString(),
    needsExpert: doc.needsExpert,
  };

  if (doc.status === 'unknown') {
    // Requirement 6.5. The row cannot carry these (`diagnoses_unknown_shape`), and pinning them to
    // `null` here is what stops the render from reintroducing them.
    if ((doc.diseaseName ?? null) !== null || (doc.confidence ?? null) !== null) return null;
    return { ...common, status: 'unknown', diseaseName: null, confidence: null, knowledge: null };
  }

  if ((doc.diseaseName ?? null) === null || (doc.confidence ?? null) === null) return null;

  return {
    ...common,
    status: 'identified',
    diseaseName: doc.diseaseName as VerifiedCondition,
    confidence: doc.confidence as number,
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

/**
 * Resolve the one image this screen shows, **preferring the Full_Size_Image** (Requirement 12.8).
 *
 * ### The order, and what each step is allowed to conclude — the opposite of the history list
 *
 * The list prefers the thumbnail (Requirement 12.6, a storage-budget rule for 20 rows at once);
 * the detail view prefers the original (Requirement 12.8), because this is where a farmer looks
 * closely at a lesion. Both share the primitive — `mediaUrl(fileId)`, the one spelling of
 * `/api/media/<fileId>`.
 *
 * 1. **`fullImageDeletedAt == null` ⇒ the original is present.** A `diagnoses` document exists only
 *    because an upload succeeded, and this column is the sweep's own record of whether the original
 *    was later deleted (Requirement 18.7). Absent stamp ⇒ present original ⇒ its URL. No probe: the
 *    Media_Endpoint is the one owner check, and a URL to a file that briefly cannot be read degrades
 *    to that endpoint's answer rather than to a fourth state here.
 * 2. **Swept original ⇒ fall back to the Thumbnail_Derivative** (Requirement 12.9), resolved by its
 *    stored `metadata.sourceRef` link (`thumbnailFileIdFor`), owner-scoped. A thumbnail is never
 *    deleted (Requirement 18.5), so it can survive the original.
 * 3. **No thumbnail either ⇒ no image** (Requirement 12.10). A Telegram-originated diagnosis never
 *    had one (the derivative is produced in the browser), and a web upload whose thumbnail failed
 *    after the original succeeded (Requirement 2.14) lands here too once the original is swept.
 */
export async function resolveDetailImage(
  doc: Pick<DiagnosisDoc, 'mediaRef' | 'fullImageDeletedAt'>,
  reads: Pick<FarmerReads, 'thumbnailFileIdFor'>,
): Promise<DetailImage> {
  const fullImageFileId = doc.mediaRef.fileId.toHexString();

  /** Requirement 12.8 — the original is present unless the sweep stamped it gone. */
  if (doc.fullImageDeletedAt === null || doc.fullImageDeletedAt === undefined) {
    return { kind: 'full', url: mediaUrl(fullImageFileId) };
  }

  /** Requirement 12.9 — the original is gone by policy; the derivative may survive it. */
  const thumbnailFileId = await reads.thumbnailFileIdFor(fullImageFileId);
  if (thumbnailFileId !== null) {
    return { kind: 'thumbnail', url: mediaUrl(thumbnailFileId) };
  }

  /** Requirement 12.10 — neither survives. */
  return { kind: 'none' };
}

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

/**
 * A stored confidence — `0` to `1` — as a whole-number percentage.
 *
 * A percentage rather than `0.87`, because a farmer reads "87%" and does not read a decimal
 * fraction. Rounded to a whole number for the same reason. Deliberately **not**
 * `Intl.NumberFormat`: its percent style inserts locale-specific spacing and can select a
 * non-Latin numbering system, and a plain `%` is what the three catalogs' own numeric copy uses.
 *
 * The clamp is not defensive noise: `confidence` is validated `between 0 and 1`, so a value outside
 * it means a caller passed something that is not a stored confidence, and reading "1400%" would be
 * worse than "100%".
 */
export function formatConfidence(confidence: number): string {
  const clamped = Math.min(1, Math.max(0, confidence));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * A stored instant as a date and time a farmer can place, in Asia/Kolkata.
 *
 * The zone is `QUOTA_TIME_ZONE` from `time.ts` rather than a second literal — Jamee has one answer
 * to "what clock is a farmer on". A server render has no access to the browser's zone, so a fixed
 * regional zone is the honest choice over UTC. `language` picks the locale so month names and digit
 * order follow the text around them. An unparseable value returns the input unchanged: a detail
 * view is not the place to fail over a timestamp (Requirement 12.11).
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
 * whether an image *should* be gone; it reads whether it *is* — `fullImageDeletedAt` is the record
 * of what actually happened (Requirement 18.7).
 *
 * **No `DiagnosisResult` construction.** Building the domain union from a row would re-validate
 * stored content through `diagnosisResultSchema`, whose `knowledge` field is required on the
 * identified branch — turning an unseeded knowledge base into a render failure instead of a screen
 * missing its grounded sections. The union above carries the guarantee that matters
 * (`knowledge: null` on the inconclusive branch) without making the knowledge read load-bearing.
 */
