import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `ProfileForm` — the state-driven rendering of the two fields (Requirement 1.8: a
 * display name and a preferred language) and the three language options (9.1). The save flow (POST
 * `/api/profile`, then show `saved`/refresh on a language change) is proven at the route layer; a
 * static render decides that the labelled fields, the initial values, and the three options appear.
 *
 * Requirements: 1.8, 9.1; "Mobile layout and accessibility" (real `<label>` association).
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ProfileForm } from '@/components/ProfileForm';
import { LANGUAGE_OPTIONS } from '@/lib/profile';
import { messages } from '@/lib/messages';

describe('ProfileForm', () => {
  it('renders the display-name and language labels and the initial values (1.8)', () => {
    const html = renderToStaticMarkup(<ProfileForm initial={{ displayName: 'Asha', language: 'en' }} />);
    const { ui } = messages('en');
    expect(html).toContain(ui.displayNameLabel);
    expect(html).toContain(ui.preferredLanguageLabel);
    expect(html).toContain('Asha');
    expect(html).toContain(ui.save);
  });

  it('offers exactly the three supported languages as options (9.1)', () => {
    const html = renderToStaticMarkup(<ProfileForm initial={{ displayName: null, language: 'hi' }} />);
    const { languageNames } = messages('hi');
    for (const option of LANGUAGE_OPTIONS) {
      expect(html).toContain(`value="${option}"`);
      expect(html).toContain(languageNames[option]);
    }
  });

  it('renders labels in the saved language (mr)', () => {
    const html = renderToStaticMarkup(<ProfileForm initial={{ displayName: null, language: 'mr' }} />);
    expect(html).toContain(messages('mr').ui.displayNameLabel);
  });
});
