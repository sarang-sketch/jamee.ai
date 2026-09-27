'use server';

import { redirect } from 'next/navigation';

import { requireFarmer } from '@/lib/auth/session';
import { conversationStoreFrom } from '@/services/conversation.service';

export async function createNewConversation(): Promise<never> {
  const userId = await requireFarmer();
  const conversation = await conversationStoreFrom().create(userId, 'web');
  redirect(`/app/chat/${encodeURIComponent(conversation.id)}`);
}
