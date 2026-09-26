'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import { AppError, isAppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import { LANGUAGE_OPTIONS, type ProfileSettings } from '@/lib/profile';
import { ERROR_CODES, type ErrorCode } from '@/lib/schemas';

import styles from './ProfileForm.module.css';

/**
 * The profile form: a display name and a preferred language, saved to the farmer's own row.
 *
 * Requirements: 1.8 (both values are persisted on that Farmer's Profile), 9.1 (English, Hindi and
 *               Marathi are the selectable languages), 15.2 (every indicator is bound to an
 *               observed request state), 15.4 (the returned message is shown and a retry offered)
 * Design: "Frontend" — the client half of the `/profile` server shell; "Mobile layout and
 *          accessibility" — visible labels with real `<label>` association, `role="alert"` errors,
 *          tap targets ≥ 44×44 px in relative units
 *
 * =============================================================================
 * AMENDMENT A3 — THE WRITE GOES THROUGH A ROUTE, NOT A BROWSER DATABASE CLIENT
 * =============================================================================
 *
 * Under Supabase this form wrote to Postgres directly and RLS authorized it. A3 removes the browser
 * database client entirely (there is no RLS to lean on). So the form POSTs to `POST /api/profile`,
 * which resolves the farmer from the server-confirmed session and writes through the
 * Data_Access_Layer's owner-scoped `setProfileFields` (D18). The `userId` is never sent from the
 * browser — the route reads it from the session — so a tampered client cannot write another
 * farmer's row: there is no client-supplied identifier for it to swap.
 *
 * ### What this component does not touch
 *
 * `phone`. The bootstrap upsert (the auth path) writes only identity fields, so a sign-in cannot
 * reset what this screen saves; the other half is that this screen never writes `phone`, so it
 * cannot overwrite a farmer's cross-channel identity (Requirement 1.5).
 */

export interface ProfileFormProps {
  /** What the profile row holds right now, read server-side through the Data_Access_Layer. */
  initial: ProfileSettings;
}

export function ProfileForm({ initial }: ProfileFormProps) {
  /**
   * The last state the server confirmed. Two jobs: it is the read-back the screen shows, and it is
   * the language every label on this screen is rendered in — so the interface follows the saved
   * preference rather than an unsaved selection. A farmer who picks Marathi sees Marathi once the
   * save succeeds, and sees no change at all if it fails, which is the truth of what happened.
   */
  const [saved, setSaved] = useState<ProfileSettings>(initial);

  const [displayName, setDisplayName] = useState(initial.displayName ?? '');
  /**
   * Typed `string`, not `Language`, and deliberately so: this holds whatever the `<select>` is
   * showing, and the only honest place to narrow it is the route's `parseProfileSettings` at the
   * write seam. A cast here would assert something about the DOM this component cannot know.
   */
  const [language, setLanguage] = useState<string>(initial.language);

  /** `true` for exactly as long as the save request is open. The whole loading model. */
  const [pending, setPending] = useState(false);
  /** What `ErrorBanner` renders and nothing more — the cause never reaches this state (15.6). */
  const [error, setError] = useState<ErrorBannerError | null>(null);
  /** Cleared the moment the farmer edits again, so it never describes the current fields. */
  const [confirmed, setConfirmed] = useState(false);

  const { ui, loading, languageNames } = messages(saved.language);

  const router = useRouter();
  const nameFieldId = useId();
  const languageFieldId = useId();

  function edited(change: () => void): void {
    setConfirmed(false);
    change();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    setConfirmed(false);

    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, language }),
      });
      if (!response.ok) throw await errorFromResponse(response);

      /** The row as the server now holds it, including the trim the write applied. */
      const settings = (await response.json()) as ProfileSettings;
      const languageChanged = settings.language !== saved.language;
      setSaved(settings);
      setDisplayName(settings.displayName ?? '');
      setLanguage(settings.language);
      setConfirmed(true);

      /**
       * A saved language changes what the **server shell** renders too — the heading and the `lang`
       * on the landmark — so the shell is asked to re-render against the row that was just written.
       * React state survives a refresh, so the confirmation above stays on screen. Only on a
       * change: a refresh after every save would re-run the read for nothing.
       */
      if (languageChanged) router.refresh();
    } catch (cause) {
      /**
       * The localized message for the coded failure, rendered through the same envelope the API
       * layer uses so this screen cannot develop its own vocabulary of errors. The language is
       * `saved.language`: the profile is unchanged after a failure, so the message arrives in the
       * language the farmer already had.
       */
      const appError = isAppError(cause) ? cause : new AppError('INTERNAL_ERROR', { cause });
      setError(toEnvelope(appError, saved.language).error);
    } finally {
      setPending(false);
    }
  }

  /**
   * The one status string, derived from the two pieces of state that can be true. `saving` is bound
   * to the open request; `saved` is bound to a write the server confirmed, and is dropped as soon
   * as the fields change so it never labels an unsaved edit.
   */
  let statusText = '';
  if (pending) statusText = loading.saving;
  else if (confirmed) statusText = ui.saved;

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-busy={pending}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={nameFieldId}>
          {ui.displayNameLabel}
        </label>
        <input
          className={styles.input}
          id={nameFieldId}
          name="display_name"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(event) => edited(() => setDisplayName(event.target.value))}
          disabled={pending}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={languageFieldId}>
          {ui.preferredLanguageLabel}
        </label>
        {/*
         * A real `<select>`: keyboard operable, rendered as a native picker on mobile, and it cannot
         * submit a value outside its options without tampering — which the route's
         * `parseProfileSettings` checks for anyway. Requirement 9.1's three options come from
         * `LANGUAGE_OPTIONS`, which is `languageSchema`'s own option list, so the form and the
         * validation cannot disagree about what is supported. Each option carries its own `lang` so a
         * screen reader announces each endonym with the right phonetics.
         */}
        <select
          className={styles.select}
          id={languageFieldId}
          name="language"
          value={language}
          onChange={(event) => edited(() => setLanguage(event.target.value))}
          disabled={pending}
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option} value={option} lang={option}>
              {languageNames[option]}
            </option>
          ))}
        </select>
      </div>

      {/*
       * Requirement 15.4: the message, with the Save control below as the retry — the fields still
       * hold what the farmer typed, so pressing it re-sends the write that failed.
       */}
      {error !== null ? <ErrorBanner error={error} retry={{ kind: 'control' }} /> : null}

      <button className={styles.primary} type="submit" disabled={pending}>
        {ui.save}
      </button>

      {/*
       * One region, two honest states: the open request, or the confirmed save. Rendered while idle
       * too, because a polite live region that appears together with its text is not reliably
       * announced, and reserving the line keeps the button from moving under a thumb. Nothing here is
       * driven by a timer (Requirement 15.2).
       */}
      <p className={styles.status} role="status">
        {statusText}
      </p>
    </form>
  );
}

/* ========================================================================== */
/* Error handling — the same envelope the API layer produces                   */
/* ========================================================================== */

/** Turn a non-2xx response into an `AppError`, reading the coded envelope when the body carries one. */
async function errorFromResponse(response: Response): Promise<AppError> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    const code = body?.error?.code;
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      return new AppError(code as ErrorCode);
    }
  } catch {
    /* no coded body — fall through to a generic internal error */
  }
  return new AppError('INTERNAL_ERROR');
}
