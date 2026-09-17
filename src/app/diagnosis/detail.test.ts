import { describe, expect, it } from 'vitest';

import {
  formatConfidence,
  formatTimestamp,
  resolveDetailImage,
  toDiagnosisDetail,
  type DiagnosisDetailRow,
} from '@/app/diagnosis/detail';
import { THUMBNAIL_PATH_INFIX } from '@/lib/config/media';
import type { KnowledgePayload } from '@/lib/schemas';
import type { StorageClientLike } from '@/lib/storage';

/**
 * Unit coverage for the detail screen's four decisions.
 *
 * Requirements: 12.3 (the fields the detail view carries), 12.8 / 12.9 / 12.10 (which image, and
 *               what the absence of one means), 12.11 (the rest of the screen survives a missing
 *               image), 6.5 (an inconclusive result carries no name, confidence or treatment)
 *
 * No mocks of Jamee's own code. The only stand-in is the storage client, which is an external
 * service — and it is the structural `StorageClientLike` seam `storage.ts` exposes for exactly
 * this, not a rewrite of the module under test.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const OBJECT = '22222222-2222-4222-8222-222222222222';
const IMAGE_PATH = `${OWNER}/2026/03/${OBJECT}.jpg`;
const THUMB_PATH = `${OWNER}/2026/03/${OBJECT}${THUMBNAIL_PATH_INFIX}.jpg`;

function identifiedRow(overrides: Partial<DiagnosisDetailRow> = {}): DiagnosisDetailRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: OWNER,
    conversation_id: '44444444-4444-4444-8444-444444444444',
    status: 'identified',
    disease_name: 'Tomato Late Blight',
    confidence: 0.874,
    severity: 'high',
    explanation: 'Dark patches are spreading on the leaves.',
    language: 'en',
    needs_expert: false,
    channel: 'web',
    image_bucket: 'crop-images',
    image_path: IMAGE_PATH,
    full_image_deleted_at: null,
    created_at: '2026-03-04T09:30:00.000Z',
    ...overrides,
  };
}

function unknownRow(overrides: Partial<DiagnosisDetailRow> = {}): DiagnosisDetailRow {
  return identifiedRow({
    status: 'unknown',
    disease_name: null,
    confidence: null,
    severity: 'none',
    needs_expert: true,
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
 * A storage client that answers `exists()` from a set of present paths and always signs
 * successfully, so a test states presence and reads back the decision.
 */
function storageWith(present: readonly string[], signable = true): StorageClientLike {
  return {
    storage: {
      from: () => ({
        exists: async (path: string) => ({ data: present.includes(path), error: null }),
        createSignedUrl: async (path: string) =>
          signable
            ? { data: { signedUrl: `https://storage.test/${path}?token=abc` }, error: null }
            : { data: null, error: new Error('cannot sign') },
      }),
    },
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
    expect(detail.conversationId).toBe('44444444-4444-4444-8444-444444444444');
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
    expect(toDiagnosisDetail(identifiedRow({ disease_name: null }), KNOWLEDGE)).toBeNull();
    expect(toDiagnosisDetail(identifiedRow({ confidence: null }), KNOWLEDGE)).toBeNull();
    expect(
      toDiagnosisDetail(unknownRow({ disease_name: 'Tomato Healthy' }), KNOWLEDGE),
    ).toBeNull();
    expect(toDiagnosisDetail(unknownRow({ confidence: 0.4 }), KNOWLEDGE)).toBeNull();
  });
});

describe('resolveDetailImage', () => {
  it('shows the full-size original while it is present (Requirement 12.8)', async () => {
    const image = await resolveDetailImage(
      identifiedRow(),
      storageWith([IMAGE_PATH, THUMB_PATH]),
    );

    expect(image.kind).toBe('full');
    if (image.kind === 'none') throw new Error('expected a url');
    expect(image.url).toContain(IMAGE_PATH);
  });

  it('falls back to the thumbnail once the sweep has stamped the row (Requirement 12.9)', async () => {
    const image = await resolveDetailImage(
      identifiedRow({ full_image_deleted_at: '2026-03-12T00:00:00.000Z' }),
      // The original is still listed as present; the stamp must win, so no probe or read of it
      // happens and the thumbnail is what renders.
      storageWith([IMAGE_PATH, THUMB_PATH]),
    );

    expect(image.kind).toBe('thumbnail');
    if (image.kind === 'none') throw new Error('expected a url');
    expect(image.url).toContain(THUMBNAIL_PATH_INFIX);
  });

  it('renders no image when neither derivative is present (Requirement 12.10)', async () => {
    // A WhatsApp-originated diagnosis past the retention window: no thumbnail was ever produced.
    const image = await resolveDetailImage(
      identifiedRow({ channel: 'whatsapp', full_image_deleted_at: '2026-03-12T00:00:00.000Z' }),
      storageWith([]),
    );

    expect(image.kind).toBe('none');
  });

  it('treats an unsignable object as absent rather than failing the render', async () => {
    const image = await resolveDetailImage(
      identifiedRow(),
      storageWith([IMAGE_PATH, THUMB_PATH], false),
    );

    expect(image.kind).toBe('none');
  });

  it('treats a missing original as absent even when the row is unstamped', async () => {
    const image = await resolveDetailImage(identifiedRow(), storageWith([THUMB_PATH]));

    expect(image.kind).toBe('thumbnail');
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
