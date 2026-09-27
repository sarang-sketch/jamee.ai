import { ActivityFeed } from '@/components/ActivityFeed';
import { EmptyState } from '@/components/EmptyState';
import { HistoryList } from '@/components/HistoryList';
import { requireFarmer } from '@/lib/auth/session';
import { readRecentActivity } from '@/lib/activity';
import { farmerData } from '@/lib/db/farmer';
import { readHistory } from '@/lib/history';
import { activeLanguage } from '@/lib/language.server';
import { messages } from '@/lib/messages';
import { DEFAULT_LANGUAGE } from '@/lib/profile';
import { productCopy } from '@/lib/product-copy';

import styles from '../section.module.css';

export const dynamic = 'force-dynamic';

export default async function AppHistoryPage() {
  const userId = await requireFarmer();
  const profile = await farmerData(userId).readProfile();
  const language = await activeLanguage(profile?.language ?? DEFAULT_LANGUAGE);
  const copy = productCopy(language).workspace;
  const { ui } = messages(language);
  const [entries, activity] = await Promise.all([
    readHistory({ userId }),
    readRecentActivity({ userId }),
  ]);
  const webCount = activity.filter((item) => item.channel === 'web').length;
  const telegramCount = activity.length - webCount;

  return (
    <div className={styles.page}>
      <header className={styles.sectionHeader}>
        <p>{copy.history}</p>
        <h1>{copy.historyTitle}</h1>
        <span>{copy.historyBody}</span>
      </header>
      <div className={styles.stats} aria-label={copy.historyTitle}>
        <div><span>{ui.diagnosisHistoryHeading}</span><strong>{entries.length}</strong></div>
        <div><span>{ui.channelWeb}</span><strong>{webCount}</strong></div>
        <div><span>{ui.channelTelegram}</span><strong>{telegramCount}</strong></div>
      </div>
      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><h2>{ui.recentActivityHeading}</h2><p>{ui.recentActivityDescription}</p></div><span>MongoDB</span></div>
        <ActivityFeed entries={activity} language={language} />
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><h2>{ui.diagnosisHistoryHeading}</h2><p>{ui.historyDescription}</p></div></div>
        {entries.length === 0 ? (
          <EmptyState message={ui.historyEmpty} actionLabel={ui.historyEmptyAction} actionHref="/app" />
        ) : (
          <HistoryList entries={entries} language={language} />
        )}
      </section>
    </div>
  );
}
