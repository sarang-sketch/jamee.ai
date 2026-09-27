import Link from 'next/link';
import type { ReactNode } from 'react';

import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SignOutButton } from '@/components/SignOutButton';
import { messages } from '@/lib/messages';
import type { Language } from '@/lib/schemas';

import styles from './AppShell.module.css';

export type AppSection = 'diagnose' | 'chat' | 'voice' | 'history' | 'profile';

type IconName = 'scan' | 'chat' | 'voice' | 'history' | 'profile' | 'telegram';

export interface AppShellProps {
  active: AppSection;
  children: ReactNode;
  description: string;
  displayName?: string | null;
  headingId?: string;
  language: Language;
  title: ReactNode;
}

const NAVIGATION: readonly {
  section: AppSection;
  href: '/diagnose' | '/chat' | '/voice' | '/history' | '/profile';
  icon: IconName;
}[] = [
  { section: 'diagnose', href: '/diagnose', icon: 'scan' },
  { section: 'chat', href: '/chat', icon: 'chat' },
  { section: 'voice', href: '/voice', icon: 'voice' },
  { section: 'history', href: '/history', icon: 'history' },
  { section: 'profile', href: '/profile', icon: 'profile' },
];

export function AppShell({
  active,
  children,
  description,
  displayName,
  headingId,
  language,
  title,
}: AppShellProps): React.JSX.Element {
  const { ui } = messages(language);
  const labels: Record<AppSection, string> = {
    diagnose: ui.navDiagnose,
    chat: ui.navChat,
    voice: ui.navVoice,
    history: ui.navHistory,
    profile: ui.navProfile,
  };
  const accountName = displayName?.trim() || ui.navProfile;
  const initial = Array.from(accountName)[0]?.toLocaleUpperCase(language) ?? 'J';

  return (
    <div className={styles.shell} lang={language}>
      <a className={styles.skipLink} href="#jamee-main-content">
        {ui.skipToContent}
      </a>

      <aside className={styles.sidebar} aria-label={ui.appName}>
        <Link className={styles.brand} href="/diagnose" aria-label={ui.appName}>
          <BrandMark />
          <span className={styles.brandCopy}>
            <strong>{ui.appName}</strong>
            <small>{ui.shellEyebrow}</small>
          </span>
        </Link>

        <nav className={styles.desktopNav} aria-label={ui.appName}>
          {NAVIGATION.map((item) => (
            <Link
              className={`${styles.navLink} ${active === item.section ? styles.navLinkActive : ''}`}
              href={item.href}
              key={item.section}
              aria-current={active === item.section ? 'page' : undefined}
            >
              <NavIcon name={item.icon} />
              <span>{labels[item.section]}</span>
            </Link>
          ))}
        </nav>

        <Link className={styles.telegramCard} href="/profile">
          <span className={styles.telegramIcon}>
            <NavIcon name="telegram" />
          </span>
          <span>
            <small>{ui.channelTelegram}</small>
            <strong>{ui.navProfile}</strong>
          </span>
          <span className={styles.arrow} aria-hidden="true">→</span>
        </Link>

        <div className={styles.accountCard}>
          <span className={styles.avatar} aria-hidden="true">{initial}</span>
          <span className={styles.accountCopy}>
            <strong>{accountName}</strong>
            <small>{ui.secureSession}</small>
          </span>
          <SignOutButton language={language} compact />
        </div>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <Link className={styles.mobileBrand} href="/diagnose" aria-label={ui.appName}>
            <BrandMark />
            <strong>{ui.appName}</strong>
          </Link>
          <div className={styles.topbarActions}>
            <LanguageSwitcher compact />
            <Link className={styles.mobileAvatar} href="/profile" aria-label={ui.navProfile}>
              {initial}
            </Link>
            <SignOutButton language={language} compact />
          </div>
        </header>

        <main className={styles.main} id="jamee-main-content">
          <header className={styles.pageHeader}>
            <p className={styles.eyebrow}>{ui.shellEyebrow}</p>
            <h1 className={styles.pageTitle} id={headingId}>{title}</h1>
            <p className={styles.pageDescription}>{description}</p>
          </header>
          <div className={styles.content}>{children}</div>
        </main>

        <nav className={styles.mobileNav} aria-label={ui.appName}>
          {NAVIGATION.map((item) => (
            <Link
              className={`${styles.mobileNavLink} ${active === item.section ? styles.mobileNavLinkActive : ''}`}
              href={item.href}
              key={item.section}
              aria-current={active === item.section ? 'page' : undefined}
            >
              <NavIcon name={item.icon} />
              <span>{labels[item.section]}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

function BrandMark(): React.JSX.Element {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <svg viewBox="0 0 32 32" focusable="false">
        <path d="M25.8 5.8C16.7 5.4 9.4 9.3 7.1 17c-1.1 3.7.2 7.2 2.9 9.4 2.2-6.9 6.6-11.9 13.1-15.1-5.5 4.3-8.9 9.3-10.1 15.2 4.5.6 8.5-1.4 10.6-5.1 2.5-4.4 2.4-10.1 2.2-15.6Z" />
        <path d="M7.1 20.7c-2.2-1.1-3.7-3-4.5-5.7 2.5-.2 4.5.4 6.1 1.6" />
      </svg>
    </span>
  );
}

function NavIcon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, ReactNode> = {
    scan: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /><path d="M8 12h8M12 8v8" /></>,
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></>,
    voice: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    profile: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    telegram: <path d="m21 4-3 16-6-4-3 3v-5l9-7-11 6-4-2Z" />,
  };

  return (
    <svg className={styles.navIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
