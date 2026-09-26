import 'server-only';

import { Buffer } from 'node:buffer';

import { ObjectId, type WithId } from 'mongodb';

import type { DiagnosisDoc, MediaRefDoc } from '@/lib/db/collections';
import { farmerData } from '@/lib/db/farmer';
import { fetchMediaForOwner } from '@/lib/media';
import type {
  Channel,
  Language,
  MediaRef,
  ModelProvider,
  Severity,
  VerifiedCondition,
} from '@/lib/schemas';

/**
 * The Data_Access_Layer accessor the photo-and-voice flow persists a Diagnosis_Result through, and
 * the owner-checked read of a crop image or a voice recording's bytes for an inline model send.
 *
 * Requirements: 2.5, 2.6 (a file's bytes are read only by the Farmer who owns it, proven before
 *               anything is spent), 2.8 (the image bytes reach the model — now inline, from GridFS),
 *               3.3 (the Diagnosis_Result is persisted with farmer, conversation, the Media_Reference
 *               and channel), 12.5 (the owner-checked read the history views use)
 * Design: D17 (one GridFS bucket, `metadata.kind` + `metadata.ownerId`), D18 (this module lives in
 *         `src/lib/db/**`, the only place the driver and the raw handle are reachable), Amendment A3
 *         (analysis reads bytes from GridFS and sends them inline rather than by URL); V29, V34
 *
 * =============================================================================
 * WHY THIS MODULE, AND WHY IT IS SMALL
 * =============================================================================
 *
 * `diagnosis.service.ts` and `voice.service.ts` must not touch `src/lib/db/farmer.ts` (owned by
 * another wave) and must not import the driver or `src/lib/db/client` (forbidden outside
 * `src/lib/db/**` by `npm run check:data-access`). So the new persistence and media accessors the
 * photo/voice flow needs live HERE, in a new `src/lib/db` module, built on the exported `owned()` /
 * `stampOwner()` discipline via `farmerData()` — every read merges the owner, every insert stamps
 * it, and no accessor accepts an owner override.
 *
 * The read path is a thin owner-scoped wrapper over `fetchMediaForOwner` (`src/lib/media`), which
 * itself delegates to the GridFS store's owner-scoped read: a file owned by another farmer and a
 * file that does not exist both return `null`, indistinguishably (Requirement 2.6). The service
 * maps that single `null` to the A3 taxonomy code for a forbidden/absent reference **before the
 * reserve**, so a foreign or missing image costs no quota unit.
 */

/** The stored Diagnosis_Result, as the analysis pipeline hands it in — minus the fields the layer stamps. */
export interface DiagnosisInsert {
  readonly conversationId: string;
  readonly status: 'identified' | 'unknown';
  /** Present only when identified; `null` on the inconclusive branch (never absent — 6.5). */
  readonly diseaseName: VerifiedCondition | null;
  readonly knowledgeId: string | null;
  readonly confidence: number | null;
  readonly severity: Severity;
  readonly explanation: string;
  readonly language: Language;
  readonly needsExpert: boolean;
  readonly channel: Channel;
  /** The Full_Size_Image in GridFS (D17). */
  readonly mediaRef: MediaRef;
  readonly modelProvider: ModelProvider;
}

/**
 * The two operations the analysis persistence half needs, bound to one farmer. A pair of functions
 * rather than a raw collection handle, so a service cannot express an unscoped write — the owner is
 * merged and stamped inside, exactly as every other Data_Access_Layer accessor.
 */
export interface AnalysisData {
  readonly ownerId: string;
  /** Requirement 3.3. Returns the stored diagnosis id (hex string) — the response and audit need it. */
  insertDiagnosis(doc: DiagnosisInsert): Promise<string>;
  /**
   * Whether a client-supplied conversation id is this farmer's — the D18-scoped check that keeps a
   * diagnosis (Requirement 2.2 permits a client-supplied `conversationId`) from being attached to
   * another farmer's thread. `farmerData(ownerId).findOneConversation` merges the owner into the
   * filter, so a foreign or non-existent id both read as "not owned". An unparseable id (not a
   * 24-hex ObjectId) is `false` without a lookup.
   */
  ownsConversation(conversationId: string): Promise<boolean>;
}

/** A Media_Reference (`{ fileId hex, kind }`) as it is stored on a document (`fileId` an ObjectId). */
function toMediaRefDoc(ref: MediaRef): MediaRefDoc {
  return { fileId: new ObjectId(ref.fileId), kind: ref.kind };
}

/**
 * Bind the analysis accessors to one Auth_User_Id. Every write goes through `farmerData(ownerId)`,
 * which merges and stamps the owner — so this module holds no unscoped seam.
 */
export function analysisData(ownerId: string): AnalysisData {
  return {
    ownerId,
    async insertDiagnosis(doc) {
      const stored: WithId<DiagnosisDoc> = await farmerData(ownerId).insertDiagnosis({
        conversationId: new ObjectId(doc.conversationId),
        status: doc.status,
        diseaseName: doc.diseaseName,
        knowledgeId: doc.knowledgeId === null ? null : new ObjectId(doc.knowledgeId),
        confidence: doc.confidence,
        severity: doc.severity,
        explanation: doc.explanation,
        language: doc.language,
        needsExpert: doc.needsExpert,
        channel: doc.channel,
        mediaRef: toMediaRefDoc(doc.mediaRef),
        fullImageDeletedAt: null,
        modelProvider: doc.modelProvider,
      });
      return stored._id.toString();
    },
    async ownsConversation(conversationId) {
      if (!ObjectId.isValid(conversationId)) return false;
      const found = await farmerData(ownerId).findOneConversation({
        _id: new ObjectId(conversationId),
      });
      return found !== null;
    },
  };
}

/**
 * What an owner-checked media read returns to a service: the bytes plus the MIME type the model
 * needs, or `null` when the caller does not own the file OR it does not exist — the store makes
 * those indistinguishable (Requirement 2.6) and this preserves that.
 */
export interface OwnedMediaBytes {
  readonly bytes: Buffer;
  readonly mimeType: string;
}

/**
 * Read a media file's bytes for the Farmer who owns it, by Media_Reference. Returns `null` for a
 * stranger's file and for a missing one alike — the caller maps that single `null` to the taxonomy
 * code for a forbidden reference, before spending anything.
 *
 * The `kind` on the reference is validated by the request schema and refined per endpoint upstream;
 * this read is by `fileId` + owner, so a reference whose `kind` mismatched the stored file's `kind`
 * still only reads a file this farmer owns.
 */
export async function readMediaBytesForOwner(
  ownerId: string,
  ref: MediaRef,
): Promise<OwnedMediaBytes | null> {
  const found = await fetchMediaForOwner(ownerId, ref.fileId);
  if (found === null) return null;
  return { bytes: found.bytes, mimeType: found.mimeType };
}
