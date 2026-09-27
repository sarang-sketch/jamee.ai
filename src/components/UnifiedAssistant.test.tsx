import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ChatTurn } from '@/components/ChatThread';
import { LanguageContext } from '@/components/LanguageProvider';
import { UnifiedAssistant } from '@/components/UnifiedAssistant';
import type { PersistedDiagnosis } from '@/lib/workspace';

const conversationId = '4'.repeat(24);

function renderAssistant(input?: {
  turns?: readonly ChatTurn[];
  diagnosis?: PersistedDiagnosis | null;
}): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', setLanguage: vi.fn() }}>
      <UnifiedAssistant
        userId="farmer-1"
        conversationId={conversationId}
        initialTurns={input?.turns ?? []}
        initialDiagnosis={input?.diagnosis ?? null}
      />
    </LanguageContext.Provider>,
  );
}

describe('UnifiedAssistant', () => {
  it('puts text, gallery, camera, voice, and send controls in one composer', () => {
    const html = renderAssistant();

    expect(html).toContain('How can I help with your crop?');
    expect(html).toContain('placeholder="Message Jamee…"');
    expect((html.match(/type="file"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('capture="environment"');
    expect(html).toContain('aria-label="Add a crop photo"');
    expect(html).toContain('Tap to start recording');
    expect(html).toContain('aria-label="Send message"');
  });

  it('renders real stored messages and only fields supplied by a persisted diagnosis', () => {
    const turns: ChatTurn[] = [
      {
        key: 'message-1', id: 'message-1', role: 'farmer',
        content: 'Why are these rings appearing?', language: 'en', inputKind: 'text',
        createdAt: '2026-09-27T08:00:00.000Z',
      },
    ];
    const diagnosis: PersistedDiagnosis = {
      id: '5'.repeat(24),
      createdAt: '2026-09-27T08:01:00.000Z',
      imageUrl: '/api/media/' + '6'.repeat(24),
      result: {
        status: 'identified',
        diseaseName: 'Tomato Early Blight',
        confidence: 0.82,
        severity: 'moderate',
        explanation: 'The visible signs match verified early blight information.',
        knowledge: {
          symptoms: ['Dark concentric rings'],
          causes: ['Warm, humid conditions'],
          treatment: ['Remove affected lower leaves'],
          prevention: ['Improve airflow'],
          source: 'Verified extension source',
        },
        needsExpert: false,
        language: 'en',
      },
    };

    const html = renderAssistant({ turns, diagnosis });
    expect(html).toContain('Why are these rings appearing?');
    expect(html).toContain('Tomato Early Blight');
    expect(html).toContain('82%');
    expect(html).toContain(`/diagnosis/${diagnosis.id}`);
    expect(html).toContain(diagnosis.imageUrl ?? '');
  });
});
