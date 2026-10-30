import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, X } from 'lucide-react';

export const AI_TRYON_TUTORIAL_SRC = '/faq/ai-tryon-tutorial.mp4';
export const AI_TRYON_TUTORIAL_POSTER = '/faq/ai-tryon-tutorial-poster.jpg';

function TutorialModal({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCloseRef = useRef(onClose);
  const [videoError, setVideoError] = useState(false);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    videoRef.current?.pause();
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      videoRef.current?.pause();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [requestClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="ai-tutorial-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="ai-tutorial-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-tutorial-title"
        aria-describedby="ai-tutorial-description"
        tabIndex={-1}
      >
        <header className="ai-tutorial-header">
          <div>
            <p>AI TRY-ON · 7 STEPS</p>
            <h2 id="ai-tutorial-title">70 秒 AI 試穿教學</h2>
          </div>
          <button ref={closeRef} type="button" onClick={requestClose} aria-label="關閉 AI 試穿教學">
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <video
          ref={videoRef}
          className="ai-tutorial-video"
          src={AI_TRYON_TUTORIAL_SRC}
          poster={AI_TRYON_TUTORIAL_POSTER}
          controls
          playsInline
          autoPlay
          preload="metadata"
          aria-label="AI 試穿七步教學影片"
          onError={() => setVideoError(true)}
        />
        {videoError && <p className="ai-tutorial-error" role="alert">影片暫時未能載入，請關閉後重試。</p>}
        <p id="ai-tutorial-description" className="ai-tutorial-description">
          揀衫、影全身相、生成對照，跟住做就得。影片有聲，可用播放器暂停或調校音量。
        </p>
      </div>
    </div>,
    document.body,
  );
}

export default function AiTryOnTutorial() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <style>{AI_TUTORIAL_CSS}</style>
      <button type="button" className="ai-tutorial-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Play size={17} fill="currentColor" aria-hidden="true" />
        70 秒教學
      </button>
      {open && <TutorialModal onClose={close} />}
    </>
  );
}

const AI_TUTORIAL_CSS = /* css */ `
  .ai-tutorial-trigger {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 17px;
    border: 1px solid var(--studio-ink, #0A0614);
    border-radius: 12px;
    background: transparent;
    color: var(--studio-ink, #0A0614);
    font-family: 'Noto Sans TC', -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: background-color .18s ease-out, color .18s ease-out;
  }
  .ai-tutorial-trigger:hover { background: var(--studio-ink, #0A0614); color: var(--studio-paper, #FFF7E8); }
  .ai-tutorial-trigger:focus-visible, .ai-tutorial-dialog button:focus-visible {
    outline: 2px solid #F5C518;
    outline-offset: 3px;
  }
  .ai-tutorial-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: grid;
    place-items: center;
    padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    background: rgba(10, 6, 20, .88);
    animation: ai-tutorial-backdrop-in .4s ease both;
  }
  .ai-tutorial-dialog {
    width: min(100%, 440px);
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(245, 197, 24, .48);
    border-radius: 16px;
    background: #0A0614;
    color: #FFF7E8;
    box-shadow: 0 24px 80px rgba(0, 0, 0, .46);
    font-family: 'Noto Sans TC', -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
    animation: ai-tutorial-dialog-in .4s ease both;
  }
  .ai-tutorial-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 16px; }
  .ai-tutorial-header p { margin: 0 0 4px; color: #F7D774; font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: .14em; }
  .ai-tutorial-header h2 { margin: 0; font-family: 'Noto Serif TC', serif; font-size: 20px; line-height: 1.35; }
  .ai-tutorial-header button {
    appearance: none;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: rgba(255, 247, 232, .1);
    color: #FFF7E8;
    cursor: pointer;
  }
  .ai-tutorial-video {
    display: block;
    width: 100%;
    min-height: 0;
    max-height: calc(100vh - 174px);
    max-height: calc(100dvh - 174px);
    aspect-ratio: 9 / 16;
    object-fit: contain;
    background: #000;
  }
  .ai-tutorial-description { margin: 0; padding: 11px 16px 13px; color: #CFC4E4; font-size: 12px; line-height: 1.65; }
  .ai-tutorial-error { margin: 0; padding: 10px 16px; color: #F7D774; font-size: 13px; }
  @keyframes ai-tutorial-backdrop-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ai-tutorial-dialog-in { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: scale(1); } }
  @media (max-width: 560px) {
    .ai-tutorial-dialog { width: min(100%, 390px); border-radius: 14px; }
    .ai-tutorial-header { padding: 11px 13px; }
    .ai-tutorial-header h2 { font-size: 18px; }
    .ai-tutorial-description { padding: 9px 13px 11px; font-size: 11px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ai-tutorial-trigger { transition: none; }
    .ai-tutorial-backdrop, .ai-tutorial-dialog { animation: none; }
  }
`;
