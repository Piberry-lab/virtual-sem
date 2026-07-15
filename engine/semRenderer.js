// ============================================================
// semRenderer.js — SEM 이미지 형성 파이프라인 (커스텀 WebGL2 엔진)
//
//  [1] G-buffer  : 빔 시점(수직 직교투영)에서 법선/위치/재질 렌더
//  [2] Signal    : SE/BSE 물리 모델로 픽셀별 신호 계산
//                  - SE: δ0·sec(θ)^0.85 (JEOL secant law) + 가장자리 효과
//                  - BSE: Reuter η(Z), 틸트 η=0.89(η0/0.89)^cosθ
//                  - 검출기 기하(LED 방향성 / UED 등방 / COMPO·TOPO·SHADOW)
//  [3] Blur      : 초점 이탈 흐림 d_blur = 2α·Δz + 비점수차 타원 커널
//  [4] Compose   : 주사(라스터) 진행 밴드에 샷노이즈(SNR=√N) 합성
//  [5] Display   : 밝기/명암/감마 LUT + 주사선 표시
// ============================================================

import { compileProgram, createRenderTarget, destroyRenderTarget, uploadMesh, drawMesh, createFullscreenQuad, drawFullscreen, FS_VS } from './gl.js';

const GBUF_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aExtra; // (원자번호 Z, 미세 거칠기)
uniform mat4 uVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
out vec3 vN;
out vec3 vLocal;
out float vDist;
out vec2 vExtra;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vN = normalize(uNormalMat * aNormal);
  vLocal = aPos;
  vDist = -world.y;      // 폴피스 하단(y=0)에서 아래로 거리 [mm]
  vExtra = aExtra;
  gl_Position = uVP * world;
}`;

const GBUF_FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vLocal;
in float vDist;
in vec2 vExtra;
layout(location=0) out vec4 oNormal;   // xyz: world normal, w: rough
layout(location=1) out vec4 oPos;      // xyz: local pos(mm), w: dist below pole(mm)
layout(location=2) out vec4 oMat;      // x: 원자번호, y: valid
void main() {
  oNormal = vec4(normalize(vN), vExtra.y);
  oPos = vec4(vLocal, vDist);
  oMat = vec4(vExtra.x, 1.0, 0.0, 0.0);
}`;

const SIGNAL_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uNormalTex;
uniform sampler2D uPosTex;
uniform sampler2D uMatTex;
uniform int uMode;          // 0 LED, 1 UED, 2 COMPO, 3 TOPO, 4 SHADOW
uniform float uKV;
uniform float uFieldMm;     // 시야폭 [mm]
uniform vec2 uResolution;
uniform float uEdgeRadiusPx;
uniform float uMicroBoost;
out vec4 oSignal;

// Reuter(1972): BSE 계수 η(Z)
float reuter(float Z) {
  return clamp(-0.0254 + 0.016*Z - 1.86e-4*Z*Z + 8.3e-7*Z*Z*Z, 0.02, 0.65);
}

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

// 시료 표면에 고정된 다중 스케일 미세 지형 높이 [mm]
// 배율(시야폭)에 맞는 옥타브만 활성화해 어느 배율에서도 디테일 유지
float microH(vec2 lp, float rough) {
  float h = 0.0;
  float freq = 10.0;    // 1/0.1mm 부터
  float amp = 0.0035;   // mm
  for (int o = 0; o < 9; o++) {
    float wavelen = 1.0 / freq;
    float pxSize = uFieldMm / uResolution.x;
    // 파장이 화면 픽셀보다 작으면 페이드아웃(앨리어싱 방지), 시야보다 크면 무시
    float w = smoothstep(pxSize * 1.5, pxSize * 6.0, wavelen) * smoothstep(uFieldMm * 2.0, uFieldMm * 0.2, wavelen);
    if (w > 0.001) h += amp * w * (vnoise(lp * freq) - 0.5);
    freq *= 2.7;
    amp *= 0.55;
  }
  return h * rough;
}

vec3 perturbNormal(vec3 N, vec2 lp, float rough) {
  float pxMm = uFieldMm / uResolution.x;
  float e = max(pxMm, 2e-5);
  float h0 = microH(lp, rough);
  float hx = microH(lp + vec2(e, 0.0), rough);
  float hz = microH(lp + vec2(0.0, e), rough);
  vec3 grad = vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e);
  // 지역 접평면 기준 섭동을 월드 법선에 근사 합성
  vec3 t = normalize(cross(abs(N.y) < 0.95 ? vec3(0,1,0) : vec3(1,0,0), N));
  vec3 b = cross(N, t);
  vec3 pn = normalize(t * grad.x * uMicroBoost + b * grad.z * uMicroBoost + N);
  return pn;
}

void main() {
  vec4 nTex = texture(uNormalTex, vUV);
  vec4 pTex = texture(uPosTex, vUV);
  vec4 mTex = texture(uMatTex, vUV);
  if (mTex.y < 0.5) { oSignal = vec4(0.0); return; } // 진공(시료 없음)

  float rough = nTex.w;
  float Zat = mTex.x;
  vec3 N = perturbNormal(normalize(nTex.xyz), pTex.xz + pTex.y * 0.37, rough);

  float cosT = clamp(dot(N, vec3(0.0, 1.0, 0.0)), 0.03, 1.0);
  float eta0 = reuter(Zat);

  // ---- 가장자리 효과: 상호작용 부피 반경 내 이웃 높이와 비교 ----
  float hC = -pTex.w;
  float rel = 0.0;
  {
    vec2 px = 1.0 / uResolution;
    float r = uEdgeRadiusPx;
    float sum = 0.0; float cnt = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = 6.2832 * float(i) / 8.0;
      vec2 o = vUV + vec2(cos(a), sin(a)) * px * r;
      vec4 np = texture(uPosTex, o);
      float nv = texture(uMatTex, o).y;
      if (nv > 0.5) { sum += -np.w; cnt += 1.0; }
    }
    if (cnt > 0.5) {
      float hAvg = sum / cnt;
      float rMm = uEdgeRadiusPx * uFieldMm / uResolution.x;
      rel = clamp((hC - hAvg) / max(rMm, 1e-5), -1.5, 2.5);
    }
  }

  float sig = 0.0;
  if (uMode <= 1) {
    // ===== 이차전자 =====
    float sec = pow(1.0 / max(cosT, 0.12), 0.85);
    float kvFac = pow(clamp(15.0 / max(uKV, 0.2), 0.4, 4.0), 0.25); // 저kV → SE 수율↑
    float delta0 = (0.30 + 0.55 * eta0) * kvFac;                    // SE2 경유 Z 의존
    sig = delta0 * sec;
    sig *= 1.0 + 0.75 * tanh(rel * 1.5);                            // edge effect
    if (uMode == 0) {
      // LED(E-T): 측면 검출기 방향 성분 + 랩어라운드 수집 (soft shadow)
      vec3 dDet = normalize(vec3(0.78, 0.5, 0.42));
      float dir = clamp(dot(N, dDet), 0.0, 1.0);
      sig *= mix(0.55, 1.45, dir);
    }
    // UED(in-lens): 등방 수집, 표면 민감(퍼터베이션 uMicroBoost로 반영)
  } else {
    // ===== 반사전자 (RBEI) =====
    float eta = 0.89 * pow(eta0 / 0.89, cosT); // 틸트 의존(η0 앵커형)
    if (uMode == 2) {
      // COMPO: 사분 세그먼트 합 → 지형 상쇄, Z 대비 유지
      sig = eta * (0.88 + 0.12 * cosT);
      sig *= 1.0 + 0.12 * tanh(rel * 1.5);
    } else if (uMode == 3) {
      // TOPO: 세그먼트 차 → Z 상쇄, 기울기 부호 신호 (측면광 릴리프)
      sig = 0.5 + 2.4 * eta * N.x + 0.25 * tanh(rel * 1.5) * eta;
    } else {
      // SHADOW: 단일 세그먼트 → 조성+지형 혼합, 강한 방향성
      vec3 dSeg = normalize(vec3(0.9, 0.35, 0.0));
      sig = eta * (0.35 + 0.95 * clamp(dot(N, dSeg), 0.0, 1.0));
      sig *= 1.0 + 0.3 * tanh(rel * 1.5);
    }
  }
  oSignal = vec4(max(sig, 0.0), 0.0, 0.0, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSignalTex;
uniform sampler2D uPosTex;
uniform sampler2D uMatTex;
uniform float uFocusWD;    // 초점면 깊이 [mm]
uniform float uAlpha;      // 수렴 반각 [rad]
uniform float uFieldMm;
uniform vec2 uResolution;
uniform float uProbePx;    // 프로브 기저 지름 [px]
uniform vec2 uStig;        // 비점수차: (진폭 mm, 방향각 rad)
out vec4 oColor;

const int NTAP = 24;

void main() {
  vec4 pTex = texture(uPosTex, vUV);
  float valid = texture(uMatTex, vUV).y;
  float dz = (valid > 0.5) ? (pTex.w - uFocusWD) : 0.0;

  // 비점수차: 직교 두 방향의 초점면이 ±sA 만큼 분리 → 타원 흐림
  float sA = uStig.x, ang = uStig.y;
  float pxPerMm = uResolution.x / uFieldMm;
  float rx = (uAlpha * abs(dz + sA)) * pxPerMm;  // 흐림 '반경' = α·Δz
  float ry = (uAlpha * abs(dz - sA)) * pxPerMm;
  float base = uProbePx * 0.5;
  rx = sqrt(rx * rx + base * base);
  ry = sqrt(ry * ry + base * base);
  rx = min(rx, 60.0); ry = min(ry, 60.0);

  if (max(rx, ry) < 0.6) { oColor = texture(uSignalTex, vUV); return; }

  float ca = cos(ang), sa = sin(ang);
  vec2 px = 1.0 / uResolution;
  float sum = 0.0, wsum = 0.0;
  for (int i = 0; i < NTAP; i++) {
    // 골든앵글 나선 디스크 샘플
    float t = (float(i) + 0.5) / float(NTAP);
    float r = sqrt(t);
    float a = float(i) * 2.39996;
    vec2 u = vec2(cos(a), sin(a)) * r;
    vec2 e = vec2(u.x * rx, u.y * ry);              // 타원 스케일
    vec2 o = vec2(e.x * ca - e.y * sa, e.x * sa + e.y * ca); // 방향 회전
    sum += texture(uSignalTex, vUV + o * px).r;
    wsum += 1.0;
  }
  oColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

const COMPOSE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uNewTex;    // 방금 렌더된(흐림 적용) 신호
uniform sampler2D uPrevTex;   // 이전 누적 프레임
uniform float uBandY0;        // 이번 틱에 주사되는 밴드 [0..1] (위→아래)
uniform float uBandY1;
uniform float uNoiseSigma;    // 1/√N — 샷노이즈 상대 강도
uniform float uSeed;
uniform float uChargeAmp;     // 차징: 라인 지터/플레어 강도
uniform float uTime;
out vec4 oColor;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  float yTop = 1.0 - vUV.y; // 주사는 위에서 아래로
  bool inBand = (yTop >= uBandY0 && yTop < uBandY1);
  if (!inBand) { oColor = texture(uPrevTex, vUV); return; }

  vec2 uv = vUV;
  // 차징: 수평 라인 지터 + 간헐 플레어
  if (uChargeAmp > 0.0) {
    float line = floor(vUV.y * 768.0);
    float j = (hash(vec2(line, floor(uTime * 13.0))) - 0.5) * uChargeAmp * 0.02;
    uv.x += j;
  }
  float sig = texture(uNewTex, uv).r;
  if (uChargeAmp > 0.0) {
    float flare = pow(hash(vec2(floor(uv.x * 60.0), floor(uv.y * 45.0)) + floor(uTime * 2.0)), 24.0);
    sig += flare * uChargeAmp * 2.5 * sig;
  }
  // 샷노이즈: σ ∝ √signal / √N (포아송 → 가우스 근사, Box-Muller)
  float u1 = max(hash(vUV * 1913.0 + uSeed), 1e-4);
  float u2 = hash(vUV * 733.0 + uSeed * 1.7);
  float g = sqrt(-2.0 * log(u1)) * cos(6.2832 * u2);
  sig += g * uNoiseSigma * sqrt(max(sig, 0.06));
  oColor = vec4(max(sig, 0.0), 0.0, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uAccumTex;
uniform float uBrightness;  // 오프셋
uniform float uContrast;    // 게인
uniform float uGamma;
uniform float uScanY;       // 현재 주사선 [0..1], <0 이면 표시 안함
out vec4 oColor;
void main() {
  float v = texture(uAccumTex, vUV).r;
  v = (v - 0.5) * uContrast + 0.5 + uBrightness;
  v = clamp(v, 0.0, 1.0);
  v = pow(v, 1.0 / max(uGamma, 0.1));
  // 주사선 마커
  float yTop = 1.0 - vUV.y;
  if (uScanY >= 0.0) {
    float d = abs(yTop - uScanY);
    v = mix(1.0, v, smoothstep(0.0, 0.004, d));
  }
  oColor = vec4(vec3(v), 1.0);
}`;

const RES_W = 1024, RES_H = 768;

export class SEMRenderer {
  constructor(gl) {
    this.gl = gl;
    this.quad = createFullscreenQuad(gl);
    this.pGbuf = compileProgram(gl, GBUF_VS, GBUF_FS, 'gbuffer');
    this.pSignal = compileProgram(gl, FS_VS, SIGNAL_FS, 'signal');
    this.pBlur = compileProgram(gl, FS_VS, BLUR_FS, 'blur');
    this.pCompose = compileProgram(gl, FS_VS, COMPOSE_FS, 'compose');
    this.pDisplay = compileProgram(gl, FS_VS, DISPLAY_FS, 'display');

    const F = gl.FLOAT, HF = gl.HALF_FLOAT, RGBA = gl.RGBA;
    this.rtGbuf = createRenderTarget(gl, RES_W, RES_H, [
      { internalFormat: gl.RGBA16F, format: RGBA, type: HF },
      { internalFormat: gl.RGBA32F, format: RGBA, type: F },
      { internalFormat: gl.RGBA16F, format: RGBA, type: HF },
    ], true);
    this.rtSignal = createRenderTarget(gl, RES_W, RES_H, [
      { internalFormat: gl.R16F, format: gl.RED, type: HF, filter: gl.LINEAR },
    ], false);
    this.rtBlur = createRenderTarget(gl, RES_W, RES_H, [
      { internalFormat: gl.R16F, format: gl.RED, type: HF, filter: gl.LINEAR },
    ], false);
    this.rtAccum = [0, 1].map(() => createRenderTarget(gl, RES_W, RES_H, [
      { internalFormat: gl.R16F, format: gl.RED, type: HF, filter: gl.LINEAR },
    ], false));
    this.accumIdx = 0;

    this.sampleMesh = null;
    this.scanY = 0;          // 현재 주사 위치 [0..1]
    this.frameSeed = 1;
  }

  setSample(gl, meshData) {
    this.sampleMesh = uploadMesh(gl, meshData);
    this.resetScan();
  }

  resetScan() { this.scanY = 0; this.frameSeed = Math.random() * 100; }

  // state: {vpMatrix, modelMatrix, normalMat, mode, kV, fieldMm, focusWD,
  //         alphaRad, probePx, stigAmpMm, stigAngle, noiseSigma, chargeAmp,
  //         frameTime, dt, time, brightness, contrast, gamma, paused}
  render(state) {
    const gl = this.gl;

    // ---- [1] G-buffer ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtGbuf.fbo);
    gl.viewport(0, 0, RES_W, RES_H);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.clearBufferfv(gl.COLOR, 0, [0, 1, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]); // valid=0 → 진공
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    if (this.sampleMesh) {
      const p = this.pGbuf;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uVP, false, state.vpMatrix);
      gl.uniformMatrix4fv(p.u.uModel, false, state.modelMatrix);
      gl.uniformMatrix3fv(p.u.uNormalMat, false, state.normalMat);
      drawMesh(gl, this.sampleMesh);
    }
    gl.disable(gl.DEPTH_TEST);

    // ---- [2] Signal ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtSignal.fbo);
    gl.viewport(0, 0, RES_W, RES_H);
    {
      const p = this.pSignal;
      gl.useProgram(p.prog);
      this.bindTex(0, this.rtGbuf.textures[0], p.u.uNormalTex);
      this.bindTex(1, this.rtGbuf.textures[1], p.u.uPosTex);
      this.bindTex(2, this.rtGbuf.textures[2], p.u.uMatTex);
      gl.uniform1i(p.u.uMode, state.mode);
      gl.uniform1f(p.u.uKV, state.kV);
      gl.uniform1f(p.u.uFieldMm, state.fieldMm);
      gl.uniform2f(p.u.uResolution, RES_W, RES_H);
      gl.uniform1f(p.u.uEdgeRadiusPx, state.edgeRadiusPx);
      gl.uniform1f(p.u.uMicroBoost, state.microBoost);
      drawFullscreen(gl, this.quad);
    }

    // ---- [3] Blur (DOF + 비점수차) ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtBlur.fbo);
    {
      const p = this.pBlur;
      gl.useProgram(p.prog);
      this.bindTex(0, this.rtSignal.textures[0], p.u.uSignalTex);
      this.bindTex(1, this.rtGbuf.textures[1], p.u.uPosTex);
      this.bindTex(2, this.rtGbuf.textures[2], p.u.uMatTex);
      gl.uniform1f(p.u.uFocusWD, state.focusWD);
      gl.uniform1f(p.u.uAlpha, state.alphaRad);
      gl.uniform1f(p.u.uFieldMm, state.fieldMm);
      gl.uniform2f(p.u.uResolution, RES_W, RES_H);
      gl.uniform1f(p.u.uProbePx, state.probePx);
      gl.uniform2f(p.u.uStig, state.stigAmpMm, state.stigAngle);
      drawFullscreen(gl, this.quad);
    }

    // ---- [4] Compose (주사 진행 + 노이즈) ----
    const rowsFrac = Math.min(state.dt / state.frameTime, 1);
    let y0 = this.scanY, y1 = this.scanY + rowsFrac;
    if (state.paused) { y0 = 0; y1 = 0; }
    const src = this.rtAccum[this.accumIdx];
    const dst = this.rtAccum[1 - this.accumIdx];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    {
      const p = this.pCompose;
      gl.useProgram(p.prog);
      this.bindTex(0, this.rtBlur.textures[0], p.u.uNewTex);
      this.bindTex(1, src.textures[0], p.u.uPrevTex);
      gl.uniform1f(p.u.uBandY0, y0);
      gl.uniform1f(p.u.uBandY1, y1);
      gl.uniform1f(p.u.uNoiseSigma, state.noiseSigma);
      gl.uniform1f(p.u.uSeed, this.frameSeed);
      gl.uniform1f(p.u.uChargeAmp, state.chargeAmp);
      gl.uniform1f(p.u.uTime, state.time);
      drawFullscreen(gl, this.quad);
    }
    this.accumIdx = 1 - this.accumIdx;
    if (!state.paused) {
      this.scanY = y1;
      if (this.scanY >= 1) { this.scanY = 0; this.frameSeed = Math.random() * 100; }
    }

    // ---- [5] Display ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    {
      const p = this.pDisplay;
      gl.useProgram(p.prog);
      this.bindTex(0, this.rtAccum[this.accumIdx].textures[0], p.u.uAccumTex);
      gl.uniform1f(p.u.uBrightness, state.brightness);
      gl.uniform1f(p.u.uContrast, state.contrast);
      gl.uniform1f(p.u.uGamma, state.gamma);
      // TV처럼 빠른 주사에서는 주사선 마커 숨김
      gl.uniform1f(p.u.uScanY, state.frameTime > 0.5 && !state.paused ? this.scanY : -1);
      drawFullscreen(gl, this.quad);
    }
  }

  bindTex(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  // 자동 밝기/명암용: 누적 텍스처 일부를 읽어 평균/표준편차 추정
  sampleStats() {
    const gl = this.gl;
    const N = 64;
    const buf = new Float32Array(N * N * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtAccum[this.accumIdx].fbo);
    try {
      gl.readPixels(RES_W / 2 - N / 2, RES_H / 2 - N / 2, N, N, gl.RGBA, gl.FLOAT, buf);
    } catch (e) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let sum = 0, sum2 = 0;
    for (let i = 0; i < N * N; i++) { const v = buf[i * 4]; sum += v; sum2 += v * v; }
    const mean = sum / (N * N);
    const std = Math.sqrt(Math.max(sum2 / (N * N) - mean * mean, 1e-8));
    return { mean, std };
  }
}

export { RES_W, RES_H };
