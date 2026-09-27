import type { ReactNode } from 'react';

import { LanguageProvider } from '@/components/LanguageProvider';
import { WorkspaceShell } from '@/components/WorkspaceShell';
import { requireFarmer } from '@/lib/auth/session';
import { farmerData } from '@/lib/db/farmer';
import { activeLanguage } from '@/lib/language.server';
import { DEFAULT_LANGUAGE } from '@/lib/profile';
import { readConversationSummaries } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function JameeAppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const userId = await requireFarmer();
  const [profile, conversations] = await Promise.all([
    farmerData(userId).readProfile(),
    readConversationSummaries(userId),
  ]);
  const language = await activeLanguage(profile?.language ?? DEFAULT_LANGUAGE);

  return (
    <LanguageProvider initialLanguage={language}>
      <WorkspaceShell
        conversations={conversations}
        displayName={profile?.displayName ?? null}
        email={profile?.email ?? null}
        language={language}
      >
        {children}
      </WorkspaceShell>
    </LanguageProvider>
  );
}
