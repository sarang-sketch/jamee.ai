'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth/auth-client';
import { messages } from '@/lib/messages';
import type { Language } from '@/lib/schemas';

import styles from './SignOutButton.module.css';

export interface SignOutButtonProps {
  compact?: boolean;
  language: Language;
}

export function SignOutButton({ compact = false, language }: SignOutButtonProps): React.JSX.Element {
  const { ui } = messages(language);
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle');

  async function signOut(): Promise<void> {
    if (state === 'pending') return;
    setState('pending');
    try {
      const result = await authClient.signOut();
      if (result.error) throw result.error;
      router.replace('/');
      router.refresh();
    } catch {
      setState('failed');
    }
  }

  return (
    <div className={`${styles.wrapper} ${compact ? styles.compact : ''}`}>
      <button
        className={styles.button}
        type="button"
        disabled={state === 'pending'}
        aria-label={ui.signOut}
        onClick={() => { void signOut(); }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M14 8l4 4-4 4M18 12H8" />
        </svg>
        <span>{ui.signOut}</span>
      </button>
      {state === 'failed' ? <p className={styles.error} role="alert">{ui.signOutFailed}</p> : null}
    </div>
  );
}
