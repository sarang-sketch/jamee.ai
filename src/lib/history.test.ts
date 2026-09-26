import { ObjectId, type WithId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import type { DiagnosisDoc } from '@/lib/db/collections';
import type { FarmerReads } from '@/lib/db/reads';
import { AppError } from '@/lib/errors';
import {
  diagnosisDetailHref,
  readHistory,
  resolveHistoryImage,
  type HistoryEntry,
} from '@/lib/history';

/**
 * Unit tests for the history screen's decisions, over the Amendment A3 Data_Access_Layer.
 *
 * Requirements: 12.1 (reverse-chronological, with the condition or the inconclusive label, the
 *               Severity_Value, the channel and the creation timestamp), 12.2 (Telegram entries
 *               included), 12.5 (images load through the Media_Endpoint), 12.6 (a present
 *               Thumbnail_Derivative is loaded and NO Full_Size_Image is), 12.7 (no derivative and
 *               a present original renders the original), 12.10 (a swept original and no derivative
 *               renders no image)
 * Design: "Media lifecycle and retention" → mechanism 2; D17, D18
 *
 * No database and no network. `FarmerReads` is the seam, so thumbnail presence is stated as data —
 * "this diagnosis has a thumbnail, that one does not" — and the assertions are about which file id
 * the Media_Endpoint URL addresses (thumbnail vs the full-image `mediaRef.fileId`), which is the
 * only way to state Requirement 12.6's prohibition.
 */

const FARMER = 'auth-user-1111';

/** A stable full-image file id, and its resolved thumbnail id, per test. */
function ids(): { full: ObjectId; thumb: ObjectId } {
  return { full: new ObjectId(), thumb: new ObjectId() };
}

function diagnosis(overrides: Partial<DiagnosisDoc> = {}): WithId<DiagnosisDoc> {
  const full = overrides.mediaRef?.fileId ?? new ObjectId();
  return {
    _id: new ObjectId(),
    ownerId: FARMER,
    conversationId: new ObjectId(),
    status: 'identified',
    diseaseName: 'Tomato Early Blight',
    severity: 'moderate',
    explanation: 'Dark patches are spreading on the leaves.',
    language: 'en',
    needsExpert: false,
    channel: 'web',
    mediaRef: { fileId: full, kind: 'crop-image' },
    fullImageDeletedAt: null,
    modelProvider: 'gemini',
    createdAt: new Date('2026-09-14T10:30:00.000Z'),
    ...overrides,
  } as WithId<DiagnosisDoc>;
}

/**
 * A read bundle over a set of diagnoses and a thumbnail map keyed by the FULL-image file id hex.
 * Every `thumbnailFileIdFor` lookup is recorded, so a test can assert an entry did or did not ask
 * for a thumbnail, and can prove the full-image URL was chosen only when no thumbnail existed.
 */
function readsOver(
  rows: readonly WithId<DiagnosisDoc>[],
  thumbnails: Readonly<Record<string, string>> = {},
): FarmerReads & { thumbLookups: string[] } {
  const thumbLookups: string[] = [];
  return {
    ownerId: FARMER,
    thumbLookups,
    listDiagnoses: (limit) => Promise.resolve(rows.slice(0, limit)),
    findDiagnosis: () => Promise.resolve(null),
    conversationMessages: () => Promise.resolve([]),
    thumbnailFileIdFor: (fullImageFileId) => {
      thumbLookups.push(fullImageFileId);
      return Promise.resolve(thumbnails[fullImageFileId] ?? null);
    },
  };
}

describe('resolveHistoryImage', () => {
  /**
   * Requirement 12.6 has two halves and the second is load-bearing: load the derivative, and load
   * NO Full_Size_Image. So this asserts the URL addresses the thumbnail id, never the full id.
   */
  it('reads the Thumbnail_Derivative and addresses no Full_Size_Image when the derivative is present', async () => {
    const { full, thumb } = ids();
    const row = diagnosis({ mediaRef: { fileId: full, kind: 'crop-image' } });
    const reads = readsOver([row], { [full.toHexString()]: thumb.toHexString() });

    const image = await resolveHistoryImage(row, reads);

    expect(image?.kind).toBe('thumbnail');
    expect(image?.url).toBe(`/api/media/${thumb.toHexString()}`);
    expect(image?.url).not.toContain(full.toHexString());
  });

  /**
   * Requirement 12.7 — the case the amendment created: a Telegram-originated row (the derivative is
   * produced in the browser, and that path has no browser), a web upload whose thumbnail failed
   * after the original succeeded (Requirement 2.14), or a row written before the amendment.
   */
  it('falls back to the Full_Size_Image when no derivative exists', async () => {
    const { full } = ids();
    const row = diagnosis({ channel: 'whatsapp', mediaRef: { fileId: full, kind: 'crop-image' } });
    const reads = readsOver([row]);

    const image = await resolveHistoryImage(row, reads);

    expect(image?.kind).toBe('full');
    expect(image?.url).toBe(`/api/media/${full.toHexString()}`);
  });

  /** Requirement 12.10 — swept by policy (Requirement 18.7) and no derivative survived it. */
  it('renders no image when the original is swept and no derivative exists', async () => {
    const { full } = ids();
    const row = diagnosis({
      mediaRef: { fileId: full, kind: 'crop-image' },
      fullImageDeletedAt: new Date('2026-09-21T00:00:00.000Z'),
    });
    const reads = readsOver([row]);

    expect(await resolveHistoryImage(row, reads)).toBeNull();
  });

  /**
   * A swept original whose derivative survived is still a thumbnail entry (Requirements 18.5,
   * 12.6). The list needs no extra copy for it — 12.9's sentence belongs to the detail view.
   */
  it('still reads the derivative after the original was swept', async () => {
    const { full, thumb } = ids();
    const row = diagnosis({
      mediaRef: { fileId: full, kind: 'crop-image' },
      fullImageDeletedAt: new Date('2026-09-21T00:00:00.000Z'),
    });
    const reads = readsOver([row], { [full.toHexString()]: thumb.toHexString() });

    const image = await resolveHistoryImage(row, reads);

    expect(image?.kind).toBe('thumbnail');
    expect(image?.url).toBe(`/api/media/${thumb.toHexString()}`);
  });
});

describe('readHistory', () => {
  /**
   * Requirement 12.1 — newest first. The accessor is responsible for the order (its `owner_recent`
   * index sort), so the stub returns them in the order it is given and the entries preserve it.
   */
  it('preserves the accessor order (newest first)', async () => {
    const a = diagnosis({ createdAt: new Date('2026-09-14T00:00:00.000Z') });
    const b = diagnosis({ createdAt: new Date('2026-09-12T00:00:00.000Z') });
    const c = diagnosis({ createdAt: new Date('2026-09-10T00:00:00.000Z') });

    const entries = await readHistory({ userId: FARMER, reads: readsOver([a, b, c]) });

    expect(entries.map((entry) => entry.id)).toEqual([
      a._id.toHexString(),
      b._id.toHexString(),
      c._id.toHexString(),
    ]);
  });

  /**
   * Requirement 12.1's five fields, and Requirement 12.2's inclusion, on one list. The inconclusive
   * row carries `condition: null` — the label a farmer reads for it is the component's job, because
   * this module has no language.
   */
  it('carries every listed field, for both channels and both row shapes', async () => {
    const { full, thumb } = ids();
    const identified = diagnosis({
      channel: 'whatsapp',
      severity: 'high',
      createdAt: new Date('2026-09-14T00:00:00.000Z'),
      mediaRef: { fileId: full, kind: 'crop-image' },
    });
    const inconclusive = diagnosis({
      status: 'unknown',
      diseaseName: null,
      severity: 'none',
      channel: 'web',
      createdAt: new Date('2026-09-13T00:00:00.000Z'),
    });

    const entries = await readHistory({
      userId: FARMER,
      reads: readsOver([identified, inconclusive], { [full.toHexString()]: thumb.toHexString() }),
    });

    const first = entries[0] as HistoryEntry;
    expect(first.id).toBe(identified._id.toHexString());
    // Requirement 9.4 — the canonical name as stored, never translated.
    expect(first.condition).toBe('Tomato Early Blight');
    expect(first.severity).toBe('high');
    // Requirement 12.2 — a diagnosis from another channel is in the list on the same footing as web
    // (the read applies no channel filter at all).
    expect(first.channel).toBe('whatsapp');
    expect(first.createdAt).toBe('2026-09-14T00:00:00.000Z');
    expect(first.image).toEqual({ kind: 'thumbnail', url: `/api/media/${thumb.toHexString()}` });

    expect(entries[1]?.condition).toBeNull();
    expect(entries[1]?.severity).toBe('none');
  });

  /** Requirement 12.4's state. An empty list is an answer, not a failure. */
  it('returns an empty list for a farmer with no diagnoses', async () => {
    const entries = await readHistory({ userId: FARMER, reads: readsOver([]) });
    expect(entries).toEqual([]);
  });

  /**
   * A failed read must not become the empty state. "You have no results yet" in front of a farmer
   * with twenty results is the one dishonest outcome this screen could produce.
   */
  it('throws rather than reporting a failed read as an empty history', async () => {
    const failing: FarmerReads = {
      ownerId: FARMER,
      listDiagnoses: () => Promise.reject(new Error('cluster unreachable')),
      findDiagnosis: () => Promise.resolve(null),
      conversationMessages: () => Promise.resolve([]),
      thumbnailFileIdFor: () => Promise.resolve(null),
    };

    await expect(readHistory({ userId: FARMER, reads: failing })).rejects.toBeInstanceOf(AppError);
  });
});

describe('diagnosisDetailHref', () => {
  /** Requirement 12.3's target, and the path the Proxy already gates (Requirement 1.6). */
  it('points at the diagnosis detail route', () => {
    expect(diagnosisDetailHref('64b7f0000000000000000001')).toBe(
      '/diagnosis/64b7f0000000000000000001',
    );
  });

  it('encodes an id that is not a bare hex string', () => {
    expect(diagnosisDetailHref('a/b?c')).toBe('/diagnosis/a%2Fb%3Fc');
  });
});
