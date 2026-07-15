// ============================================================
// app.js — Virtual SEM 조립: UI ↔ 스테이지 ↔ 렌더 파이프라인
// ============================================================

import { createGL } from './engine/gl.js';
import { SEMRenderer, RES_W, RES_H } from './engine/semRenderer.js';
import { ChamberRenderer } from './engine/chamberRenderer.js';
import { Stage, SAFETY_MARGIN, STUB_RADIUS, RBEI_BOTTOM } from './engine/stage.js';
import { mat3FromMat4, clamp, DEG } from './engine/math.js';
import { makeSampleSnBalls, makeSampleParticles, makeSamplePillars, makeSampleFracture, makeSampleChip } from './engine/mesh.js';
import { SPEC, DETECTORS, convergenceAngle, depthOfFieldMm, probeDiameterNm, detectorEfficiency, electronsPerPixel, fieldWidthMm, scaleBar } from './engine/physics.js';

const $ = (id) => document.getElementById(id);

const SAMPLE_FACTORIES = {
  snballs: makeSampleSnBalls,
  particles: makeSampleParticles,
  pillars: makeSamplePillars,
  fracture: makeSampleFracture,
  chip: makeSampleChip,
};
const sampleCache = {};

const state = {
  kV: 15,
  probeIdx: 2,          // 86 pA
  apertureIdx: 1,       // 50 µm
  mag: 500,
  scanIdx: 0,           // TV
  detIdx: 0,            // LED
  gentleBeam: false,
  charging: false,
  focusCoarse: 10, focusFine: 0,
  stigX: 0, stigY: 0,
  // 장비 고유 잔류 비점수차 — 스티그마 노브로 상쇄해야 고배율이 선명해짐
  stigPresetX: 0.34, stigPresetY: -0.22,
  brightness: 0.05, contrast: 1.25, gamma: 1.05,
  paused: false,
  sampleId: 'snballs',
  sampleName: '', sampleHeightUm: 130,
};

const stage = new Stage();
let semR, chamR, gl;
let lastT = performance.now();
let toastTimer = null;

function toast(msg, isWarn = true) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isWarn ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function focusWD() { return clamp(state.focusCoarse + state.focusFine, 0.5, 45); }

function loadSample(id) {
  const info = sampleCache[id] || (sampleCache[id] = SAMPLE_FACTORIES[id]());
  state.sampleId = id;
  state.sampleName = info.name;
  state.sampleHeightUm = info.heightRangeUm;
  stage.sampleHeightMm = Math.max(info.heightRangeUm / 1000, 0.05);
  semR.setSample(gl, info.mesh);
  $('sampleDesc').textContent = info.desc;
  document.querySelectorAll('[data-sample]').forEach((b) =>
    b.classList.toggle('active', b.dataset.sample === id));
}

// ---------- 파생 광학량 ----------
function optics() {
  const apUm = SPEC.apertures[state.apertureIdx];
  const wd = focusWD();
  const alpha = convergenceAngle(apUm, wd);
  const mag = state.mag;
  const field = fieldWidthMm(mag);
  const dof = depthOfFieldMm(mag, alpha);
  const probeNm = probeDiameterNm({
    kV: state.kV, alphaRad: alpha,
    probeCurrentA: SPEC.probeCurrents[state.probeIdx],
    gentleBeam: state.gentleBeam,
  });
  return { apUm, wd, alpha, mag, field, dof, probeNm };
}

// ---------- 메인 루프 ----------
function frame(now) {
  const dt = clamp((now - lastT) / 1000, 0.001, 0.05);
  lastT = now;
  stage.tick(dt);

  const o = optics();
  const det = DETECTORS[state.detIdx];
  const scan = SPEC.scanModes[state.scanIdx];

  // 빔 시점 직교 VP (시야폭 = field, 4:3)
  const hw = o.field / 2, hh = (o.field * RES_H / RES_W) / 2;
  const vp = new Float32Array([
    1 / hw, 0, 0, 0,
    0, 0, -1 / 25, 0,
    0, -1 / hh, 0, 0,
    0, 0, -1, 1,
  ]);
  const model = stage.modelMatrix();

  // 노이즈: SNR = √N
  const eff = detectorEfficiency(det.id, o.wd);
  const N = electronsPerPixel({
    probeCurrentA: SPEC.probeCurrents[state.probeIdx],
    frameTime: scan.frameTime, pixels: RES_W * RES_H,
    yieldFactor: 0.35, efficiency: eff,
  });
  const noiseSigma = 1 / Math.sqrt(N);

  // 상호작용 부피(가장자리 효과 반경): R ≈ 1.5µm·(kV/15)^1.67
  const edgeUm = 1.5 * Math.pow(state.kV / 15, 1.67);
  const edgeRadiusPx = clamp(edgeUm * 1e-3 / o.field * RES_W, 1.2, 15);

  // 비점수차: 노브(스티그마)로 장비 잔류분을 상쇄
  const sx = state.stigX - state.stigPresetX;
  const sy = state.stigY - state.stigPresetY;
  const stigAmpMm = 0.03 * Math.hypot(sx, sy);
  const stigAngle = 0.5 * Math.atan2(sy, sx);

  const gbBoost = state.gentleBeam && state.kV <= 5;
  const probeNmEff = gbBoost ? o.probeNm * 0.4 : o.probeNm;
  const probePx = clamp(probeNmEff * 1e-6 / o.field * RES_W, 0, 30);

  const wasScanning = semR.scanY;
  semR.render({
    vpMatrix: vp, modelMatrix: model, normalMat: mat3FromMat4(model),
    mode: det.mode, kV: state.kV, fieldMm: o.field,
    focusWD: o.wd, alphaRad: o.alpha, probePx,
    stigAmpMm, stigAngle,
    noiseSigma, chargeAmp: state.charging ? clamp(state.kV / 12, 0.15, 1) * (gbBoost ? 0.25 : 1) : 0,
    frameTime: scan.frameTime, dt, time: now / 1000,
    brightness: state.brightness, contrast: state.contrast, gamma: state.gamma,
    edgeRadiusPx, microBoost: det.id === 'UED' ? 1.5 : (det.mode >= 2 ? 0.6 : 1.0),
    paused: state.paused,
  });
  // PHOTO 모드: 한 프레임 완주 시 자동 프리즈
  if (scan.id === 'photo' && !state.paused && semR.scanY < wasScanning) {
    state.paused = true;
    $('btnFreeze').classList.add('active');
    toast('PHOTO 스캔 완료 — 프레임 고정됨', false);
  }

  // 충돌 근접 판정 (시각화용)
  const s = Math.abs(Math.sin(stage.cur.t * DEG)), c = Math.cos(stage.cur.t * DEG);
  const ceiling = stage.rbeiInserted ? RBEI_BOTTOM : 0;
  const clearance = stage.cur.z - (STUB_RADIUS * s + stage.sampleHeightMm * c - ceiling);
  const risk = clearance < SAFETY_MARGIN + 0.45;

  chamR.render({ stage, focusWD: o.wd, dofMm: o.dof, collisionRisk: risk });

  updateReadouts(o, det, scan, N, clearance, risk);
  scheduleFrame();
}

// rAF + 타임아웃 워치독 이중 스케줄:
// 보이는 탭에선 rAF(주사율)로, 숨겨진/멈춘 탭에선 타임아웃으로 계속 진행
function scheduleFrame() {
  let fired = false;
  const run = () => {
    if (fired) return;
    fired = true;
    frame(performance.now());
  };
  requestAnimationFrame(run);
  setTimeout(run, 80);
}

// ---------- 판독/데이터바 ----------
function fmtLen(mm) {
  if (mm >= 1) return mm.toFixed(mm >= 10 ? 1 : 2) + ' mm';
  if (mm >= 1e-3) return (mm * 1e3).toFixed(mm >= 1e-2 ? 1 : 2) + ' µm';
  return (mm * 1e6).toFixed(1) + ' nm';
}

function updateReadouts(o, det, scan, N, clearance, risk) {
  $('dbKv').textContent = state.kV.toFixed(1) + ' kV';
  $('dbWd').textContent = 'WD ' + o.wd.toFixed(1) + 'mm';
  $('dbMag').textContent = '×' + (o.mag >= 1000 ? (o.mag / 1000).toFixed(o.mag >= 10000 ? 0 : 1) + 'k' : Math.round(o.mag));
  $('dbDet').textContent = det.id + (state.gentleBeam && state.kV <= 5 ? '·GB' : '');
  $('dbScan').textContent = scan.name;

  const sb = scaleBar(o.field);
  const canvasCss = $('semCanvas').clientWidth || 640;
  $('scalebarLine').style.width = Math.round(sb.lenMm / o.field * canvasCss) + 'px';
  $('scalebarLabel').textContent = sb.label;

  $('roAlpha').textContent = (o.alpha * 1000).toFixed(2) + ' mrad';
  $('roDof').textContent = fmtLen(o.dof);
  $('roProbe').textContent = o.probeNm.toFixed(1) + ' nm';
  $('roPixel').textContent = fmtLen(o.field / RES_W);
  const surfWD = stage.surfaceWDAtAxis();
  const defoc = surfWD - o.wd;
  $('roDefocus').textContent = (defoc >= 0 ? '+' : '') + fmtLen(Math.abs(defoc)).replace(/^/, '') + (Math.abs(defoc) < o.dof / 2 ? ' (초점 내)' : ' (초점 밖)');
  $('roDefocus').className = Math.abs(defoc) < o.dof / 2 ? 'ok' : 'bad';
  $('roSnr').textContent = Math.sqrt(N).toFixed(1);

  // 스테이지 현재값
  $('roStage').textContent =
    `X ${stage.cur.x.toFixed(2)} · Y ${stage.cur.y.toFixed(2)} · Z ${stage.cur.z.toFixed(2)}mm · T ${stage.cur.t.toFixed(1)}° · R ${stage.cur.r.toFixed(0)}°`;

  // 인터록/근접 상태
  const banner = $('interlockBanner');
  if (risk) {
    banner.textContent = `⚠ 충돌 근접: 여유 ${Math.max(clearance - SAFETY_MARGIN, 0).toFixed(2)}mm — ${stage.rbeiInserted ? 'RBEI 하단' : '폴피스'} 기준`;
    banner.className = 'banner warn';
  } else if (stage.rbeiInserted) {
    const tMax = stage.maxTiltFor(stage.tgt.z, true);
    banner.textContent = `RBEI 삽입됨 — 현재 WD에서 틸트 한계 ${tMax.toFixed(1)}°, 최소 WD ${stage.minZFor(stage.tgt.t, true).toFixed(1)}mm`;
    banner.className = 'banner info';
  } else {
    banner.textContent = '인터록 정상 — RBEI 인출 상태';
    banner.className = 'banner';
  }
  $('rbeiState').textContent = stage.rbeiInserted ? '삽입됨' : '인출됨';
  $('rbeiState').className = 'led ' + (stage.rbeiInserted ? 'on' : '');
}

// ---------- UI 배선 ----------
function bindSlider(id, get, set, fmt, outId) {
  const el = $(id), out = outId ? $(outId) : null;
  el.value = get();
  if (out) out.textContent = fmt(get());
  el.addEventListener('input', () => {
    set(parseFloat(el.value));
    if (out) out.textContent = fmt(get());
  });
  return el;
}

function initUI() {
  // 전자총
  bindSlider('kv', () => state.kV, (v) => { state.kV = v; }, (v) => v.toFixed(1) + ' kV', 'kvOut');
  const pcSel = $('probeCurrent');
  SPEC.probeCurrents.forEach((a, i) => {
    const op = document.createElement('option');
    op.value = i;
    op.textContent = a >= 1e-9 ? (a * 1e9).toFixed(a >= 1e-8 ? 0 : 1) + ' nA' : (a * 1e12).toFixed(0) + ' pA';
    if (i === state.probeIdx) op.selected = true;
    pcSel.appendChild(op);
  });
  pcSel.addEventListener('change', () => { state.probeIdx = +pcSel.value; });
  $('gb').addEventListener('change', (e) => {
    state.gentleBeam = e.target.checked;
    if (state.gentleBeam && state.kV > 5) toast('GENTLEBEAM은 저가속(≤5kV)에서 효과적입니다', false);
  });

  // 조리개
  document.querySelectorAll('[data-ap]').forEach((b, i) => {
    b.addEventListener('click', () => {
      state.apertureIdx = +b.dataset.ap;
      document.querySelectorAll('[data-ap]').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  // 배율 (로그 슬라이더)
  const magEl = $('mag');
  const magToSlider = (m) => Math.log(m / SPEC.magMin) / Math.log(SPEC.magMax / SPEC.magMin);
  const sliderToMag = (v) => SPEC.magMin * Math.pow(SPEC.magMax / SPEC.magMin, v);
  magEl.value = magToSlider(state.mag);
  magEl.addEventListener('input', () => {
    state.mag = Math.round(sliderToMag(parseFloat(magEl.value)));
    $('magOut').textContent = '×' + state.mag.toLocaleString();
  });
  $('magOut').textContent = '×' + state.mag.toLocaleString();
  document.querySelectorAll('[data-mag]').forEach((b) => b.addEventListener('click', () => {
    state.mag = +b.dataset.mag;
    magEl.value = magToSlider(state.mag);
    $('magOut').textContent = '×' + state.mag.toLocaleString();
  }));

  // 초점
  bindSlider('focusCoarse', () => state.focusCoarse, (v) => { state.focusCoarse = v; }, (v) => v.toFixed(1) + ' mm', 'focusCoarseOut');
  bindSlider('focusFine', () => state.focusFine, (v) => { state.focusFine = v; }, (v) => (v * 1000).toFixed(0) + ' µm', 'focusFineOut');
  $('btnAF').addEventListener('click', () => {
    state.focusCoarse = clamp(stage.surfaceWDAtAxis(), 0.5, 45);
    state.focusFine = 0;
    $('focusCoarse').value = state.focusCoarse;
    $('focusCoarseOut').textContent = state.focusCoarse.toFixed(1) + ' mm';
    $('focusFine').value = 0;
    $('focusFineOut').textContent = '0 µm';
    toast('오토포커스: 광축상 시료면에 초점 (WD ' + state.focusCoarse.toFixed(2) + 'mm)', false);
  });
  bindSlider('stigX', () => state.stigX, (v) => { state.stigX = v; }, (v) => v.toFixed(2), 'stigXOut');
  bindSlider('stigY', () => state.stigY, (v) => { state.stigY = v; }, (v) => v.toFixed(2), 'stigYOut');

  // 주사
  document.querySelectorAll('[data-scan]').forEach((b, i) => {
    b.addEventListener('click', () => {
      state.scanIdx = +b.dataset.scan;
      state.paused = false;
      $('btnFreeze').classList.remove('active');
      semR.resetScan();
      document.querySelectorAll('[data-scan]').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  $('btnFreeze').addEventListener('click', () => {
    state.paused = !state.paused;
    $('btnFreeze').classList.toggle('active', state.paused);
  });
  $('btnSave').addEventListener('click', () => {
    const a = document.createElement('a');
    const o = optics();
    a.download = `SEM_${state.sampleId}_x${state.mag}_${state.kV.toFixed(1)}kV_WD${o.wd.toFixed(1)}.png`;
    a.href = $('semCanvas').toDataURL('image/png');
    a.click();
    toast('이미지 저장됨 (' + a.download + ')', false);
  });
  $('btnACB').addEventListener('click', () => {
    const st = semR.sampleStats();
    if (!st || st.std < 1e-4) { toast('ACB: 신호 통계를 읽을 수 없습니다', true); return; }
    state.contrast = clamp(0.18 / st.std, 0.2, 8);
    state.brightness = clamp(-(st.mean - 0.5) * state.contrast, -1, 1);
    $('contrast').value = state.contrast;
    $('brightness').value = state.brightness;
    toast('자동 밝기/명암 적용', false);
  });
  bindSlider('brightness', () => state.brightness, (v) => { state.brightness = v; }, (v) => v.toFixed(2));
  bindSlider('contrast', () => state.contrast, (v) => { state.contrast = v; }, (v) => v.toFixed(2));
  bindSlider('gamma', () => state.gamma, (v) => { state.gamma = v; }, (v) => v.toFixed(2));

  // 검출기
  const detBox = $('detectors');
  DETECTORS.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'btn det' + (i === 0 ? ' active' : '');
    b.textContent = d.name;
    b.addEventListener('click', () => {
      if (d.needsRBEI && !stage.rbeiInserted) {
        toast('BSE 모드는 RBEI 검출기 삽입이 필요합니다 (검출기 패널에서 삽입)');
        return;
      }
      state.detIdx = i;
      semR.resetScan();
      detBox.querySelectorAll('button').forEach((x, j) => x.classList.toggle('active', j === i));
    });
    detBox.appendChild(b);
  });
  $('btnRBEI').addEventListener('click', () => {
    if (stage.rbeiInserted) {
      stage.requestRBEI(false);
      if (DETECTORS[state.detIdx].needsRBEI) {
        state.detIdx = 0;
        detBox.querySelectorAll('button').forEach((x, j) => x.classList.toggle('active', j === 0));
        toast('RBEI 인출 → 검출기를 SEI(LED)로 전환했습니다', false);
      }
    } else {
      const err = stage.requestRBEI(true);
      if (err) toast(err);
      else toast('RBEI 삽입 중 — 틸트·WD 인터록이 활성화됩니다', false);
    }
    $('btnRBEI').textContent = stage.rbeiInserted ? 'RBEI 인출' : 'RBEI 삽입';
  });

  // 스테이지
  const axes = [
    ['stX', 'x', (v) => v.toFixed(1) + 'mm'],
    ['stY', 'y', (v) => v.toFixed(1) + 'mm'],
    ['stZ', 'z', (v) => v.toFixed(1) + 'mm'],
    ['stT', 't', (v) => v.toFixed(1) + '°'],
    ['stR', 'r', (v) => v.toFixed(0) + '°'],
  ];
  for (const [id, axis, fmt] of axes) {
    const el = $(id), out = $(id + 'Out');
    el.value = stage.tgt[axis];
    out.textContent = fmt(stage.tgt[axis]);
    el.addEventListener('input', () => {
      const err = stage.request(axis, parseFloat(el.value));
      el.value = stage.tgt[axis]; // 인터록 클램프 반영
      out.textContent = fmt(stage.tgt[axis]);
      if (err) toast(err);
    });
  }
  $('btnHome').addEventListener('click', () => {
    for (const [axis, v] of [['t', 0], ['x', 0], ['y', 0], ['r', 0], ['z', 10]]) stage.request(axis, v);
    ['stX', 'stY', 'stZ', 'stT', 'stR'].forEach((id, i) => {
      const a = ['x', 'y', 'z', 't', 'r'][i];
      $(id).value = stage.tgt[a];
    });
    toast('스테이지 원점 복귀 (교환 위치)', false);
  });

  // 시료
  document.querySelectorAll('[data-sample]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.sample === state.sampleId) return;
      $('sampleDesc').textContent = '시료 교체 중...';
      setTimeout(() => { loadSample(b.dataset.sample); semR.resetScan(); }, 30);
    });
  });
  $('charging').addEventListener('change', (e) => {
    state.charging = e.target.checked;
    if (state.charging) toast('비전도성(미코팅) 시료 — 차징 아티팩트 발생. 저kV 또는 GB로 완화하세요', false);
  });

  // 키보드
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const step = { x: 0.5, y: 0.5, z: 0.5, t: 1, r: 5 };
    const map = {
      ArrowLeft: ['x', -1], ArrowRight: ['x', 1],
      ArrowUp: ['y', 1], ArrowDown: ['y', -1],
      PageUp: ['z', 1], PageDown: ['z', -1],
      t: ['t', 1], g: ['t', -1],
    };
    const m = map[e.key];
    if (!m) return;
    e.preventDefault();
    const err = stage.request(m[0], stage.tgt[m[0]] + step[m[0]] * m[1]);
    const idMap = { x: 'stX', y: 'stY', z: 'stZ', t: 'stT', r: 'stR' };
    $(idMap[m[0]]).value = stage.tgt[m[0]];
    if (err) toast(err);
  });
}

// ---------- 부트스트랩 ----------
function main() {
  const semCanvas = $('semCanvas');
  semCanvas.width = RES_W; semCanvas.height = RES_H;
  try {
    gl = createGL(semCanvas);
    if (!gl.__hasFloatBuffer) throw new Error('EXT_color_buffer_float 미지원 GPU/브라우저입니다.');
    semR = new SEMRenderer(gl);
    const cc = $('chamberCanvas');
    cc.width = cc.clientWidth * (window.devicePixelRatio || 1);
    cc.height = cc.clientHeight * (window.devicePixelRatio || 1);
    chamR = new ChamberRenderer(cc);
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#fff"><h2>초기화 실패</h2><p>${e.message}</p><p>최신 Chrome/Edge/Firefox에서 실행해 주세요.</p></div>`;
    throw e;
  }
  initUI();
  loadSample('snballs');
  // 디버그/테스트 훅
  window.__sem = { state, stage, get semR() { return semR; }, focusWD, optics };
  lastT = performance.now();
  scheduleFrame();
}

main();
