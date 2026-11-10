'use client';

/**
 * 透明角色 72 幀連續行路序列，由滾動進度逐幀驅動。
 * v2026.11.09.3：原生 WebGL GPU 逐幀渲染（8 列 × 9 行，每幀 480×750，
 * 每張 row 2880×1125 按需要載入，GPU texture cache 穩定後只保留 current±1）。
 * WebGL／圖片失敗或 context lost 會降級顯示靜態 /web-design/character-hero.webp。
 * 原西裝影片只作離線動作參考；頁面冇嵌入或播放原片。
 */
import { useEffect, useRef } from 'react';

const FRAME_COUNT = 72;
const FRAME_COLS = 4;
const FRAME_ROWS = 18;
const FRAME_WIDTH = 720;
const FRAME_HEIGHT = 1125;
const FRAME_ASPECT = FRAME_WIDTH / FRAME_HEIGHT;
const ROW_WIDTH = FRAME_WIDTH * FRAME_COLS; // 2880，兼容 WebGL1 常見 4096 texture 上限
const MAX_DPR = 2.5; // 只在改幀／resize 時繪製；保留高 DPR 手機面部細節

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_fit;
uniform float u_col;
void main() {
  vec2 fuv = v_uv * u_fit.xy + u_fit.zw;
  if (fuv.x < 0.0 || fuv.x > 1.0 || fuv.y < 0.0 || fuv.y > 1.0) {
    gl_FragColor = vec4(0.0);
  } else {
    gl_FragColor = texture2D(u_tex, vec2((fuv.x + u_col) * 0.25, fuv.y));
  }
}
`;

export interface SuitScrollProps {
  /** 手機及桌面都保留完整滾動故事；只有 reduced-motion 會靜態降級。 */
  spacerVh?: number;
}

interface RowEntry {
  texture: WebGLTexture | null;
  status: 'loading' | 'ready' | 'error';
  image: HTMLImageElement | null;
}

const rowUrl = (row: number) => `/web-design/character-walk-row-${row}.webp`;

export default function SuitScroll({ spacerVh = 250 }: SuitScrollProps) {
  const spacerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const spacer = spacerRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!spacer || !stage || !canvas) return undefined;
    const hero = spacer.closest<HTMLElement>('.wd-hero');

    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let cancelled = false;
    let enabled = !reduceQuery.matches;
    let raf = 0;
    let targetProgress = 0;
    let currentProgress = 0;
    let lastFrame = -1; // 實際畫出的 frame；-1 = 從未成功繪製
    let drawCount = 0;

    // --- WebGL 狀態 ---
    let gl: WebGLRenderingContext | null = null;
    let glFailed = false;
    let program: WebGLProgram | null = null;
    let vertexShader: WebGLShader | null = null;
    let fragmentShader: WebGLShader | null = null;
    let posBuffer: WebGLBuffer | null = null;
    let fitUniform: WebGLUniformLocation | null = null;
    let colUniform: WebGLUniformLocation | null = null;
    const rows = new Map<number, RowEntry>();

    const syncTextureCount = () => {
      let count = 0;
      rows.forEach((entry) => {
        if (entry.texture) count += 1;
      });
      stage.dataset.textureCount = String(count);
    };

    const releaseRow = (entry: RowEntry) => {
      if (entry.image) {
        entry.image.onload = null;
        entry.image.onerror = null;
        entry.image.src = '';
        entry.image = null;
      }
      if (entry.texture) {
        if (gl && !glFailed) gl.deleteTexture(entry.texture);
        entry.texture = null;
      }
    };

    /** GPU texture cache 穩定後最多保留 current±1 三張 row。 */
    const evictRows = (centerRow: number) => {
      rows.forEach((entry, row) => {
        if (Math.abs(row - centerRow) > 1) {
          releaseRow(entry);
          rows.delete(row);
        }
      });
      syncTextureCount();
    };

    const cleanupGl = () => {
      rows.forEach(releaseRow);
      rows.clear();
      if (gl) {
        if (posBuffer) gl.deleteBuffer(posBuffer);
        if (program) gl.deleteProgram(program);
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
        const loseContext = gl.getExtension('WEBGL_lose_context');
        loseContext?.loseContext();
      }
      gl = null;
      program = null;
      vertexShader = null;
      fragmentShader = null;
      posBuffer = null;
      fitUniform = null;
      colUniform = null;
      syncTextureCount();
    };

    /** 永久降級：顯示靜態 hero img，絕不白屏。 */
    const failToStatic = (reason: string) => {
      if (glFailed) return;
      glFailed = true;
      cleanupGl();
      stage.dataset.renderer = 'static-fallback';
      stage.dataset.sprite = 'error';
      stage.dataset.error = reason;
    };

    const compileShader = (context: WebGLRenderingContext, type: number, source: string) => {
      const shader = context.createShader(type);
      if (!shader) return null;
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        context.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const initRenderer = () => {
      if (gl || glFailed) return !glFailed;
      const context = canvas.getContext('webgl', {
        alpha: true,
        depth: false,
        stencil: false,
        antialias: false,
        premultipliedAlpha: false,
        powerPreference: 'high-performance',
      });
      if (!context) {
        failToStatic('webgl-unavailable');
        return false;
      }
      if ((context.getParameter(context.MAX_TEXTURE_SIZE) as number) < ROW_WIDTH) {
        const loseContext = context.getExtension('WEBGL_lose_context');
        loseContext?.loseContext();
        failToStatic('texture-too-large');
        return false;
      }
      vertexShader = compileShader(context, context.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
      fragmentShader = compileShader(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
      program = context.createProgram();
      if (!vertexShader || !fragmentShader || !program) {
        failToStatic('shader-compile');
        return false;
      }
      context.attachShader(program, vertexShader);
      context.attachShader(program, fragmentShader);
      context.linkProgram(program);
      if (!context.getProgramParameter(program, context.LINK_STATUS)) {
        failToStatic('program-link');
        return false;
      }
      posBuffer = context.createBuffer();
      fitUniform = context.getUniformLocation(program, 'u_fit');
      colUniform = context.getUniformLocation(program, 'u_col');
      const texUniform = context.getUniformLocation(program, 'u_tex');
      if (!posBuffer || !fitUniform || !colUniform) {
        failToStatic('shader-setup');
        return false;
      }
      context.useProgram(program);
      context.bindBuffer(context.ARRAY_BUFFER, posBuffer);
      context.bufferData(
        context.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        context.STATIC_DRAW,
      );
      const posAttrib = context.getAttribLocation(program, 'a_pos');
      context.enableVertexAttribArray(posAttrib);
      context.vertexAttribPointer(posAttrib, 2, context.FLOAT, false, 0, 0);
      context.uniform1i(texUniform, 0);
      // 單一透明 quad 直接寫入；non-premultiplied canvas 保留真實 alpha 邊緣。
      context.disable(context.BLEND);
      context.clearColor(0, 0, 0, 0);
      canvas.addEventListener('webglcontextlost', onContextLost);
      gl = context;
      stage.dataset.renderer = 'webgl-gpu';
      return true;
    };

    /** drawing buffer 跟元素尺寸 × DPR（上限 2.5），回傳有冇改變。 */
    const resizeCanvas = () => {
      if (!gl) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      return true;
    };

    /** contain + 底部對齊：canvas uv → frame uv（fuv = uv * scale + offset）。 */
    const computeFit = (): [number, number, number, number] => {
      const canvasAspect = canvas.width / Math.max(1, canvas.height);
      if (canvasAspect >= FRAME_ASPECT) {
        // 畫布較寬：以高度為準，水平置中
        const usedWidth = FRAME_ASPECT / canvasAspect;
        return [1 / usedWidth, 1, (1 - 1 / usedWidth) / 2, 0];
      }
      // 畫布較高：以寬度為準，底部對齊
      const usedHeight = canvasAspect / FRAME_ASPECT;
      return [1, 1 / usedHeight, 0, 0];
    };

    const ensureRow = (row: number) => {
      if (!gl || glFailed || row < 0 || row >= FRAME_ROWS || rows.has(row)) return;
      const entry: RowEntry = { texture: null, status: 'loading', image: new Image() };
      rows.set(row, entry);
      const image = entry.image;
      if (!image) return;
      image.decoding = 'async';
      image.onload = () => {
        if (cancelled) return;
        entry.image = null;
        if (!gl || glFailed) {
          rows.delete(row);
          return;
        }
        const texture = gl.createTexture();
        if (!texture) {
          entry.status = 'error';
          if (drawCount === 0) failToStatic('texture-create');
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        } catch {
          gl.deleteTexture(texture);
          entry.status = 'error';
          if (drawCount === 0) failToStatic('texture-upload');
          return;
        }
        // LINEAR + CLAMP_TO_EDGE，無 mipmap，避免跨 frame bleeding
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        entry.texture = texture;
        entry.status = 'ready';
        const frame = enabled
          ? Math.min(FRAME_COUNT - 1, Math.max(0, Math.round(currentProgress * (FRAME_COUNT - 1))))
          : 0;
        evictRows(Math.floor(frame / FRAME_COLS));
        if (Math.floor(frame / FRAME_COLS) === row) {
          resizeCanvas();
          drawFrame(frame, true);
        }
      };
      image.onerror = () => {
        if (cancelled) return;
        entry.image = null;
        entry.status = 'error';
        rows.delete(row);
        syncTextureCount();
        // 未成功畫過任何 frame 而當前需要的 row 載入失敗 → 靜態降級
        const frame = enabled
          ? Math.min(FRAME_COUNT - 1, Math.max(0, Math.round(currentProgress * (FRAME_COUNT - 1))))
          : 0;
        if (drawCount === 0 && Math.floor(frame / FRAME_COLS) === row) {
          failToStatic('image-load');
        }
      };
      image.src = rowUrl(row);
    };

    const drawFrame = (frame: number, force: boolean) => {
      if (!gl || glFailed || !program || !fitUniform || !colUniform) return;
      const row = Math.floor(frame / FRAME_COLS);
      const col = frame % FRAME_COLS;
      ensureRow(row);
      ensureRow(row - 1);
      ensureRow(row + 1);
      evictRows(row);
      const entry = rows.get(row);
      if (!entry || entry.status !== 'ready' || !entry.texture) return; // 保留上一幀
      if (frame === lastFrame && !force) return;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      const [sx, sy, ox, oy] = computeFit();
      gl.uniform4f(fitUniform, sx, sy, ox, oy);
      gl.uniform1f(colUniform, col);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      lastFrame = frame;
      drawCount += 1;
      stage.dataset.frame = String(frame);
      stage.dataset.textureRow = String(row);
      stage.dataset.drawCount = String(drawCount);
      canvas.dataset.frame = String(frame);
      if (drawCount === 1) stage.dataset.sprite = 'ready';
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      failToStatic('context-lost');
    };

    const measure = () => {
      if (!enabled) {
        targetProgress = 0;
        return;
      }
      const rect = spacer.getBoundingClientRect();
      const range = Math.max(1, rect.height - window.innerHeight);
      targetProgress = Math.min(1, Math.max(0, -rect.top / range));
    };

    const render = () => {
      const progress = currentProgress;
      const compact = window.innerWidth <= 900;
      const copyFade = Math.min(1, Math.max(0, (progress - 0.5) / 0.2));
      stage.style.setProperty('--wd-progress', progress.toFixed(4));
      // 手機 x 位移必須為 0，避免角色向左撞字
      stage.style.setProperty('--wd-character-x', compact ? '0px' : `${(-72 * progress).toFixed(2)}px`);
      stage.style.setProperty('--wd-character-y', `${((compact ? 5 : 4) * progress).toFixed(2)}svh`);
      stage.style.setProperty('--wd-character-scale', (1 - progress * 0.055).toFixed(4));
      stage.style.setProperty('--wd-wordmark-x', `${(-110 * progress).toFixed(2)}px`);
      stage.style.setProperty('--wd-orbit-turn', `${(progress * 72).toFixed(2)}deg`);
      hero?.style.setProperty('--wd-hero-copy-opacity', (1 - copyFade).toFixed(4));
      hero?.style.setProperty('--wd-hero-copy-y', `${(-32 * copyFade).toFixed(2)}px`);
      if (hero) hero.dataset.phase = copyFade >= 0.99 ? 'walk' : 'intro';
      stage.dataset.phase = progress >= 0.5 ? 'walk' : 'intro';
      const frame = enabled
        ? Math.min(FRAME_COUNT - 1, Math.max(0, Math.round(progress * (FRAME_COUNT - 1))))
        : 0;
      stage.dataset.targetFrame = String(frame);
      if (enabled) {
        const resized = resizeCanvas();
        drawFrame(frame, resized);
      }
    };

    const tick = () => {
      raf = 0;
      const difference = targetProgress - currentProgress;
      currentProgress = Math.abs(difference) < 0.0005
        ? targetProgress
        : currentProgress + difference * 0.24;
      render();
      if (currentProgress !== targetProgress && !raf) {
        raf = window.requestAnimationFrame(tick);
      }
    };

    const wake = () => {
      measure();
      if (!enabled) currentProgress = 0;
      if (!raf) raf = window.requestAnimationFrame(tick);
    };

    const syncMode = () => {
      enabled = !reduceQuery.matches;
      stage.dataset.motion = enabled ? 'scroll' : 'static';
      if (!enabled) {
        // reduced-motion：靜態 hero img，唔起 WebGL、唔留長駐 animation loop
        targetProgress = 0;
        currentProgress = 0;
        stage.dataset.targetFrame = '0';
        if (!gl && !glFailed) stage.dataset.renderer = 'static-fallback';
      } else if (initRenderer()) {
        stage.dataset.frame = String(lastFrame);
      }
      wake();
    };

    stage.dataset.sprite = 'loading';
    syncMode();
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('resize', syncMode);
    reduceQuery.addEventListener('change', syncMode);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('resize', syncMode);
      reduceQuery.removeEventListener('change', syncMode);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      cleanupGl();
    };
  }, []);

  return (
    <div
      ref={spacerRef}
      className="wd-suit-spacer"
      style={{ height: `${spacerVh}vh` }}
      aria-hidden="true"
    >
      <div
        ref={stageRef}
        className="wd-suit-stage"
        data-motion="static"
        data-sprite="loading"
        data-frame="0"
        data-renderer="static-fallback"
        data-target-frame="0"
        data-texture-row="-1"
        data-texture-count="0"
        data-draw-count="0"
      >
        <div className="wd-hero-wordmark">WEB DESIGN</div>
        <div className="wd-hero-orbit wd-hero-orbit--outer" />
        <div className="wd-hero-orbit wd-hero-orbit--inner" />
        <div className="wd-hero-index">RED / 01</div>
        <div className="wd-character-wrap">
          <img
            className="wd-character wd-character--hero"
            src="/web-design/character-hero.webp"
            alt=""
            width="864"
            height="1350"
            loading="eager"
            decoding="async"
            fetchPriority="high"
          />
          <canvas
            ref={canvasRef}
            className="wd-character wd-character-canvas"
            width={FRAME_WIDTH}
            height={FRAME_HEIGHT}
            data-frame="0"
          />
        </div>
        <div className="wd-hero-scroll-cue">
          <span>SCROLL TO CREATE</span>
          <i />
        </div>
      </div>
    </div>
  );
}
