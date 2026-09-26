import 'server-only';

import { Buffer } from 'node:buffer';

import {
  ACCEPTED_IMAGE_TYPES,
  MAX_AUDIO_BYTES,
  REQUEST_BODY_CEILING_BYTES,
} from '@/lib/config/verified';
import type { MediaRefDoc } from '@/lib/db/collections';
import {
  deleteMediaForOwner,
  readMediaForOwner,
  writeMedia,
  type MediaBytes,
} from '@/lib/db/media';
import type { MediaKind } from '@/lib/db/names';
import { AppError } from '@/lib/errors';

/**
 * The application-level media wrapper — the ONE place a byte payload is admitted (kind, MIME type,
 * and size validated) before it reaches the GridFS store in `src/lib/db/media.ts`.
 *
 * Requirements: 2.3, 2.4 (an image is admitted on its type and size, both stated on rejection),
 *               2.5, 2.6 (a file is read only by the Farmer who owns it), 2.7 (a stored payload
 *               stays under the 4.5 MB Request_Body_Ceiling, V16), 8.2, 8.3 (a voice recording is
 *               at most 3 MB under Amendment A3), 12.5 (the owner-checked read the history views
 *               use)
 * Design: D1 (amended — the upload leg carries bytes through the Media_Endpoint), D17, D18; V29
 *
 * =============================================================================
 * WHY VALIDATION LIVES HERE AND NOT IN `src/lib/db/media.ts`
 * =============================================================================
 *
 * The DAL media store (D18) is the mechanism: it writes, reads, and deletes GridFS files owned by a
 * farmer. It deliberately validates NOTHING about the bytes — a store that also decided whether a
 * MIME type is acceptable would be two responsibilities in the module the CI check pins as the
 * driver holder. So the size and type rules — which are Jamee's own product numbers from
 * `config/verified.ts`, not database facts — sit one layer up, here, and this wrapper is what every
 * route and service calls. It is still under `src/lib/**` server code and imports no driver, so it
 * does not touch the `check-data-access` boundary.
 *
 * The numbers, and why each ceiling is the one it is:
 *  - **Images** are admitted on `ACCEPTED_IMAGE_TYPES` (jpeg/png/webp) and must land under the
 *    4.5 MB Request_Body_Ceiling (V16), because under A3's amended D1 the upload leg carries the
 *    bytes through the Media_Endpoint rather than direct-to-Storage. The browser re-encodes toward
 *    ~400 KB before upload (Requirement 2.10), so a compliant image is far under this — the ceiling
 *    is the wrapper's defence against a hand-built request, not a limit the normal path approaches.
 *    (Requirements 2.3/2.4's 10 MB gate is on the file the farmer *selects*, before re-encode, and
 *    is enforced client-side; what reaches GridFS is the re-encoded object, which this bounds.)
 *  - **Thumbnails** are the browser's ~25 KB derivative and share the image type list and the same
 *    ceiling; nothing else could produce one.
 *  - **Voice** is at most `MAX_AUDIO_BYTES` — 3 MB under A3 (down from 10 MB), because the voice
 *    upload leg must also fit under the 4.5 MB ceiling and 3 MB leaves margin for multipart framing.
 *    Its MIME type is checked against the transcription provider's accepted containers so an
 *    unusable recording is refused before it is stored, not after a provider rejects it.
 */

/* ========================================================================== */
/* The per-kind admission rules                                                */
/* ========================================================================== */

/**
 * The transcription provider's accepted audio MIME types — the containers V10 records. A Telegram
 * `voice` note is OGG/Opus and a browser recording is typically WebM/Opus; both are here. Kept as a
 * MIME-type list rather than the container-name list in `verified.ts` because the byte payload's
 * MIME type is what the uploader and the Telegram adapter actually report.
 */
const ACCEPTED_VOICE_TYPES = [
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
] as const;

interface KindRule {
  readonly acceptedTypes: readonly string[];
  readonly maxBytes: number;
  /** Which taxonomy code an over-size payload of this kind raises. */
  readonly tooLargeCode: 'FILE_TOO_LARGE' | 'AUDIO_TOO_LONG';
  /** Which taxonomy code a wrong MIME type of this kind raises. */
  readonly typeCode: 'FILE_TYPE_UNSUPPORTED' | 'AUDIO_FORMAT_UNSUPPORTED';
}

const RULES: Record<MediaKind, KindRule> = {
  'crop-image': {
    acceptedTypes: ACCEPTED_IMAGE_TYPES,
    maxBytes: REQUEST_BODY_CEILING_BYTES,
    tooLargeCode: 'FILE_TOO_LARGE',
    typeCode: 'FILE_TYPE_UNSUPPORTED',
  },
  thumbnail: {
    acceptedTypes: ACCEPTED_IMAGE_TYPES,
    maxBytes: REQUEST_BODY_CEILING_BYTES,
    tooLargeCode: 'FILE_TOO_LARGE',
    typeCode: 'FILE_TYPE_UNSUPPORTED',
  },
  voice: {
    acceptedTypes: ACCEPTED_VOICE_TYPES,
    maxBytes: MAX_AUDIO_BYTES,
    tooLargeCode: 'AUDIO_TOO_LONG',
    typeCode: 'AUDIO_FORMAT_UNSUPPORTED',
  },
};

/** The three kinds this wrapper admits, as a runtime set for validating a caller-supplied string. */
const KNOWN_KINDS = new Set<string>(Object.keys(RULES));

/* ========================================================================== */
/* Admission                                                                   */
/* ========================================================================== */

/**
 * Validate a payload's `kind`, `mimeType`, and byte length against the per-kind rule. Throws the
 * taxonomy `AppError` a farmer reads on the first failure; returns the narrowed `MediaKind` when it
 * passes. Exported so a caller can validate without writing (the route can reject before touching
 * the store).
 *
 * A normalized MIME type (lower-cased, parameters after `;` dropped) is compared, because a browser
 * may report `audio/webm;codecs=opus` and the accepted list holds bare container types.
 */
export function assertAdmissible(kind: string, mimeType: string, byteLength: number): MediaKind {
  if (!KNOWN_KINDS.has(kind)) {
    throw new AppError('STORAGE_REF_INVALID', {
      context: { reason: 'unknown_media_kind', kind },
    });
  }
  const mediaKind = kind as MediaKind;
  const rule = RULES[mediaKind];

  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!rule.acceptedTypes.includes(normalized)) {
    throw new AppError(rule.typeCode, {
      context: { reason: 'unsupported_media_type', kind: mediaKind, mimeType: normalized },
    });
  }

  if (byteLength <= 0 || byteLength > rule.maxBytes) {
    throw new AppError(rule.tooLargeCode, {
      context: { reason: 'media_size_out_of_range', kind: mediaKind, byteLength, maxBytes: rule.maxBytes },
    });
  }

  return mediaKind;
}

/* ========================================================================== */
/* Write / read / delete — validated, then delegated                           */
/* ========================================================================== */

/**
 * Admit and store one media payload for `ownerId`, returning the Media_Reference the domain
 * document stores. Validation runs BEFORE the store is touched, so an oversized or wrong-type
 * payload never becomes a GridFS file.
 */
export async function storeMedia(
  ownerId: string,
  kind: string,
  mimeType: string,
  bytes: Buffer,
  sourceRef?: string | null,
): Promise<MediaRefDoc> {
  const mediaKind = assertAdmissible(kind, mimeType, bytes.byteLength);
  return writeMedia(ownerId, mediaKind, mimeType, bytes, sourceRef);
}

/**
 * Read a file's bytes for the Farmer who owns it. Returns `null` when the caller does not own the
 * file OR it does not exist — the store makes those indistinguishable (Requirement 2.6), and this
 * wrapper preserves that rather than turning one into a distinguishable error.
 */
export async function fetchMediaForOwner(ownerId: string, fileId: string): Promise<MediaBytes | null> {
  return readMediaForOwner(ownerId, fileId);
}

/**
 * Delete a file the Farmer owns. Returns whether a file was removed; a non-owner's attempt and an
 * already-absent file both return `false` without error (the idempotence the retention sweep and a
 * double-submit both rely on).
 */
export async function removeMediaForOwner(ownerId: string, fileId: string): Promise<boolean> {
  return deleteMediaForOwner(ownerId, fileId);
}

/** Re-exported so callers type against one media surface. */
export type { MediaBytes } from '@/lib/db/media';
