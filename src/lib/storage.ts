import {
  SIGNED_URL_EXPIRY_SECONDS,
  STORAGE_OWNER_PATH_SEGMENT_INDEX,
  type StorageBucket,
} from '@/lib/config/verified';
import { THUMBNAIL_PATH_INFIX } from '@/lib/config/media';
import { AppError } from '@/lib/errors';
import { storageRefSchema, type StorageRef } from '@/lib/schemas';

/**
 * Object paths, the ownership gate, and signed-URL minting — the one module that knows how a
 * Jamee storage object is named and who is allowed to read it.
 *
 * Requirements: 2.5 / 2.6 (a reference names the right bucket AND resolves to an object owned by
 *               the requesting farmer, verified before analysis starts; a failure is 403 with the
 *               quota untouched), 2.8 (the diagnosis read obtains image bytes through a
 *               Signed_URL), 2.13 (the Thumbnail_Derivative path is DERIVED from the
 *               Full_Size_Image path), 12.5 (every stored image or thumbnail the web app displays
 *               is loaded through a Signed_URL), 18.8 (a deletion happens only under the owning
 *               farmer's prefix)
 * Design: "0009: storage buckets and policies" → *Object path convention*, *Thumbnail path
 *         derivation*; "Media lifecycle and retention"; "Storage references"
 * Depends on: V3 — `createSignedUrl(path, expiresIn)`, expiresIn in **SECONDS**
 *
 * ### THE SHAPE OF A PATH IS NOT THE OWNER OF AN OBJECT
 *
 * `storageRefSchema` proves that a client-supplied reference has the right *shape*. It cannot
 * prove ownership and must never be read as though it does: the string came from the client.
 * Ownership is `assertOwnership()` below — a runtime comparison of the path's first segment
 * against the session user id, plus an object-exists probe — and it is the only thing in this
 * codebase that authorizes a storage read on the application side. The storage RLS policies in
 * migration `0009` are the independent second boundary for a farmer session; for the two
 * service-role paths (the WhatsApp adapter and the retention sweep) there is no second boundary,
 * so this check IS the boundary.
 *
 * ### WHY THIS MODULE IS NOT `server-only`
 *
 * Every function that touches a Supabase client takes the client as an ARGUMENT rather than
 * constructing one. Three consequences, and all three are the point:
 *
 *  1. **One implementation serves both channels.** The web path holds a farmer session and passes
 *     the RLS-scoped server client; the WhatsApp adapter has no session at all and passes the
 *     service-role client; `VoiceService`'s on-success delete and the retention sweep pass the
 *     service-role client too (Requirements 8.11, 18.9). A module that constructed its own client
 *     would have had to pick one of those and leave the others without a check.
 *  2. **No secret is reachable from here.** This file imports neither `@/lib/env` nor
 *     `@/lib/supabase/admin`, so the `import 'server-only'` guard belongs on those modules — where
 *     it already is — and not on this one.
 *  3. **`ImageUploader` can derive a thumbnail path.** Requirement 2.13 has the BROWSER produce
 *     and upload the Thumbnail_Derivative at the derived path, so `buildStorageRef()` and
 *     `thumbPathFor()` must be importable from a client component. A `server-only` import at the
 *     top of this file would make that a build error, and the uploader would end up with a second
 *     copy of the path convention — which is exactly the drift this module exists to prevent.
 */

/* ========================================================================== */
/* The client seam                                                             */
/* ========================================================================== */

/**
 * The narrow slice of a Supabase client this module actually uses.
 *
 * Structural rather than nominal on purpose: `SupabaseClient<Database>` from
 * `createServerSupabase()` and `AdminClient` from `createAdminClient()` both satisfy it without
 * either being imported here, which is what keeps this file free of `server-only`.
 *
 * The two method shapes mirror `@supabase/storage-js` as pinned by
 * `@supabase/supabase-js 2.116.0`. `exists()` in particular has a three-way outcome that
 * `assertOwnership()` depends on, documented at the call site.
 */
export interface StorageClientLike {
  storage: {
    from(bucket: string): {
      exists(path: string): Promise<{ data: boolean; error: unknown }>;
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<
        { data: { signedUrl: string }; error: null } | { data: null; error: unknown }
      >;
    };
  };
}

/* ========================================================================== */
/* Building a path                                                             */
/* ========================================================================== */

export interface BuildStorageRefInput {
  bucket: StorageBucket;
  /** The owning farmer's `auth.users.id`. Becomes the FIRST path segment, and nothing else may. */
  userId: string;
  /** File extension with or without a leading dot, e.g. `jpg`, `.webp`, `WEBM`. */
  extension: string;
  /** Injectable for tests. Defaults to now. */
  now?: Date;
  /** Injectable for tests. Defaults to `crypto.randomUUID()`. */
  objectId?: string;
}

/**
 * Build a `{user_id}/{YYYY}/{MM}/{uuid}.{ext}` object reference.
 *
 * **The bucket is not part of the path.** `StorageRef` carries `bucket` and `path` as separate
 * fields because that is what the Supabase API takes — `from(bucket).upload(path)` — and because
 * the storage RLS predicate reads `bucket_id` and `(storage.foldername(name))[1]` separately too.
 * The design writes paths as `crop-images/{user_id}/…` when describing a bucket's contents; that
 * is a display convention, not a `path` value.
 *
 * ### The date segments are ORGANIZATIONAL, and they are UTC
 *
 * Nothing derives a window, a deadline, or an age from `{YYYY}/{MM}`. The retention sweep reads
 * `diagnoses.created_at` for its row-driven scan and object metadata for its orphan scan (design:
 * *How the sweep finds its work*), so these segments only keep a bucket listing browsable.
 *
 * Deliberately **not** the `Asia/Kolkata` clock that `src/lib/time.ts` owns. That clock defines
 * the quota window (Requirement 14.1), and reusing it here would imply the path participates in
 * quota accounting, which it does not. UTC is also the one clock the browser and the server agree
 * on without either importing the other's timezone machinery, so a web upload and a WhatsApp
 * upload made in the same minute land in the same folder.
 *
 * A malformed result throws a plain `Error` rather than an `AppError`. `STORAGE_REF_INVALID` is
 * the code for a reference a CLIENT submitted (Requirement 2.2); a reference this builder produced
 * badly is a defect in Jamee, and it should surface as an internal error with a loud message
 * rather than as a localized sentence telling a farmer their upload was malformed.
 */
export function buildStorageRef(input: BuildStorageRefInput): StorageRef {
  const { bucket, userId } = input;
  const now = input.now ?? new Date();
  const objectId = input.objectId ?? crypto.randomUUID();
  const extension = normalizeExtension(input.extension);

  // `toISOString()` is UTC by definition, so this needs no formatter and cannot pick up the
  // runtime's local zone. Positions 0-3 are the year, 5-6 the zero-padded month.
  const iso = now.toISOString();
  const year = iso.slice(0, 4);
  const month = iso.slice(5, 7);

  const candidate: StorageRef = {
    bucket,
    path: `${userId}/${year}/${month}/${objectId}.${extension}`,
  };

  // The builder cannot be allowed to emit a path the contract rejects: `assertOwnership()` splits
  // on `/` and trusts the first segment to exist, and the storage policy compares that same
  // segment. Validating here means a bad `userId` fails at the upload site, naming the problem,
  // instead of becoming a 403 on the diagnosis request that follows.
  const parsed = storageRefSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `buildStorageRef produced a path that fails storageRefSchema: "${candidate.path}" ` +
        `(${parsed.error.issues[0]?.message ?? 'unknown reason'}). ` +
        'Expected {user_id}/{YYYY}/{MM}/{uuid}.{ext} — check that userId is a uuid and that the ' +
        'extension is 2-5 lowercase alphanumerics.',
    );
  }
  return parsed.data;
}

/** Lowercase, strip one optional leading dot. The schema enforces the rest. */
function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}

/* ========================================================================== */
/* Thumbnail paths — derived, never stored (Requirement 2.13)                   */
/* ========================================================================== */

/**
 * `thumbPathFor` and `originalPathFor` are **exact inverses**, and that is the whole mechanism:
 *
 * ```
 * a/2026/09/b.jpg        ->  a/2026/09/b.thumb.jpg
 * a/2026/09/b.thumb.jpg  ->  a/2026/09/b.jpg
 * ```
 *
 * **No column anywhere stores a thumbnail path.** `diagnoses` holds `image_bucket` and
 * `image_path` for the Full_Size_Image and nothing else — the design is explicit that
 * `image_path` is left intact even after the sweep deletes the original, precisely so the
 * surviving thumbnail stays derivable (Requirement 18.7). These two functions are therefore the
 * single source of that truth: a second derivation written inline anywhere else would be a second
 * place for the convention to drift, with no schema or constraint to catch the divergence.
 *
 * `THUMBNAIL_PATH_INFIX` lives in `config/media.ts` because the browser's re-encode pass reads it
 * from the same place the retention sweep's exclusion predicate does.
 *
 * The infix is matched **case-sensitively**. Only server-side and uploader code ever produces one
 * of these paths, both through `thumbPathFor()`, so `…/b.THUMB.jpg` is not a Jamee thumbnail —
 * treating it as one would let a hand-crafted name masquerade as a derivative the sweep must keep.
 */
function splitExtension(path: string): { stem: string; extension: string } {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = path.lastIndexOf('/');

  // `lastDot <= lastSlash + 1` catches all three degenerate cases at once: no dot at all
  // (`lastDot === -1`), a dot that belongs to a parent segment, and a dotfile with an empty stem
  // (`a/.jpg`). Each would make "insert before the final extension" meaningless.
  if (lastDot <= lastSlash + 1) {
    throw new Error(
      `storage path has no file extension to derive from: "${path}". Every Jamee object path ` +
        'ends in {uuid}.{ext} — see storageRefSchema.',
    );
  }

  const extension = path.slice(lastDot + 1);
  if (extension.length === 0) {
    throw new Error(`storage path ends in a bare dot, so it has no extension: "${path}"`);
  }
  return { stem: path.slice(0, lastDot), extension };
}

/** The Thumbnail_Derivative path for a Full_Size_Image path. */
export function thumbPathFor(originalPath: string): string {
  const { stem, extension } = splitExtension(originalPath);
  return `${stem}${THUMBNAIL_PATH_INFIX}.${extension}`;
}

/**
 * Whether a path names a Thumbnail_Derivative.
 *
 * This is the retention sweep's keep-predicate (Requirement 18.5) and the guard a caller uses
 * before `originalPathFor()`. A path whose stem is *only* the infix (`a/.thumb.jpg`) is not a
 * derivative of anything — there is no original stem left — so it reports `false` and
 * `originalPathFor()` rejects it rather than returning the truncated `a/`.
 */
export function isThumbPath(path: string): boolean {
  let stem: string;
  try {
    stem = splitExtension(path).stem;
  } catch {
    return false;
  }
  if (!stem.endsWith(THUMBNAIL_PATH_INFIX)) return false;

  const remaining = stem.slice(0, stem.length - THUMBNAIL_PATH_INFIX.length);
  return remaining.length > 0 && !remaining.endsWith('/');
}

/**
 * The Full_Size_Image path a Thumbnail_Derivative path was derived from.
 *
 * Removes **exactly one** infix, which is what makes the round trip hold even for an original
 * that already contained `.thumb.`: `b.thumb.jpg` → `b.thumb.thumb.jpg` → `b.thumb.jpg`.
 *
 * Throws on a path that is not a thumbnail path. Being lenient — returning the input unchanged —
 * would hide the one bug this function can have: a caller deriving an original from something
 * that was already an original, and then reporting "the full-size photo is no longer stored"
 * (Requirement 12.9) about an object that never existed. Check `isThumbPath()` first.
 */
export function originalPathFor(thumbPath: string): string {
  if (!isThumbPath(thumbPath)) {
    throw new Error(
      `not a Thumbnail_Derivative path: "${thumbPath}". Expected the literal ` +
        `"${THUMBNAIL_PATH_INFIX}" immediately before the final extension.`,
    );
  }
  const { stem, extension } = splitExtension(thumbPath);
  return `${stem.slice(0, stem.length - THUMBNAIL_PATH_INFIX.length)}.${extension}`;
}

/** The thumbnail reference for an image reference — same bucket, derived path. */
export function thumbRefFor(ref: StorageRef): StorageRef {
  return { bucket: ref.bucket, path: thumbPathFor(ref.path) };
}

/* ========================================================================== */
/* Ownership (Requirements 2.5, 2.6)                                           */
/* ========================================================================== */

/**
 * The path's first segment, or `undefined` when there is none.
 *
 * Reads `STORAGE_OWNER_PATH_SEGMENT_INDEX` from `config/verified.ts` rather than a literal `0`,
 * because that constant exists to tie this comparison to the `(storage.foldername(name))[1]`
 * predicate in migration `0009` (V4, Postgres arrays being 1-indexed). Two boundaries checking
 * two different segments would be worse than one boundary.
 */
export function ownerSegmentOf(path: string): string | undefined {
  return path.split('/')[STORAGE_OWNER_PATH_SEGMENT_INDEX];
}

/**
 * Reject unless `ref` is well-formed AND its first path segment is `userId` AND the object is
 * actually there.
 *
 * Called BEFORE any quota reserve, any provider call, and any delete. Requirement 2.6's "leave
 * the farmer's quota unchanged" is satisfied by that ordering rather than by anything in this
 * function: it takes no quota dependency and performs no reserve, so a route that reserved first
 * would have to make the reserve visibly precede this call.
 *
 * ### Three outcomes, in this order, and the order is load-bearing
 *
 *  1. **Malformed reference → `STORAGE_REF_INVALID` (400, Requirement 2.2).** The route already
 *     validated through `diagnoseRequestSchema`, so this is defence in depth — and it is what
 *     lets step 2 trust that a first segment exists at all.
 *  2. **Prefix mismatch → `STORAGE_REF_FORBIDDEN` (403, Requirement 2.6).** Checked *before* the
 *     probe, deliberately. The probe may be running on the service-role client, which bypasses
 *     RLS; probing first would mean Jamee had confirmed the existence of another farmer's object,
 *     even if it then refused to act on it. Comparing first means a cross-tenant path never
 *     reaches the network.
 *  3. **Object absent → `STORAGE_REF_FORBIDDEN` (403) as well.** See below.
 *
 * ### Why an absent object is 403 and not 404 or 400
 *
 * Requirement 2.5 is a single conjunctive gate: a reference must name the expected bucket *and*
 * resolve to an object owned by the requesting farmer. A path under the caller's own prefix that
 * resolves to nothing fails that gate just as squarely as a path under someone else's prefix, so
 * it gets the same rejection. Three further reasons to collapse the two rather than split them:
 *
 *  - **The probe cannot honestly tell them apart.** On the RLS-scoped client, "denied by policy"
 *    and "not there" arrive as the same 400/404. A distinct code would be claiming a precision
 *    the probe does not have.
 *  - **Requirement 2.6's real guarantee is the quota one**, and it holds identically on both
 *    branches — nothing has been reserved when either throws.
 *  - **A 404 would be an existence oracle.** The prefix check makes cross-tenant probing
 *    impossible today, so the leak would be narrow; but a code that means "no object at this
 *    path" is a primitive worth not building, and Requirement 15.6's spirit is to say less.
 *
 * The two branches stay distinguishable **server-side**: `context.reason` is `prefix_mismatch` or
 * `object_absent`, and `AppError.context` is written to the server log and structurally cannot
 * reach the response body (see `toEnvelope` in `src/lib/errors.ts`). So an operator debugging a
 * client that posts stale references can still tell which happened; the client cannot.
 *
 * ### What a thrown probe means
 *
 * `exists()` in the pinned `@supabase/storage-js` has three outcomes, and this function treats
 * them as three different things. `{ data: true }` is present. `{ data: false }` — which the SDK
 * returns for HTTP 400 and 404 — is absent. **Anything else throws**, including a network failure
 * and a 403 from a misconfigured policy, and that is neither a permission fact about the farmer
 * nor evidence of absence. Those become `INTERNAL_ERROR` (500) with the real cause logged, because
 * "Jamee could not determine ownership" must not be reported as "you do not own this".
 *
 * That three-way behaviour was read off the pinned package rather than from documentation (V3
 * covers `createSignedUrl` only), so re-check it when `@supabase/supabase-js` is upgraded.
 */
export async function assertOwnership(
  ref: StorageRef,
  userId: string,
  client: StorageClientLike,
): Promise<void> {
  const parsed = storageRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new AppError('STORAGE_REF_INVALID', {
      context: {
        reason: 'schema_rejected',
        issue: parsed.error.issues[0]?.message ?? 'unknown',
      },
    });
  }
  const validated = parsed.data;

  const owner = ownerSegmentOf(validated.path);
  if (owner !== userId) {
    throw new AppError('STORAGE_REF_FORBIDDEN', {
      context: {
        reason: 'prefix_mismatch',
        bucket: validated.bucket,
        // The requesting farmer, not the prefix owner: logging the prefix would copy another
        // farmer's id into a log line that the mismatch itself already accounts for.
        requestedBy: userId,
      },
    });
  }

  let present: boolean;
  try {
    const { data } = await client.storage.from(validated.bucket).exists(validated.path);
    present = data;
  } catch (cause) {
    throw new AppError('INTERNAL_ERROR', {
      cause,
      context: {
        reason: 'existence_probe_failed',
        bucket: validated.bucket,
        path: validated.path,
      },
    });
  }

  if (!present) {
    throw new AppError('STORAGE_REF_FORBIDDEN', {
      context: {
        reason: 'object_absent',
        bucket: validated.bucket,
        path: validated.path,
        requestedBy: userId,
      },
    });
  }
}

/**
 * `assertOwnership` narrowed to a bucket, for the two request shapes that name one.
 *
 * Requirements 2.5 and 2.6 make the bucket part of the same gate as the prefix. The wire schemas
 * already refine on it (`diagnoseRequestSchema`, `voiceRequestSchema`), so this is the same
 * defence-in-depth argument as the schema re-parse above: a service called from somewhere other
 * than a route handler still gets both halves of the check.
 */
export async function assertOwnershipInBucket(
  ref: StorageRef,
  userId: string,
  bucket: StorageBucket,
  client: StorageClientLike,
): Promise<void> {
  if (ref.bucket !== bucket) {
    throw new AppError('STORAGE_REF_FORBIDDEN', {
      context: { reason: 'wrong_bucket', expected: bucket, received: ref.bucket },
    });
  }
  await assertOwnership(ref, userId, client);
}

/* ========================================================================== */
/* Signed URLs (Requirements 2.8, 12.5)                                        */
/* ========================================================================== */

/**
 * Mint a signed URL for one object, or `null` when it cannot be signed.
 *
 * **V3: the second argument to `createSignedUrl` is a number of SECONDS**, not milliseconds. The
 * parameter is named `expiresInSeconds` here and the default is
 * `SIGNED_URL_EXPIRY_SECONDS` from `config/verified.ts`, so the unit is stated at every point a
 * reader could get it wrong. A factor-of-1000 error fails in the forgiving direction — a URL that
 * lives ten minutes instead of six-tenths of a second — which is exactly why it needs stating
 * rather than inferring.
 *
 * One function serves both readers named in the task, because they need the same thing:
 *  - Requirement 2.8 — `DiagnosisService` fetches the image bytes through a signed URL. Providers
 *    take a URL (V6's Gemini image input, V9's Groq `image_url`), so the object never passes
 *    through Jamee's own memory.
 *  - Requirement 12.5 — the history list and detail view load the thumbnail and the full-size
 *    image through signed URLs, because both buckets are private (Requirement 13.5).
 *
 * **Returning `null` rather than throwing is what the history views need.** After the retention
 * sweep, a Full_Size_Image is legitimately gone while its row and its thumbnail remain
 * (Requirements 18.3, 18.5, 18.7), and Requirements 12.9 and 12.10 define exactly what to render
 * then: the thumbnail plus plain-language copy, or no image plus plain-language copy. An absent
 * object is an expected state on that path, not an error. Use `signedUrlFor()` where absence is
 * genuinely a failure.
 *
 * No batch variant yet. V3 records `createSignedUrls(paths, expiresIn)` with the same units, and a
 * 20-entry history list is the obvious caller — but its per-path error shape belongs with the view
 * that has to render per-entry fallbacks (Requirements 12.7, 12.9, 12.10), so it is left to that
 * task rather than guessed at here.
 */
export async function signedUrlOrNull(
  ref: StorageRef,
  client: StorageClientLike,
  expiresInSeconds: number = SIGNED_URL_EXPIRY_SECONDS,
): Promise<string | null> {
  try {
    const { data, error } = await client.storage
      .from(ref.bucket)
      .createSignedUrl(ref.path, expiresInSeconds);
    if (error !== null || data === null) return null;
    return data.signedUrl;
  } catch {
    // A transport failure and a missing object are both "no URL to render" to a view that already
    // has copy for a missing image. The distinction matters to `signedUrlFor()`, which is where a
    // caller that cannot proceed without the bytes goes.
    return null;
  }
}

/**
 * Mint a signed URL, or throw.
 *
 * For the diagnosis read path (Requirement 2.8): if the bytes cannot be reached there is nothing
 * to classify, and continuing would mean sending a provider a URL that 404s and reading the result
 * as an inconclusive diagnosis — a provider bill and a farmer-visible wrong answer for what is a
 * storage problem. `INTERNAL_ERROR` rather than a storage code because, by the time this runs,
 * `assertOwnership()` has already confirmed the object was there.
 */
export async function signedUrlFor(
  ref: StorageRef,
  client: StorageClientLike,
  expiresInSeconds: number = SIGNED_URL_EXPIRY_SECONDS,
): Promise<string> {
  const url = await signedUrlOrNull(ref, client, expiresInSeconds);
  if (url === null) {
    throw new AppError('INTERNAL_ERROR', {
      context: {
        reason: 'signed_url_failed',
        bucket: ref.bucket,
        path: ref.path,
        expiresInSeconds,
      },
    });
  }
  return url;
}

/* ========================================================================== */
/* Object size (Requirement 8.3's server-side half, V10's provider cap)        */
/* ========================================================================== */

/**
 * The narrow slice of a Supabase client the size probe uses.
 *
 * **Deliberately separate from `StorageClientLike`.** `info()` has exactly one caller
 * (`/api/voice`), and widening the shared seam would make every fake that only ever needed an
 * ownership probe grow a method it never calls — for no gain in either boundary.
 *
 * `info(path)` resolves to the object's own metadata, `size` in bytes among it. That shape was read
 * off the pinned `@supabase/storage-js` (`@supabase/supabase-js 2.116.0`) rather than from a
 * V-item, the same way `exists()`'s three-way outcome above was: V3 covers `createSignedUrl` only.
 * **Re-check it when `@supabase/supabase-js` is upgraded** — and note that a storage deployment
 * that does not serve `/object/info` degrades to "size unknown" rather than to a failure, which is
 * the whole reason `objectSizeOf()` reports absence instead of throwing.
 */
export interface ObjectInfoClientLike {
  storage: {
    from(bucket: string): {
      info(path: string): Promise<{
        data: { readonly size?: number | undefined } | null;
        error: unknown;
      }>;
    };
  };
}

/**
 * The object's real size in bytes, or `undefined` when storage did not answer with one.
 *
 * ### Why a server-side size probe exists at all
 *
 * Requirement 8.2 admits recordings up to 10 MB and Requirement 8.3 declines the rest — and until
 * this function, the *only* enforcement of that half was `VoiceRecorder`'s check on the blob it had
 * just recorded. The duration half is re-checked server-side (`voiceRequestSchema.durationSeconds`,
 * then `assertAdmissibleAudio()`); the size half had nothing, because the wire contract carries no
 * byte count and `exists()` returns a boolean rather than metadata. V10's 25 MB provider cap in
 * `groq.ts` was therefore unreachable on the web path: `TranscribeRequest.bytes` is optional and
 * nothing on that path supplied it.
 *
 * The object itself is the authority on its own size, which is why this reads storage rather than
 * trusting a number the client could have put in the body. One metadata round trip, before the
 * quota reserve, is the price.
 *
 * ### Absence is reported, never thrown, and never silent
 *
 * A probe that cannot answer must not fail a request the ownership gate already accepted — the
 * bytes are in the bucket and the farmer is waiting. So every failure path returns `undefined`,
 * `assertAdmissibleAudio()` skips a check it has no number for, and the request proceeds exactly as
 * it did before this function existed.
 *
 * `console.warn` is what keeps that from being a guard quietly switched off: an unanswered probe is
 * one log line per voice request, which is loud enough to notice and cheap enough to leave in. It
 * is a `warn` rather than an `error` because nothing is broken for the farmer.
 *
 * The caller passes its own client, so on the web path this runs under the farmer's session and
 * `voice_messages_read_own` (migration `0009`) confines it to their own prefix. A path outside it
 * yields `undefined` here and a 403 from `assertOwnership()` moments later, so this cannot become
 * an existence or size oracle for another farmer's objects.
 */
export async function objectSizeOf(
  ref: StorageRef,
  client: ObjectInfoClientLike,
): Promise<number | undefined> {
  let size: number | undefined;

  try {
    const { data, error } = await client.storage.from(ref.bucket).info(ref.path);
    if (error !== null && error !== undefined) {
      warnSizeUnknown(ref, 'info_error', error);
      return undefined;
    }
    size = data?.size;
  } catch (cause) {
    warnSizeUnknown(ref, 'info_threw', cause);
    return undefined;
  }

  // A metadata row without a size, or one carrying something that is not a usable number, is the
  // same fact as no answer at all: there is nothing to compare a limit against.
  if (size === undefined || !Number.isFinite(size) || size < 0) {
    warnSizeUnknown(ref, 'size_absent', size);
    return undefined;
  }
  return size;
}

function warnSizeUnknown(ref: StorageRef, reason: string, detail: unknown): void {
  console.warn(
    '[jamee] object_size_unknown',
    JSON.stringify({ reason, bucket: ref.bucket, path: ref.path }),
    detail instanceof Error ? (detail.stack ?? detail.message) : String(detail),
  );
}

/**
 * ### What is deliberately NOT here
 *
 * **No thumbnail-then-original fallback helper.** Requirements 12.6, 12.7, 12.9 and 12.10 need one,
 * but the decision it makes is not a storage decision: the design has the history view read
 * `diagnoses.full_image_deleted_at` to choose between "here is the thumbnail" and "the full-size
 * photo is no longer stored", and a helper in this module has no access to that column. Building
 * the fallback out of `thumbRefFor()` + `signedUrlOrNull()` at the view — where the row is already
 * in hand — keeps the presence question and the copy question in one place. Composing it here
 * would also have made the fallback depend on `createSignedUrl` failing for a missing object,
 * which V3 does not state, whereas `exists()` above has behaviour that was actually read off the
 * pinned package.
 */
