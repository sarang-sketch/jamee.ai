import { notFound } from 'next/navigation';

import { UnifiedAssistant } from '@/components/UnifiedAssistant';
import { requireFarmer } from '@/lib/auth/session';
import { readWorkspaceConversation } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await requireFarmer();
  const { id } = await params;
  const conversation = await readWorkspaceConversation(userId, id);
  if (conversation === null) notFound();

  return (
    <UnifiedAssistant
      key={conversation.conversationId}
      userId={userId}
      conversationId={conversation.conversationId}
      initialTurns={conversation.turns}
      initialDiagnosis={conversation.diagnosis}
    />
  );
}
