import 'server-only';

import { GridFSBucket, ObjectId, type Collection, type Filter, type WithId } from 'mongodb';

import { getDb } from '@/lib/db/client';
import {
  COLLECTIONS,
  MEDIA_BUCKET,
  type ConversationDoc,
  type DiagnosisDoc,
  type DiseaseKnowledgeDoc,
  type MediaKind,
  type MessageDoc,
} from '@/lib/db/collections';
import { farmerData, owned } from '@/lib/db/farmer';
import type { Channel, InputKind, Language, MessageRole, VerifiedCondition } from '@/lib/schemas';

/**
 * Records as callers outside `src/lib/db/**` see them — the stored document with its `_id`. Aliased
 * and re-exported here because `scripts/check-data-access.ts` forbids importing the `mongodb` driver
 * (including its `WithId` type and `ObjectId`) anywhere but `src/lib/db/**` (D18). A screen or
 * service that needs "a diagnosis as stored" imports this type from the layer rather than the
 * driver's `WithId<DiagnosisDoc>`.
 */
export type DiagnosisRecord = WithId<DiagnosisDoc>;
export type MessageRecord = WithId<MessageDoc>;
export type DiseaseKnowledgeRecord = WithId<DiseaseKnowledgeDoc>;

/**
 * Whether a caller-supplied id is a valid ObjectId hex string, without the caller importing the
 * driver. Screens use it to answer "is this a well-formed diagnosis id" before a read — a `false`
 * is the same 404 as a miss (an ill-formed id names no row).
 */
export function isValidObjectId(id: string): boolean {
  return ObjectId.isValid(id);
}

/**
 * The Data_Access_Layer's READ accessors for the screen and chat-context paths — the reads that
 * `src/lib/db/farmer.ts` does not already expose in exactly the shape a reader needs, plus the ONE
 * read of a collection that belongs to no farmer.
 *
 * Requirements: 7.1, 7.2 (Conversation_Context is the recent messages of one conversation, keyed on
 *               the conversation identifier and scoped to the owning Farmer), 12.1, 12.2 (a Farmer's
 *               own Diagnosis_Results, newest first, both channels), 12.3 (the detail view's one
 *               diagnosis and its conversation's messages), 13.1, 13.2 (every farmer read carries
 *               the owning Auth_User_Id), 4.1, 4.3, 13.3, 13.4 (the five Verified_Conditions are a
 *               read-only base with no farmer and no write path)
 * Design: D18 (this module is inside `src/lib/db/**`, so it is one of the few files allowed to hold
 *         the driver; every farmer read merges the bound owner through `owned()` from `farmer.ts`,
 *         and the knowledge read is a deliberate, greppable no-owner exception), D17
 *
 * =============================================================================
 * WHY A SECOND READ MODULE BESIDE `farmer.ts`, AND WHAT KEEPS IT SCOPED
 * =============================================================================
 *
 * `farmerData(userId)` in `farmer.ts` already binds an owner and exposes `findDiagnoses`,
 * `findOneDiagnosis` and `findMessages`. Those serve the write-side services perfectly, but two of
 * the read paths this task ports need a shape the bundle does not offer:
 *
 *  - the history list needs the newest `HISTORY_PAGE_SIZE` diagnoses — a `limit` the sort-only
 *    `findDiagnoses` accessor does not take; and
 *  - the chat context and the detail thread need the newest N messages of ONE conversation, ordered
 *    to a total tiebreak so the token trim and the transcript reverse are repeatable.
 *
 * So this module adds those bounded, ordered reads. It does NOT reintroduce a `find(arbitraryFilter)`
 * seam — the defect D18 makes unexpressible: every farmer read here takes its filter WITHOUT an
 * owner field and merges `owned(userId, …)` itself, exactly as `farmer.ts` does, and the owner is
 * bound by `farmerReads(userId)` and cannot be widened by a caller's filter (the spread puts
 * `ownerId` last). The reads are by `_id`, by `conversationId`, and newest-first with a cap, and
 * nothing accepts a raw filter.
 *
 * =============================================================================
 * THE KNOWLEDGE BASE BELONGS TO NO FARMER — SO ITS ACCESSOR HAS NO OWNER, AND NO WRITE
 * =============================================================================
 *
 * `disease_knowledge` holds exactly the five Verified_Conditions (Requirement 4.1). It carries no
 * `ownerId` — there is nothing farmer-specific in it — so the owner-merge discipline the rest of
 * this module follows cannot apply and would be meaningless if it did. `knowledgeReads()` is
 * therefore a NAMED no-owner accessor, in the spirit of the system accessors in `farmer.ts`: an
 * unscoped read is a deliberate, documented exception rather than an accident, and it is safe for
 * exactly the reason the discipline exists — the table holds no tenant data, so a read of it cannot
 * cross a tenant boundary.
 *
 * It exposes a read and NOTHING ELSE. There is deliberately no insert, update or delete on this
 * accessor: Requirement 13.4 makes the knowledge base read-only to the application, writable only
 * by the setup script's seed (`src/lib/db/setup.ts`, which owns the driver for that one job). A
 * write path here would be a second way to change agronomic content a farmer reads, which is the one
 * thing the single-seed discipline exists to prevent.
 */

/* ========================================================================== */
/* Typed collection handles — internal                                         */
/* ========================================================================== */

function diagnoses(): Collection<DiagnosisDoc> {
  return getDb().collection<DiagnosisDoc>(COLLECTIONS.diagnoses);
}
function messages(): Collection<MessageDoc> {
  return getDb().collection<MessageDoc>(COLLECTIONS.messages);
}
function conversations(): Collection<ConversationDoc> {
  return getDb().collection<ConversationDoc>(COLLECTIONS.conversations);
}
function diseaseKnowledge(): Collection<DiseaseKnowledgeDoc> {
  return getDb().collection<DiseaseKnowledgeDoc>(COLLECTIONS.diseaseKnowledge);
}

/** Coerce a caller-supplied id to an `ObjectId`, or `null` when it is not a valid one. */
function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

/* ========================================================================== */
/* The farmer-scoped read bundle                                               */
/* ========================================================================== */

export interface FarmerReads {
  readonly ownerId: string;

  /**
   * The Farmer's own diagnoses, newest first, capped at `limit` (Requirements 12.1, 12.2).
   *
   * No channel filter — that absence IS Requirement 12.2: a `telegram` diagnosis and a `web` one
   * are both this owner's rows, so both are returned. Ordered `createdAt` desc with `_id` desc as
   * the total tiebreak, served by the `owner_recent` index (`setup.ts`).
   */
  listDiagnoses(limit: number): Promise<WithId<DiagnosisDoc>[]>;

  /**
   * ONE diagnosis of this Farmer, by id — or `null` when it is not theirs, does not exist, or the
   * id does not parse. All three are indistinguishable on purpose (Requirement 12.3's 404 over a
   * 403): the owner is part of the filter, so another farmer's row simply does not match, and a
   * caller cannot use this to learn that an id names a real diagnosis belonging to someone.
   */
  findDiagnosis(id: string): Promise<WithId<DiagnosisDoc> | null>;

  /**
   * The newest `limit` messages of ONE conversation this Farmer owns, newest first (Requirements
   * 7.1, 7.2, 12.3).
   *
   * Both predicates are load-bearing: `conversationId` is Requirement 7.2's key, and the merged
   * `ownerId` is the tenant boundary. The order is `createdAt` desc, then `role` desc (so a farmer
   * message and its answer sharing an instant reverse to question-then-answer), then `_id` desc as
   * the total tiebreak — the same order the retired PostgREST read used, so the token trim and the
   * transcript reverse are repeatable. Served by `owner_conversation_recent`.
   *
   * A `conversationId` that does not parse yields an empty list rather than throwing: an unparseable
   * id names no conversation, which is the same answer as one that is not the Farmer's.
   */
  conversationMessages(conversationId: string, limit: number): Promise<WithId<MessageDoc>[]>;

  /**
   * The `_id` (as a hex string) of the Thumbnail_Derivative whose source is `fullImageFileId`, or
   * `null` when this Farmer has no such thumbnail (a Telegram-originated diagnosis never had one —
   * the derivative is produced in the browser; a web upload whose thumbnail upload failed after the
   * original succeeded; a row written before the media-lifecycle amendment).
   *
   * Owner-scoped: the GridFS `files` filter carries `metadata.ownerId`, so a stranger's thumbnail
   * never matches (Requirement 2.6). This is how the history list and the detail view honour
   * Requirement 12.6 without the diagnosis document storing a second reference — the derivative's
   * `metadata.sourceRef` is the explicit stored link that replaced the retired `.thumb`-path
   * convention (Requirement 2.13, Amendment A3).
   */
  thumbnailFileIdFor(fullImageFileId: string): Promise<string | null>;
}

/**
 * Bind the read accessors to one owning Auth_User_Id.
 *
 * The owner is merged into every filter through `owned()` — the SAME single merge point `farmer.ts`
 * uses — so a caller cannot express an unscoped read, and a caller who tried to pass their own
 * `ownerId` in a filter cannot override the bound one.
 */
export function farmerReads(ownerId: string): FarmerReads {
  return {
    ownerId,

    async listDiagnoses(limit) {
      return diagnoses()
        .find(owned<DiagnosisDoc>(ownerId, {}))
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
    },

    async findDiagnosis(id) {
      const objectId = toObjectId(id);
      if (objectId === null) return null;
      return diagnoses().findOne(owned<DiagnosisDoc>(ownerId, { _id: objectId } as Filter<DiagnosisDoc>));
    },

    async conversationMessages(conversationId, limit) {
      const objectId = toObjectId(conversationId);
      if (objectId === null) return [];
      return messages()
        .find(owned<MessageDoc>(ownerId, { conversationId: objectId } as Filter<MessageDoc>))
        .sort({ createdAt: -1, role: -1, _id: -1 })
        .limit(limit)
        .toArray();
    },

    async thumbnailFileIdFor(fullImageFileId) {
      const sourceId = toObjectId(fullImageFileId);
      if (sourceId === null) return null;
      /**
       * The Thumbnail_Derivative is a GridFS file in the one media bucket, told apart by
       * `metadata.kind='thumbnail'` and linked to its Full_Size_Image by `metadata.sourceRef`
       * (Amendment A3, Requirement 2.13). The owner is part of the filter — `metadata.ownerId` —
       * so a stranger's thumbnail never matches (Requirement 2.6). A projection of `_id` only,
       * because the caller needs the id to build `mediaUrl(fileId)` and nothing else.
       *
       * The driver types a `GridFSBucket.find` filter over `media.files`, whose documents carry
       * the open `metadata` sub-document; the filter is written against the dotted metadata keys
       * the media store stamps in `src/lib/db/media.ts`.
       */
      const files = new GridFSBucket(getDb(), { bucketName: MEDIA_BUCKET });
      const doc = await files
        .find({
          'metadata.kind': 'thumbnail',
          'metadata.ownerId': ownerId,
          'metadata.sourceRef': sourceId,
        })
        .limit(1)
        .project({ _id: 1 })
        .toArray();

      const found = doc[0];
      return found === undefined ? null : (found._id as ObjectId).toHexString();
    },
  };
}

/* ========================================================================== */
/* Conversation ownership — used by the chat write path's ownership check       */
/* ========================================================================== */

/**
 * Whether `conversationId` is a conversation this Farmer owns.
 *
 * Owner-scoped by construction: the filter carries the bound owner, so another farmer's
 * conversation simply does not match. An unparseable id is "not yours" (`false`). This is the read
 * the chat turn's step-1 ownership check is built on — a farmer must not be able to append their
 * question, and Jamee's answer, to another farmer's thread.
 */
export async function conversationBelongsTo(conversationId: string, ownerId: string): Promise<boolean> {
  const objectId = toObjectId(conversationId);
  if (objectId === null) return false;
  const found = await conversations().findOne(
    owned<ConversationDoc>(ownerId, { _id: objectId } as Filter<ConversationDoc>),
    { projection: { _id: 1 } },
  );
  return found !== null;
}

/**
 * Bump one conversation's `updatedAt` to now — the activity marker `conversation.service.ts`'s
 * find-or-create ordering depends on (Requirement 7.4, D-note "bumping it belongs to the code that
 * persists a message"). Owner-scoped: the filter carries the bound owner through `owned()`, so a
 * farmer cannot touch another farmer's thread.
 *
 * This is the one WRITE in this module, and it is here rather than in `farmer.ts` because it is the
 * accessor the chat write path needs and `farmer.ts` is not this worker's to edit; it stays
 * owner-scoped through the same `owned()` merge every read here uses. It is NOT on the read-only
 * knowledge accessor, which has no write path at all (Requirement 13.4). **Reports rather than
 * throws**: returns whether a row was matched, so the chat turn can log a missed bump without
 * failing a farmer's committed answer.
 */
export async function touchConversation(conversationId: string, ownerId: string): Promise<boolean> {
  const objectId = toObjectId(conversationId);
  if (objectId === null) return false;
  const result = await conversations().updateOne(
    owned<ConversationDoc>(ownerId, { _id: objectId } as Filter<ConversationDoc>),
    { $set: { updatedAt: new Date() } },
  );
  return result.matchedCount > 0;
}

/**
 * The most recent diagnosis of one conversation this farmer owns, or `null`.
 *
 * `findDiagnoses` (from `farmer.ts`) merges the owner and sorts `createdAt` desc; this filters on
 * the conversation and takes the head. "Most recent" full stop — no reaching back past an
 * inconclusive one (Requirements 7.1, 7.3). Lives here so the chat context path can read it without
 * importing the driver (D18). An unparseable conversation id is a miss (`null`).
 */
export async function latestConversationDiagnosis(
  ownerId: string,
  conversationId: string,
): Promise<DiagnosisRecord | null> {
  const objectId = toObjectId(conversationId);
  if (objectId === null) return null;
  const rows = await farmerData(ownerId).findDiagnoses({
    conversationId: objectId,
  } as Filter<DiagnosisDoc>);
  return rows[0] ?? null;
}

/* ========================================================================== */
/* The chat-turn write — string-shaped, so the driver stays inside the layer    */
/* ========================================================================== */

/**
 * One message to persist, in the string shape a caller outside `src/lib/db/**` can build without
 * the driver. `conversationId` is a hex string and `transcriptOf.fileId` is the 24-hex Media_
 * Reference id; this module converts both to `ObjectId` before the insert. `ownerId` is the farmer
 * anchor the accessor is bound to.
 */
export interface ChatTurnInsert {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly language: Language;
  readonly channel: Channel;
  readonly inputKind: InputKind;
  readonly transcriptOf?: { readonly fileId: string; readonly kind: MediaKind } | undefined;
}

/**
 * Persist a chat turn's messages — the farmer message and the Jamee answer — through the
 * owner-scoped Data_Access_Layer, converting the string ids to `ObjectId` here so the chat service
 * never imports the driver (D18). Each row is inserted with its own `ownerId` bound
 * (`farmerData(row.ownerId).insertMessage`), which re-stamps the owner and `createdAt`. Returns the
 * stored records (with `_id`), in the order given.
 */
export async function insertChatTurn(
  rows: readonly ChatTurnInsert[],
): Promise<MessageRecord[]> {
  const stored: MessageRecord[] = [];
  for (const row of rows) {
    const conversationObjectId = toObjectId(row.conversationId);
    if (conversationObjectId === null) {
      throw new Error(`insertChatTurn: invalid conversationId ${row.conversationId}`);
    }
    const doc: Omit<MessageDoc, '_id' | 'ownerId' | 'createdAt'> = {
      conversationId: conversationObjectId,
      role: row.role,
      content: row.content,
      language: row.language,
      channel: row.channel,
      inputKind: row.inputKind,
      ...(row.transcriptOf === undefined
        ? {}
        : {
            transcriptOf: {
              fileId: new ObjectId(row.transcriptOf.fileId),
              kind: row.transcriptOf.kind,
            },
          }),
    };
    stored.push(await farmerData(row.ownerId).insertMessage(doc));
  }
  return stored;
}

/* ========================================================================== */
/* The read-only knowledge accessor — NO owner, NO write                        */
/* ========================================================================== */

export interface KnowledgeReads {
  /**
   * The rows for the given Canonical_Disease_Names. An empty request reads nothing (no query is
   * issued). The names are `VerifiedCondition`s, so a name outside the five is unrepresentable — the
   * safety gate is upstream (`visionVerifiedSchema`), and this accessor does not re-litigate it.
   */
  byNames(names: readonly VerifiedCondition[]): Promise<DiseaseKnowledgeDoc[]>;
  /** Every seeded condition, for the base-integrity read the integration suite makes. */
  all(): Promise<DiseaseKnowledgeDoc[]>;
}

/**
 * The knowledge base, read side only. NO owner (the base belongs to no farmer, Requirement 13.3)
 * and NO write path (Requirement 13.4 — writable only by the seed in `setup.ts`).
 */
export function knowledgeReads(): KnowledgeReads {
  return {
    async byNames(names) {
      if (names.length === 0) return [];
      return diseaseKnowledge()
        .find({ diseaseName: { $in: [...names] } })
        .toArray();
    },
    async all() {
      return diseaseKnowledge().find({}).toArray();
    },
  };
}
