import Link from 'next/link';
import type { ReactNode } from 'react';

import { JameeLogo } from '@/components/JameeLogo';
import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { activeLanguage } from '@/lib/language.server';
import { productCopy } from '@/lib/product-copy';

import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const language = await activeLanguage(null);
  const copy = productCopy(language);

  return (
    <LanguageProvider initialLanguage={language}>
      <main className={styles.page} lang={language}>
        <header className={styles.navbar}>
          <div className={styles.navInner}>
            <Link className={styles.brand} href="#home" aria-label="Jamee home">
              <JameeLogo className={styles.brandMark} size={42} />
              <span><strong>Jamee</strong><small>{copy.hero.eyebrow}</small></span>
            </Link>
            <nav className={styles.desktopNav} aria-label="Primary navigation">
              <Link href="#home">{copy.nav.home}</Link>
              <Link href="#how-it-works">{copy.nav.how}</Link>
              <Link href="#features">{copy.nav.features}</Link>
              <Link href="#languages">{copy.nav.languages}</Link>
              <Link href="#telegram">{copy.nav.telegram}</Link>
              <Link href="#why-jamee">{copy.nav.about}</Link>
            </nav>
            <div className={styles.navActions}>
              <LanguageSwitcher compact />
              <Link className={styles.loginLink} href="/login">{copy.nav.login}</Link>
              <Link className={styles.primarySmall} href="/login">{copy.nav.getStarted}</Link>
            </div>
            <details className={styles.mobileMenu}>
              <summary aria-label={copy.nav.openMenu}><Icon name="menu" /></summary>
              <nav>
                <Link href="#home">{copy.nav.home}</Link>
                <Link href="#how-it-works">{copy.nav.how}</Link>
                <Link href="#features">{copy.nav.features}</Link>
                <Link href="#languages">{copy.nav.languages}</Link>
                <Link href="#telegram">{copy.nav.telegram}</Link>
                <Link href="#why-jamee">{copy.nav.about}</Link>
                <Link href="/login">{copy.nav.login}</Link>
                <Link className={styles.mobileCta} href="/login">{copy.nav.getStarted}</Link>
              </nav>
            </details>
          </div>
        </header>

        <section className={styles.hero} id="home">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}><span aria-hidden="true" />{copy.hero.eyebrow}</p>
            <h1>{copy.hero.title}</h1>
            <p className={styles.lede}>{copy.hero.body}</p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryButton} href="/login">{copy.hero.primary}<Icon name="arrow" /></Link>
              <Link className={styles.secondaryButton} href="#how-it-works"><Icon name="play" />{copy.hero.secondary}</Link>
            </div>
            <ul className={styles.trustList}>
              {copy.hero.trust.map((item) => <li key={item}><Icon name="check" />{item}</li>)}
            </ul>
          </div>

          <div className={styles.heroVisual} aria-label={copy.preview.label}>
            <div className={styles.glow} />
            <div className={styles.previewWindow}>
              <div className={styles.windowTop}>
                <span className={styles.previewBrand}><JameeLogo className={styles.tinyLogo} size={34} /><span><strong>Jamee</strong><small>{copy.hero.eyebrow}</small></span></span>
                <span className={styles.online}><i /> AI online</span>
              </div>
              <div className={styles.previewBody}>
                <aside className={styles.previewSidebar}>
                  <span><Icon name="plus" />{copy.workspace.newChat}</span>
                  <span><Icon name="history" />{copy.workspace.history}</span>
                  <span><Icon name="connect" />{copy.workspace.connect}</span>
                </aside>
                <div className={styles.previewChat}>
                  <div className={styles.previewPrompt}>
                    <span className={styles.leafPhoto}><Icon name="leaf" /></span>
                    <p>{copy.preview.user}</p>
                  </div>
                  <div className={styles.previewAnswer}>
                    <JameeLogo className={styles.answerLogo} size={30} />
                    <div><strong>{copy.preview.conditionLabel}</strong><b lang="en">{copy.preview.condition}</b><p>{copy.preview.response}</p></div>
                  </div>
                  <div className={styles.miniComposer}><span><Icon name="plus" /></span><p>{copy.workspace.composerPlaceholder}</p><span><Icon name="voice" /></span><b><Icon name="send" /></b></div>
                </div>
              </div>
            </div>
            <div className={`${styles.floatingTag} ${styles.photoTag}`}><Icon name="image" /><span><strong>Photo</strong><small>Crop analysis</small></span></div>
            <div className={`${styles.floatingTag} ${styles.voiceTag}`}><Icon name="voice" /><span><strong>Voice</strong><small>Speak naturally</small></span></div>
          </div>
        </section>

        <section className={styles.previewSection} aria-labelledby="preview-title">
          <div className={styles.sectionHeading}>
            <p>{copy.preview.eyebrow}</p><h2 id="preview-title">{copy.preview.title}</h2><span>{copy.preview.body}</span>
          </div>
          <div className={styles.diagnosisPreview}>
            <div className={styles.previewPhotoLarge}><Icon name="leaf" /><span>{copy.preview.label}</span></div>
            <article className={styles.resultCard}>
              <div className={styles.resultHeader}><span><Icon name="scan" /></span><div><small>{copy.preview.cropLabel}</small><strong>{copy.preview.crop}</strong></div></div>
              <div className={styles.condition}><small>{copy.preview.conditionLabel}</small><strong lang="en">{copy.preview.condition}</strong></div>
              <div className={styles.observations}>
                <h3>{copy.preview.observedLabel}</h3>
                <ul>{copy.preview.observed.map((item) => <li key={item}><Icon name="check" />{item}</li>)}</ul>
              </div>
              <div className={styles.guidance}><h3>{copy.preview.guidanceLabel}</h3><p>{copy.preview.guidance}</p></div>
            </article>
          </div>
        </section>

        <section className={styles.howSection} id="how-it-works" aria-labelledby="how-title">
          <div className={styles.sectionHeading}>
            <p>{copy.how.eyebrow}</p><h2 id="how-title">{copy.how.title}</h2><span>{copy.how.body}</span>
          </div>
          <ol className={styles.steps}>
            {copy.how.steps.map((step, index) => (
              <li key={step.title}><span>{String(index + 1).padStart(2, '0')}</span><Icon name={(['camera', 'chat', 'sparkle', 'telegram'] as IconName[])[index] ?? 'sparkle'} /><h3>{step.title}</h3><p>{step.body}</p></li>
            ))}
          </ol>
        </section>

        <section className={styles.featuresSection} id="features" aria-labelledby="features-title">
          <div className={styles.sectionHeading}>
            <p>{copy.features.eyebrow}</p><h2 id="features-title">{copy.features.title}</h2><span>{copy.features.body}</span>
          </div>
          <div className={styles.featureGrid}>
            {copy.features.items.map((feature) => (
              <article key={feature.title}><span><Icon name={feature.icon as IconName} /></span><h3>{feature.title}</h3><p>{feature.body}</p></article>
            ))}
          </div>
        </section>

        <section className={styles.waysSection} aria-labelledby="ways-title">
          <div className={styles.waysCopy}><p>{copy.ways.eyebrow}</p><h2 id="ways-title">{copy.ways.title}</h2><span>{copy.ways.body}</span></div>
          <div className={styles.wayCards}>
            {copy.ways.items.map((way) => <article key={way.title}><span><Icon name={way.icon as IconName} /></span><div><small>{way.title}</small><p>{way.body}</p></div></article>)}
          </div>
        </section>

        <section className={styles.languageSection} id="languages" aria-labelledby="language-title">
          <div className={styles.languageVisual}><span>English</span><span>हिन्दी</span><span>मराठी</span><div><Icon name="language" /></div></div>
          <div className={styles.languageCopy}><p>{copy.languages.eyebrow}</p><h2 id="language-title">{copy.languages.title}</h2><span>{copy.languages.body}</span><LanguageSwitcher /></div>
        </section>

        <section className={styles.telegramSection} id="telegram" aria-labelledby="telegram-title">
          <div className={styles.telegramCopy}><p>{copy.telegram.eyebrow}</p><h2 id="telegram-title">{copy.telegram.title}</h2><span>{copy.telegram.body}</span><Link className={styles.lightButton} href="/login">{copy.telegram.cta}<Icon name="arrow" /></Link></div>
          <div className={styles.channelMap}><span><Icon name="browser" /><small>{copy.telegram.website}</small></span><i>↔</i><b><JameeLogo className={styles.channelLogo} size={56} /><small>{copy.telegram.assistant}</small></b><i>↔</i><span><Icon name="telegram" /><small>Telegram</small></span></div>
        </section>

        <section className={styles.paymentSection} aria-labelledby="payment-title">
          <div className={styles.price}><small>₹</small><strong>20</strong><span>/ 7 days</span></div>
          <div className={styles.paymentCopy}><p>{copy.payment.eyebrow}</p><h2 id="payment-title">{copy.payment.title}</h2><span>{copy.payment.body}</span><small>{copy.payment.detail}</small></div>
          <Link className={styles.primaryButton} href="/login">{copy.payment.cta}<Icon name="arrow" /></Link>
        </section>

        <section className={styles.whySection} id="why-jamee" aria-labelledby="why-title">
          <div className={styles.sectionHeading}><p>{copy.why.eyebrow}</p><h2 id="why-title">{copy.why.title}</h2><span>{copy.why.body}</span></div>
          <div className={styles.whyGrid}>{copy.why.items.map((item, index) => <article key={item.title}><span>{String(index + 1).padStart(2, '0')}</span><h3>{item.title}</h3><p>{item.body}</p></article>)}</div>
        </section>

        <section className={styles.examplesSection} aria-labelledby="examples-title">
          <div><p>{copy.examples.eyebrow}</p><h2 id="examples-title">{copy.examples.title}</h2><span>{copy.examples.body}</span></div>
          <div>{copy.examples.items.map((example) => <blockquote key={example}>“{example}”<Icon name="arrow" /></blockquote>)}</div>
        </section>

        <section className={styles.safetySection} id="responsible-ai" aria-labelledby="safety-title">
          <span><Icon name="shield" /></span><div><p>{copy.safety.eyebrow}</p><h2 id="safety-title">{copy.safety.title}</h2><small>{copy.safety.body}</small></div>
        </section>

        <section className={styles.finalCta}>
          <JameeLogo className={styles.finalLogo} size={66} />
          <h2>{copy.final.title}</h2><p>{copy.final.body}</p>
          <div><Link className={styles.primaryButton} href="/login">{copy.final.primary}<Icon name="arrow" /></Link><Link className={styles.secondaryButton} href="/login">{copy.final.secondary}</Link></div>
        </section>

        <footer className={styles.footer}>
          <div className={styles.footerTop}>
            <div className={styles.footerBrand}><Link className={styles.brand} href="#home"><JameeLogo className={styles.brandMark} size={42} /><span><strong>Jamee</strong><small>{copy.hero.eyebrow}</small></span></Link><p>{copy.footer.description}</p></div>
            <nav><strong>{copy.footer.product}</strong><Link href="#how-it-works">{copy.nav.how}</Link><Link href="#features">{copy.nav.features}</Link><Link href="#languages">{copy.nav.languages}</Link><Link href="#telegram">{copy.nav.telegram}</Link></nav>
            <nav><strong>{copy.footer.account}</strong><Link href="/login">{copy.nav.login}</Link><Link href="/login">{copy.nav.getStarted}</Link><LanguageSwitcher compact /></nav>
            <nav><strong>{copy.footer.legal}</strong><Link href="/privacy">{copy.footer.privacy}</Link><Link href="/terms">{copy.footer.terms}</Link><Link href="#responsible-ai">{copy.footer.disclaimer}</Link></nav>
          </div>
          <p className={styles.copyright}>© 2026 {copy.footer.copyright}</p>
        </footer>
      </main>
    </LanguageProvider>
  );
}

type IconName = 'menu' | 'arrow' | 'play' | 'check' | 'plus' | 'history' | 'connect' | 'voice' | 'send' | 'image' | 'leaf' | 'scan' | 'camera' | 'chat' | 'sparkle' | 'telegram' | 'language' | 'browser' | 'shield' | 'photo' | 'text';
function Icon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, ReactNode> = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />, arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>, play: <path d="m9 7 8 5-8 5Z" />,
    check: <path d="m5 12 4 4L19 6" />, plus: <path d="M12 5v14M5 12h14" />, history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    connect: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1" /></>,
    voice: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>, send: <path d="M12 19V5M6 11l6-6 6 6" />,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
    leaf: <path d="M20 4C11 4 5 8 5 15c0 3 2 5 5 5 6 0 9-6 10-16ZM6 19c3-5 6-8 11-11" />,
    scan: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /><path d="M8 12h8M12 8v8" /></>,
    camera: <><path d="M14.5 5 16 7h3a2 2 0 0 1 2 2v9H3V9a2 2 0 0 1 2-2h3l1.5-2Z" /><circle cx="12" cy="12.5" r="3" /></>,
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></>,
    sparkle: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z" /><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" /></>,
    telegram: <path d="m21 4-3 16-6-4-3 3v-5l9-7-11 6-4-2Z" />, language: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
    browser: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>, shield: <><path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6Z" /><path d="m8 12 2.5 2.5L16 9" /></>,
    photo: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m4 16 5-5 4 4 3-3 5 5" /></>, text: <><path d="M5 5h14M12 5v14M8 19h8" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
