// @vitest-environment node
import { Buffer } from 'node:buffer';

import type { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelopeSchema, mediaRefSchema } from '@/lib/schemas';

import { POST, maxDuration } from './route';

/**
 * Unit tests for `src/app/api/media/route.ts` — the authenticated upload leg of the Media_Endpoint
 * (task 54.2 / 54.4).
 *
 * Requirements: 1.7 (no session → 401, no write), 2.1 (a crop image is uploaded and its
 *               Media_Reference returned), 2.5 (`metadata.ownerId` comes from the session, never
 *               client input), 2.4 / 8.3 (a wrong type or oversized file is refused through
 *               `storeMedia`), 15.3 (one localized envelope)
 *
 * `storeMedia` and the session resolver are the two seams. The store is stubbed so these tests are
 * about the boundary — was the session id passed as the owner, is the returned reference the exact
 * `{ fileId, kind }` shape, does a bad body become a 400 — not about GridFS, which the media
 * integration test exercises against a real replica set.
 */

const spies = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  storeMedia: vi.fn(),
}));

/** The route's wrapper resolves identity through `@/lib/auth/session` (Better Auth, V30). */
vi.mock('@/lib/auth/session', () => ({ currentUserId: spies.currentUserId }));

/** The application media wrapper — the one place admission runs before GridFS. Stubbed here. */
vi.mock('@/lib/media', () => ({ storeMedia: spies.storeMedia }));

const USER = 'farmer-1';
const FILE_ID = 'a'.repeat(24);

function multipart(fields: { kind?: string; file?: Blob | string }): Promise<Response> {
  const form = new FormData();
  if (fields.kind !== undefined) form.append('kind', fields.kind);
  if (fields.file !== undefined) {
    if (typeof fields.file === 'string') form.append('file', fields.file);
    else form.append('file', fields.file, 'upload.jpg');
  }
  const request = new Request('https://jamee.test/api/media', { method: 'POST', body: form });
  return POST(request as NextRequest);
}

function jpegBlob(): Blob {
  return new Blob([Buffer.from('fake-jpeg')], { type: 'image/jpeg' });
}

async function envelopeOf(response: Response) {
  return errorEnvelopeSchema.parse(await response.json());
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.currentUserId.mockResolvedValue(USER);
  spies.storeMedia.mockRejectedValue(new Error('tripwire: storeMedia reached unexpectedly'));
});

describe('POST /api/media with no session', () => {
  it('returns 401 and never touches the store', async () => {
    spies.currentUserId.mockResolvedValue(null);

    const response = await multipart({ kind: 'crop-image', file: jpegBlob() });
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(401);
    expect(envelope.error.code).toBe('AUTH_REQUIRED');
    expect(spies.storeMedia).not.toHaveBeenCalled();
  });
});

describe('POST /api/media with a valid multipart body', () => {
  it('admits the file through storeMedia with the SESSION owner, and returns its reference', async () => {
    spies.storeMedia.mockResolvedValue({ fileId: { toHexString: () => FILE_ID }, kind: 'crop-image' });

    const response = await multipart({ kind: 'crop-image', file: jpegBlob() });

    expect(response.status).toBe(201);
    // Requirement 2.5: the owner is the session id, and the kind + MIME type come off the part.
    expect(spies.storeMedia).toHaveBeenCalledTimes(1);
    const [ownerId, kind, mimeType, bytes] = spies.storeMedia.mock.calls[0] ?? [];
    expect(ownerId).toBe(USER);
    expect(kind).toBe('crop-image');
    expect(mimeType).toBe('image/jpeg');
    expect(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array).toBe(true);

    const payload = (await response.json()) as { mediaRef: unknown };
    const parsed = mediaRefSchema.safeParse(payload.mediaRef);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ fileId: FILE_ID, kind: 'crop-image' });
    }
  });
});

describe('POST /api/media with a malformed body', () => {
  it('returns 400 STORAGE_REF_INVALID for a missing kind or a missing file, storing nothing', async () => {
    const cases: { label: string; send: () => Promise<Response> }[] = [
      { label: 'no kind', send: () => multipart({ file: jpegBlob() }) },
      { label: 'empty kind', send: () => multipart({ kind: '', file: jpegBlob() }) },
      { label: 'no file', send: () => multipart({ kind: 'crop-image' }) },
      { label: 'file field is a string, not a File', send: () => multipart({ kind: 'crop-image', file: 'not-a-file' }) },
    ];

    for (const { label, send } of cases) {
      const response = await send();
      const envelope = await envelopeOf(response);
      expect(response.status, label).toBe(400);
      expect(envelope.error.code, label).toBe('STORAGE_REF_INVALID');
    }

    expect(spies.storeMedia).not.toHaveBeenCalled();
  });

  it('renders a storeMedia admission refusal through the one envelope', async () => {
    const { AppError } = await import('@/lib/errors');
    spies.storeMedia.mockRejectedValue(new AppError('FILE_TYPE_UNSUPPORTED'));

    const response = await multipart({ kind: 'crop-image', file: jpegBlob() });
    const envelope = await envelopeOf(response);

    expect(response.status).toBe(400);
    expect(envelope.error.code).toBe('FILE_TYPE_UNSUPPORTED');
    expect(envelope.error.retryable).toBe(false);
  });
});

describe('the route declares its own duration ceiling', () => {
  it('exports maxDuration as a positive number', () => {
    expect(typeof maxDuration).toBe('number');
    expect(maxDuration).toBeGreaterThan(0);
  });
});
