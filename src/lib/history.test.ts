import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';
import {
  diagnosisDetailHref,
  readHistory,
  resolveHistoryImage,
  storageImageSource,
  type HistoryImageSource,
  type HistoryRow,
} from '@/lib/history';
import type { StorageRef } from '@/lib/schemas';
import { thumbPathFor, type StorageClientLike } from '@/lib/storage';

/**
 * Unit tests for the history screen's decisions.
 *
 * Requirements: 12.1 (reverse-chronological, with the condition or the inconclusive label, the
 *               Severity_Value, the channel and the creation timestamp), 12.2 (WhatsApp entries
 *               included), 12.5 (images load through Signed_URLs), 12.6 (a present
 *               Thumbnail_Derivative is loaded and NO Full_Size_Image is), 12.7 (no derivative and
 *               a present original renders the original), 12.10 (neither present renders no image)
 * Design: "Media lifecycle and retention" → mechanism 2
 *
 * No Supabase client and no network. `HistoryImageSource` is the seam, so presence is stated as
 * data — "the thumbnail is there, the original is not" — and the assertions are about which object
 * got signed rather than about the shape of a URL.
 */

const FARMER = '11111111-1111-4111-8111-111111111111';
const OTHER_MONTH = `${FARMER}/2026/08`;
const THIS_MONTH = `${FARMER}/2026/09`;

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'identified',
    disease_name: 'Tomato Early Blight',
    severity: 'moderate',
    channel: 'web',
    created_at: '2026-09-14T10:30:00.000Z',
    image_bucket: 'crop-images',
    image_path: `${THIS_MONTH}/33333333-3333-4333-8333-333333333333.jpg`,
    full_image_deleted_at: null,
    ...overrides,
  };
}

/**
 * A source over a set of paths that exist. Every signature is recorded, so a test can assert that
 * an object was **not** signed — which is the only way to state Requirement 12.6's prohibition.
 */
function sourceOver(present: readonly string[]): HistoryImageSource & { signed: string[] } {
  const signed: string[] = [];
  return {
    signed,
    probe: (ref: StorageRef) => Promise.resolve(present.includes(ref.path)),
    sign: (ref: StorageRef) => {
      signed.push(ref.path);
      return Promise.resolve(`https://signed.test/${ref.bucket}/${ref.path}?token=t`);
    },
  };
}

describe('resolveHistoryImage', () => {
  /**
   * Requirement 12.6 has two halves and the second is the load-bearing one: load the derivative,
   * and load NO Full_Size_Image for that entry. So this asserts the original was never signed.
   */
  it('reads the Thumbnail_Derivative and signs no Full_Size_Image when the derivative is present', async () => {
    const subject = row();
    const thumb = thumbPathFor(subject.image_path);
    const source = sourceOver([subject.image_path, thumb]);

    const image = await resolveHistoryImage(subject, source);

    expect(image?.kind).toBe('thumbnail');
    expect(image?.url).toContain(thumb);
    expect(source.signed).toEqual([thumb]);
    expect(source.signed).not.toContain(subject.image_path);
  });

  /**
   * Requirement 12.7 — the case the amendment created: a WhatsApp-originated row (the derivative is
   * produced in the browser, and that path has no browser), a web upload whose thumbnail failed
   * after the original succeeded (Requirement 2.14), or a row written before the amendment.
   */
  it('falls back to the Full_Size_Image when no derivative exists', async () => {
    const subject = row({ channel: 'whatsapp' });
    const source = sourceOver([subject.image_path]);

    const image = await resolveHistoryImage(subject, source);

    expect(image?.kind).toBe('full');
    expect(image?.url).toContain(subject.image_path);
    expect(source.signed).toEqual([subject.image_path]);
  });

  /** Requirement 12.10 — swept by policy (Requirement 18.7) and no derivative survived it. */
  it('renders no image when the original is swept and no derivative exists', async () => {
    const subject = row({ full_image_deleted_at: '2026-09-21T00:00:00.000Z' });
    const source = sourceOver([]);

    expect(await resolveHistoryImage(subject, source)).toBeNull();
    // Nothing is signed for an object the row itself says is gone.
    expect(source.signed).toEqual([]);
  });

  /**
   * A swept original whose derivative survived is still a thumbnail entry (Requirements 18.5,
   * 12.6). The list needs no extra copy for it — 12.9's sentence belongs to the detail view.
   */
  it('still reads the derivative after the original was swept', async () => {
    const subject = row({ full_image_deleted_at: '2026-09-21T00:00:00.000Z' });
    const thumb = thumbPathFor(subject.image_path);
    const source = sourceOver([thumb]);

    const image = await resolveHistoryImage(subject, source);

    expect(image?.kind).toBe('thumbnail');
    expect(source.signed).toEqual([thumb]);
  });

  /** A signing failure is "nothing to show", which the list already has honest copy for. */
  it('renders no image when a URL cannot be minted', async () => {
    const subject = row();

    const image = await resolveHistoryImage(subject, {
      probe: () => Promise.resolve(false),
      sign: () => Promise.resolve(null),
    });

    expect(image).toBeNull();
  });

  /**
   * A path with no extension has no derivable thumbnail. That is a corrupt row rather than a reason
   * to fail the render, so it lands on the fallback instead of throwing out of the page.
   */
  it('treats an undrivable thumbnail path as no derivative', async () => {
    const subject = row({ image_path: `${THIS_MONTH}/no-extension` });
    const source = sourceOver([subject.image_path]);

    const image = await resolveHistoryImage(subject, source);

    expect(image?.kind).toBe('full');
  });
});

describe('readHistory', () => {
  /** Requirement 12.1 — newest first, whatever order the statement happened to return. */
  it('orders entries newest first', async () => {
    const rows = [
      row({ id: 'aaaa1', created_at: '2026-09-10T00:00:00.000Z' }),
      row({ id: 'aaaa3', created_at: '2026-09-14T00:00:00.000Z' }),
      row({ id: 'aaaa2', created_at: '2026-09-12T00:00:00.000Z' }),
    ];

    const entries = await readHistory({
      userId: FARMER,
      source: sourceOver([]),
      query: () => Promise.resolve({ data: rows, error: null }),
    });

    expect(entries.map((entry) => entry.id)).toEqual(['aaaa3', 'aaaa2', 'aaaa1']);
  });

  /**
   * Requirement 12.1's five fields, and Requirement 12.2's inclusion, on one list. The inconclusive
   * row carries `condition: null` — the label a farmer reads for it is the component's job, because
   * this module has no language.
   */
  it('carries every listed field, for both channels and both row shapes', async () => {
    const identified = row({
      id: 'bbbb1',
      channel: 'whatsapp',
      severity: 'high',
      created_at: '2026-09-14T00:00:00.000Z',
      image_path: `${OTHER_MONTH}/44444444-4444-4444-8444-444444444444.jpg`,
    });
    const inconclusive = row({
      id: 'bbbb0',
      status: 'unknown',
      disease_name: null,
      severity: 'none',
      channel: 'web',
      created_at: '2026-09-13T00:00:00.000Z',
    });

    const entries = await readHistory({
      userId: FARMER,
      source: sourceOver([identified.image_path, inconclusive.image_path]),
      query: () => Promise.resolve({ data: [inconclusive, identified], error: null }),
    });

    expect(entries[0]).toEqual({
      id: 'bbbb1',
      // Requirement 9.4 — the canonical name as stored, never translated.
      condition: 'Tomato Early Blight',
      severity: 'high',
      // Requirement 12.2 — a WhatsApp-originated diagnosis is in the list.
      channel: 'whatsapp',
      createdAt: '2026-09-14T00:00:00.000Z',
      image: { kind: 'full', url: expect.stringContaining(identified.image_path) as string },
    });
    expect(entries[1]?.condition).toBeNull();
    expect(entries[1]?.severity).toBe('none');
  });

  /** Requirement 12.4's state. An empty list is an answer, not a failure. */
  it('returns an empty list for a farmer with no diagnoses', async () => {
    const entries = await readHistory({
      userId: FARMER,
      source: sourceOver([]),
      query: () => Promise.resolve({ data: [], error: null }),
    });

    expect(entries).toEqual([]);
  });

  /**
   * A failed read must not become the empty state. "You have no results yet" in front of a farmer
   * with twenty results is the one dishonest outcome this screen could produce.
   */
  it('throws rather than reporting a failed read as an empty history', async () => {
    await expect(
      readHistory({
        userId: FARMER,
        source: sourceOver([]),
        query: () =>
          Promise.resolve({ data: null, error: { code: 'PGRST301', message: 'jwt expired' } }),
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('storageImageSource', () => {
  /** `{ data: false }` is what the pinned SDK returns for 400 and 404 — absence, not an error. */
  it('reports a probe as absent when the client says the object is not there', async () => {
    const source = storageImageSource(clientWhere({ exists: false }));
    expect(await source.probe({ bucket: 'crop-images', path: 'p.jpg' })).toBe(false);
  });

  it('reports a probe as present when the client says it is', async () => {
    const source = storageImageSource(clientWhere({ exists: true }));
    expect(await source.probe({ bucket: 'crop-images', path: 'p.jpg' })).toBe(true);
  });

  /**
   * A throwing probe is neither evidence of presence nor of absence. Reported as absent, because
   * this view has a fallback and honest copy for absence — see the comment at the call site.
   */
  it('reports a throwing probe as absent', async () => {
    const source = storageImageSource(clientWhere({ throws: true }));
    expect(await source.probe({ bucket: 'crop-images', path: 'p.jpg' })).toBe(false);
  });

  /** Requirement 12.5 — the URL a view renders comes from `createSignedUrl`, nothing else. */
  it('signs through the storage client', async () => {
    const source = storageImageSource(clientWhere({ exists: true }));
    expect(await source.sign({ bucket: 'crop-images', path: 'p.jpg' })).toBe(
      'https://signed.test/crop-images/p.jpg',
    );
  });
});

/**
 * The narrowest client that satisfies `StorageClientLike`. Constructed here rather than imported
 * from `storage.test.ts` so this file states its own assumptions about the two calls it makes.
 */
function clientWhere(behaviour: { exists?: boolean; throws?: boolean }): StorageClientLike {
  return {
    storage: {
      from: (bucket: string) => ({
        exists: (path: string) => {
          if (behaviour.throws === true) return Promise.reject(new Error('network down'));
          void path;
          return Promise.resolve({ data: behaviour.exists === true, error: null });
        },
        createSignedUrl: (path: string) =>
          Promise.resolve({
            data: { signedUrl: `https://signed.test/${bucket}/${path}` },
            error: null,
          }),
      }),
    },
  };
}

describe('diagnosisDetailHref', () => {
  /** Requirement 12.3's target, and the path the Proxy already gates (Requirement 1.6). */
  it('points at the diagnosis detail route', () => {
    expect(diagnosisDetailHref('55555555-5555-4555-8555-555555555555')).toBe(
      '/diagnosis/55555555-5555-4555-8555-555555555555',
    );
  });

  it('encodes an id that is not a bare uuid', () => {
    expect(diagnosisDetailHref('a/b?c')).toBe('/diagnosis/a%2Fb%3Fc');
  });
});
