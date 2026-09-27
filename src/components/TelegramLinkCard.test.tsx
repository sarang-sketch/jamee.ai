import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `TelegramLinkCard` — the state-driven rendering (Requirement 21.20: the card shows
 * the linked state and offers link OR unlink). Interaction (mint → open deep link, unlink → re-read)
 * is a fetch-and-`window.open` flow the integration/route layers already prove end to end; what a
 * static render decides is that the correct copy and the correct control appear for each state.
 *
 * Requirements: 21.15, 21.20; "Mobile layout and accessibility" (a `role="status"` state line)
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { TelegramLinkCard } from '@/components/TelegramLinkCard';
import { messages } from '@/lib/messages';

const noop = (): void => undefined;

describe('TelegramLinkCard', () => {
  it('when linked, shows the linked state and the unlink control (21.15)', () => {
    const html = renderToStaticMarkup(<TelegramLinkCard botUsername="jamee_bot" isLinked language="en" onChanged={noop} />);
    const { access } = messages('en');
    expect(html).toContain(access.linkedState);
    expect(html).toContain('@jamee_bot');
    expect(html).toContain(access.unlinkButton);
    expect(html).not.toContain(access.linkButton);
    expect(html).toContain('role="status"');
  });

  it('when not linked, shows the not-linked state and the link control (21.20)', () => {
    const html = renderToStaticMarkup(<TelegramLinkCard botUsername="jamee_bot" isLinked={false} language="en" onChanged={noop} />);
    const { access } = messages('en');
    expect(html).toContain(access.notLinkedState);
    expect(html).toContain(access.linkButton);
    expect(html).not.toContain(access.unlinkButton);
  });

  it('renders its copy in the farmer’s saved language (hi)', () => {
    const html = renderToStaticMarkup(<TelegramLinkCard botUsername="jamee_bot" isLinked={false} language="hi" onChanged={noop} />);
    const { access } = messages('hi');
    expect(html).toContain(access.linkHeading);
    expect(html).toContain(access.linkButton);
  });
});
