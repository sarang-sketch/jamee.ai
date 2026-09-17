/**
 * Media lifecycle configuration — Requirement 18.
 *
 * Requirements: 18.1 (the Retention_Window is a whole number of days, readable from ONE place
 *               in the codebase), 18.2 (the bounding arithmetic is recorded in the deployment
 *               package), 18.11 (a bounded number of deletions per invocation), 2.10–2.13
 *               (browser re-encode target and the thumbnail derivative)
 * Design: "Media lifecycle and retention"
 *
 * Like `verified.ts`, this module imports nothing — the uploader (a client component) reads
 * the re-encode target and the thumbnail dimensions, and the retention service (a server
 * module) reads the window and the batch bound.
 *
 * None of these are V-items. They are Jamee's own numbers, and every one of them is a number
 * to REVIEW rather than a number to set once — see the arithmetic below.
 */

/* ========================================================================== */
/* Retention window (Requirement 18.1)                                         */
/* ========================================================================== */

/**
 * How many days a Full_Size_Image or a voice recording survives.
 *
 * **Requirement 18.1 is satisfied by this being the only declaration.** Nothing else in the
 * codebase may hard-code a retention duration; the sweep, the history view's
 * "no longer stored" copy, and the deployment document's arithmetic all read this.
 *
 * ### The arithmetic that bounds it (Requirement 18.2)
 *
 * The constraint, from the design:
 *
 * ```
 * (full_size_bytes_per_day + straggler_bytes_per_day) × MEDIA_RETENTION_DAYS
 *   + thumbnail_bytes_per_day × pilot_days
 *   ≤ 1 GB × 0.75
 * ```
 *
 * Worst-case load is Jamee's own quota: 6 farmers × 20 images and 20 voice notes a day = 120
 * of each. Substituting, with each per-object figure labelled for what it actually is:
 *
 * | Term | Figure | Basis |
 * | --- | --- | --- |
 * | `full_size_bytes_per_day`  | 120 × ~400 KB ≈ **48 MB/day** | the re-encode target below — a design target, not a measurement |
 * | `thumbnail_bytes_per_day`  | 120 × ~25 KB  ≈  **3 MB/day** | planning estimate for a ~320 px longest-edge re-encode; **retained forever** |
 * | `straggler_bytes_per_day`  | ≈ **5 MB/day**                | planning estimate: voice objects whose transcription did not succeed |
 * | Usable budget              | 0.75 × 1 GB ≈ **768 MB**      | V19's 1 GB Supabase Free storage allowance, less 25% headroom for a missed sweep run |
 *
 * ```
 * day 0   of the pilot:  768        / 53 ≈ 14 days available
 * day 90  of the pilot: (768 − 270) / 53 ≈  9 days available
 * day 132 of the pilot: (768 − 396) / 53 ≈  7 days available   <- this default's limit
 * ```
 *
 * **The safe window shrinks as thumbnails accumulate**, because thumbnails are never swept
 * (Requirement 18.5). 7 days holds for roughly the first four months at maximum farmer
 * activity, and far longer at realistic activity — at 20% of quota the whole media footprint
 * is under 300 MB after a year. That is why this is configurable and why the arithmetic is
 * reproduced in `docs/DEPLOYMENT.md`: it is a number to review, not a number to set once.
 *
 * The 25% headroom is what makes V21's finding survivable. Vercel documents cron delivery as
 * best-effort — a scheduled run can simply not arrive — so the reserve is the cost of a
 * missed sweep, and it is why a missed run costs bucket headroom rather than correctness.
 */
export const MEDIA_RETENTION_DAYS = 7;

/**
 * The same window governs a voice object whose transcription failed or came back empty
 * (Requirement 8.10). It is deliberately NOT a separate constant.
 *
 * Two reasons, both from the design. It keeps the deletion rule a single testable
 * biconditional — *a voice object is absent if and only if a transcript message exists for
 * it* — instead of three cases with three triggers. And it keeps Requirement 18.1's "readable
 * from one place" literally true: a second grace-period constant would be a second number to
 * configure and a second thing to get out of step.
 */
export const VOICE_FAILURE_GRACE_DAYS = MEDIA_RETENTION_DAYS;

/* ========================================================================== */
/* Sweep bounds (Requirement 18.11)                                            */
/* ========================================================================== */

/**
 * Maximum objects deleted per sweep invocation, per scan.
 *
 * Requirement 18.11 requires each invocation to finish inside the 60 s ceiling and to bound
 * how many objects it deletes. Leftover work is picked up by the next run, which is safe
 * precisely because the operation is idempotent (Requirement 18.10) — and V21 confirms that
 * "safe to run late, twice, or several times in a row" is exactly what the platform's
 * best-effort cron delivery requires.
 *
 * 200 is sized against the worst-case daily production of 240 objects: one daily run clears
 * close to a day's accumulation per scan, and a backlog drains over a few runs rather than
 * requiring one long invocation. `remove()` takes a whole batch in one call (V22), so the
 * per-invocation cost is a handful of round trips, not 200.
 */
export const RETENTION_SWEEP_BATCH_LIMIT = 200;

/**
 * Scan 2 — the age-driven orphan backstop — is **OFF**, and that is a resolved-state flag
 * rather than a preference.
 *
 * **U-V22b** could not confirm that the storage schema exposes a creation timestamp usable for
 * age filtering. The design's own contingency applies: *"until it resolves, scan 2 is the part
 * of the sweep that does not run, and scan 1 alone still satisfies Requirements 18.3 and 18.7
 * for every object a farmer can see."*
 *
 * What stays uncollected while this is `false` is the orphan class only — an image uploaded
 * before its diagnosis request failed, and a voice object whose transcription failed. Those
 * are the `straggler_bytes_per_day ≈ 5 MB/day` term already carried in the arithmetic above,
 * so the storage projection does not change.
 *
 * To turn it on: confirm the `storage.objects` column set on a live project, record the
 * finding under V22 in `docs/VERIFIED_VALUES.md`, then flip this flag. Nothing else changes —
 * the scan is implemented and tested, it is just not called.
 */
export const RETENTION_ORPHAN_SCAN_ENABLED = false;

/* ========================================================================== */
/* Browser re-encode (Requirements 2.10–2.13)                                  */
/* ========================================================================== */

/**
 * Requirement 2.10's Downscale_Target: the approximate stored size the browser aims for when
 * re-encoding an admitted image.
 *
 * **A target, not a threshold.** Requirement 2.11 is explicit that the uploaded object's size
 * *differs* from this number, and Requirement 2.12 says to PREFER exceeding it over destroying
 * lesion detail. Re-encoding cannot hit an exact output size, and a leaf lesion that has been
 * compressed into mush is not diagnosable — which would defeat the whole product.
 *
 * Nothing rejects a file for missing this target. Requirements 2.3 and 2.4 still gate on the
 * file the farmer SELECTS, before any re-encode: a 9 MB photo is still admitted and still gets
 * no size complaint. The 10 MB allowance stays real; it is simply no longer the size of the
 * object that lands in the bucket.
 */
export const DOWNSCALE_TARGET_BYTES = 400 * 1024;

/**
 * Longest-edge cap for the re-encoded Full_Size_Image.
 *
 * 1600 px is the resolution floor for Requirement 2.12: early- and late-blight lesions are
 * judged on concentric rings, lesion margins, and the presence of white sporulation on a leaf
 * underside — features measured in tens of pixels on a leaf that fills part of the frame.
 * Below roughly this size those features stop surviving JPEG quantization, and the classifier
 * is being asked to judge an artefact.
 *
 * The re-encoder walks quality DOWN toward the target before it reduces dimensions further,
 * because quality loss degrades lesion detail more gracefully than resolution loss does.
 */
export const FULL_SIZE_MAX_EDGE_PX = 1600;

/** Quality ladder for the re-encode, tried in order until the output is near the target. */
export const FULL_SIZE_QUALITY_LADDER = [0.82, 0.72, 0.62, 0.52] as const;

/**
 * Thumbnail_Derivative dimensions and quality (Requirement 2.13).
 *
 * ~320 px longest edge at quality 0.7 lands around 25 KB, which is the
 * `thumbnail_bytes_per_day` figure the retention arithmetic above is built on. Changing this
 * changes that arithmetic, so change both together.
 *
 * The egress case for it: a 20-entry history list reads 20 thumbnails at ~25 KB (≈0.5 MB per
 * render) instead of 20 originals at ~400 KB (≈8 MB). Against V19's 5 GB/month egress
 * allowance — about 170 MB/day — a farmer scrolling their history several times a day is the
 * difference between noise and a real threat.
 */
export const THUMBNAIL_MAX_EDGE_PX = 320;
export const THUMBNAIL_QUALITY = 0.7;

/**
 * The infix that marks a Thumbnail_Derivative, inserted immediately before the file
 * extension: `…/{uuid}.jpg` → `…/{uuid}.thumb.jpg`.
 *
 * Three properties made this convention preferable to a sibling `thumbs/` folder:
 *  - **The storage RLS predicate needs no change.** `(storage.foldername(name))[1]` is still
 *    `{user_id}` (V4), so both objects are covered by the existing policy with no new grant.
 *  - **Both derivatives share an extension**, because the browser produces both in one
 *    re-encode pass with one output MIME type — so the extension is not a second thing to
 *    derive.
 *  - **It is a single unambiguous predicate for the sweep**, which must delete originals and
 *    keep thumbnails while scanning one bucket.
 *
 * `storageRefSchema` deliberately REJECTS a path containing this infix: its regex allows
 * exactly one dot before the extension, so a client cannot submit a thumbnail as the object to
 * diagnose, and cannot submit a fabricated derived path at all. A thumbnail path is only ever
 * computed server-side by `thumbPathFor()` from an original that already passed validation and
 * ownership. Do not widen that regex.
 */
export const THUMBNAIL_PATH_INFIX = '.thumb';
