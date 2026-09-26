/**
 * The Media_Endpoint URL convention, in one place.
 *
 * Requirements: 2.8, 12.5 (a stored image or thumbnail is loaded through the owner-checked
 *               Media_Endpoint rather than a Supabase Signed_URL), 12.6 (the history list prefers
 *               the Thumbnail_Derivative), 12.8 / 12.9 (the detail view prefers the Full_Size_Image
 *               then falls back to the derivative)
 * Design: D1 (amended by Amendment A3 — the browser reads a file back through the Media_Endpoint,
 *         not a direct-to-Storage signed URL), D17, D18
 *
 * =============================================================================
 * WHY THE URL IS A PURE FUNCTION OF THE FILE ID, AND WHY IT LIVES HERE
 * =============================================================================
 *
 * Under Amendment A3 there is no Supabase Storage and no `createSignedUrl`. A stored file is a
 * GridFS object owned by `metadata.ownerId`, and it is served by `GET /api/media/<fileId>` — a
 * route (task 54.2) that streams the bytes back ONLY after the Data_Access_Layer has confirmed the
 * requesting Farmer owns the file. So the "which URL" question that used to mean "mint a
 * short-lived signed URL for this path" is now the constant, un-minted string this function
 * returns: no round trip, no expiry, no secret. The owner check happens at fetch time on the
 * endpoint, not at URL-build time — which is what lets a server component build these URLs for a
 * whole page of history entries with no I/O at all.
 *
 * It is a `24`-hex `fileId` because that is the wire shape of a Media_Reference (`mediaRefSchema`
 * in `src/lib/schemas.ts`: `{ fileId, kind }`, `fileId` a 24-character ObjectId hex string). The
 * convention `/api/media/<fileId>` is fixed, and this is the ONE place it is spelled, so a history
 * view, a detail view and the endpoint's own route cannot drift into two spellings of it.
 *
 * This module imports nothing and touches no driver, so it is safe in a server component, a client
 * component, and a unit test alike — it is a string builder, not a data-access path.
 */

/** The Media_Endpoint base path. Files are addressed by their GridFS `_id` hex string. */
export const MEDIA_ENDPOINT_BASE = '/api/media';

/**
 * The URL a browser fetches to load one stored media file.
 *
 * `fileId` is the GridFS `_id` as its 24-character hex string — the `fileId` half of a
 * Media_Reference. `encodeURIComponent` is not defensive theatre about the database: a real
 * ObjectId hex needs no escaping, and encoding it keeps this correct if it is ever handed a value
 * from somewhere other than a `mediaRef.fileId`.
 *
 * The returned URL carries no owner and no token by design — the Media_Endpoint reads the session
 * and confirms ownership against `metadata.ownerId` before it streams a byte (Requirement 2.6), so
 * a URL leaked to another farmer resolves to a 403 there rather than to someone else's photo.
 */
export function mediaUrl(fileId: string): string {
  return `${MEDIA_ENDPOINT_BASE}/${encodeURIComponent(fileId)}`;
}
