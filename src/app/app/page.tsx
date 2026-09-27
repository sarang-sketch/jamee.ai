import { UnifiedAssistant } from '@/components/UnifiedAssistant';
import { requireFarmer } from '@/lib/auth/session';
import { readWorkspaceConversation } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function JameeAppPage() {
  const userId = await requireFarmer();
  const conversation = await readWorkspaceConversation(userId);

  if (conversation === null) return null;

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
