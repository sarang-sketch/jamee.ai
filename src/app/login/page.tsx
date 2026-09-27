import Link from 'next/link';
import { redirect } from 'next/navigation';

import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { JameeLogo } from '@/components/JameeLogo';
import { LanguageProvider } from '@/components/LanguageProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { currentUserId } from '@/lib/auth/session';
import { activeLanguage } from '@/lib/language.server';
import { productCopy } from '@/lib/product-copy';

import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if ((await currentUserId()) !== null) redirect('/app');

  const language = await activeLanguage(null);
  const copy = productCopy(language);

  return (
    <LanguageProvider initialLanguage={language}>
      <main className={styles.page} lang={language}>
        <section className={styles.story}>
          <Link className={styles.brand} href="/">
            <JameeLogo className={styles.logo} size={46} />
            <span><strong>Jamee</strong><small>{copy.hero.eyebrow}</small></span>
          </Link>
          <div className={styles.storyCopy}>
            <p>{copy.login.eyebrow}</p>
            <h1>{copy.login.visualTitle}</h1>
            <span>{copy.login.visualBody}</span>
            <ul>{copy.login.highlights.map((item) => <li key={item}><CheckIcon />{item}</li>)}</ul>
          </div>
          <div className={styles.cropVisual} aria-hidden="true">
            <div className={styles.sun} />
            <div className={styles.fieldLines} />
            <JameeLogo className={styles.visualLogo} size={82} />
          </div>
        </section>

        <section className={styles.loginArea}>
          <div className={styles.topActions}><LanguageSwitcher compact /><Link href="/">{copy.login.back}</Link></div>
          <div className={styles.card}>
            <JameeLogo className={styles.cardLogo} size={54} />
            <p>{copy.login.eyebrow}</p>
            <h2>{copy.login.welcome}</h2>
            <span>{copy.login.body}</span>
            <div className={styles.googleAction}><GoogleSignInButton language={language} /></div>
            <small>{copy.login.accountNote}</small>
            <div className={styles.legal}><Link href="/privacy">{copy.footer.privacy}</Link><span>·</span><Link href="/terms">{copy.footer.terms}</Link></div>
          </div>
        </section>
      </main>
    </LanguageProvider>
  );
}

function CheckIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
}
