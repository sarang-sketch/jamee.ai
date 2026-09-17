import styles from './EmptyState.module.css';

/**
 * A screen with nothing on it yet, plus the one action that changes that.
 *
 * Requirements: 12.4 (while a Farmer has no stored Diagnosis_Results, an empty-state message
 *               invites them to upload a first crop image), 15.2 (this is an observed state — an
 *               empty result set — not a placeholder shown while something loads)
 * Design: "Frontend" — `EmptyState` invites a first upload when the farmer has no diagnoses;
 *          "Mobile layout and accessibility" — tap targets at least 44x44 px
 *
 * Server component: no `'use client'`, no state. It renders two localized strings its caller
 * already resolved.
 *
 * ### Why the strings come in as props
 *
 * The catalog lookup needs a `Language`, and the screen that mounts this has already resolved one.
 * Taking `language` here instead would give the component a second opinion about which catalog to
 * read, and a component with no data of its own is the wrong place to hold one.
 *
 * ### Why it is not history-specific
 *
 * `/chat` and `/voice` reach the same state, and the design names this file generically for that
 * reason. So the requirement reference above is the *first* caller's, not a limit on the
 * component: it renders a sentence and a link, and knows nothing about diagnoses.
 */
export interface EmptyStateProps {
  /** The honest statement of the state, e.g. `ui.historyEmpty`. */
  message: string;
  /** The invitation, e.g. `ui.historyEmptyAction`. Becomes the link's accessible name. */
  actionLabel: string;
  actionHref: string;
}

export function EmptyState({ message, actionLabel, actionHref }: EmptyStateProps) {
  return (
    /**
     * A plain `<p>` and a plain `<a>`, and no `role`. This is ordinary content in the document
     * flow, so a screen reader reads the sentence and then offers the link — which is exactly the
     * order a sighted farmer reads them in. `role="status"` would be wrong: nothing changed, this
     * is what the screen says.
     */
    <div className={styles.empty}>
      <p className={styles.message}>{message}</p>
      <a className={styles.action} href={actionHref}>
        {actionLabel}
      </a>
    </div>
  );
}
