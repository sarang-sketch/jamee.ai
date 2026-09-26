import { ObjectId, type WithId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import {
  formatConfidence,
  formatTimestamp,
  resolveDetailImage,
  toDiagnosisDetail,
} from '@/app/diagnosis/detail';
import type { DiagnosisDoc } from '@/lib/db/collections';
import type { FarmerReads } from '@/lib/db/reads';
import type { KnowledgePayload } from '@/lib/schemas';

/**
 * Unit coverage for the detail screen's four decisions.
 *
 * Requirements: 12.3 (the fields the detail view carries), 12.8 / 12.9 / 12.10 (which image, and
 *               what the absence of one means), 12.11 (the rest of the screen survives a missing
 *               image), 6.5 (an inconclusive result carries no name, confidence or treatment)
 *
 * *Amendment A3:* no mocks of Jamee's own code, and no storage client. The image decision now reads
 * through the owner-scoped Data_Access_Layer, so the only stand-in is a `FarmerReads`-shaped stub
 * whose `thumbnailFileIdFor` states whether a Thumbnail_Derivative exists — and the assertions are
 * about which file id the Media_Endpoint URL addresses (the full-image `mediaRef.fileId` vs the
 * resolved thumbnail id).
 */

const OWNER = 'auth-user-1111';
const FULL_IMAGE = new ObjectId();
const THUMB_IMAGE = new ObjectId();
const CONVERSATION = new ObjectId();

function identifiedRow(overrides: Partial<WithId<DiagnosisDoc>> = {}): WithId<DiagnosisDoc> {
  return {
    _id: new ObjectId(),
    ownerId: OWNER,
    conversationId: CONVERSATION,
    status: 'identified',
    diseaseName: 'Tomato Late Blight',
    knowledgeId: null,
    confidence: 0.874,
    severity: 'high',
    explanation: 'Dark patches are spreading on the leaves.',
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: { fileId: FULL_IMAGE, kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
    createdAt: new Date('2026-03-04T09:30:00.000Z'),
    ...overrides,
  } as WithId<DiagnosisDoc>;
}

function unknownRow(overrides: Partial<WithId<DiagnosisDoc>> = {}): WithId<DiagnosisDoc> {
  return identifiedRow({
    status: 'unknown',
    diseaseName: null,
    confidence: null,
    severity: 'none',
    needsExpert: true,
    explanation: 'Jamee could not judge this photo.',
    ...overrides,
  });
}

const KNOWLEDGE: KnowledgePayload = {
  symptoms: ['Water-soaked patches on leaves'],
  causes: ['Phytophthora infestans'],
  treatment: ['Remove affected leaves'],
  prevention: ['Space plants for airflow'],
  source: 'State agricultural extension service',
};

/**
 * A read bundle whose `thumbnailFileIdFor` returns the given thumbnail id for the full-image id it
 * is asked about, or `null`. Only `thumbnailFileIdFor` is exercised by `resolveDetailImage`.
 */
function readsWithThumbnail(thumbnailId: ObjectId | null): Pick<FarmerReads, 'thumbnailFileIdFor'> {
  return {
    thumbnailFileIdFor: (fullImageFileId) =>
      Promise.resolve(
        thumbnailId !== null && fullImageFileId === FULL_IMAGE.toHexString()
          ? thumbnailId.toHexString()
          : null,
      ),
  };
}

describe('toDiagnosisDetail', () => {
  it('carries every field Requirement 12.3 lists for an identified result', () => {
    const detail = toDiagnosisDetail(identifiedRow(), KNOWLEDGE);

    expect(detail).not.toBeNull();
    if (detail === null || detail.status !== 'identified') throw new Error('expected identified');

    expect(detail.diseaseName).toBe('Tomato Late Blight');
    expect(detail.confidence).toBe(0.874);
    expect(detail.severity).toBe('high');
    expect(detail.explanation).toBe('Dark patches are spreading on the leaves.');
    expect(detail.conversationId).toBe(CONVERSATION.toHexString());
    expect(detail.knowledge).toEqual(KNOWLEDGE);
  });

  it('leaves the grounded sections empty when the knowledge base has no entry', () => {
    const detail = toDiagnosisDetail(identifiedRow(), null);

    if (detail === null || detail.status !== 'identified') throw new Error('expected identified');
    // Requirement 12.11: the rest of the screen is unaffected by a missing knowledge row.
    expect(detail.knowledge).toBeNull();
    expect(detail.diseaseName).toBe('Tomato Late Blight');
  });

  it('pins name, confidence and knowledge to null on the inconclusive branch', () => {
    const detail = toDiagnosisDetail(unknownRow(), KNOWLEDGE);

    if (detail === null || detail.status !== 'unknown') throw new Error('expected unknown');
    expect(detail.diseaseName).toBeNull();
    expect(detail.confidence).toBeNull();
    // Requirement 6.5: knowledge is null even though a payload was handed in, so no render can
    // reach treatment content for an inconclusive result.
    expect(detail.knowledge).toBeNull();
    expect(detail.needsExpert).toBe(true);
  });

  it('rejects a row that contradicts its own status', () => {
    expect(toDiagnosisDetail(identifiedRow({ diseaseName: null }), KNOWLEDGE)).toBeNull();
    expect(toDiagnosisDetail(identifiedRow({ confidence: null }), KNOWLEDGE)).toBeNull();
    expect(toDiagnosisDetail(unknownRow({ diseaseName: 'Tomato Healthy' }), KNOWLEDGE)).toBeNull();
    expect(toDiagnosisDetail(unknownRow({ confidence: 0.4 }), KNOWLEDGE)).toBeNull();
  });
});

describe('resolveDetailImage', () => {
  it('shows the full-size original while it is present (Requirement 12.8)', async () => {
    // A thumbnail also exists, but the detail view prefers the original and must not address it.
    const image = await resolveDetailImage(identifiedRow(), readsWithThumbnail(THUMB_IMAGE));

    expect(image.kind).toBe('full');
    if (image.kind === 'none') throw new Error('expected a url');
    expect(image.url).toBe(`/api/media/${FULL_IMAGE.toHexString()}`);
    expect(image.url).not.toContain(THUMB_IMAGE.toHexString());
  });

  it('falls back to the thumbnail once the sweep has stamped the row (Requirement 12.9)', async () => {
    const image = await resolveDetailImage(
      identifiedRow({ fullImageDeletedAt: new Date('2026-03-12T00:00:00.000Z') }),
      readsWithThumbnail(THUMB_IMAGE),
    );

    expect(image.kind).toBe('thumbnail');
    if (image.kind === 'none') throw new Error('expected a url');
    expect(image.url).toBe(`/api/media/${THUMB_IMAGE.toHexString()}`);
  });

  it('renders no image when neither derivative is present (Requirement 12.10)', async () => {
    // A Telegram-originated diagnosis past the retention window: no thumbnail was ever produced.
    const image = await resolveDetailImage(
      identifiedRow({
        channel: 'whatsapp',
        fullImageDeletedAt: new Date('2026-03-12T00:00:00.000Z'),
      }),
      readsWithThumbnail(null),
    );

    expect(image.kind).toBe('none');
  });
});

describe('formatConfidence', () => {
  it('reads a stored fraction as a whole-number percentage', () => {
    expect(formatConfidence(0.874)).toBe('87%');
    expect(formatConfidence(0)).toBe('0%');
    expect(formatConfidence(1)).toBe('100%');
  });

  it('clamps a value the column could not have held', () => {
    expect(formatConfidence(-0.5)).toBe('0%');
    expect(formatConfidence(14)).toBe('100%');
  });
});

describe('formatTimestamp', () => {
  it('renders a UTC instant on the Asia/Kolkata clock', () => {
    // 2026-03-04T20:15Z is 01:45 on 5 March in Kolkata, so the date rolls over.
    expect(formatTimestamp('2026-03-04T20:15:00.000Z', 'en')).toContain('5');
  });

  it('returns an unparseable value unchanged', () => {
    expect(formatTimestamp('not-a-timestamp', 'en')).toBe('not-a-timestamp');
  });
});
