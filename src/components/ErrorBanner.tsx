'use client';

import { messages } from '@/lib/messages';
import type { Language } from '@/lib/schemas';

import styles from './ErrorBanner.module.css';

/**
 * The one error banner. Every screen that has something to report about a failed operation reports
 * it through this component.
 *
 * Requirements: 15.3 (the message is the localized one the API returned, carrying its language),
 *               15.4 (that message is displayed and a retry action is offered for the failed
 *               operation), 15.6 (nothing here can render a cause — see the props)
 * Design: "Error taxonomy"; "Frontend — Mobile layout and accessibility" → `role="alert"` error
 *          banners, tap targets at least 44×44 px
 *
 * ### The message is passed in, never rebuilt
 *
 * The props carry a message, not a code. That is the whole of Requirement 15.3's client side:
 * `QUOTA_EXCEEDED` has a limit and a reset instant interpolated into its sentence server-side, and
 * `FILE_TYPE_UNSUPPORTED` has the accepted types and the size limit, all from `toEnvelope`. A
 * banner that took a code and looked the sentence up again would give the app two versions of
 * every one of them, and the second version would be the one with no access to `details`.
 *
 * `error` is structurally `ErrorEnvelope['error']` minus the code, so a caller holding an envelope
 * writes `error={envelope.error}` and nothing is transcribed. It deliberately has no field for a
 * cause, a stack or a provider payload: this component *cannot* render one (Requirement 15.6).
 *
 * ### Where a banner goes: outside every live region, next to the control that retries
 *
 * `role="alert"` is an **assertive** live region. Nesting one inside the `aria-live="polite"`
 * result region a screen already has produces two announcements of one event — the polite region
 * announces its changed contents and the alert interrupts with the same sentence. So the rule,
 * applied uniformly across all six consumers, is that a banner is a **sibling** of the polite
 * region and never a child of it, placed beside the control that retries the failed operation.
 * `ChatComposer` and `VoicePanel` already read it that way; `DiagnosisPanel` had its paragraph
 * inside the region and now does not.
 *
 * The banner is also the one live region in this codebase that is **conditionally rendered** rather
 * than reserved while empty. Every `role="status"` line is in the DOM from the first render,
 * because a polite region inserted together with its text is not reliably announced; an assertive
 * one is announced on insertion, which is exactly what an error needs and why the two are written
 * differently.
 *
 * ### `retryable` decides whether a retry is offered at all
 *
 * Requirement 15.4 asks for a retry action, and `ERROR_SPECS` decides honestly whether one can
 * exist: `QUOTA_EXCEEDED` is `retryable: false` on purpose, because a button that does nothing for
 * hours is worse than no button. So the flag gates the control, and a screen cannot override it.
 *
 * ### Everything is routed through here
 *
 * `VoiceRecorder`'s own `notice` paragraph was the last holdout, and task 26.2 folded it in: its
 * catalog sentences each got a language and a `retryable` flag (see `RecorderNotice` in that file),
 * so `role="alert"` is now written in exactly one component in this codebase and every screen places
 * a banner by the one rule above.
 *
 * ### Why the retry control is not also wired as the submit control's `aria-describedby`
 *
 * It was considered — an id contract on `.message` would let a test prove that the `control` arm's
 * claim points at something real. It is deliberately not done, because the cost lands on the farmer
 * rather than on the test: `aria-describedby` on a submit button makes a screen reader read the whole
 * failure sentence again **every time focus lands on that control**, which is the same
 * announce-it-twice problem the sibling rule above exists to prevent, moved from insertion time to
 * focus time. The alert has already said it, assertively, and it is the previous element in the
 * reading order.
 *
 * What makes the `control` arm checkable instead is a component test: a screen that passes
 * `retry={{ kind: 'control' }}` must also render an enabled control that resends. That is an
 * assertion about the screen, which is where the claim actually lives, and it costs a farmer
 * nothing.
 */

/* ========================================================================== */
/* What a banner renders                                                       */
/* ========================================================================== */

export interface ErrorBannerError {
  /** The message the API returned (or `toEnvelope` produced). Rendered verbatim. */
  readonly message: string;
  /**
   * The language that message was written in — `envelope.error.language`, not the active switcher
   * value. A Devanagari sentence under `lang="en"` is mispronounced or skipped by a screen reader,
   * and a farmer who switched language after sending a request would get the wrong one.
   */
  readonly language: Language;
  /** `envelope.error.retryable`. Gates the retry control below (Requirement 15.4). */
  readonly retryable: boolean;
}

/**
 * How the failed operation is retried. Three arms, because the honest answer differs per screen and
 * two of them are not a button in the banner:
 *
 *  - `action` — **the banner owns the retry.** It renders a control labelled `ui.retry` that calls
 *    `onRetry`. For a screen with no adjacent control of its own.
 *  - `control` — **a control already on screen is the retry**, with the farmer's input restored:
 *    `ImageUploader`'s submit with the photo still selected, `ChatComposer`'s Send with the text
 *    back in the box, `ProfileForm`'s Save, `SignInForm`'s submit. A second button here would be
 *    two controls doing one thing, which is worse for a screen reader and for a thumb.
 *  - `none` — **nothing retries this operation**, and saying so is a decision rather than an
 *    omission. `VoicePanel` is the case: it never holds the recording, and re-posting a reference
 *    to an object the service may already have deleted would fail differently rather than succeed.
 *
 * `control` and `none` render the same thing — no button. They are separate arms because they are
 * different *claims*: one says a retry exists elsewhere, the other says none exists. Collapsing
 * them would make a screen that simply forgot Requirement 15.4 indistinguishable from one that
 * justified its absence, which is precisely what task 26.2's audit needs to be able to tell apart.
 */
export type ErrorBannerRetry =
  | { readonly kind: 'action'; readonly onRetry: () => void }
  | { readonly kind: 'control' }
  | { readonly kind: 'none' };

export interface ErrorBannerProps {
  readonly error: ErrorBannerError;
  readonly retry: ErrorBannerRetry;
  /**
   * Placement only — a screen whose siblings are spaced with margins rather than a flex `gap`
   * passes its own class for that. The banner's appearance stays in `ErrorBanner.module.css`; where
   * it sits in a column is the container's decision, and that is the one thing a consumer may say.
   *
   * `| undefined` is written out because `exactOptionalPropertyTypes` is on and a CSS-module class is
   * `string | undefined` under `noUncheckedIndexedAccess` — the same shape React's own `className`
   * accepts, so a consumer passes `styles.errorSlot` without a cast or a conditional spread.
   */
  readonly className?: string | undefined;
}

/**
 * Whether a retry control is offered, as a function so a test and the component cannot disagree.
 *
 * Both halves are necessary: the taxonomy has to admit that a retry could work, and the screen has
 * to have delegated the retry to the banner.
 */
export function offersRetryControl(error: ErrorBannerError, retry: ErrorBannerRetry): boolean {
  return error.retryable && retry.kind === 'action';
}

export function ErrorBanner({ error, retry, className }: ErrorBannerProps) {
  const { ui } = messages(error.language);

  return (
    <div
      className={className === undefined ? styles.banner : `${styles.banner} ${className}`}
      role="alert"
    >
      {/* Verbatim, and in its own language. Nothing else in this subtree is farmer-facing text. */}
      <p className={styles.message} lang={error.language}>
        {error.message}
      </p>

      {/*
       * The same two conditions `offersRetryControl` states, written inline so the narrowing to the
       * `action` arm is the compiler's rather than an assertion about it.
       */}
      {error.retryable && retry.kind === 'action' ? (
        <button className={styles.retry} type="button" onClick={retry.onRetry}>
          {/*
           * Labelled in the message's language rather than the switcher's, so the button and the
           * sentence above it are never in two different languages.
           */}
          {ui.retry}
        </button>
      ) : null}
    </div>
  );
}
