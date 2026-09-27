import { JameeLogo } from '@/components/JameeLogo';
import { ProfileAccessCards } from '@/components/ProfileAccessCards';
import { requireFarmer } from '@/lib/auth/session';
import { accessData } from '@/lib/db/access';
import { farmerData } from '@/lib/db/farmer';
import { telegramBotUsername } from '@/lib/env.public';
import { activeLanguage } from '@/lib/language.server';
import { DEFAULT_LANGUAGE } from '@/lib/profile';
import { productCopy } from '@/lib/product-copy';
import { entitlementStatus } from '@/services/entitlement.service';

import styles from '../section.module.css';

export const dynamic = 'force-dynamic';

export default async function ConnectPage() {
  const userId = await requireFarmer();
  const [profile, isLinked, entitlement] = await Promise.all([
    farmerData(userId).readProfile(),
    accessData(userId).isTelegramLinked(),
    entitlementStatus(userId),
  ]);
  const language = await activeLanguage(profile?.language ?? DEFAULT_LANGUAGE);
  const copy = productCopy(language).workspace;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <span className={styles.heroIcon}><JameeLogo size={46} /></span>
        <div>
          <p>Telegram + Jamee</p>
          <h1>{copy.connectTitle}</h1>
          <span>{copy.connectBody}</span>
        </div>
      </header>
      <p className={styles.securityNote}>{copy.connectNote}</p>
      <div className={styles.cardGrid}>
        <ProfileAccessCards
          botUsername={telegramBotUsername()}
          isLinked={isLinked}
          entitlement={entitlement}
          language={language}
        />
      </div>
    </div>
  );
}
