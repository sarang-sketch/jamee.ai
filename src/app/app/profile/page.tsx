import { ProfileForm } from '@/components/ProfileForm';
import { SignOutButton } from '@/components/SignOutButton';
import { requireFarmer } from '@/lib/auth/session';
import { farmerData } from '@/lib/db/farmer';
import { activeLanguage } from '@/lib/language.server';
import { DEFAULT_LANGUAGE, readProfileSettings } from '@/lib/profile';
import { productCopy } from '@/lib/product-copy';

import styles from '../section.module.css';

export const dynamic = 'force-dynamic';

export default async function AppProfilePage() {
  const userId = await requireFarmer();
  const profile = await farmerData(userId).readProfile();
  const settings = (await readProfileSettings(async () => profile)) ?? {
    displayName: null,
    language: DEFAULT_LANGUAGE,
  };
  const language = await activeLanguage(settings.language);
  const copy = productCopy(language).workspace;

  return (
    <div className={styles.page}>
      <header className={styles.sectionHeader}>
        <p>{copy.accountTitle}</p>
        <h1>{copy.profileTitle}</h1>
        <span>{copy.profileBody}</span>
      </header>
      <div className={styles.profileGrid}>
        <section className={styles.panel}>
          <ProfileForm initial={{ ...settings, language }} />
        </section>
        <aside className={styles.accountCard}>
          <div className={styles.accountAvatar} aria-hidden="true">
            {Array.from(settings.displayName?.trim() || 'J')[0]?.toLocaleUpperCase(language)}
          </div>
          <div>
            <p>{copy.accountTitle}</p>
            <strong>{settings.displayName?.trim() || copy.profile}</strong>
            <span>{copy.email}</span>
            <a href={`mailto:${profile?.email ?? ''}`}>{profile?.email ?? '—'}</a>
            <small>{copy.signedInWithGoogle}</small>
          </div>
          <SignOutButton language={language} />
        </aside>
      </div>
    </div>
  );
}
