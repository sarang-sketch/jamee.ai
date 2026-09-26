import { Buffer } from 'node:buffer';

import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaBytes } from '@/lib/media';

import { GET, maxDuration } from './route';

/**
 * Unit tests for `src/app/api/media/[id]/route.ts` — the owner-checked serve leg of the
 * Media_Endpoint (task 54.2 / 54.4).
 *
 * Requirements: 1.7 (no session → 401, nothing served), 2.5, 2.6 (a file is streamed only to its
 *               owner; a missing file and a foreign file are BOTH 404, so a stranger cannot probe
 *               for existence), 12.5 (this is the URL history thumbnails and the detail screen load
 *               through), 13.5 (private caching only)
 *
 * `fetchMediaForOwner` and the session resolver are the two seams. The store is stubbed so these
 * tests are about the boundary — that a `null` from the owner-scoped read becomes a 404, that an
 * unauthenticated request never reads, and that a hit carries the stored MIME type and a private
 * cache header — not about GridFS, which the media integration test exercises for real.
 */

const spies = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  fetchMediaForOwner: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ currentUserId: spies.currentUserId }));
vi.mock('@/lib/media', () => ({ fetchMediaForOwner: spies.fetchMediaForOwner }));

const USER = 'farmer-1';
const FILE_ID = 'a'.repeat(24);
const BYTES = Buffer.from('the served image bytes');

function get(fileId: string): Promise<Response> {
  const request = new Request(`https://jamee.test/api/media/${fileId}`, { method: 'GET' });
  return GET(request as NextRequest, { params: Promise.resolve({ id: fileId }) });
}

const foundBytes: MediaBytes = { bytes: BYTES, mimeType: 'image/jpeg', length: BYTES.byteLength };

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
});

describe('GET /api/media/:id with no session (1.7)', () => {
  it('returns 401 and never reads the store', async () => {
    spies.currentUserId.mockResolvedValue(null);

    const response = await get(FILE_ID);

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(spies.fetchMediaForOwner).not.toHaveBeenCalled();
  });
});

describe('GET /api/media/:id for the owner', () => {
  it('streams the bytes with the stored MIME type and a private cache header (2.5, 12.5, 13.5)', async () => {
    spies.fetchMediaForOwner.mockResolvedValue(foundBytes);

    const response = await get(FILE_ID);

    expect(response.status).toBe(200);
    // The read is scoped to the session owner and the id from the dynamic segment.
    expect(spies.fetchMediaForOwner).toHaveBeenCalledWith(USER, FILE_ID);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Cache-Control')).toContain('private');
    const returned = Buffer.from(await response.arrayBuffer());
    expect(returned.equals(BYTES)).toBe(true);
  });
});

describe('GET /api/media/:id for a foreign or missing file (2.6)', () => {
  it('returns 404 with no body for a null read — foreign and missing are the same answer', async () => {
    spies.fetchMediaForOwner.mockResolvedValue(null);

    const response = await get(FILE_ID);

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('returns 500 with no body when the store read throws, not a 404', async () => {
    // A driver failure is a server fault, not "the file does not exist" — a 404 would be a lie.
    spies.fetchMediaForOwner.mockRejectedValue(new Error('gridfs offline'));

    const response = await get(FILE_ID);

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });
});

describe('the route declares its own duration ceiling', () => {
  it('exports maxDuration as a positive number', () => {
    expect(typeof maxDuration).toBe('number');
    expect(maxDuration).toBeGreaterThan(0);
  });
});
