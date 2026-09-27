import { Buffer } from 'node:buffer';

import type { NextRequest } from 'next/server';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupDatabase } from '@/lib/db/setup';

import { clearDatabase, startMongo, stopMongo, type MongoHarness } from './mongo';

/**
 * Integration test for the Media_Endpoint round trip (task 54.4) against a single-node
 * `MongoMemoryReplSet` (V31, V33): upload a file through `POST /api/media` and read it back through
 * `GET /api/media/<fileId>` — as its owner, who gets the bytes, and as a stranger, who gets 404.
 *
 * Requirements: 1.7 (no session → 401, no write and no read), 2.1 (the upload leg stores the file
 *               and returns its Media_Reference), 2.5 (`metadata.ownerId` comes from the session,
 *               never client input), 2.6 (a foreign file and a missing file are both 404, so a
 *               stranger cannot probe for existence), 12.5 (the owner-checked serve leg the history
 *               views load through)
 * Design: D1 (amended — the browser uploads and reads through the Media_Endpoint), D17 (one GridFS
 *         bucket), D18 (the Data_Access_Layer is the owner boundary)
 *
 * The session is the one thing stubbed: `@/lib/auth/session`'s `currentUserId` is mocked so the
 * real `authenticatedRoute` runs and the real store writes to the harness. `MONGODB_URI` is pointed
 * at the in-memory replica set BEFORE the route modules are imported, so their GridFS bucket connects
 * to the harness rather than to a real cluster — the same wiring `media.test.ts` uses for the store.
 */

let harness: MongoHarness | undefined;

/** The session the mocked `currentUserId` answers with. Reassigned per test to switch identities. */
let currentUser: string | null = null;

vi.mock('@/lib/auth/session', () => ({
  currentUserId: () => Promise.resolve(currentUser),
}));

type UploadRoute = typeof import('@/app/api/media/route');
type ServeRoute = typeof import('@/app/api/media/[id]/route');
let uploadRoute: UploadRoute;
let serveRoute: ServeRoute;

const OWNER = 'farmer-owner-1';
const STRANGER = 'farmer-stranger-2';

const IMAGE_BYTES = Buffer.from('\xff\xd8\xff fake jpeg body for the media round trip', 'binary');

beforeAll(async () => {
  harness = await startMongo();
  process.env.MONGODB_URI = harness.replSet.getUri();
  uploadRoute = await import('@/app/api/media/route');
  serveRoute = await import('@/app/api/media/[id]/route');
  await setupDatabase(harness.db);
}, 120_000);

afterAll(async () => {
  await stopMongo(harness);
});

beforeEach(async () => {
  currentUser = null;
  if (harness) await clearDatabase(harness.db);
});

/* -------------------------------------------------------------------------- */
/* Helpers — drive the two handlers as a browser would                         */
/* -------------------------------------------------------------------------- */

/** POST a multipart body to the upload handler and return the response. */
function uploadRequest(kind: string, bytes: Buffer, mimeType: string): Promise<Response> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `upload.jpg`);
  const request = new Request('https://jamee.test/api/media', { method: 'POST', body: form });
  return uploadRoute.POST(request as NextRequest);
}

/** GET the serve handler for one file id, with the dynamic `params` Promise Next.js 16 passes. */
function serveRequest(fileId: string): Promise<Response> {
  const request = new Request(`https://jamee.test/api/media/${fileId}`, { method: 'GET' });
  return serveRoute.GET(request as NextRequest, { params: Promise.resolve({ id: fileId }) });
}

/** Upload a crop image as OWNER and return the fileId the endpoint minted. */
async function uploadAsOwner(): Promise<string> {
  currentUser = OWNER;
  const response = await uploadRequest('crop-image', IMAGE_BYTES, 'image/jpeg');
  expect(response.status).toBe(201);
  const body = (await response.json()) as { mediaRef: { fileId: string; kind: string } };
  expect(body.mediaRef.kind).toBe('crop-image');
  expect(body.mediaRef.fileId).toMatch(/^[0-9a-f]{24}$/);
  return body.mediaRef.fileId;
}

/* ========================================================================== */
/* The round trip                                                              */
/* ========================================================================== */

describe('Media_Endpoint round trip', () => {
  it('streams the exact bytes and MIME type back to the uploading owner (2.1, 2.5, 12.5)', async () => {
    const fileId = await uploadAsOwner();

    currentUser = OWNER;
    const served = await serveRequest(fileId);

    expect(served.status).toBe(200);
    expect(served.headers.get('Content-Type')).toBe('image/jpeg');
    // Requirement 13.5 — the object is one farmer's, never cached by a shared/CDN layer.
    expect(served.headers.get('Cache-Control')).toContain('private');

    const returned = Buffer.from(await served.arrayBuffer());
    expect(returned.equals(IMAGE_BYTES)).toBe(true);
  });

  it('answers 404 to a stranger, indistinguishable from a missing file (2.6)', async () => {
    const fileId = await uploadAsOwner();

    // The stranger reading the owner's real file.
    currentUser = STRANGER;
    const foreign = await serveRequest(fileId);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe('');

    // Anyone reading a well-formed but non-existent id gets the SAME 404 — no existence oracle.
    currentUser = OWNER;
    const missing = await serveRequest('a'.repeat(24));
    expect(missing.status).toBe(404);

    // And the owner still reads their own file, proving the stranger's 404 was about ownership.
    currentUser = OWNER;
    const ownRead = await serveRequest(fileId);
    expect(ownRead.status).toBe(200);
  });

  it('stamps metadata.ownerId from the session, so a stranger who uploads gets a different file', async () => {
    const ownerFileId = await uploadAsOwner();

    // The stranger uploads their own crop image; it must be a distinct GridFS file owned by them.
    currentUser = STRANGER;
    const strangerUpload = await uploadRequest('crop-image', Buffer.from('stranger bytes'), 'image/jpeg');
    expect(strangerUpload.status).toBe(201);
    const strangerFileId = ((await strangerUpload.json()) as { mediaRef: { fileId: string } }).mediaRef.fileId;
    expect(strangerFileId).not.toBe(ownerFileId);

    // Each reads only their own.
    currentUser = STRANGER;
    expect((await serveRequest(strangerFileId)).status).toBe(200);
    expect((await serveRequest(ownerFileId)).status).toBe(404);
    currentUser = OWNER;
    expect((await serveRequest(ownerFileId)).status).toBe(200);
    expect((await serveRequest(strangerFileId)).status).toBe(404);
  });

  it('rejects an unauthenticated upload and an unauthenticated read (1.7)', async () => {
    currentUser = null;
    const upload = await uploadRequest('crop-image', IMAGE_BYTES, 'image/jpeg');
    expect(upload.status).toBe(401);

    // Nothing was stored: a subsequent authenticated read of any id is a 404, not a hit.
    currentUser = null;
    const read = await serveRequest('a'.repeat(24));
    expect(read.status).toBe(401);
  });

  it('refuses a voice upload larger than the 3 MB cap, storing nothing (A3)', async () => {
    currentUser = OWNER;
    const tooBig = Buffer.alloc(3 * 1024 * 1024 + 1, 1);
    const response = await uploadRequest('voice', tooBig, 'audio/webm');

    // `storeMedia` refuses it through `assertAdmissible` before GridFS is touched.
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUDIO_TOO_LONG');
  });

  it('refuses an image whose MIME type is not accepted', async () => {
    currentUser = OWNER;
    const response = await uploadRequest('crop-image', Buffer.from('gif'), 'image/gif');

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_TYPE_UNSUPPORTED');
  });
});
