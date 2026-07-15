// ============================================================
// chamberRenderer.js — 시료실 3D 뷰 (포워드 렌더, 궤도 카메라)
// 폴피스/스테이지/검출기/빔/초점면·DOF 밴드를 표시하고
// RBEI 삽입·틸트 간섭(충돌 위험)을 시각화한다.
// ============================================================

import { mat4Perspective, mat4LookAt, mat4Multiply, mat4Chain, mat4Translate, mat4RotX, mat4RotY, mat4Scale, mat4Identity, mat3FromMat4, DEG, clamp } from './math.js';
import { compileProgram } from './gl.js';
import { makeChamberParts, makeCylinder, setColor } from './mesh.js';
import { STUB_RADIUS, RBEI_BOTTOM, RBEI_THICKNESS } from './stage.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uProj, uView, uModel;
uniform mat3 uNormalMat;
out vec3 vN;
out vec3 vColor;
void main() {
  vN = normalize(uNormalMat * aNormal);
  vColor = aColor;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vColor;
uniform vec3 uTint;
uniform float uAlpha;
uniform float uUnlit;
out vec4 oColor;
void main() {
  vec3 N = normalize(vN);
  float l1 = max(dot(N, normalize(vec3(0.5, 0.8, 0.4))), 0.0);
  float l2 = max(dot(N, normalize(vec3(-0.6, 0.2, -0.5))), 0.0);
  float shade = 0.32 + 0.62 * l1 + 0.22 * l2;
  vec3 c = vColor * uTint * mix(shade, 1.0, uUnlit);
  oColor = vec4(c, uAlpha);
}`;

function uploadColorMesh(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const bind = (loc, data, size) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  bind(0, mesh.positions, 3);
  bind(1, mesh.normals, 3);
  if (mesh.colors) bind(2, mesh.colors, 3);
  else { gl.disableVertexAttribArray(2); gl.vertexAttrib3f(2, 0.7, 0.7, 0.7); }
  const idx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: mesh.indices.length };
}

// 위치 P에서 target을 향해 +y축이 정렬되는 강체 행렬
function aimMatrix(P, target) {
  const y = normDir([target[0] - P[0], target[1] - P[1], target[2] - P[2]]);
  let x = cross(y, [0, 1, 0]);
  if (len(x) < 1e-4) x = [1, 0, 0]; else x = normDir(x);
  const z = cross(x, y);
  return new Float32Array([
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    P[0], P[1], P[2], 1,
  ]);
}
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const normDir = (a) => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };

export class ChamberRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
    if (!gl) throw new Error('WebGL2 미지원');
    this.gl = gl;
    this.canvas = canvas;
    this.prog = compileProgram(gl, VS, FS, 'chamber');

    const parts = makeChamberParts();
    this.m = {};
    for (const [k, v] of Object.entries(parts)) this.m[k] = uploadColorMesh(gl, v);
    this.m.beam = uploadColorMesh(gl, setColor(makeCylinder(0.14, 0.14, 1, 10), 0.3, 0.95, 1.0));
    this.m.ground = uploadColorMesh(gl, setColor(makeCylinder(55, 55, 1.5, 48), 0.14, 0.16, 0.2));

    // 궤도 카메라
    this.cam = { yaw: 0.7, pitch: 0.32, dist: 95, target: [0, -14, 0] };
    this.attachControls(canvas);
  }

  attachControls(canvas) {
    let drag = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.cam.yaw += (e.clientX - lx) * 0.008;
      this.cam.pitch = clamp(this.cam.pitch + (e.clientY - ly) * 0.008, -0.2, 1.4);
      lx = e.clientX; ly = e.clientY;
    });
    canvas.addEventListener('pointerup', () => { drag = false; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = clamp(this.cam.dist * (1 + Math.sign(e.deltaY) * 0.1), 30, 260);
    }, { passive: false });
  }

  // state: {stage(Stage), focusWD, dofMm, collisionRisk, etTargetY}
  render(state) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.055, 0.07, 0.095, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    const { yaw, pitch, dist, target } = this.cam;
    const eye = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const proj = mat4Perspective(35 * DEG, W / H, 1, 500);
    const view = mat4LookAt(eye, target, [0, 1, 0]);

    const p = this.prog;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.u.uProj, false, proj);
    gl.uniformMatrix4fv(p.u.uView, false, view);

    const st = state.stage;
    const { x, y, z, t, r } = st.cur;
    const Mtilt = mat4Chain(mat4Translate(0, -z, 0), mat4RotX(t * DEG));
    const Mfull = mat4Chain(Mtilt, mat4Translate(x, 0, y), mat4RotY(r * DEG));

    const risk = state.collisionRisk;
    const warnTint = risk ? [1.55, 0.45, 0.45] : [1, 1, 1];

    const draw = (mesh, model, { tint = [1, 1, 1], alpha = 1, unlit = 0 } = {}) => {
      gl.uniformMatrix4fv(p.u.uModel, false, model);
      gl.uniformMatrix3fv(p.u.uNormalMat, false, mat3FromMat4(model));
      gl.uniform3fv(p.u.uTint, tint);
      gl.uniform1f(p.u.uAlpha, alpha);
      gl.uniform1f(p.u.uUnlit, unlit);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    };

    // ---- 불투명 ----
    draw(this.m.ground, mat4Translate(0, -48, 0));
    draw(this.m.polePiece, mat4Identity());
    draw(this.m.etDetector, aimMatrix([30, -3, 20], [0, -Math.min(z, 12), 0]));

    // RBEI: 슬라이드 삽입 (rbeiPos 0→1)
    const slideX = (1 - st.rbeiPos) * 42;
    if (st.rbeiPos > 0.01) {
      draw(this.m.rbeiDisc, mat4Translate(slideX, RBEI_BOTTOM, 0), { tint: warnTint });
      draw(this.m.rbeiArm, mat4Translate(slideX + 8.5 + 21, RBEI_BOTTOM + RBEI_THICKNESS / 2 - 1.1, 0), { tint: warnTint });
    }

    // 스테이지 어셈블리
    draw(this.m.stageBase, mat4Chain(mat4Translate(0, -z - 19, 0)));
    draw(this.m.tiltCradle, mat4Chain(Mtilt, mat4Translate(0, -10.1, 0)));
    draw(this.m.rotPlatter, mat4Chain(Mtilt, mat4Translate(0, -7.1, 0)));
    draw(this.m.stub, mat4Chain(Mfull, mat4Translate(0, -3.1, 0)), { tint: risk ? warnTint : [1, 1, 1] });
    draw(this.m.sampleProxy, mat4Chain(Mfull, mat4Translate(0, -0.6, 0)), { tint: risk ? warnTint : [1.0, 1.0, 1.0] });

    // ---- 반투명 (빔, 초점면, DOF 밴드) ----
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    const fWD = state.focusWD;
    // 빔: 폴피스 → 초점면 (밝음), 이후 발산 (어두움)
    draw(this.m.beam, mat4Chain(mat4Translate(0, -fWD, 0), mat4Scale(1, fWD, 1)), { tint: [1, 1, 1], alpha: 0.85, unlit: 1 });
    draw(this.m.beam, mat4Chain(mat4Translate(0, -(z + 8), 0), mat4Scale(1.6, Math.max(z + 8 - fWD, 0.01), 1.6)), { tint: [0.5, 0.9, 1], alpha: 0.25, unlit: 1 });

    // 초점면 + DOF 밴드
    const dofVis = clamp(state.dofMm, 0.06, 80);
    draw(this.m.focalPlane, mat4Chain(mat4Translate(0, -fWD, 0), mat4Scale(1, dofVis / 0.05, 1)), { tint: [0.3, 1.0, 1.2], alpha: 0.16, unlit: 1 });
    draw(this.m.focalPlane, mat4Translate(0, -fWD, 0), { tint: [0.5, 1.4, 1.6], alpha: 0.5, unlit: 1 });

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }
}
