import { describe, expect, it } from 'vitest';

import { MediaUploadError, uploadMedia, type UploadFetch } from './upload';

/**
 * Unit tests for `src/lib/media/upload.ts` — the browser-side upload leg of the Media_Endpoint.
 *
 * Requirements: 2.1 / 8.1 (a file is uploaded and its Media_Reference returned), 2.7 (the analysis
 *               request then carries a reference, not bytes)
 *
 * The `fetch` seam is injected, so these tests are about what the helper puts on the wire (a
 * multipart body with `file` + `kind`, to `/api/media`) and what it does with the answer (validates
 * the reference; turns a non-ok status or a bad body into `MediaUploadError`).
 */

const FILE_ID = 'a'.repeat(24);

function ok(mediaRef: unknown): UploadFetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ mediaRef }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

function jpeg(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
}

describe('uploadMedia', () => {
  it('POSTs a multipart body carrying file and kind to /api/media, and returns the reference', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl: UploadFetch = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return ok({ fileId: FILE_ID, kind: 'crop-image' })(url, init);
    };

    const ref = await uploadMedia({ body: jpeg(), kind: 'crop-image', fetchImpl });

    expect(seenUrl).toBe('/api/media');
    expect(seenInit?.method).toBe('POST');
    expect(seenInit?.body).toBeInstanceOf(FormData);
    const form = seenInit?.body as FormData;
    expect(form.get('kind')).toBe('crop-image');
    expect(form.get('file')).toBeInstanceOf(Blob);

    expect(ref).toEqual({ fileId: FILE_ID, kind: 'crop-image' });
  });

  it('sends the voice kind for a recording', async () => {
    let form: FormData | undefined;
    const fetchImpl: UploadFetch = (url, init) => {
      form = init.body as FormData;
      return ok({ fileId: FILE_ID, kind: 'voice' })(url, init);
    };

    await uploadMedia({
      body: new Blob([new Uint8Array([9])], { type: 'audio/webm' }),
      kind: 'voice',
      fetchImpl,
    });

    expect(form?.get('kind')).toBe('voice');
  });

  it('throws MediaUploadError carrying the HTTP status on a non-ok response', async () => {
    const fetchImpl: UploadFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'FILE_TOO_LARGE' } }), { status: 400 }),
      );

    await expect(uploadMedia({ body: jpeg(), kind: 'crop-image', fetchImpl })).rejects.toMatchObject({
      name: 'MediaUploadError',
      status: 400,
    });
  });

  it('throws when the response carries no valid mediaRef', async () => {
    const fetchImpl = ok({ fileId: 'not-hex', kind: 'crop-image' });

    const error = await uploadMedia({ body: jpeg(), kind: 'crop-image', fetchImpl }).catch((e) => e);

    expect(error).toBeInstanceOf(MediaUploadError);
  });

  it('throws when the fetch itself rejects', async () => {
    const fetchImpl: UploadFetch = () => Promise.reject(new TypeError('Failed to fetch'));

    await expect(uploadMedia({ body: jpeg(), kind: 'crop-image', fetchImpl })).rejects.toBeInstanceOf(
      MediaUploadError,
    );
  });
});
