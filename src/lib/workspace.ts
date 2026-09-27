import 'server-only';

import { farmerData } from '@/lib/db/farmer';
import {
  farmerReads,
  latestConversationDiagnosis,
  listRecentMessages,
} from '@/lib/db/reads';
import { resolveHistoryImage } from '@/lib/history';
import { knowledgePayloadOf, lookupCondition } from '@/lib/knowledge';
import type { DiagnosisResult } from '@/lib/schemas';
import {
  conversationBelongsTo,
  type MessageRecord,
} from '@/lib/db/reads';
import {
  conversationStoreFrom,
  findOrCreateActive,
} from '@/services/conversation.service';
import { CHAT_MESSAGE_LIMIT, toChatTurns, type ChatTurn } from '@/components/ChatThread';

export interface ConversationSummary {
  id: string;
  group: 'today' | 'yesterday' | 'older';
  title: string | null;
  updatedAt: string;
}

export interface PersistedDiagnosis {
  id: string;
  createdAt: string;
  imageUrl: string | null;
  result: DiagnosisResult;
}

export interface WorkspaceConversation {
  conversationId: string;
  diagnosis: PersistedDiagnosis | null;
  turns: ChatTurn[];
}

/**
 * Sidebar data from the existing MongoDB collections. Conversation titles are never fabricated:
 * an explicit stored title wins, then the first real farmer message, then the latest real
 * diagnosis name. A conversation with no content remains untitled and is localized by the UI.
 */
export async function readConversationSummaries(
  userId: string,
): Promise<ConversationSummary[]> {
  const data = farmerData(userId);
  const [conversations, recentMessages, diagnoses] = await Promise.all([
    data.findConversations({ channel: 'web' }),
    listRecentMessages(userId, 300),
    data.findDiagnoses({ channel: 'web' }),
  ]);

  const firstFarmerMessage = new Map<string, string>();
  for (const message of [...recentMessages].reverse()) {
    if (message.channel !== 'web' || message.role !== 'farmer') continue;
    const conversationId = message.conversationId.toHexString();
    if (!firstFarmerMessage.has(conversationId)) {
      firstFarmerMessage.set(conversationId, compactTitle(message.content));
    }
  }

  const latestDiagnosis = new Map<string, string>();
  for (const diagnosis of diagnoses) {
    const conversationId = diagnosis.conversationId.toHexString();
    if (latestDiagnosis.has(conversationId)) continue;
    if (diagnosis.status === 'identified' && diagnosis.diseaseName !== null && diagnosis.diseaseName !== undefined) {
      latestDiagnosis.set(conversationId, diagnosis.diseaseName);
    }
  }

  const now = new Date();
  return conversations.slice(0, 30).map((conversation) => {
    const id = conversation._id.toHexString();
    const storedTitle = conversation.title?.trim();
    return {
      id,
      group: dayGroup(conversation.updatedAt, now),
      title:
        storedTitle && storedTitle.length > 0
          ? compactTitle(storedTitle)
          : (firstFarmerMessage.get(id) ?? latestDiagnosis.get(id) ?? null),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  });
}

/** Resolve the active web conversation, or a requested conversation after owner validation. */
export async function readWorkspaceConversation(
  userId: string,
  requestedConversationId?: string,
): Promise<WorkspaceConversation | null> {
  let conversationId: string;

  if (requestedConversationId === undefined) {
    const conversation = await findOrCreateActive(userId, 'web', conversationStoreFrom());
    conversationId = conversation.id;
  } else {
    const belongs = await conversationBelongsTo(requestedConversationId, userId);
    if (!belongs) return null;
    conversationId = requestedConversationId;
  }

  const reads = farmerReads(userId);
  const [messages, diagnosisDoc] = await Promise.all([
    reads.conversationMessages(conversationId, CHAT_MESSAGE_LIMIT),
    latestConversationDiagnosis(userId, conversationId),
  ]);

  const rows = messages.map((message: MessageRecord) => ({
    id: message._id.toHexString(),
    role: message.role,
    content: message.content,
    language: message.language,
    inputKind: message.inputKind,
    createdAt: message.createdAt.toISOString(),
  }));

  let diagnosis: PersistedDiagnosis | null = null;
  if (diagnosisDoc !== null) {
    const image = await resolveHistoryImage(diagnosisDoc, reads);
    if (diagnosisDoc.status === 'unknown') {
      diagnosis = {
        id: diagnosisDoc._id.toHexString(),
        createdAt: diagnosisDoc.createdAt.toISOString(),
        imageUrl: image?.url ?? null,
        result: {
          status: 'unknown',
          diseaseName: null,
          confidence: null,
          severity: 'none',
          explanation: diagnosisDoc.explanation,
          knowledge: null,
          needsExpert: true,
          language: diagnosisDoc.language,
        },
      };
    } else if (
      diagnosisDoc.diseaseName !== null &&
      diagnosisDoc.diseaseName !== undefined &&
      diagnosisDoc.confidence !== null &&
      diagnosisDoc.confidence !== undefined
    ) {
      const lookup = await lookupCondition(diagnosisDoc.diseaseName);
      if (lookup.found) {
        diagnosis = {
          id: diagnosisDoc._id.toHexString(),
          createdAt: diagnosisDoc.createdAt.toISOString(),
          imageUrl: image?.url ?? null,
          result: {
            status: 'identified',
            diseaseName: diagnosisDoc.diseaseName,
            confidence: diagnosisDoc.confidence,
            severity: diagnosisDoc.severity,
            explanation: diagnosisDoc.explanation,
            knowledge: knowledgePayloadOf(lookup.entry),
            needsExpert: false,
            language: diagnosisDoc.language,
          },
        };
      }
    }
  }

  return {
    conversationId,
    diagnosis,
    turns: toChatTurns(rows),
  };
}

function compactTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 48) return normalized;
  return `${normalized.slice(0, 47).trimEnd()}…`;
}

function dayGroup(value: Date, now: Date): ConversationSummary['group'] {
  const delta = daySerial(now) - daySerial(value);
  if (delta <= 0) return 'today';
  if (delta === 1) return 'yesterday';
  return 'older';
}

function daySerial(value: Date): number {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(value);
  const number = (type: 'year' | 'month' | 'day') =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return Math.floor(Date.UTC(number('year'), number('month') - 1, number('day')) / 86_400_000);
}
