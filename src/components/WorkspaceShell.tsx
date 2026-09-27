'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

import { createNewConversation } from '@/app/app/actions';
import { JameeLogo } from '@/components/JameeLogo';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SignOutButton } from '@/components/SignOutButton';
import { productCopy } from '@/lib/product-copy';
import type { Language } from '@/lib/schemas';
import type { ConversationSummary } from '@/lib/workspace';

import styles from './WorkspaceShell.module.css';

export interface WorkspaceShellProps {
  children: ReactNode;
  conversations: readonly ConversationSummary[];
  displayName: string | null;
  email: string | null;
  language: Language;
}

type PrimarySection = 'chat' | 'history' | 'connect' | 'profile';

export function WorkspaceShell({
  children,
  conversations,
  displayName,
  email,
  language,
}: WorkspaceShellProps): React.JSX.Element {
  const pathname = usePathname();
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const copy = productCopy(language).workspace;
  const section: PrimarySection = pathname.startsWith('/app/history')
    ? 'history'
    : pathname.startsWith('/app/connect')
      ? 'connect'
      : pathname.startsWith('/app/profile')
        ? 'profile'
        : 'chat';
  const accountName = displayName?.trim() || copy.profile;
  const initial = Array.from(accountName)[0]?.toLocaleUpperCase(language) ?? 'J';
  const drawerOpen = drawerPath === pathname;

  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerPath(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [drawerOpen]);

  const sidebar = (
    <>
      <div className={styles.sidebarTop}>
        <Link className={styles.brand} href="/app" aria-label="Jamee">
          <JameeLogo className={styles.logo} size={42} />
          <span>
            <strong>Jamee</strong>
            <small>{copy.assistantSubtitle}</small>
          </span>
        </Link>
        <button
          type="button"
          className={styles.drawerClose}
          onClick={() => setDrawerPath(null)}
          aria-label={copy.closeMenu}
        >
          <Icon name="close" />
        </button>
      </div>

      <form action={createNewConversation} className={styles.newChatForm}>
        <NewChatButton label={copy.newChat} pendingLabel={copy.startingChat} />
      </form>

      <nav className={styles.primaryNav} aria-label="Jamee">
        <NavLink href="/app/history" active={section === 'history'} icon="history">
          {copy.history}
        </NavLink>
        <NavLink href="/app/connect" active={section === 'connect'} icon="connect">
          {copy.connect}
        </NavLink>
      </nav>

      <div className={styles.conversationSection}>
        <p className={styles.sectionLabel}>{copy.recent}</p>
        {conversations.length === 0 ? (
          <p className={styles.emptyHistory}>{copy.noHistory}</p>
        ) : (
          <ConversationGroups conversations={conversations} pathname={pathname} language={language} />
        )}
      </div>

      <Link
        className={`${styles.profileCard} ${section === 'profile' ? styles.profileCardActive : ''}`}
        href="/app/profile"
        aria-current={section === 'profile' ? 'page' : undefined}
      >
        <span className={styles.avatar} aria-hidden="true">{initial}</span>
        <span className={styles.profileCopy}>
          <strong>{accountName}</strong>
          <small>{email ?? copy.profile}</small>
        </span>
        <Icon name="chevron" />
      </Link>
    </>
  );

  return (
    <div className={styles.shell} lang={language}>
      <a className={styles.skipLink} href="#jamee-workspace">Skip to conversation</a>

      <aside className={styles.desktopSidebar}>{sidebar}</aside>

      {drawerOpen ? (
        <button
          type="button"
          className={styles.backdrop}
          onClick={() => setDrawerPath(null)}
          aria-label={copy.closeMenu}
        />
      ) : null}
      <aside className={`${styles.mobileDrawer} ${drawerOpen ? styles.mobileDrawerOpen : ''}`} aria-hidden={!drawerOpen}>
        {sidebar}
      </aside>

      <div className={styles.workspace}>
        <header className={styles.mobileHeader}>
          <button
            type="button"
            className={styles.menuButton}
            onClick={() => setDrawerPath(pathname)}
            aria-label={copy.openMenu}
            aria-expanded={drawerOpen}
          >
            <Icon name="menu" />
          </button>
          <Link className={styles.mobileBrand} href="/app">
            <JameeLogo className={styles.logo} size={36} />
            <strong>Jamee</strong>
          </Link>
          <div className={styles.mobileActions}>
            <LanguageSwitcher compact />
            <SignOutButton language={language} compact />
          </div>
        </header>
        <main className={styles.main} id="jamee-workspace">{children}</main>
      </div>
    </div>
  );
}

function NewChatButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={styles.newChat} type="submit" disabled={pending}>
      <Icon name="plus" />
      <span>{pending ? pendingLabel : label}</span>
    </button>
  );
}

function NavLink({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <Link
      className={`${styles.navLink} ${active ? styles.navLinkActive : ''}`}
      href={href}
      aria-current={active ? 'page' : undefined}
    >
      <Icon name={icon} />
      <span>{children}</span>
    </Link>
  );
}

function ConversationGroups({
  conversations,
  pathname,
  language,
}: {
  conversations: readonly ConversationSummary[];
  pathname: string;
  language: Language;
}) {
  const copy = productCopy(language).workspace;
  const groups = [
    ['today', copy.today],
    ['yesterday', copy.yesterday],
    ['older', copy.older],
  ] as const;

  return (
    <div className={styles.groups}>
      {groups.map(([group, label]) => {
        const rows = conversations.filter((conversation) => conversation.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} className={styles.group} aria-label={label}>
            <p>{label}</p>
            <ul>
              {rows.map((conversation) => {
                const href = `/app/chat/${conversation.id}`;
                const active = pathname === href;
                return (
                  <li key={conversation.id}>
                    <Link
                      className={`${styles.conversationLink} ${active ? styles.conversationLinkActive : ''}`}
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      title={conversation.title ?? copy.untitled}
                    >
                      <Icon name="chat" />
                      <span>{conversation.title ?? copy.untitled}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

type IconName = 'plus' | 'history' | 'connect' | 'chat' | 'chevron' | 'menu' | 'close';

function Icon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    connect: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1" /></>,
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  };
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
