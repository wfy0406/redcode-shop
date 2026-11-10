'use client';

/** 滾動驅動嘅粒子星場＋三階段工作流程；粒子由原生 WebGL GPU 繪製（gl.POINTS 圓形柔邊粒子＋gl.LINES 連線），WebGL 唔可用會用 css-fallback 保留原有版面，reduced-motion 維持靜態降級。 */
import { useEffect, useRef, useState } from 'react';

const STEPS = [
  {
    no: '01',
    code: 'DISCOVER',
    title: '先理解，再設計',
    body: '將你嘅生意、客群、內容同功能需要整理成清晰規格；設計唔係換模板，而係由真實需要出發。',
    tags: ['需求梳理', '內容架構', '視覺方向'],
  },
  {
    no: '02',
    code: 'CREATE',
    title: '設計與開發並行',
    body: '唔同 AI agent 分工處理版面、功能同檢查，加快反覆試作；慳到嘅工序時間，反映喺你睇到嘅價錢。',
    tags: ['介面設計', '功能開發', '手機適配'],
  },
  {
    no: '03',
    code: 'VERIFY',
    title: '真人驗收先交付',
    body: '實際檢查桌面、手機、表單、權限同付款流程；每一項有結果先算完成，AI 唔會代替最終把關。',
    tags: ['功能驗證', '畫面檢查', '人類把關'],
  },
] as const;

interface Particle {
  x: number;
  y: number;
  depth: number;
  radius: number;
  drift: number;
  phase: number;
  warm: boolean;
}

function createParticles(count: number): Particle[] {
  let seed = 20261109;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    depth: 0.25 + random() * 0.75,
    radius: 0.65 + random() * 1.75,
    drift: (random() - 0.5) * 0.3,
    phase: random() * Math.PI * 2,
    warm: random() > 0.88,
  }));
}

const PARTICLE_COUNT = 112;
const MAX_DPR = 1.5;
const MAX_LINE_COUNT = (PARTICLE_COUNT * (PARTICLE_COUNT - 1)) / 2;
const LINE_VERTEX_FLOATS = 3; // x, y, alpha
const POINT_FLOATS = 6; // x, y, size, glow, warm, halo

const POINT_VERTEX_SOURCE = `
precision mediump float;
attribute vec2 a_position;
attribute float a_size;
attribute float a_glow;
attribute float a_warm;
attribute float a_halo;
uniform vec2 u_resolution;
uniform float u_haloPass;
varying float v_glow;
varying float v_warm;
void main() {
  float enabled = (u_haloPass > 0.5) ? a_halo : 1.0;
  float scale = (u_haloPass > 0.5) ? 6.4 : 2.0;
  vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
  gl_Position = (enabled > 0.5) ? vec4(clip.x, -clip.y, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
  gl_PointSize = a_size * scale;
  v_glow = a_glow * enabled;
  v_warm = a_warm;
}
`;

const POINT_FRAGMENT_SOURCE = `
precision mediump float;
uniform float u_haloPass;
varying float v_glow;
varying float v_warm;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float dist = length(uv);
  vec3 cool = vec3(0.4706, 0.9647, 0.9020);
  vec3 color = cool;
  float alpha;
  if (u_haloPass > 0.5) {
    // 柔邊光環，對應原本 depth > 0.84 嘅外圈描邊。
    alpha = (1.0 - smoothstep(0.0, 0.3, abs(dist - 0.86))) * v_glow * 0.3;
  } else {
    // 圓形柔邊粒子。
    alpha = (1.0 - smoothstep(0.4, 1.0, dist)) * v_glow;
    vec3 warm = vec3(1.0, 0.4353, 0.2275);
    color = mix(cool, warm, v_warm);
  }
  if (alpha <= 0.004) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

const LINE_VERTEX_SOURCE = `
attribute vec2 a_position;
attribute float a_alpha;
uniform vec2 u_resolution;
varying float v_alpha;
void main() {
  vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_alpha = a_alpha;
}
`;

const LINE_FRAGMENT_SOURCE = `
precision mediump float;
varying float v_alpha;
void main() {
  gl_FragColor = vec4(0.4706, 0.9647, 0.9020, v_alpha);
}
`;

interface GpuRenderer {
  /** Interleaved per-particle data：x, y, size, glow, warm, halo（device px）。 */
  readonly pointData: Float32Array;
  /** Interleaved per-vertex line data：x, y, alpha（device px）。 */
  readonly lineData: Float32Array;
  resize(width: number, height: number): void;
  /** 每個 buffer 一次 bufferData，之後用 drawArrays 一次過繪製；回傳今次 draw call 次數。 */
  draw(lineCount: number): number;
  dispose(): void;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext, vertex: WebGLShader, fragment: WebGLShader): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** 建立 WebGL renderer；任何一步失敗都會清理已建立嘅資源並回傳 null（行 css-fallback）。 */
function createGpuRenderer(canvas: HTMLCanvasElement): GpuRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  const pointVertex = compileShader(gl, gl.VERTEX_SHADER, POINT_VERTEX_SOURCE);
  const pointFragment = compileShader(gl, gl.FRAGMENT_SHADER, POINT_FRAGMENT_SOURCE);
  const lineVertex = compileShader(gl, gl.VERTEX_SHADER, LINE_VERTEX_SOURCE);
  const lineFragment = compileShader(gl, gl.FRAGMENT_SHADER, LINE_FRAGMENT_SOURCE);
  const pointProgram = pointVertex && pointFragment ? linkProgram(gl, pointVertex, pointFragment) : null;
  const lineProgram = lineVertex && lineFragment ? linkProgram(gl, lineVertex, lineFragment) : null;
  const pointBuffer = pointProgram ? gl.createBuffer() : null;
  const lineBuffer = lineProgram ? gl.createBuffer() : null;

  if (!pointVertex || !pointFragment || !lineVertex || !lineFragment || !pointProgram || !lineProgram || !pointBuffer || !lineBuffer) {
    if (pointBuffer) gl.deleteBuffer(pointBuffer);
    if (lineBuffer) gl.deleteBuffer(lineBuffer);
    if (pointProgram) gl.deleteProgram(pointProgram);
    if (lineProgram) gl.deleteProgram(lineProgram);
    if (pointVertex) gl.deleteShader(pointVertex);
    if (pointFragment) gl.deleteShader(pointFragment);
    if (lineVertex) gl.deleteShader(lineVertex);
    if (lineFragment) gl.deleteShader(lineFragment);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }

  const aPointPosition = gl.getAttribLocation(pointProgram, 'a_position');
  const aPointSize = gl.getAttribLocation(pointProgram, 'a_size');
  const aPointGlow = gl.getAttribLocation(pointProgram, 'a_glow');
  const aPointWarm = gl.getAttribLocation(pointProgram, 'a_warm');
  const aPointHalo = gl.getAttribLocation(pointProgram, 'a_halo');
  const uPointResolution = gl.getUniformLocation(pointProgram, 'u_resolution');
  const uHaloPass = gl.getUniformLocation(pointProgram, 'u_haloPass');
  const aLinePosition = gl.getAttribLocation(lineProgram, 'a_position');
  const aLineAlpha = gl.getAttribLocation(lineProgram, 'a_alpha');
  const uLineResolution = gl.getUniformLocation(lineProgram, 'u_resolution');

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const pointData = new Float32Array(PARTICLE_COUNT * POINT_FLOATS);
  const lineData = new Float32Array(MAX_LINE_COUNT * 2 * LINE_VERTEX_FLOATS);
  let viewWidth = 1;
  let viewHeight = 1;

  return {
    pointData,
    lineData,
    resize(width, height) {
      viewWidth = Math.max(1, width);
      viewHeight = Math.max(1, height);
      gl.viewport(0, 0, viewWidth, viewHeight);
    },
    draw(lineCount) {
      let drawCount = 0;
      gl.clear(gl.COLOR_BUFFER_BIT);

      // 連線先畫，粒子覆蓋喺上面，同原本 Canvas2D 順序一致。
      if (lineCount > 0) {
        gl.useProgram(lineProgram);
        gl.uniform2f(uLineResolution, viewWidth, viewHeight);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, lineData.subarray(0, lineCount * 2 * LINE_VERTEX_FLOATS), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aLinePosition);
        gl.vertexAttribPointer(aLinePosition, 2, gl.FLOAT, false, LINE_VERTEX_FLOATS * 4, 0);
        gl.enableVertexAttribArray(aLineAlpha);
        gl.vertexAttribPointer(aLineAlpha, 1, gl.FLOAT, false, LINE_VERTEX_FLOATS * 4, 8);
        gl.drawArrays(gl.LINES, 0, lineCount * 2);
        drawCount += 1;
      }

      gl.useProgram(pointProgram);
      gl.uniform2f(uPointResolution, viewWidth, viewHeight);
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, pointData, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPointPosition);
      gl.vertexAttribPointer(aPointPosition, 2, gl.FLOAT, false, POINT_FLOATS * 4, 0);
      gl.enableVertexAttribArray(aPointSize);
      gl.vertexAttribPointer(aPointSize, 1, gl.FLOAT, false, POINT_FLOATS * 4, 8);
      gl.enableVertexAttribArray(aPointGlow);
      gl.vertexAttribPointer(aPointGlow, 1, gl.FLOAT, false, POINT_FLOATS * 4, 12);
      gl.enableVertexAttribArray(aPointWarm);
      gl.vertexAttribPointer(aPointWarm, 1, gl.FLOAT, false, POINT_FLOATS * 4, 16);
      gl.enableVertexAttribArray(aPointHalo);
      gl.vertexAttribPointer(aPointHalo, 1, gl.FLOAT, false, POINT_FLOATS * 4, 20);

      // 光環 pass（depth > 0.84 粒子）先畫，再畫核心柔邊圓點。
      gl.uniform1f(uHaloPass, 1);
      gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
      drawCount += 1;
      gl.uniform1f(uHaloPass, 0);
      gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
      drawCount += 1;
      return drawCount;
    },
    dispose() {
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(lineBuffer);
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(lineProgram);
      gl.deleteShader(pointVertex);
      gl.deleteShader(pointFragment);
      gl.deleteShader(lineVertex);
      gl.deleteShader(lineFragment);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export default function AiScene() {
  const spacerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const spacer = spacerRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!spacer || !stage || !canvas) return undefined;

    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const particles = createParticles(PARTICLE_COUNT);
    const renderer = createGpuRenderer(canvas);
    const rendererName = renderer ? 'webgl-gpu' : 'css-fallback';
    stage.dataset.renderer = rendererName;
    canvas.dataset.renderer = rendererName;
    stage.dataset.particleCount = String(PARTICLE_COUNT);
    canvas.dataset.particleCount = String(PARTICLE_COUNT);
    let raf = 0;
    let enabled = false;
    let lastPhase = -1;
    let width = 1;
    let height = 1;
    let ratio = 1;
    let lastProgress = -1;
    const posX = new Float32Array(PARTICLE_COUNT);
    const posY = new Float32Array(PARTICLE_COUNT);

    const drawParticles = (progress: number) => {
      // css-fallback：停止粒子渲染，只保留原有 SVG/HUD 同文字。
      if (!renderer) return;
      if (lastProgress === progress) return;
      lastProgress = progress;

      // JS 只計位置；rasterization 全部交俾 GPU。
      const pointData = renderer.pointData;
      for (let i = 0; i < PARTICLE_COUNT; i += 1) {
        const particle = particles[i];
        const travel = progress * (0.32 + particle.depth * 0.72);
        const x = ((particle.x + particle.drift * progress + Math.sin(progress * Math.PI * 2 + particle.phase) * 0.018 * particle.depth + 1) % 1) * width * ratio;
        const y = (((particle.y - travel + 2) % 1.25) * height - height * 0.1) * ratio;
        posX[i] = x;
        posY[i] = y;
        const base = i * POINT_FLOATS;
        pointData[base] = x;
        pointData[base + 1] = y;
        pointData[base + 2] = particle.radius * (0.75 + particle.depth * 0.7) * ratio;
        pointData[base + 3] = 0.36 + particle.depth * 0.56;
        pointData[base + 4] = particle.warm ? 1 : 0;
        pointData[base + 5] = particle.depth > 0.84 ? 1 : 0;
      }

      // 星塵之間嘅連線同樣由滾動後嘅實際位置計算，唔係固定 SVG 裝飾。
      // 最多 112² 次距離檢查，收集落一個 Float32Array 之後一次 bufferData/drawArrays。
      const lineData = renderer.lineData;
      let lineCount = 0;
      for (let i = 0; i < PARTICLE_COUNT; i += 1) {
        const a = particles[i];
        for (let j = i + 1; j < PARTICLE_COUNT; j += 1) {
          const b = particles[j];
          const dx = posX[i] - posX[j];
          const dy = posY[i] - posY[j];
          const distance = Math.hypot(dx, dy);
          const minDepth = Math.min(a.depth, b.depth);
          const limit = (88 + minDepth * 58) * ratio;
          if (distance >= limit) continue;
          // 原本 0.55px 嘅 stroke 喺 WebGL 以 alpha 折算（GL line width 普遍得 1px）。
          const alpha = (1 - distance / limit) * 0.13 * minDepth * 0.55;
          const base = lineCount * 2 * LINE_VERTEX_FLOATS;
          lineData[base] = posX[i];
          lineData[base + 1] = posY[i];
          lineData[base + 2] = alpha;
          lineData[base + 3] = posX[j];
          lineData[base + 4] = posY[j];
          lineData[base + 5] = alpha;
          lineCount += 1;
        }
      }

      const drawCount = renderer.draw(lineCount);
      const progressText = progress.toFixed(4);
      stage.dataset.particleProgress = progressText;
      stage.dataset.progress = progressText;
      stage.dataset.lineCount = String(lineCount);
      stage.dataset.drawCount = String(drawCount);
      canvas.dataset.progress = progressText;
      canvas.dataset.lineCount = String(lineCount);
      canvas.dataset.drawCount = String(drawCount);
    };

    const resizeCanvas = () => {
      const rect = stage.getBoundingClientRect();
      ratio = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      renderer?.resize(canvas.width, canvas.height);
      lastProgress = -1;
    };

    const update = () => {
      raf = 0;
      let progress = 0;
      if (enabled) {
        const rect = spacer.getBoundingClientRect();
        const range = Math.max(1, rect.height - window.innerHeight);
        progress = Math.min(1, Math.max(0, -rect.top / range));
      }
      const nextPhase = enabled ? Math.min(2, Math.floor(progress * 3)) : 0;
      stage.dataset.motion = enabled ? 'scroll' : 'static';
      stage.style.setProperty('--wd-ai-progress', progress.toFixed(4));
      stage.style.setProperty('--wd-ai-turn', `${(progress * 150).toFixed(2)}deg`);
      stage.style.setProperty('--wd-ai-scan', `${(progress * 82 + 8).toFixed(2)}%`);
      stage.style.setProperty('--wd-ai-dash', (-progress * 180).toFixed(2));
      stage.style.setProperty('--wd-ai-network-y', `${(-progress * 64).toFixed(2)}px`);
      if (nextPhase !== lastPhase) {
        lastPhase = nextPhase;
        setPhase(nextPhase);
      }
      drawParticles(progress);
    };

    const wake = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    const handleResize = () => {
      resizeCanvas();
      wake();
    };
    const syncMode = () => {
      enabled = !reduceQuery.matches;
      if (!enabled) setPhase(0);
      handleResize();
    };

    syncMode();
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('resize', handleResize);
    reduceQuery.addEventListener('change', syncMode);
    const observer = new ResizeObserver(handleResize);
    observer.observe(stage);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('resize', handleResize);
      reduceQuery.removeEventListener('change', syncMode);
      observer.disconnect();
      renderer?.dispose();
    };
  }, []);

  return (
    <div ref={spacerRef} className="wd-ai-scene">
      <div
        ref={stageRef}
        className="wd-ai-stage"
        data-motion="static"
        data-phase={phase}
        data-particle-progress="0"
        data-renderer="css-fallback"
        data-progress="0"
        data-particle-count="112"
        data-line-count="0"
        data-draw-count="0"
      >
        <canvas
          ref={canvasRef}
          className="wd-ai-particles"
          data-renderer="css-fallback"
          data-progress="0"
          data-particle-count="112"
          data-line-count="0"
          data-draw-count="0"
          aria-hidden="true"
        />
        <div className="wd-ai-hud" aria-hidden="true">
          <div className="wd-ai-hud-top"><span>REDCODE / CREATIVE SYSTEM</span><span>PROCESS 0{phase + 1}</span></div>
          <svg className="wd-ai-network" viewBox="0 0 1200 700" fill="none">
            <path d="M80 520L280 350L480 410L650 190L860 270L1110 80" />
            <path d="M110 120L280 350L360 90L650 190L760 540L1030 480L1110 80" />
            <path d="M80 520L360 90M480 410L760 540M860 270L1030 480" />
            {[[80,520],[280,350],[480,410],[650,190],[860,270],[1110,80],[110,120],[360,90],[760,540],[1030,480]].map(([cx,cy],i) => (
              <g key={i}><circle cx={cx} cy={cy} r="7" /><circle cx={cx} cy={cy} r="18" className="wd-ai-node-ring" /></g>
            ))}
          </svg>
          <div className="wd-ai-scanner"><i /><b /><span /></div>
          <div className="wd-ai-coordinates">HK / 22.3193° N<br />HUMAN IN THE LOOP</div>
        </div>

        <div className="wd-ai-stage-grid">
          <div className="wd-ai-rail">
            <p className="wd-ai-system-label">WORKFLOW / 03</p>
            <ol>
              {STEPS.map((step, index) => (
                <li key={step.no} className={phase === index ? 'is-active' : ''} aria-current={phase === index ? 'step' : undefined}>
                  <span>{step.no}</span><strong>{step.code}</strong>
                </li>
              ))}
            </ol>
            <p className="wd-ai-rail-note">AI 分工加速<br />真人逐項驗收</p>
          </div>

          <div className="wd-ai-panels">
            {STEPS.map((step, index) => (
              <article key={step.no} className={`wd-ai-panel${phase === index ? ' is-active' : ''}`}>
                <div className="wd-ai-panel-meta"><span>{step.no} / 03</span><span>{step.code}</span></div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <ul>{step.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
              </article>
            ))}
          </div>
        </div>
        <div className="wd-ai-progress" aria-hidden="true"><i /></div>
      </div>
    </div>
  );
}
