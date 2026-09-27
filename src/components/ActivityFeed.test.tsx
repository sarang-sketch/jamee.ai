import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActivityFeed } from '@/components/ActivityFeed';
import type { ActivityMessage } from '@/lib/activity';
import { messages } from '@/lib/messages';

const ENTRIES: readonly ActivityMessage[] = [
  {
    id: 'a'.repeat(24),
    channel: 'telegram',
    content: 'A reply delivered through Telegram.',
    createdAt: '2026-09-27T08:00:00.000Z',
    inputKind: 'voice',
    language: 'en',
    role: 'jamee',
  },
  {
    id: 'b'.repeat(24),
    channel: 'web',
    content: 'A question asked on the website.',
    createdAt: '2026-09-27T07:00:00.000Z',
    inputKind: 'text',
    language: 'en',
    role: 'farmer',
  },
];

describe('ActivityFeed', () => {
  it('renders both channels with visible channel and speaker labels', () => {
    const html = renderToStaticMarkup(<ActivityFeed entries={ENTRIES} language="en" />);
    const { ui } = messages('en');

    expect(html).toContain(ui.channelTelegram);
    expect(html).toContain(ui.channelWeb);
    expect(html).toContain(ui.roleJamee);
    expect(html).toContain(ui.roleFarmer);
    expect(html).toContain('A reply delivered through Telegram.');
    expect(html).toContain('A question asked on the website.');
  });

  it('offers both channel entry points when no messages exist', () => {
    const html = renderToStaticMarkup(<ActivityFeed entries={[]} language="en" />);
    const { ui } = messages('en');

    expect(html).toContain(ui.activityEmpty);
    expect(html).toContain('href="/app"');
    expect(html).toContain('href="/app/connect"');
  });
});
