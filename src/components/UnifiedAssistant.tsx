'use client';

import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { readChatResponse } from '@/components/ChatComposer';
import type { ChatTurn } from '@/components/ChatThread';
import { DiagnosisResultCard, readDiagnoseResponse } from '@/components/DiagnosisResultCard';
import { ErrorBanner, type ErrorBannerError } from '@/components/ErrorBanner';
import {
  admissionCode,
  encodeCropImage,
  mediaEndpointUploader,
  rejectionMessage,
  submitCropImage,
} from '@/components/ImageUploader';
import { JameeLogo } from '@/components/JameeLogo';
import { useJameeRequests } from '@/components/LanguageProvider';
import { readVoiceResponse } from '@/components/VoiceAnswerCard';
import { VoiceRecorder } from '@/components/VoiceRecorder';
import { AppError, toEnvelope } from '@/lib/errors';
import { mediaUrl } from '@/lib/media/url';
import { messages } from '@/lib/messages';
import { productCopy } from '@/lib/product-copy';
import type { DiagnosisResult } from '@/lib/schemas';
import { formatInstant } from '@/lib/time';
import type { PersistedDiagnosis } from '@/lib/workspace';

import styles from './UnifiedAssistant.module.css';

export interface UnifiedAssistantProps {
  conversationId: string;
  initialDiagnosis: PersistedDiagnosis | null;
  initialTurns: readonly ChatTurn[];
  userId: string;
}

type MessageItem = {
  kind: 'message';
  key: string;
  id: string | null;
  role: ChatTurn['role'];
  content: string;
  language: ChatTurn['language'];
  inputKind: ChatTurn['inputKind'];
  createdAt: string;
  imageUrl?: string;
};

type DiagnosisItem = {
  kind: 'diagnosis';
  key: string;
  id: string;
  result: DiagnosisResult;
  createdAt: string;
  imageUrl: string | null;
};

type TimelineItem = MessageItem | DiagnosisItem;
type Phase = 'idle' | 'uploading' | 'analyzing' | 'thinking';

export function UnifiedAssistant({
  conversationId,
  initialDiagnosis,
  initialTurns,
  userId,
}: UnifiedAssistantProps): React.JSX.Element {
  const requests = useJameeRequests();
  const { ui, loading } = messages(requests.language);
  const copy = productCopy(requests.language).workspace;
  const [timeline, setTimeline] = useState<TimelineItem[]>(() =>
    initialTimeline(initialTurns, initialDiagnosis),
  );
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [failure, setFailure] = useState<ErrorBannerError | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [dragActive, setDragActive] = useState(false);

  const galleryId = useId();
  const cameraId = useId();
  const composerId = useId();
  const galleryInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const localKeys = useRef(0);
  const previewRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  const busy = phase !== 'idle';
  const message = draft.trim();
  const canSend = !busy && (file !== null || message.length > 0);
  const accept = 'image/jpeg,image/png,image/webp';

  function nextKey(prefix: string): string {
    localKeys.current += 1;
    return `${prefix}:${localKeys.current}`;
  }

  function setPreview(next: string | null): void {
    if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next;
    setPreviewUrl(next);
  }

  function chooseFile(selected: File | undefined): void {
    setFailure(null);
    setAttachmentOpen(false);
    if (selected === undefined) return;

    const code = admissionCode(selected);
    if (code !== null) {
      setFile(null);
      setPreview(null);
      setFailure({
        message: rejectionMessage(code, requests.language),
        language: requests.language,
        retryable: false,
      });
      return;
    }

    setFile(selected);
    setPreview(URL.createObjectURL(selected));
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    chooseFile(event.target.files?.[0]);
  }

  function clearPhoto(): void {
    setFile(null);
    setPreview(null);
    if (galleryInput.current !== null) galleryInput.current.value = '';
    if (cameraInput.current !== null) cameraInput.current.value = '';
    textarea.current?.focus();
  }

  async function sendText(content: string): Promise<boolean> {
    const normalized = content.trim();
    if (normalized.length === 0 || phase !== 'idle') return false;

    const key = nextKey('text');
    const createdAt = new Date().toISOString();
    setFailure(null);
    setPhase('thinking');
    setTimeline((current) => [
      ...current,
      {
        kind: 'message', key, id: null, role: 'farmer', content: normalized,
        language: requests.language, inputKind: 'text', createdAt,
      },
    ]);
    setDraft('');

    try {
      const response = await requests.chat({ conversationId, message: normalized });
      const outcome = await readChatResponse(response, requests.language);
      if (outcome.kind === 'error') {
        if (outcome.cause !== undefined) console.error('[jamee] chat response parse failed', outcome.cause);
        setTimeline((current) => current.filter((item) => item.key !== key));
        setDraft(normalized);
        setFailure(outcome.envelope.error);
        return false;
      }

      setTimeline((current) => [
        ...current.map((item) =>
          item.kind === 'message' && item.key === key
            ? { ...item, id: outcome.response.farmerMessageId }
            : item,
        ),
        {
          kind: 'message', key: outcome.response.answer.messageId,
          id: outcome.response.answer.messageId, role: 'jamee',
          content: outcome.response.answer.content,
          language: outcome.response.answer.language, inputKind: 'text',
          createdAt: new Date().toISOString(),
        },
      ]);
      return true;
    } catch (cause) {
      console.error('[jamee] chat request failed', cause);
      setTimeline((current) => current.filter((item) => item.key !== key));
      setDraft(normalized);
      setFailure(toEnvelope(new AppError('INTERNAL_ERROR'), requests.language).error);
      return false;
    } finally {
      setPhase('idle');
    }
  }

  async function sendPhoto(selected: File, caption: string): Promise<void> {
    const optimisticKey = nextKey('photo');
    const optimisticUrl = previewUrl ?? URL.createObjectURL(selected);
    const createdAt = new Date().toISOString();

    setFailure(null);
    setPhase('uploading');
    setTimeline((current) => [
      ...current,
      {
        kind: 'message', key: optimisticKey, id: null, role: 'farmer',
        content: copy.cropPhoto, language: requests.language, inputKind: 'image',
        createdAt, imageUrl: optimisticUrl,
      },
    ]);

    const submission = await submitCropImage({
      file: selected,
      userId,
      upload: mediaEndpointUploader,
      encode: encodeCropImage,
      conversationId,
      diagnose: (body) => {
        setPhase('analyzing');
        return requests.diagnose(body);
      },
    });

    if (submission.status === 'rejected') {
      setTimeline((current) => current.filter((item) => item.key !== optimisticKey));
      setDraft(caption);
      setFailure({
        message: rejectionMessage(submission.code, requests.language),
        language: requests.language,
        retryable: false,
      });
      setPhase('idle');
      return;
    }

    if (submission.status === 'failed') {
      console.error(`[jamee] unified crop photo ${submission.stage} failed`, submission.cause);
      setTimeline((current) => current.filter((item) => item.key !== optimisticKey));
      setDraft(caption);
      setFailure(toEnvelope(new AppError('INTERNAL_ERROR'), requests.language).error);
      setPhase('idle');
      return;
    }

    const outcome = await readDiagnoseResponse(submission.response, requests.language);
    if (outcome.kind === 'error') {
      if (outcome.cause !== undefined) console.error('[jamee] diagnosis response parse failed', outcome.cause);
      setTimeline((current) => current.filter((item) => item.key !== optimisticKey));
      setDraft(caption);
      setFailure(outcome.envelope.error);
      setPhase('idle');
      return;
    }

    const storedImageUrl = mediaUrl(submission.image.fileId);
    setTimeline((current) => [
      ...current.filter((item) => item.key !== optimisticKey),
      {
        kind: 'diagnosis', key: `diagnosis:${outcome.response.diagnosisId}`,
        id: outcome.response.diagnosisId, result: outcome.response.result,
        createdAt: new Date().toISOString(), imageUrl: storedImageUrl,
      },
    ]);
    setFile(null);
    setPreview(null);
    if (galleryInput.current !== null) galleryInput.current.value = '';
    if (cameraInput.current !== null) cameraInput.current.value = '';
    setPhase('idle');

    if (caption.trim().length > 0) await sendText(caption);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    if (file !== null) {
      const caption = message;
      setDraft('');
      await sendPhoto(file, caption);
      return;
    }
    await sendText(message);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function onDrop(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDragActive(false);
    if (busy) return;
    chooseFile(event.dataTransfer.files[0]);
  }

  function onVoiceResponse(response: Response): void {
    void (async () => {
      const outcome = await readVoiceResponse(response, requests.language);
      if (outcome.kind === 'error') {
        if (outcome.cause !== undefined) console.error('[jamee] voice response parse failed', outcome.cause);
        setFailure(outcome.envelope.error);
        return;
      }
      const now = new Date().toISOString();
      setTimeline((current) => [
        ...current,
        {
          kind: 'message', key: nextKey('voice'), id: `voice:${outcome.response.answer.messageId}`,
          role: 'farmer', content: outcome.response.transcript,
          language: outcome.response.answer.language, inputKind: 'voice', createdAt: now,
        },
        {
          kind: 'message', key: outcome.response.answer.messageId, id: outcome.response.answer.messageId,
          role: 'jamee', content: outcome.response.answer.content,
          language: outcome.response.answer.language, inputKind: 'text',
          createdAt: new Date().toISOString(),
        },
      ]);
      setFailure(null);
    })();
  }

  let status = '';
  if (phase === 'uploading') status = loading.uploading;
  else if (phase === 'analyzing') status = loading.analyzing;
  else if (phase === 'thinking') status = loading.thinking;

  return (
    <section className={styles.assistant} aria-labelledby={composerId}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <JameeLogo className={styles.logo} size={38} />
          <span><strong id={composerId}>Jamee</strong><small>{copy.assistantSubtitle}</small></span>
        </div>
        <Link className={styles.connectLink} href="/app/connect">{copy.connect}</Link>
      </header>

      <div className={styles.timeline}>
        {timeline.length === 0 ? (
          <div className={styles.empty}>
            <JameeLogo className={styles.emptyLogo} size={62} />
            <h1>{copy.emptyTitle}</h1>
            <p>{copy.emptyBody}</p>
            <div className={styles.suggestions}>
              {copy.suggestions.map((suggestion) => (
                <button key={suggestion} type="button" disabled={busy} onClick={() => { void sendText(suggestion); }}>
                  <span>{suggestion}</span><Icon name="arrow" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className={styles.messages} aria-live="polite">
            {timeline.map((item) => (
              <li key={item.key} className={item.kind === 'diagnosis' ? styles.diagnosisRow : item.role === 'farmer' ? styles.userRow : styles.jameeRow}>
                {item.kind === 'diagnosis' ? (
                  <article className={styles.diagnosisWrap}>
                    {item.imageUrl === null ? null : (
                      <figure className={styles.cropFigure}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated media endpoint */}
                        <img src={item.imageUrl} alt={ui.cropPhotoAlt} />
                        <figcaption>{copy.cropPhoto}</figcaption>
                      </figure>
                    )}
                    <DiagnosisResultCard result={item.result} />
                    <Link className={styles.resultLink} href={`/diagnosis/${item.id}`}>{ui.historyHeading} →</Link>
                  </article>
                ) : (
                  <article className={styles.message} aria-busy={item.id === null || undefined}>
                    <p className={styles.speaker}>
                      {item.role === 'farmer' ? ui.roleFarmer : ui.roleJamee}
                      {item.inputKind === 'voice' ? ` · ${ui.transcriptLabel}` : ''}
                    </p>
                    {item.imageUrl === undefined ? null : (
                      <figure className={styles.messageImage}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- local preview before authenticated upload */}
                        <img src={item.imageUrl} alt={ui.cropPhotoAlt} />
                      </figure>
                    )}
                    <p lang={item.language}>{item.content}</p>
                    <time dateTime={item.createdAt}>{formatInstant(item.createdAt, requests.language)}</time>
                  </article>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className={styles.composerDock}>
        {failure === null ? null : <ErrorBanner error={failure} retry={{ kind: file !== null || draft.trim() !== '' ? 'control' : 'none' }} />}
        <form
          className={`${styles.composer} ${dragActive ? styles.composerDragging : ''}`}
          onSubmit={(event) => { void onSubmit(event); }}
          onDragOver={(event) => { event.preventDefault(); if (!busy) setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          aria-busy={busy}
        >
          {previewUrl === null ? null : (
            <div className={styles.preview}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local user-selected preview */}
              <img src={previewUrl} alt={ui.cropPhotoAlt} />
              <span><strong>{file?.name}</strong><small>{copy.imageReady}</small></span>
              <button type="button" onClick={clearPhoto} aria-label={copy.removePhoto}><Icon name="close" /></button>
            </div>
          )}

          <div className={styles.composerRow}>
            <div className={styles.attachment}>
              <button
                className={styles.iconButton}
                type="button"
                onClick={() => setAttachmentOpen((open) => !open)}
                aria-label={copy.addAttachment}
                aria-expanded={attachmentOpen}
                disabled={busy}
              ><Icon name="plus" /></button>
              {attachmentOpen ? (
                <div className={styles.attachmentMenu}>
                  <label htmlFor={galleryId}><Icon name="image" /><span>{copy.uploadPhoto}</span></label>
                  <label htmlFor={cameraId}><Icon name="camera" /><span>{copy.takePhoto}</span></label>
                </div>
              ) : null}
              <input ref={galleryInput} id={galleryId} type="file" accept={accept} onChange={onFileChange} />
              <input ref={cameraInput} id={cameraId} type="file" accept={accept} capture="environment" onChange={onFileChange} />
            </div>

            <label className={styles.visuallyHidden} htmlFor={`${composerId}-input`}>{copy.composerPlaceholder}</label>
            <textarea
              ref={textarea}
              id={`${composerId}-input`}
              rows={1}
              maxLength={1000}
              placeholder={copy.composerPlaceholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={busy}
            />

            <div className={styles.voiceSlot}>
              <VoiceRecorder userId={userId} conversationId={conversationId} onVoiceResponse={onVoiceResponse} />
            </div>

            <button className={styles.sendButton} type="submit" disabled={!canSend} aria-label={copy.send}>
              <Icon name="send" />
            </button>
          </div>
          <p className={styles.status} role="status">{status}</p>
        </form>
        <p className={styles.responsible}>{copy.responsibleNote}</p>
      </div>
    </section>
  );
}

function initialTimeline(
  turns: readonly ChatTurn[],
  diagnosis: PersistedDiagnosis | null,
): TimelineItem[] {
  const items: TimelineItem[] = turns.map((turn) => ({ kind: 'message', ...turn }));
  if (diagnosis !== null) {
    items.push({
      kind: 'diagnosis', key: `diagnosis:${diagnosis.id}`, id: diagnosis.id,
      result: diagnosis.result, createdAt: diagnosis.createdAt, imageUrl: diagnosis.imageUrl,
    });
  }
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

type IconName = 'plus' | 'image' | 'camera' | 'send' | 'close' | 'arrow';
function Icon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, React.ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
    camera: <><path d="M14.5 5 16 7h3a2 2 0 0 1 2 2v9H3V9a2 2 0 0 1 2-2h3l1.5-2Z" /><circle cx="12" cy="12.5" r="3" /></>,
    send: <><path d="M12 19V5M6 11l6-6 6 6" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
