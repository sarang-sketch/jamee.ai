import Link from 'next/link';

import type { ActivityMessage } from '@/lib/activity';
import { messages } from '@/lib/messages';
import type { Channel, Language } from '@/lib/schemas';
import { formatInstant } from '@/lib/time';

import styles from './ActivityFeed.module.css';

export interface ActivityFeedProps {
  entries: readonly ActivityMessage[];
  language: Language;
}

export function ActivityFeed({ entries, language }: ActivityFeedProps): React.JSX.Element {
  const { ui } = messages(language);
  const channelNames: Record<Channel, string> = {
    web: ui.channelWeb,
    telegram: ui.channelTelegram,
  };

  if (entries.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon} aria-hidden="true">✦</span>
        <p>{ui.activityEmpty}</p>
        <div className={styles.emptyActions}>
          <Link href="/app">{ui.navChat}</Link>
          <Link href="/app/connect">{ui.channelTelegram}</Link>
        </div>
      </div>
    );
  }

  return (
    <ol className={styles.feed}>
      {entries.map((entry) => {
        const fromFarmer = entry.role === 'farmer';
        return (
          <li className={styles.item} key={entry.id}>
            <span className={`${styles.marker} ${entry.channel === 'telegram' ? styles.markerTelegram : styles.markerWeb}`} aria-hidden="true">
              {entry.channel === 'telegram' ? 'T' : 'W'}
            </span>
            <article className={styles.card}>
              <header className={styles.cardHeader}>
                <div className={styles.identity}>
                  <strong>{fromFarmer ? ui.roleFarmer : ui.roleJamee}</strong>
                  <span className={`${styles.channel} ${entry.channel === 'telegram' ? styles.telegram : styles.web}`}>
                    {channelNames[entry.channel]}
                  </span>
                  {entry.inputKind === 'voice' ? <span className={styles.inputKind}>{ui.transcriptLabel}</span> : null}
                </div>
                <time dateTime={entry.createdAt}>{formatInstant(entry.createdAt, language)}</time>
              </header>
              <p className={styles.body} lang={entry.language}>{entry.content}</p>
            </article>
          </li>
        );
      })}
    </ol>
  );
}
