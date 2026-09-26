'use client';

import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import { useJameeRequests, type DiagnoseBody } from '@/components/LanguageProvider';
import {
  DOWNSCALE_TARGET_BYTES,
  FULL_SIZE_MAX_EDGE_PX,
  FULL_SIZE_QUALITY_LADDER,
  THUMBNAIL_MAX_EDGE_PX,
  THUMBNAIL_QUALITY,
} from '@/lib/config/media';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  type AcceptedImageType,
} from '@/lib/config/verified';
import { AppError, toEnvelope } from '@/lib/errors';
import { interpolate, messages } from '@/lib/messages';
import type { ErrorCode, Language, MediaKind, MediaRef } from '@/lib/schemas';
import { uploadMedia } from '@/lib/media/upload';

import styles from './ImageUploader.module.css';

/**
 * Choose or photograph a leaf, re-encode it in the browser, upload it and its thumbnail
 * straight to storage, then post the reference.
 *
 * Requirements: 2.1 (the Full_Size_Image goes browser-direct to `crop-images` and only the
 *               Storage_Reference is sent to the API), 2.3 / 2.4 (accept jpeg/png/webp up to
 *               10 MB; a rejection states the accepted types AND the limit), 2.7 (the request
 *               body stays a reference, so it is never near the 4.5 MB ceiling), 2.9 (2.3 and
 *               2.4 are evaluated against the file the farmer SELECTS, before any re-encode),
 *               2.10 / 2.11 (re-encode toward the Downscale_Target and upload that in place of
 *               the selected file; the target is a target), 2.12 (retain enough pixel
 *               resolution for lesion detail; prefer exceeding the target over destroying it),
 *               2.13 (also produce and upload a Thumbnail_Derivative at the DERIVED path),
 *               2.14 (a thumbnail upload that fails after the full image succeeded still sends
 *               the diagnosis request), 15.2 (every indicator is bound to an observed request
 *               state), 15.5 (an upload failure is reported and NO diagnosis request is sent)
 * Design: "Frontend" → *Browser-direct upload*, *Honest loading states*, *Mobile layout and
 *          accessibility*; "Media lifecycle and retention" → mechanisms 1 and 2
 *
 * ### The order of operations, and why it is this order
 *
 * ```
 * select ──▶ admit (2.3, 2.4, 2.9)  ──▶ re-encode (2.10–2.13) ──▶ upload full (2.1)
 *                    │                                                    │
 *                    └─▶ decline, no bytes leave the phone                ├─▶ fail: report,
 *                                                                         │   NO diagnosis (15.5)
 *                                                                         ▼
 *                                              upload thumbnail ──▶ fail: keep going (2.14)
 *                                                                         │
 *                                                                         ▼
 *                                                        POST { image: ref } (2.1, 2.2)
 * ```
 *
 * **Admission runs on the selected file, before the re-encode.** That is Requirement 2.9 stated
 * literally, and it is what keeps the 10 MB allowance real: a 9 MB photo is admitted with no
 * size complaint and only then shrunk. Checking after the re-encode would make the ceiling
 * meaningless, because every re-encoded image is ~400 KB.
 *
 * **The full image is uploaded before the thumbnail.** Requirement 2.14 is written about a
 * thumbnail that fails *after* its full image succeeded, and that ordering is the reason: the
 * Full_Size_Image is the object the diagnosis reads, the thumbnail only makes the history list
 * cheap to render (Requirements 12.6, 18.5). A missing thumbnail degrades a later screen; a
 * missing diagnosis loses the request the farmer actually made.
 *
 * ### The thumbnail path is derived, never composed here
 *
 * `thumbRefFor()` (which is `thumbPathFor()` plus the same bucket) comes from
 * `src/lib/storage.ts`, and that is deliberate: no column stores a thumbnail path, so that
 * module is the single source of the convention and the retention sweep's keep-predicate reads
 * the same infix from the same place. A second derivation written inline here would be a second
 * place for it to drift, with no constraint to catch the divergence. `src/lib/storage.ts` is
 * importable from a client component precisely so this file can call it.
 *
 * ### What task 12.2 has to wire
 *
 * This component owns the upload and the diagnosis request; it does not render a result.
 * `/diagnose` (task 12.2) must:
 *
 *  1. resolve the session server-side and pass `userId` — the first path segment of every
 *     object, and the value the storage policy re-checks against `auth.uid()`;
 *  2. wrap this component in `<LanguageProvider>`, because `useJameeRequests()` is the only way
 *     to reach `/api/diagnose` and it takes the language from that context (Requirement 9.2);
 *  3. pass `onDiagnosisResponse` and render `DiagnosisResultCard` from it inside an
 *     `aria-live="polite"` region — including the **non-ok** case, where the envelope's message
 *     and a retry action are Requirement 15.4's job. This component reports only what it can
 *     see for itself: a declined file, a failed re-encode, a failed upload, and a diagnosis
 *     request that never produced a response at all.
 *  4. NOT add a second loading indicator. The two honest strings — `loading.uploading` while
 *     objects are going to the bucket, `loading.analyzing` while the POST is open — are
 *     rendered here, because this is the component holding the request.
 */

/* ========================================================================== */
/* Admission — on the SELECTED file (Requirements 2.3, 2.4, 2.9)               */
/* ========================================================================== */

/** The two ways a selected file is declined. Both are `ErrorCode`s, so both have catalog copy. */
export type AdmissionCode = Extract<ErrorCode, 'FILE_TYPE_UNSUPPORTED' | 'FILE_TOO_LARGE'>;

/**
 * The slice of `File` admission actually reads. A test constructs one of these rather than
 * fabricating image bytes: the check is about the MIME type the browser reported and the byte
 * count it measured, and neither becomes more real for having a JPEG behind it.
 */
export interface SelectedFileFacts {
  type: string;
  size: number;
}

/**
 * Which rejection a selected file earns, or `null` when it is admitted.
 *
 * The type check comes first, so a 12 MB PDF is reported as the wrong kind of file rather than
 * as a large one — the type is the more actionable fact, and the message for it names the size
 * limit anyway.
 *
 * `size` is compared with `>`: `MAX_IMAGE_BYTES` is *inclusive*, because Requirement 2.3 says
 * "up to 10 MB". A file of exactly 10 485 760 bytes is admitted.
 */
export function admissionCode(file: SelectedFileFacts): AdmissionCode | null {
  const accepted: readonly string[] = ACCEPTED_IMAGE_TYPES;
  if (!accepted.includes(file.type)) return 'FILE_TYPE_UNSUPPORTED';
  if (file.size > MAX_IMAGE_BYTES) return 'FILE_TOO_LARGE';
  return null;
}

/**
 * The farmer-facing sentence for a rejection, in the active language.
 *
 * **Requirement 2.4 wants both facts on every rejection** — the accepted types and the size
 * limit — and only `FILE_TYPE_UNSUPPORTED`'s copy carries both ("Please choose a JPG, PNG or
 * WebP photo of up to 10 MB."). So that string is used as the shared *instruction*, and
 * `FILE_TOO_LARGE`'s copy is prepended as the *reason* when that is what happened. A
 * too-large file therefore reads: reason, then what to send instead.
 *
 * Both come through `toEnvelope`, which is what fills `{maxMb}` from `MAX_IMAGE_BYTES` — the
 * same constant `admissionCode()` compares against. A hand-written "10 MB" here could disagree
 * with the check that produced the message, which Requirement 2.4 makes a farmer-visible
 * defect.
 */
export function rejectionMessage(code: AdmissionCode, language: Language): string {
  const instruction = toEnvelope(new AppError('FILE_TYPE_UNSUPPORTED'), language).error.message;
  if (code === 'FILE_TYPE_UNSUPPORTED') return instruction;
  const reason = toEnvelope(new AppError('FILE_TOO_LARGE'), language).error.message;
  return `${reason} ${instruction}`;
}

/**
 * The same rejection as what `ErrorBanner` renders.
 *
 * The message is `rejectionMessage`'s composition; the `language` and the `retryable` flag come from
 * the envelope, so the taxonomy still decides whether a retry is offered. Both admission codes are
 * `retryable: false` in `ERROR_SPECS` and that is the right answer here: the same file re-sent is
 * declined identically, and choosing a different photo is a new request rather than a retry of this
 * one.
 */
function rejectionBanner(code: AdmissionCode, language: Language): ErrorBannerError {
  const { error } = toEnvelope(new AppError(code), language);
  return { message: rejectionMessage(code, language), language, retryable: error.retryable };
}

/**
 * The limit as a farmer reads it, from the same constant the check compares against.
 *
 * Mirrors `templateValues()` in `src/lib/errors.ts`, which fills `{maxMb}` for the error copy
 * the same way. The arithmetic is duplicated; `MAX_IMAGE_BYTES` is not, and that is the part
 * that could drift.
 */
const MAX_IMAGE_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

/**
 * The standing hint under both inputs: the accepted types, the limit, and the one piece of
 * advice that changes the outcome.
 *
 * Requirement 2.4 only demands both facts on a *rejection*, but stating them before a farmer
 * opens the picker is what prevents most of them — and `ui.imageHint` is the catalog string
 * written for this slot, so the daylight advice arrives in the farmer's own language too.
 */
export function imageHint(language: Language): string {
  return interpolate(messages(language).ui.imageHint, { maxMb: MAX_IMAGE_MB });
}

/* ========================================================================== */
/* Re-encode (Requirements 2.10–2.13)                                          */
/* ========================================================================== */

/**
 * One output MIME type for both derivatives, and it is JPEG.
 *
 * Requirement 2.10 requires an Accepted_Image_Type, which leaves three candidates:
 *  - **PNG is lossless**, so `quality` does nothing and a 1600 px leaf photo lands in the
 *    megabytes — the Downscale_Target would be unreachable by construction.
 *  - **WebP encodes smaller than JPEG at equal quality**, and is the better format on paper.
 *    But `canvas.toBlob` support for it is not universal on the phones this pilot targets, and
 *    a browser that does not support the requested type silently falls back to PNG — which
 *    would produce a multi-megabyte object with no error to notice.
 *  - **JPEG is the one every target browser can encode**, and it is what a phone camera
 *    produces anyway.
 *
 * Both the full image and the thumbnail use it, which is also why the extension is not a second
 * thing to derive: `thumbPathFor()` keeps the original's extension.
 */
export const REENCODE_TYPE: AcceptedImageType = 'image/jpeg';
export const REENCODE_EXTENSION = 'jpg';

export interface EncodedCropImage {
  /** The Full_Size_Image bytes (Requirement 2.10). */
  full: Blob;
  /**
   * The Thumbnail_Derivative bytes (Requirement 2.13), or `null` when the browser could not
   * produce one. `null` is treated exactly like a failed thumbnail upload — see Requirement
   * 2.14 — rather than as a reason to abandon a diagnosis.
   */
  thumbnail: Blob | null;
  contentType: AcceptedImageType;
  extension: string;
  /** What the pass actually achieved. Recorded for the log and the tests, never rendered. */
  outcome: {
    width: number;
    height: number;
    quality: number;
    /** `false` means the object is above the Downscale_Target — allowed by 2.11 and 2.12. */
    reachedTarget: boolean;
  };
}

/** The seam a test substitutes: jsdom has neither `createImageBitmap` nor a canvas encoder. */
export type CropImageEncoder = (file: Blob) => Promise<EncodedCropImage>;

/**
 * Longest-edge cap that never upscales. A small photo is left at its own resolution.
 *
 * Exported because it is the whole of Requirement 2.12's resolution decision, and it is
 * testable without a canvas — which the two render paths are not.
 */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function renderToBlob(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas 2d context unavailable');

  /**
   * JPEG has no alpha channel. Without this, the transparent background of a PNG a farmer
   * cropped in a gallery app comes out **black**, and a black frame around a leaf is not a
   * neutral change to an image a classifier is about to judge.
   */
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size.width, size.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size.width, size.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('canvas.toBlob produced no blob'));
        else resolve(blob);
      },
      REENCODE_TYPE,
      quality,
    );
  });
}

/**
 * Re-encode an admitted file into a Full_Size_Image and its Thumbnail_Derivative.
 *
 * ### The tradeoff Requirement 2.12 forces, and how it is resolved
 *
 * Requirement 2.12 puts resolution above bytes: keep enough pixels for lesion detail to stay
 * diagnosable, and **prefer an image above the Downscale_Target over one whose lesions are no
 * longer visible**. So this pass has exactly one degree of freedom, and it is quality:
 *
 *  1. **Resolution is set once and never traded.** The longest edge goes to at most
 *     `FULL_SIZE_MAX_EDGE_PX` (1600), and never below — that figure is the resolution *floor*
 *     for early- and late-blight features: concentric rings, lesion margins, and white
 *     sporulation on a leaf underside are tens of pixels across on a leaf that fills part of
 *     the frame. A photo already smaller than 1600 px is left alone rather than upscaled.
 *  2. **Quality walks down** the `FULL_SIZE_QUALITY_LADDER` (0.82 → 0.52), stopping at the
 *     first output at or under `DOWNSCALE_TARGET_BYTES`. Quality loss degrades lesion detail
 *     more gracefully than resolution loss does: a slightly blockier ring is still a ring,
 *     while a 600 px leaf has no ring left to blur.
 *  3. **If 0.52 still misses the target, that output is uploaded anyway.** This is the branch
 *     Requirement 2.12 is about, and `outcome.reachedTarget` records it as `false`. The target
 *     is a target (Requirement 2.11) and nothing rejects a file for missing it; the retention
 *     arithmetic carries ~400 KB as a planning figure, not a guarantee, and a busy leaf canopy
 *     that will not compress is a photo worth diagnosing.
 *
 * The thumbnail is produced from the same decoded bitmap in the same pass, at
 * `THUMBNAIL_MAX_EDGE_PX` / `THUMBNAIL_QUALITY`. It is a **separate render, not a re-encode of
 * the full output**, so its detail comes from the original pixels rather than from an image
 * that has already been through JPEG once. A thumbnail failure is swallowed to `null`: it costs
 * a history-list optimisation, not a diagnosis (Requirement 2.14).
 */
export async function encodeCropImage(file: Blob): Promise<EncodedCropImage> {
  /**
   * `createImageBitmap` rather than an `<img>` and an object URL: it decodes off the main
   * thread, it needs no load/error event plumbing, and a file the browser cannot decode
   * rejects here — which the caller reports as a re-encode failure and no diagnosis request,
   * rather than uploading bytes nothing can read.
   */
  const bitmap = await createImageBitmap(file);
  try {
    const fullSize = scaledSize(bitmap.width, bitmap.height, FULL_SIZE_MAX_EDGE_PX);

    let full: Blob | null = null;
    let quality = 0;
    for (const step of FULL_SIZE_QUALITY_LADDER) {
      full = await renderToBlob(bitmap, fullSize, step);
      quality = step;
      if (full.size <= DOWNSCALE_TARGET_BYTES) break;
    }
    if (full === null) {
      // Unreachable: the ladder is a non-empty `as const` tuple. Stated rather than asserted,
      // because a silent `!` here would hide an empty ladder as a broken upload.
      throw new Error('FULL_SIZE_QUALITY_LADDER is empty');
    }

    const thumbSize = scaledSize(bitmap.width, bitmap.height, THUMBNAIL_MAX_EDGE_PX);
    let thumbnail: Blob | null;
    try {
      thumbnail = await renderToBlob(bitmap, thumbSize, THUMBNAIL_QUALITY);
    } catch {
      thumbnail = null;
    }

    return {
      full,
      thumbnail,
      contentType: REENCODE_TYPE,
      extension: REENCODE_EXTENSION,
      outcome: {
        width: fullSize.width,
        height: fullSize.height,
        quality,
        reachedTarget: full.size <= DOWNSCALE_TARGET_BYTES,
      },
    };
  } finally {
    // Decoded bitmaps hold real memory on a phone, and this one is not small.
    bitmap.close();
  }
}

/* ========================================================================== */
/* Upload seam                                                                 */
/* ========================================================================== */

/**
 * Upload one re-encoded blob to the Media_Endpoint and return its Media_Reference, or throw.
 *
 * A function rather than a client, for the same reason `saveProfileSettings` takes one: the caller
 * keeps the decision about what a failed upload means, and a test needs neither a network nor a
 * `fetch` stub wired through the component. **Amendment A3:** the object goes to
 * `POST /api/media` (authenticated, owner-stamped from the session) instead of browser-direct to a
 * Supabase bucket — there is no bucket, and no path a client could forge. The route admits the
 * bytes (kind + MIME type + size) and returns the reference the diagnosis request then carries.
 */
export type MediaUploader = (input: { body: Blob; kind: MediaKind }) => Promise<MediaRef>;

/**
 * The production uploader: `POST /api/media` with the blob and its kind. The MIME type the route
 * admits is the blob's own `type` (JPEG, from the re-encoder). No owner is named here — the route
 * stamps `metadata.ownerId` from the server-confirmed session, so a client cannot upload a file
 * owned by another farmer (Requirement 2.5 holds by construction).
 */
export const mediaEndpointUploader: MediaUploader = ({ body, kind }) => uploadMedia({ body, kind });

/* ========================================================================== */
/* The submission (Requirements 2.1, 2.13, 2.14, 15.5)                         */
/* ========================================================================== */

/** Whether the Thumbnail_Derivative made it. Never a reason to withhold a diagnosis. */
export type ThumbnailOutcome = 'uploaded' | 'failed';

export type CropImageSubmission =
  /** Declined before any bytes left the phone (Requirements 2.4, 2.9). */
  | { status: 'rejected'; code: AdmissionCode }
  /**
   * Nothing to diagnose. `encode` and `upload` both mean no usable object exists, so no
   * diagnosis request is sent (Requirement 15.5). `diagnose` means the objects are in GridFS but
   * the POST never produced a response — the retention sweep's orphan scan is what eventually
   * reclaims those bytes (design: *How the sweep finds its work*).
   */
  | { status: 'failed'; stage: 'encode' | 'upload' | 'diagnose'; cause: unknown }
  | {
      status: 'sent';
      image: MediaRef;
      thumbnail: ThumbnailOutcome;
      /** Unparsed on purpose: the envelope and the result card belong to the screen. */
      response: Response;
      encoded: EncodedCropImage['outcome'];
    };

export interface SubmitCropImageInput {
  /** The file the farmer selected. Re-admitted here, so this function is safe to call directly. */
  file: File;
  /** The signed-in farmer. Recorded by the server from the session; not used to build any path. */
  userId: string;
  upload: MediaUploader;
  encode: CropImageEncoder;
  /** `useJameeRequests().diagnose` — the only way to reach `/api/diagnose`. */
  diagnose: (body: DiagnoseBody) => Promise<Response>;
  conversationId?: string;
}

/**
 * Admit, re-encode, upload, then post the reference — the whole flow, with no React in it.
 *
 * Extracted from the component because every rule worth testing here is a rule about
 * *sequencing*: that a declined file uploads nothing, that a failed full-image upload posts nothing
 * (Requirement 15.5), that a failed thumbnail still posts (Requirement 2.14), and that what is
 * posted is a reference rather than bytes (Requirements 2.1, 2.2). None of that is about the DOM.
 */
export async function submitCropImage(
  input: SubmitCropImageInput,
): Promise<CropImageSubmission> {
  const { file, upload, encode, diagnose } = input;

  /** Requirement 2.9: on the selected file, before the re-encode. */
  const rejected = admissionCode(file);
  if (rejected !== null) return { status: 'rejected', code: rejected };

  let encoded: EncodedCropImage;
  try {
    encoded = await encode(file);
  } catch (cause) {
    /**
     * Requirement 2.10 says the re-encoded image is uploaded **in place of** the selected file,
     * so there is no fallback to the original here. Uploading a 10 MB original would break the
     * storage projection the retention window is built on, and doing it silently would make that
     * breakage invisible.
     */
    return { status: 'failed', stage: 'encode', cause };
  }

  /**
   * The full image first (Requirement 2.1). A failure here is Requirement 15.5: report it and send
   * NO diagnosis request, because the object the diagnosis reads does not exist.
   */
  let image: MediaRef;
  try {
    image = await upload({ body: encoded.full, kind: 'crop-image' });
  } catch (cause) {
    return { status: 'failed', stage: 'upload', cause };
  }

  /**
   * Requirement 2.13 — the thumbnail, as a separate `thumbnail`-kind upload; and Requirement 2.14
   * for the failure: a thumbnail that does not land degrades the history list (which falls back to
   * the full image, Requirement 12.7). Abandoning the diagnosis over it would throw away the
   * request the farmer actually made. A `null` thumbnail (the browser could not produce one) is the
   * same case, handled the same way.
   */
  let thumbnail: ThumbnailOutcome = 'failed';
  let thumbnailRef: MediaRef | null = null;
  if (encoded.thumbnail !== null) {
    try {
      thumbnailRef = await upload({ body: encoded.thumbnail, kind: 'thumbnail' });
      thumbnail = 'uploaded';
    } catch {
      thumbnail = 'failed';
      thumbnailRef = null;
    }
  }

  /** Requirements 2.1, 2.2, 2.7: the reference(s), and nothing else. ~60 bytes on the wire. */
  const body: DiagnoseBody = {
    image,
    ...(thumbnailRef === null ? {} : { thumbnail: thumbnailRef }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
  };

  let response: Response;
  try {
    response = await diagnose(body);
  } catch (cause) {
    return { status: 'failed', stage: 'diagnose', cause };
  }

  return { status: 'sent', image, thumbnail, response, encoded: encoded.outcome };
}

/* ========================================================================== */
/* Component                                                                   */
/* ========================================================================== */

export interface ImageUploaderProps {
  /** The signed-in farmer, from `getUser()` in the `/diagnose` server shell (task 12.2). */
  userId: string;
  /** Attach the diagnosis to the screen's conversation when it has one (Requirement 2.2). */
  conversationId?: string;
  /**
   * The unparsed `/api/diagnose` response, ok or not. Task 12.2 parses it with
   * `diagnoseResponseSchema`, renders `DiagnosisResultCard`, and renders the error envelope
   * plus a retry for a non-ok status (Requirement 15.4).
   */
  onDiagnosisResponse?: (response: Response) => void;
  /** Test seams. Production defaults are the Media_Endpoint uploader and the canvas re-encoder. */
  upload?: MediaUploader;
  encode?: CropImageEncoder;
}

/** `'idle'` is the whole loading model. There is nothing else to derive an indicator from. */
type Phase = 'idle' | 'uploading' | 'analyzing';

export function ImageUploader({
  userId,
  conversationId,
  onDiagnosisResponse,
  upload,
  encode,
}: ImageUploaderProps) {
  /**
   * `useJameeRequests()` is the only way to reach `/api/diagnose`, and it stamps the active
   * language onto the body from context — a caller cannot pass one (Requirement 9.2). Its
   * `language` is also what every string on this control is rendered in.
   */
  const requests = useJameeRequests();
  const { ui, loading } = messages(requests.language);

  const [file, setFile] = useState<File | null>(null);
  const [rejection, setRejection] = useState<AdmissionCode | null>(null);
  /** What `ErrorBanner` needs and nothing more. The cause is logged, never held (15.6). */
  const [failure, setFailure] = useState<ErrorBannerError | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');

  const chooseId = useId();
  const captureId = useId();
  const hintId = useId();

  const chooseInput = useRef<HTMLInputElement | null>(null);
  const captureInput = useRef<HTMLInputElement | null>(null);

  /**
   * The Media_Endpoint uploader (`POST /api/media`), or a test's seam. Under Amendment A3 this
   * needs no client and reads no env var — it is a `fetch` to an authenticated route — so there is
   * nothing to build lazily and no `NEXT_PUBLIC_*` read to defer past hydration.
   */
  function objectUploader(): MediaUploader {
    return upload ?? mediaEndpointUploader;
  }

  const busy = phase !== 'idle';

  function onSelect(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0];
    setFailure(null);

    if (selected === undefined) {
      setFile(null);
      setRejection(null);
      return;
    }

    /** Requirements 2.3, 2.4, 2.9 — the selected file, before anything is re-encoded. */
    const code = admissionCode(selected);
    if (code !== null) {
      /**
       * "Decline the upload" (Requirement 2.4) means the file is not held either: clearing the
       * input stops a rejected 12 MB photo from sitting there looking chosen next to an enabled
       * submit button.
       */
      event.target.value = '';
      setFile(null);
      setRejection(code);
      return;
    }

    setRejection(null);
    setFile(selected);

    /**
     * One selection at a time across the two inputs. Without this, choosing from the gallery
     * after taking a photo would leave the camera input still showing the discarded one.
     */
    const other = event.target === chooseInput.current ? captureInput.current : chooseInput.current;
    if (other !== null) other.value = '';
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || file === null) return;

    setPhase('uploading');
    setFailure(null);

    const outcome = await submitCropImage({
      file,
      userId,
      upload: objectUploader(),
      encode: encode ?? encodeCropImage,
      /**
       * The phase flips as the POST opens, not on a timer: `diagnose` is called exactly once,
       * immediately before the request, and the text is cleared when it resolves. That is the
       * whole of Requirement 15.1 and 15.2 — real request state, no interval, no percentage.
       */
      diagnose: (body) => {
        setPhase('analyzing');
        return requests.diagnose(body);
      },
      ...(conversationId === undefined ? {} : { conversationId }),
    });

    switch (outcome.status) {
      case 'rejected':
        setRejection(outcome.code);
        break;

      case 'failed':
        /**
         * `INTERNAL_ERROR` is the honest code for all three stages. The taxonomy has no
         * upload-specific code, and inventing one here would put a farmer-facing string outside
         * the catalog; the generic message ("Something went wrong at Jamee's end. Please try
         * again.") is accurate and `retryable: true`, which the submit control is the retry for
         * (Requirement 15.4). The real cause goes to the browser console and nowhere else.
         */
        console.error(`[jamee] crop image ${outcome.stage} failed`, outcome.cause);
        setFailure(toEnvelope(new AppError('INTERNAL_ERROR'), requests.language).error);
        break;

      case 'sent':
        if (outcome.thumbnail === 'failed') {
          /**
           * Requirement 2.14: not an error a farmer is shown. The diagnosis went out; the
           * history list will fall back to the full-size image for this entry (Requirement
           * 12.7). Logged because it is worth noticing in aggregate.
           */
          console.warn('[jamee] thumbnail upload failed; diagnosis sent anyway');
        }
        onDiagnosisResponse?.(outcome.response);
        break;
    }

    setPhase('idle');
  }

  /** One string, from the one piece of state. Empty while idle. */
  let statusText = '';
  if (phase === 'uploading') statusText = loading.uploading;
  else if (phase === 'analyzing') statusText = loading.analyzing;

  const accept = ACCEPTED_IMAGE_TYPES.join(',');

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-busy={busy}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={chooseId}>
          {ui.chooseImage}
        </label>
        {/*
         * A real `<input type="file">` with a real `<label htmlFor>`, which is what the design
         * requires in place of a click-handled `<div>`: it is keyboard operable, it is announced
         * as a file input, and it needs no JavaScript to open a picker.
         *
         * `accept` lists the three MIME types rather than `image/*`, so the picker offers what
         * Jamee can actually take. It is a hint, not a check — `admissionCode()` is the check,
         * and it runs on whatever arrives.
         */}
        <input
          className={styles.file}
          id={chooseId}
          name="crop_image"
          type="file"
          accept={accept}
          aria-describedby={hintId}
          aria-invalid={rejection !== null}
          onChange={onSelect}
          disabled={busy}
          ref={chooseInput}
        />
        <p className={styles.hint} id={hintId}>
          {/*
           * States the accepted types and the limit up front, not only on a rejection — and
           * adds the one piece of advice that changes the outcome: photograph the leaf in
           * daylight. A blurry or dark photo is Requirement 6.2's `unclear` result, which costs
           * the farmer a quota unit for no answer.
           */}
          {imageHint(requests.language)}
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={captureId}>
          {ui.captureImage}
        </label>
        {/*
         * `capture="environment"` asks a phone for the REAR camera, which is the one pointed at
         * a leaf. It is a second control rather than an attribute on the input above because on
         * Android Chrome `capture` opens the camera directly and takes the gallery away — and
         * Requirement 2's user story is "upload **or** capture". Two labelled affordances also
         * read better than one system chooser for a farmer who is not a heavy phone user.
         *
         * On a desktop browser `capture` is ignored and this behaves as a second file picker.
         */}
        <input
          className={styles.file}
          id={captureId}
          name="crop_image_capture"
          type="file"
          accept={accept}
          capture="environment"
          /*
           * The same hint governs both controls, so both point at the one paragraph.
           *
           * Task 26.2 audited this specifically, because two file inputs sharing one description is
           * the shape that *looks* like two identical controls. It is not: each input has its own
           * `<label for>`, so the accessible names differ — "Choose a photo" and "Take a photo" — and
           * the description is the part that is genuinely identical (the same three types, the same
           * 10 MB limit, the same daylight advice apply to both). Duplicating that sentence into a
           * second paragraph would give the screen two copies of one fact for a farmer to reconcile.
           * Whether hearing the hint twice while tabbing between the two is tedious in practice is a
           * question for the manual screen-reader pass in task 30.1, not one markup can answer.
           */
          aria-describedby={hintId}
          aria-invalid={rejection !== null}
          onChange={onSelect}
          disabled={busy}
          ref={captureInput}
        />
      </div>

      {/* What is actually going to be sent. Reserved while empty so nothing shifts. */}
      <p className={styles.selected}>
        {file === null ? '' : <span className={styles.fileName}>{file.name}</span>}
      </p>

      {/*
       * Requirement 2.4 — states the accepted types and the limit, in the active language. No retry
       * is offered and none is claimed: the input was cleared with the file, so there is nothing on
       * screen to send again, and both admission codes are `retryable: false` anyway.
       */}
      {rejection !== null ? (
        <ErrorBanner
          error={rejectionBanner(rejection, requests.language)}
          retry={{ kind: 'none' }}
        />
      ) : null}

      {/*
       * Requirement 15.5 — the upload failure. `retry: 'control'` is the submit control below: the
       * chosen photo is still chosen, so pressing it re-sends the request that failed.
       */}
      {failure !== null ? (
        <ErrorBanner error={failure} retry={{ kind: 'control' }} />
      ) : null}

      {/* Disabled while a request is in flight, and while there is nothing chosen to send. */}
      <button className={styles.primary} type="submit" disabled={busy || file === null}>
        {ui.submitImage}
      </button>

      {/*
       * Real text bound to a real request state (Requirement 15.2), including Requirement
       * 15.1's exact `analyzing` string from the catalog. Rendered while idle too: a polite
       * live region that appears together with its text is not reliably announced, and
       * reserving the line keeps the button from moving under a thumb.
       */}
      <p className={styles.status} role="status">
        {statusText}
      </p>
    </form>
  );
}
