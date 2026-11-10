'use client';

/** 全頁程序化 white crystal shards 動態背景：原生 WebGL1 fragment shader 畫三角網格切面（白／冷灰玻璃感＋少量冰藍折射＋柔和 glints＋慢速漂移），單一 fullscreen triangle、每 frame 一次 drawArrays、無 textures。滾動時按 viewport 中央最近嘅 [data-crystal] section 更新 variant（密度／角度／冰藍強度微調），data-crystal="dark" 覆蓋時暫停；DPR 上限桌面 1、手機 0.85，fps 上限 24，document.hidden 停 rAF，reduced-motion 只畫 time=0 一幀。WebGL 失敗／context lost 時 dataset.renderer='css-fallback'，交俾 CSS 白灰 gradient。 */
import { useEffect, useRef } from 'react';

const FPS_CAP = 24;
const FRAME_MS = 1000 / FPS_CAP;
const DPR_DESKTOP = 1;
const DPR_MOBILE = 0.85;

/** variant = (density, angleRadians, iceStrength)；各 section 細微差異。 */
const VARIANTS: Record<string, readonly [number, number, number]> = {
  hero: [0.0, 0.0, 0.55],
  services: [0.35, 0.26, 0.4],
  pricing: [0.7, -0.22, 0.3],
  demos: [0.5, 0.48, 0.65],
  contact: [0.2, -0.4, 0.45],
};
const DEFAULT_VARIANT: readonly [number, number, number] = [0.0, 0.0, 0.5];

const VERTEX_SOURCE = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_variant;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/* 三角網格 cell：回傳三角形 id、重心座標同邊距。 */
vec4 triCell(vec2 q, out vec3 bary) {
  float sy = 0.8660254;
  vec2 t = vec2(q.x, q.y / sy);
  vec2 cell = floor(t);
  vec2 f = fract(t);
  float lower = step(f.x + f.y, 1.0);
  vec3 baryLower = vec3(1.0 - f.x - f.y, f.x, f.y);
  vec3 baryUpper = vec3(1.0 - f.x, 1.0 - f.y, f.x + f.y - 1.0);
  bary = mix(baryUpper, baryLower, lower);
  vec2 id = cell + mix(vec2(0.5, 0.75), vec2(0.5, 0.25), lower);
  return vec4(id, 0.0, 0.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  float density = u_variant.x;
  float angle = u_variant.y;
  float ice = u_variant.z;

  /* 慢速漂移＋每 variant 微旋轉。 */
  float ca = cos(angle);
  float sa = sin(angle);
  mat2 rot = mat2(ca, -sa, sa, ca);
  vec2 q = rot * p;
  q += vec2(u_time * 0.011, u_time * 0.007);
  q *= 1.9 + density * 0.9;

  vec3 bary;
  vec4 cellInfo = triCell(q, bary);
  vec2 id = cellInfo.xy;

  float h1 = hash21(id);
  float h2 = hash21(id + vec2(17.31, 9.17));
  float h3 = hash21(id + vec2(41.7, 23.9));

  /* 切面偽法線 → 柔光：每塊 facet 有輕微明暗差。 */
  float tilt = h1 * 6.2831853 + angle;
  float shade = 0.5 + 0.5 * cos(tilt - 0.9) * (0.35 + 0.65 * h2);
  /* 重心漸層令大塊切面由邊緣向中心過渡，似玻璃厚度。 */
  float centre = bary.x * bary.y * bary.z * 6.75;
  float facet = clamp(shade * 0.75 + centre * 0.45, 0.0, 1.0);

  /* 白／冷灰玻璃基調，配合頁面垂直柔光。 */
  vec3 base = mix(vec3(0.936, 0.949, 0.965), vec3(0.988, 0.992, 0.998), facet);
  base = mix(base, vec3(0.972, 0.98, 0.99), smoothstep(0.0, 1.0, uv.y) * 0.35);

  /* 少量冰藍折射：只有部分 facet，強度由 variant 控制。 */
  float iceMask = step(0.62, h3) * ice;
  vec3 iceTint = vec3(0.62, 0.8, 0.96);
  base = mix(base, iceTint, iceMask * (0.16 + 0.18 * centre));

  /* facet 邊線：幼身冷灰稜線。 */
  float edge = min(bary.x, min(bary.y, bary.z));
  float line = 1.0 - smoothstep(0.0, 0.035, edge);
  base = mix(base, vec3(0.78, 0.83, 0.9), line * 0.35);
  /* 稜線受光位有少許亮邊。 */
  float bevel = 1.0 - smoothstep(0.035, 0.09, edge);
  base += vec3(0.05) * bevel * (1.0 - line) * shade;

  /* 柔和 glints：稀疏光點慢速閃爍，唔會遮字。 */
  vec2 gq = rot * p * (0.55 + density * 0.2) + vec2(-u_time * 0.005, u_time * 0.004);
  vec3 gbary;
  vec4 ginfo = triCell(gq, gbary);
  float gh = hash21(ginfo.xy + vec2(3.1, 7.7));
  float twinkle = 0.5 + 0.5 * sin(u_time * 0.6 + gh * 6.2831853);
  float glint = step(0.93, gh) * twinkle * smoothstep(0.55, 1.0, gbary.x * gbary.y * gbary.z * 6.75);
  base += vec3(0.75, 0.85, 1.0) * glint * 0.14 * (0.4 + ice);

  /* 整體保持高明度，確保白底淺灰、唔遮礙文字。 */
  vec3 color = clamp(base, 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0);
}
`;

interface CrystalRenderer {
  resize(width: number, height: number): void;
  draw(time: number, variant: readonly [number, number, number]): void;
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

/** 建立 renderer；任何一步失敗都清理已建立資源並回傳 null（行 css-fallback）。 */
function createCrystalRenderer(canvas: HTMLCanvasElement): CrystalRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });
  if (!gl) return null;

  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  let program: WebGLProgram | null = null;
  if (vertex && fragment) {
    program = gl.createProgram();
    if (program) {
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        program = null;
      }
    }
  }
  const buffer = program ? gl.createBuffer() : null;

  if (!vertex || !fragment || !program || !buffer) {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }

  /* 單一 fullscreen triangle：(-1,-1), (3,-1), (-1,3)。 */
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPosition = gl.getAttribLocation(program, 'a_position');
  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  const uTime = gl.getUniformLocation(program, 'u_time');
  const uVariant = gl.getUniformLocation(program, 'u_variant');
  gl.useProgram(program);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  let viewWidth = 1;
  let viewHeight = 1;

  return {
    resize(width, height) {
      viewWidth = Math.max(1, width);
      viewHeight = Math.max(1, height);
      gl.viewport(0, 0, viewWidth, viewHeight);
    },
    draw(time, variant) {
      gl.uniform2f(uResolution, viewWidth, viewHeight);
      gl.uniform1f(uTime, time);
      gl.uniform3f(uVariant, variant[0], variant[1], variant[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** 搵 viewport 中央最近嘅 [data-crystal] section；回傳佢嘅 data-crystal 值。 */
function nearestCrystalSection(): string | null {
  const sections = document.querySelectorAll<HTMLElement>('[data-crystal]');
  if (sections.length === 0) return null;
  const centre = window.innerHeight / 2;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  sections.forEach((section) => {
    const rect = section.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    const sectionCentre = rect.top + rect.height / 2;
    const distance = Math.abs(sectionCentre - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = section.dataset.crystal ?? null;
    }
  });
  return best;
}

export default function CrystalBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mobileQuery = window.matchMedia('(max-width: 768px)');
    const renderer = createCrystalRenderer(canvas);
    canvas.dataset.renderer = renderer ? 'webgl-gpu' : 'css-fallback';
    canvas.dataset.fpsCap = String(FPS_CAP);
    canvas.dataset.drawCount = '0';
    canvas.dataset.variant = 'hero';

    let raf = 0;
    let drawCount = 0;
    let startTime = 0;
    let lastFrame = 0;
    let variantName = 'hero';
    let variant = VARIANTS.hero ?? DEFAULT_VARIANT;
    let covered = false; // data-crystal="dark"（AI / footer 不透明覆蓋）時暫停
    let disposed = false;

    const currentDpr = () => {
      const cap = mobileQuery.matches ? DPR_MOBILE : DPR_DESKTOP;
      return Math.min(cap, window.devicePixelRatio || 1);
    };

    const renderFrame = (time: number) => {
      if (!renderer) return;
      renderer.draw(time, variant);
      drawCount += 1;
      canvas.dataset.drawCount = String(drawCount);
    };

    const syncVariant = () => {
      const section = nearestCrystalSection();
      covered = section === 'dark';
      if (section && section !== 'dark' && section !== variantName) {
        variantName = section;
        variant = VARIANTS[section] ?? DEFAULT_VARIANT;
        canvas.dataset.variant = section;
      }
    };

    const resizeCanvas = () => {
      const ratio = currentDpr();
      canvas.width = Math.max(1, Math.round(window.innerWidth * ratio));
      canvas.height = Math.max(1, Math.round(window.innerHeight * ratio));
      renderer?.resize(canvas.width, canvas.height);
    };

    const tick = (timestamp: number) => {
      raf = 0;
      if (disposed) return;
      if (timestamp - lastFrame < FRAME_MS - 1) {
        wake(); // fps cap：未夠時間就等下一幀
        return;
      }
      lastFrame = timestamp;
      if (!startTime) startTime = timestamp;
      syncVariant();
      if (covered || document.hidden) return;
      renderFrame((timestamp - startTime) / 1000);
      wake();
    };

    function wake() {
      if (raf || disposed || reduceQuery.matches) return;
      raf = window.requestAnimationFrame(tick);
    }

    const stop = () => {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const handleScroll = () => {
      if (reduceQuery.matches || !renderer) return;
      // 即時同步 variant，dark 覆蓋時下一個 tick 會自動停畫。
      wake();
    };
    const handleResize = () => {
      resizeCanvas();
      if (reduceQuery.matches) {
        syncVariant();
        if (!covered) renderFrame(0);
        return;
      }
      wake();
    };
    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        lastFrame = 0;
        wake();
      }
    };
    const syncMotion = () => {
      stop();
      resizeCanvas();
      syncVariant();
      if (reduceQuery.matches) {
        // reduced-motion：只畫 time=0 一幀靜態水晶。
        if (!covered) renderFrame(0);
        return;
      }
      lastFrame = 0;
      wake();
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      disposed = true;
      stop();
      canvas.dataset.renderer = 'css-fallback';
    };

    syncMotion();
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibility);
    reduceQuery.addEventListener('change', syncMotion);
    mobileQuery.addEventListener('change', handleResize);
    canvas.addEventListener('webglcontextlost', handleContextLost);

    return () => {
      disposed = true;
      stop();
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      reduceQuery.removeEventListener('change', syncMotion);
      mobileQuery.removeEventListener('change', handleResize);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      renderer?.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="wd-crystal-bg" aria-hidden="true" />;
}
