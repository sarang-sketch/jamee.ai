import Link from 'next/link';

import { JameeLogo } from '@/components/JameeLogo';
import { activeLanguage } from '@/lib/language.server';
import { productCopy } from '@/lib/product-copy';

import styles from '../legal.module.css';

export const dynamic = 'force-dynamic';

export default async function TermsPage() {
  const language = await activeLanguage(null);
  const copy = productCopy(language).legal;
  return (
    <main className={styles.page} lang={language}>
      <article className={styles.card}>
        <Link className={styles.brand} href="/"><JameeLogo className={styles.logo} size={44} /><strong>Jamee</strong></Link>
        <p className={styles.eyebrow}>Terms</p>
        <h1>{copy.termsTitle}</h1>
        {copy.termsBody.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        <Link className={styles.back} href="/">← {copy.back}</Link>
      </article>
    </main>
  );
}
