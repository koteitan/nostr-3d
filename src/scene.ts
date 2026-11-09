// The 3D scene: every column is a DOM element that is shown as a quad in 3D space.
//
// mode 'drawable' (HTML-in-Canvas): the column elements are children of
//   <canvas content="drawable">. The browser fires a `paint` event when the rendering of
//   an element changed; the changed elements are then copied into WebGL textures with
//   gl.texElementSubImage2D() and all columns are drawn as quads. When only a pose
//   changed (dragging), the quads are redrawn from the existing textures.
//   canvas.updateElementGeometry() tells the browser where each element ended up on
//   the screen, so that clicks, scrolling and text selection reach the real DOM.
//
// mode 'css3d' (fallback for browsers without HTML-in-Canvas): the same matrix is
//   applied to the elements as a CSS matrix3d() transform.

import {
  fromQuat,
  mul,
  perspective,
  quatBetween,
  quatMul,
  quatNormalize,
  rotateVec,
  scaling,
  transformPoint,
  translation,
  type Mat4,
  type Quat,
  type Vec3,
} from './mat4';

export type Mode = 'drawable' | 'css3d';

export interface Pose {
  /** centre of the column. 1 unit = 1 CSS pixel at z = 0, x right, y up, z toward the viewer */
  pos: Vec3;
  rot: Quat;
}

interface Entry {
  id: number;
  el: HTMLElement;
  tex: WebGLTexture | null;
  texW: number;
  texH: number;
  dirty: boolean;
  /** the texture holds a picture of the element */
  ready: boolean;
  lastTransform: string;
}

// The HTML-in-Canvas members that TypeScript's DOM library does not know yet.
interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint(): void;
  updateElementGeometry(el: Element, init: { canvasTransform: DOMMatrix }): void;
  getElementImageDefaultSize?(el: Element): { width: number; height: number };
}
interface DrawableGL extends WebGL2RenderingContext {
  texElementSubImage2D(
    target: number,
    level: number,
    xoffset: number,
    yoffset: number,
    element: Element,
  ): void;
}
interface CanvasPaintEvent extends Event {
  changedElements?: readonly Element[];
}

/** distance from the camera to the plane z = 0, in CSS pixels */
const CAMERA_DISTANCE = 1400;
const Z_MIN = -4000;
const Z_MAX = CAMERA_DISTANCE * 0.6;

export const detectMode = (): Mode => {
  if (new URLSearchParams(location.search).get('mode') === 'css3d') return 'css3d';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('content', 'drawable');
  if ((canvas as unknown as { content?: string }).content !== 'drawable') return 'css3d';
  if (!('updateElementGeometry' in canvas) || !('requestPaint' in canvas)) return 'css3d';
  const gl = canvas.getContext('webgl2');
  if (gl == null || !('texElementSubImage2D' in gl)) return 'css3d';
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return 'drawable';
};

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;           // (0,0) = top-left of the element, (1,1) = bottom-right
uniform mat4 u_matrix;   // element pixel -> clip space
uniform vec2 u_size;     // element size in CSS pixels
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = u_matrix * vec4(a_pos * u_size, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_shade;
out vec4 color;
void main() {
  vec4 c = texture(u_tex, v_uv);   // premultiplied alpha
  color = vec4(c.rgb * u_shade, c.a);
}`;

export class Scene {
  readonly mode: Mode;
  /** called with a message when something goes wrong in the renderer */
  onError: (message: string) => void = (message) => console.error(message);

  private stage: HTMLElement | null = null;
  private gl: DrawableGL | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private entries = new Map<number, Entry>();
  private poses = new Map<number, Pose>();
  private raised = new Map<number, number>();
  private raiseSeq = 0;
  /** animation token -> column id */
  private animating = new Map<object, number>();
  private animationFrame = 0;
  private frame = 0;

  private cssW = 1;
  private cssH = 1;
  /** projection * view */
  private pv: Mat4 = translation(0, 0, 0);

  constructor(mode: Mode) {
    this.mode = mode;
  }

  // ---------------------------------------------------------------- lifecycle

  attach(stage: HTMLElement) {
    this.stage = stage;
    this.measure();
    if (this.mode === 'drawable') {
      const canvas = stage as HTMLCanvasElement;
      this.initGL(canvas);
      canvas.addEventListener('paint', this.onPaint);
      canvas.addEventListener('webglcontextlost', this.onContextLost);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    }
    this.resizeObserver = new ResizeObserver(() => this.invalidate());
    this.resizeObserver.observe(stage);
    this.invalidate();
  }

  detach() {
    const stage = this.stage;
    if (stage == null) return;
    stage.removeEventListener('paint', this.onPaint);
    stage.removeEventListener('webglcontextlost', this.onContextLost);
    stage.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stage = null;
  }

  /** Starts showing the element as a column. Returns the function that stops it. */
  register(id: number, el: HTMLElement): () => void {
    const entry: Entry = {
      id,
      el,
      tex: null,
      texW: 0,
      texH: 0,
      dirty: true,
      ready: false,
      lastTransform: '',
    };
    this.entries.set(id, entry);
    if (!this.poses.has(id)) this.poses.set(id, { pos: [0, 0, 0], rot: [0, 0, 0, 1] });
    if (!this.raised.has(id)) this.raise(id);
    this.invalidate();
    return () => {
      if (this.entries.get(id) !== entry) return;
      if (entry.tex != null) this.gl?.deleteTexture(entry.tex);
      this.entries.delete(id);
      this.invalidate();
    };
  }

  /** Forgets the pose of a column that was closed. */
  forget(id: number) {
    this.poses.delete(id);
    this.raised.delete(id);
  }

  // -------------------------------------------------------------------- poses

  getPose(id: number): Pose | undefined {
    return this.poses.get(id);
  }

  setPose(id: number, pose: Pose) {
    this.poses.set(id, pose);
    this.invalidate();
  }

  /** The pose of a column shifted by (right, down) CSS pixels inside the plane of column `id`. */
  offsetPose(id: number, right: number, down: number): Pose {
    const base = this.poses.get(id) ?? { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    const d = rotateVec(base.rot, [right, -down, 0]);
    return {
      pos: [base.pos[0] + d[0], base.pos[1] + d[1], base.pos[2] + d[2]],
      rot: [...base.rot],
    };
  }

  /** Draws the column in front of the other columns at the same depth. */
  raise(id: number) {
    this.raiseSeq += 1;
    this.raised.set(id, this.raiseSeq);
    this.invalidate();
  }

  /** Moves the column parallel to the screen so that it follows the pointer. */
  moveBy(id: number, dxScreen: number, dyScreen: number) {
    const pose = this.poses.get(id);
    if (pose == null) return;
    const scale = (CAMERA_DISTANCE - pose.pos[2]) / CAMERA_DISTANCE;
    pose.pos = [pose.pos[0] + dxScreen * scale, pose.pos[1] - dyScreen * scale, pose.pos[2]];
    this.invalidate();
  }

  /** Moves the column toward (+) or away from (-) the viewer. */
  dolly(id: number, dz: number) {
    const pose = this.poses.get(id);
    if (pose == null) return;
    pose.pos = [pose.pos[0], pose.pos[1], Math.min(Z_MAX, Math.max(Z_MIN, pose.pos[2] + dz))];
    this.invalidate();
  }

  /** Client coordinates of the centre of the column. */
  screenCenter(id: number): { x: number; y: number } {
    const pose = this.poses.get(id);
    const rect = this.stage?.getBoundingClientRect();
    if (pose == null || rect == null) return { x: 0, y: 0 };
    const p = transformPoint(this.pv, pose.pos[0], pose.pos[1], pose.pos[2]);
    return {
      x: rect.left + ((p.x / p.w + 1) * this.cssW) / 2,
      y: rect.top + ((1 - p.y / p.w) * this.cssH) / 2,
    };
  }

  /**
   * Rotates the column around its centre like a trackball of the given radius centred
   * at `center`: the point of the ball under (x0, y0) moves to (x1, y1).
   */
  rotateArc(
    id: number,
    center: { x: number; y: number },
    radius: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) {
    const pose = this.poses.get(id);
    if (pose == null) return;
    const onBall = (x: number, y: number): Vec3 => {
      const px = (x - center.x) / radius;
      const py = -(y - center.y) / radius;
      const d2 = px * px + py * py;
      // a sphere near the centre, a hyperbolic sheet outside of it (no clamping at the rim)
      const pz = d2 <= 0.5 ? Math.sqrt(1 - d2) : 0.5 / Math.sqrt(d2);
      const n = Math.hypot(px, py, pz);
      return [px / n, py / n, pz / n];
    };
    const q = quatBetween(onBall(x0, y0), onBall(x1, y1));
    pose.rot = quatNormalize(quatMul(q, pose.rot));
    this.invalidate();
  }

  // ---------------------------------------------------------------- rendering

  /** Requests a redraw of the scene in the next animation frame. */
  invalidate() {
    if (this.stage == null || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.mode === 'drawable') this.draw();
      else this.applyCss();
    });
  }

  /** Marks the picture of a column as stale and asks the browser for a new one. */
  markDirty(id: number) {
    const entry = this.entries.get(id);
    if (entry == null || this.stage == null) return;
    entry.dirty = true;
    if (this.mode === 'drawable') (this.stage as DrawableCanvas).requestPaint();
    this.invalidate();
  }

  /**
   * While something animates inside a column (a video is playing) the texture of the
   * column is refreshed every frame. `token` identifies the animation.
   */
  startAnimating(token: object, columnId: number) {
    this.animating.set(token, columnId);
    if (this.mode !== 'drawable' || this.animationFrame !== 0) return;
    const tick = () => {
      this.animationFrame = 0;
      if (this.animating.size === 0) return;
      new Set(this.animating.values()).forEach((id) => this.markDirty(id));
      this.animationFrame = requestAnimationFrame(tick);
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  stopAnimating(token: object) {
    this.animating.delete(token);
  }

  private measure() {
    const stage = this.stage;
    if (stage == null) return;
    this.cssW = Math.max(1, stage.clientWidth);
    this.cssH = Math.max(1, stage.clientHeight);
    const fovY = 2 * Math.atan(this.cssH / 2 / CAMERA_DISTANCE);
    const projection = perspective(fovY, this.cssW / this.cssH, 20, CAMERA_DISTANCE * 8);
    this.pv = mul(projection, translation(0, 0, -CAMERA_DISTANCE));
  }

  /** Back to front: columns farther from the viewer first, then the least recently raised. */
  private sorted(): Entry[] {
    const z = (e: Entry) => this.poses.get(e.id)?.pos[2] ?? 0;
    const r = (e: Entry) => this.raised.get(e.id) ?? 0;
    return [...this.entries.values()].sort((a, b) => z(a) - z(b) || r(a) - r(b));
  }

  /** element pixel (x right, y down, origin at the top-left corner) -> clip space */
  private elementToClip(entry: Entry, w: number, h: number): Mat4 {
    const pose = this.poses.get(entry.id) ?? { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    const model = mul(translation(pose.pos[0], pose.pos[1], pose.pos[2]), fromQuat(pose.rot));
    const pixelToLocal = mul(translation(-w / 2, h / 2, 0), scaling(1, -1, 1));
    return mul(mul(this.pv, model), pixelToLocal);
  }

  /** element pixel -> CSS pixel of the stage. The browser does the division by w. */
  private elementToStage(clip: Mat4): Mat4 {
    const viewport: Mat4 = [
      this.cssW / 2, 0, 0, 0,
      0, -this.cssH / 2, 0, 0,
      0, 0, 1, 0,
      this.cssW / 2, this.cssH / 2, 0, 1,
    ];
    return mul(viewport, clip);
  }

  private applyCss() {
    this.measure();
    this.sorted().forEach((entry, index) => {
      const { el } = entry;
      const m = this.elementToStage(this.elementToClip(entry, el.offsetWidth, el.offsetHeight));
      const transform = `matrix3d(${m.join(',')})`;
      if (transform !== entry.lastTransform) {
        el.style.transform = transform;
        entry.lastTransform = transform;
      }
      el.style.zIndex = String(index);
    });
  }

  private onPaint = (ev: Event) => {
    const changed = (ev as CanvasPaintEvent).changedElements;
    if (changed == null) {
      this.entries.forEach((entry) => {
        entry.dirty = true;
      });
    } else {
      const byElement = new Map([...this.entries.values()].map((e) => [e.el as Element, e]));
      for (const el of changed) {
        const entry = byElement.get(el);
        if (entry != null) entry.dirty = true;
      }
    }
    this.draw();
  };

  private onContextLost = (ev: Event) => {
    ev.preventDefault();
    this.gl = null;
  };

  private onContextRestored = () => {
    if (this.stage == null) return;
    this.entries.forEach((entry) => {
      entry.tex = null;
      entry.texW = 0;
      entry.texH = 0;
      entry.dirty = true;
      entry.ready = false;
    });
    this.initGL(this.stage as HTMLCanvasElement);
    this.invalidate();
  };

  private initGL(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    }) as DrawableGL | null;
    if (gl == null) {
      this.onError('WebGL2 is not available');
      return;
    }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        this.onError(`shader: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.onError(`program: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      matrix: gl.getUniformLocation(program, 'u_matrix'),
      size: gl.getUniformLocation(program, 'u_size'),
      shade: gl.getUniformLocation(program, 'u_shade'),
    };
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    this.anisotropy =
      ext == null ? null : { ext, max: gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) };

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.gl = gl;
    this.program = program;
  }

  /** Copies the current picture of the element into its texture. */
  private upload(entry: Entry, canvas: DrawableCanvas, gl: DrawableGL) {
    const { el } = entry;
    try {
      // The picture of an element has the resolution of the canvas grid.
      // (getElementImageDefaultSize exists since Chrome 157.)
      const size = canvas.getElementImageDefaultSize?.(el) ?? {
        width: (el.offsetWidth * canvas.width) / this.cssW,
        height: (el.offsetHeight * canvas.height) / this.cssH,
      };
      const w = Math.max(1, Math.ceil(size.width));
      const h = Math.max(1, Math.ceil(size.height));
      if (entry.tex == null) entry.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      if (entry.texW !== w || entry.texH !== h) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (this.anisotropy != null) {
          gl.texParameterf(
            gl.TEXTURE_2D,
            this.anisotropy.ext.TEXTURE_MAX_ANISOTROPY_EXT,
            Math.min(8, this.anisotropy.max),
          );
        }
        entry.texW = w;
        entry.texH = h;
      }
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
      gl.generateMipmap(gl.TEXTURE_2D);
      entry.dirty = false;
      entry.ready = true;
    } catch (err) {
      // "No cached paint record for element" is thrown (by getElementImageDefaultSize and
      // by texElementSubImage2D) until the browser has painted the element once.
      // The entry stays dirty and is retried on the next paint event.
      if (entry.ready) this.onError(`texElementSubImage2D: ${(err as Error).message}`);
    }
  }

  private draw() {
    const canvas = this.stage as DrawableCanvas | null;
    const gl = this.gl;
    if (canvas == null || gl == null || this.program == null) return;

    this.measure();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.cssW * dpr));
    const height = Math.max(1, Math.round(this.cssH * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      // The resolution of the element pictures follows the canvas grid.
      canvas.width = width;
      canvas.height = height;
      this.entries.forEach((entry) => {
        entry.dirty = true;
      });
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0); // the background colour comes from the CSS of the canvas
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);

    const sorted = this.sorted();
    for (const entry of sorted) {
      const w = entry.el.offsetWidth;
      const h = entry.el.offsetHeight;
      if (w === 0 || h === 0) continue;
      if (entry.dirty || entry.tex == null) this.upload(entry, canvas, gl);
      const clip = this.elementToClip(entry, w, h);
      if (entry.tex != null && entry.ready) {
        const rot = this.poses.get(entry.id)?.rot ?? [0, 0, 0, 1];
        const facing = Math.abs(rotateVec(rot, [0, 0, 1])[2]);
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        gl.uniformMatrix4fv(this.uniforms.matrix, false, new Float32Array(clip));
        gl.uniform2f(this.uniforms.size, w, h);
        gl.uniform1f(this.uniforms.shade, 0.8 + 0.2 * facing);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      // Tell the browser where the element is now. The element that is updated last is
      // on top for hit testing, which matches the back-to-front drawing order.
      try {
        canvas.updateElementGeometry(entry.el, {
          canvasTransform: new DOMMatrix(this.elementToStage(clip)),
        });
      } catch (err) {
        this.onError(`updateElementGeometry: ${(err as Error).message}`);
      }
    }
  }
}

export const scene = new Scene(detectMode());
