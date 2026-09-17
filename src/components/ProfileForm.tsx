'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';

import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import { AppError, isAppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  LANGUAGE_OPTIONS,
  PROFILE_SETTINGS_SELECT,
  saveProfileSettings,
  type ProfileSettings,
} from '@/lib/profile';
import { createClient } from '@/lib/supabase/client';

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
 * ### The write goes straight to Postgres, and RLS is what authorizes it
 *
 * No route handler sits in front of this. `profiles_update_own` in `0002_profiles.sql` is
 * `using (auth.uid() = id) with check (auth.uid() = id)`, so the database independently re-checks
 * the one thing that must be true, exactly as the storage policies do for the direct upload. The
 * `userId` prop is a convenience for the `eq` filter — not the thing that makes the write safe. A
 * tampered client that swapped it in gets zero updated rows, which
 * `saveProfileSettings` reports rather than swallows.
 *
 * ### What this component does not touch
 *
 * `phone`. The auth callback's upsert (task 6.2) writes only `id` and `phone`, so a sign-in cannot
 * reset what this screen saves; the other half of that arrangement is that this screen never writes
 * `phone`, so it cannot overwrite a farmer's cross-channel identity (Requirement 1.5).
 *
 * This is also **not** task 12.3's `LanguageSwitcher`. The switcher is a per-request control that
 * rides along on diagnosis, chat and voice requests (Requirement 9.2); this is where the saved
 * default it starts from is set (Requirement 1.8).
 */

export interface ProfileFormProps {
  /** The signed-in farmer, from `getUser()` in the server shell. */
  userId: string;
  /** What the profile row holds right now, read server-side under RLS. */
  initial: ProfileSettings;
}

export function ProfileForm({ userId, initial }: ProfileFormProps) {
  /**
   * The last state the database confirmed. Two jobs: it is the read-back the screen shows, and it
   * is the language every label on this screen is rendered in — so the interface follows the saved
   * preference rather than an unsaved selection. A farmer who picks Marathi sees Marathi once the
   * save succeeds, and sees no change at all if it fails, which is the truth of what happened.
   */
  const [saved, setSaved] = useState<ProfileSettings>(initial);

  const [displayName, setDisplayName] = useState(initial.displayName ?? '');
  /**
   * Typed `string`, not `Language`, and deliberately so: this holds whatever the `<select>` is
   * showing, and the only honest place to narrow it is `parseProfileSettings` at the write seam. A
   * cast here would assert something about the DOM that this component cannot know.
   */
  const [language, setLanguage] = useState<string>(initial.language);

  /** `true` for exactly as long as the update is open. The whole loading model. */
  const [pending, setPending] = useState(false);
  /** What `ErrorBanner` renders and nothing more — the cause never reaches this state (15.6). */
  const [error, setError] = useState<ErrorBannerError | null>(null);
  /** Cleared the moment the farmer edits again, so it never describes the current fields. */
  const [confirmed, setConfirmed] = useState(false);

  const { ui, loading, languageNames } = messages(saved.language);

  const router = useRouter();
  const nameFieldId = useId();
  const languageFieldId = useId();

  /**
   * Built on first use rather than during render: `publicEnv()` throws when
   * `NEXT_PUBLIC_SUPABASE_URL` is absent, and this component is server-rendered before it hydrates.
   * Same reasoning as `SignInForm`.
   */
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  function supabase(): ReturnType<typeof createClient> {
    supabaseRef.current ??= createClient();
    return supabaseRef.current;
  }

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
      /**
       * The statement, built here and handed to `saveProfileSettings` as a function — see that
       * module's note on why the seam is a function rather than a slice of the client. The payload
       * comes from the module, so this call site cannot widen what gets written; the `eq` is the
       * defence-in-depth filter over a row `profiles_update_own` already confines to one.
       */
      const settings = await saveProfileSettings(
        (values) =>
          supabase()
            .from('profiles')
            .update(values)
            .eq('id', userId)
            .select(PROFILE_SETTINGS_SELECT),
        userId,
        { displayName, language },
      );

      /** The row as the database now holds it, including the trim this write applied. */
      const languageChanged = settings.language !== saved.language;
      setSaved(settings);
      setDisplayName(settings.displayName ?? '');
      setLanguage(settings.language);
      setConfirmed(true);

      /**
       * A saved language changes what the **server shell** renders too — the heading and the `lang`
       * on the landmark — so the shell is asked to re-render against the row that was just written.
       * React state survives a refresh, so the confirmation above stays on screen.
       *
       * Only on a change: a refresh after every save would re-run the read for nothing.
       */
      if (languageChanged) router.refresh();
    } catch (cause) {
      /**
       * The localized message for the coded failure, rendered through the same envelope the API
       * layer uses so this screen cannot develop its own vocabulary of errors. An unexpected
       * throw — a network failure with no PostgREST code, say — becomes `INTERNAL_ERROR`, which is
       * honest and retryable rather than silent.
       *
       * The language is `saved.language`: the profile is unchanged after a failure, so the message
       * has to arrive in the language the farmer already had.
       */
      const appError = isAppError(cause)
        ? cause
        : new AppError('INTERNAL_ERROR', { cause });
      setError(toEnvelope(appError, saved.language).error);
    } finally {
      setPending(false);
    }
  }

  /**
   * The one status string, derived from the two pieces of state that can be true. `saving` is bound
   * to the open update; `saved` is bound to a write the database confirmed, and is dropped as soon
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
         * A real `<select>`: it is keyboard operable, it is the control a mobile OS renders as a
         * native picker, and it cannot submit a value outside its options without tampering — which
         * `parseProfileSettings` checks for anyway.
         *
         * Requirement 9.1's three options come from `LANGUAGE_OPTIONS`, which is `languageSchema`'s
         * own option list, so the form and the validation cannot disagree about what is supported.
         * Each option is labelled with that language's endonym from the catalog, so it is readable
         * to the farmer who is looking for it.
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
            /**
             * `lang` per option, matching `LanguageSwitcher`: each label is that language's own
             * endonym, so `हिन्दी` under the form's `lang` would be read with the wrong phonetics by a
             * screen reader and rendered from the wrong font by the browser. The two language
             * controls in the app now announce their options identically.
             */
            <option key={option} value={option} lang={option}>
              {languageNames[option]}
            </option>
          ))}
        </select>
      </div>

      {/*
       * Requirement 15.4: the message, with the Save control below as the retry for it — the fields
       * still hold what the farmer typed, so pressing it re-sends the write that failed.
       */}
      {error !== null ? <ErrorBanner error={error} retry={{ kind: 'control' }} /> : null}

      <button className={styles.primary} type="submit" disabled={pending}>
        {ui.save}
      </button>

      {/*
       * One region, two honest states: the open request, or the confirmed save. Rendered while idle
       * as well, because a polite live region that appears together with its text is not reliably
       * announced, and because reserving the line keeps the button from moving under a thumb.
       * Nothing here is driven by a timer (Requirement 15.2).
       */}
      <p className={styles.status} role="status">
        {statusText}
      </p>
    </form>
  );
}
