import { useEffect, useRef, useState } from 'react';
import { FAIRY_ACTIONS, FAIRY_ALL_ACTIONS, type FairyAction } from '@/components/fairyActions';

/**
 * 同左上角 logo 一樣用真 alpha 動畫 WebP：poster 先頂住，目前動作 load 完先即時切換。
 * 所有 poster 由開局起各自預載；新 poster 未解碼時保留上一張，唔會喺動作交界露空。
 * 兩類圖層都冇 opacity transition，任何時刻只有一層可見，唔會交接重影。
 */
export default function FairyActionAnimation({
  action,
  animate,
  replay,
  onHoldComplete,
}: {
  action: FairyAction;
  animate: boolean;
  replay: number;
  onHoldComplete: (action: FairyAction) => void;
}) {
  const [readyAction, setReadyAction] = useState<FairyAction | null>(null);
  const [failedAction, setFailedAction] = useState<FairyAction | null>(null);
  const [loadedPosters, setLoadedPosters] = useState<ReadonlySet<FairyAction>>(() => new Set());
  const [posterFallback, setPosterFallback] = useState<FairyAction>(action);
  const activeActionRef = useRef(action);
  activeActionRef.current = action;
  const spec = FAIRY_ACTIONS[action];
  const showAnimation = animate && readyAction === action && failedAction !== action;
  const posterAction = loadedPosters.has(action) ? action : posterFallback;

  // 動畫由開局預載（閒置循環＋指引 point＋拖曳 scared）；poster 則用下面固定 src 嘅 img 預載及追蹤真正 onLoad。
  useEffect(() => {
    const preloads = FAIRY_ALL_ACTIONS.map((name) => {
      const image = new Image();
      image.src = FAIRY_ACTIONS[name].animation;
      return image;
    });
    return () => {
      for (const image of preloads) {
        image.onload = null;
        image.onerror = null;
      }
    };
  }, []);

  useEffect(() => {
    if (loadedPosters.has(action)) setPosterFallback(action);
  }, [action, loadedPosters]);

  // 離開曾失敗嘅動作後解除失敗鎖，下次返到嚟會真正重試；背景分頁恢復亦要重新等 onLoad。
  useEffect(() => {
    setFailedAction(null);
  }, [action]);

  useEffect(() => {
    if (!animate) setReadyAction(null);
  }, [animate]);

  // hold 由動畫實際可顯示後先起計，唔再由 React 切 action 嗰刻估載入時間。
  // 失敗時以靜態 poster 停留同一段時間，之後仍可繼續其他動作及稍後重試。
  useEffect(() => {
    if (!showAnimation && failedAction !== action) return;
    const timer = window.setTimeout(() => onHoldComplete(action), spec.holdMs);
    return () => window.clearTimeout(timer);
  }, [action, failedAction, onHoldComplete, replay, showAnimation, spec.holdMs]);

  return (
    <>
      {FAIRY_ALL_ACTIONS.map((name) => (
        <img
          key={name}
          className="fairy-action-poster"
          src={FAIRY_ACTIONS[name].poster}
          alt=""
          width={384}
          height={576}
          draggable={false}
          data-fairy-poster={name === action ? name : undefined}
          data-fairy-poster-asset={name}
          data-fairy-poster-visible={name === posterAction && !showAnimation ? 'true' : 'false'}
          onLoad={() => {
            setLoadedPosters((previous) => {
              if (previous.has(name)) return previous;
              const next = new Set(previous);
              next.add(name);
              return next;
            });
          }}
          style={{ opacity: name === posterAction && !showAnimation ? 1 : 0 }}
        />
      ))}
      {animate && failedAction !== action && (
        <img
          key={action}
          className="fairy-action-animation"
          src={spec.animation}
          alt=""
          width={256}
          height={384}
          draggable={false}
          data-fairy-animation={action}
          data-fairy-frame-mode={showAnimation ? 'animated' : 'loading'}
          onLoad={() => {
            if (activeActionRef.current !== action) return;
            setFailedAction((current) => current === action ? null : current);
            setReadyAction(action);
          }}
          onError={() => {
            if (activeActionRef.current !== action) return;
            setReadyAction((current) => current === action ? null : current);
            setFailedAction(action);
          }}
          style={{ opacity: showAnimation ? 1 : 0 }}
        />
      )}
    </>
  );
}
