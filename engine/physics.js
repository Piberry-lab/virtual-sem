// ============================================================
// physics.js — SEM 물리 모델 (JS측 계산 + 셰이더와 공유하는 상수)
//
// 근거 (2026-07 웹 리서치, README 참조):
//  - DOF = 2r/α, r = 0.1mm/M  →  DOF = 0.2mm/(M·α)   [Semitracks 표 검증]
//  - α = R_aperture / WD                              [소각 근사]
//  - SE:  δ(θ) = δ0·sec(θ)^n (n≈0.85), 가장자리 효과   [JEOL glossary]
//  - BSE: Reuter(1972) η(Z), 틸트 η(φ)=0.89(η0/0.89)^cosφ
//  - 노이즈: N = (Ip·t/e)·yield·ε, SNR = √N            [Rose criterion]
// ============================================================

export const E_CHARGE = 1.602e-19; // C

// JSM-7610F 사양 (JEOL 카탈로그 No.1502H323C)
export const SPEC = {
  kvMin: 0.1, kvMax: 30,
  magMin: 25, magMax: 1_000_000,
  // 표준 스테이지 Type IA2: X70 × Y50, Z(WD) 1.0–40, T −5…+70°, R 360°
  stage: {
    xMin: -35, xMax: 35,
    yMin: -25, yMax: 25,
    zMin: 1.0, zMax: 40.0,
    tMin: -5, tMax: 70,
  },
  // 대물 조리개 (µm 직경, JEOL 계열 상용값)
  apertures: [30, 50, 70, 100],
  probeCurrents: [1e-12, 1e-11, 8.6e-11, 5e-10, 1e-9, 5e-9, 2e-8, 1e-7, 2e-7], // A
  // 스캔 속도: 한 프레임 주사 시간(초) — TV / SLOW1 / SLOW2 / PHOTO
  scanModes: [
    { id: 'tv',    name: 'TV',    frameTime: 1 / 25 },
    { id: 'slow1', name: 'SLOW1', frameTime: 2.0 },
    { id: 'slow2', name: 'SLOW2', frameTime: 8.0 },
    { id: 'photo', name: 'PHOTO', frameTime: 25.0 },
  ],
  // 배율 기준 폭 (표시 배율 = 기준폭 / 시야폭, 전통적 128mm 폴라로이드 기준)
  refWidthMm: 128,
};

// 검출기 정의
export const DETECTORS = [
  { id: 'LED',        name: 'SEI (LED, 하부 E-T)', needsRBEI: false, mode: 0 },
  { id: 'UED',        name: 'SEI (UED, 상부 In-lens)', needsRBEI: false, mode: 1 },
  { id: 'BSE_COMPO',  name: 'BSE COMPO (조성)', needsRBEI: true,  mode: 2 },
  { id: 'BSE_TOPO',   name: 'BSE TOPO (지형)',  needsRBEI: true,  mode: 3 },
  { id: 'BSE_SHADOW', name: 'BSE SHADOW (음영)', needsRBEI: true, mode: 4 },
];

// Reuter(1972) BSE 계수 — 금속, 10–100 keV
export function bseYield(Z) {
  return -0.0254 + 0.016 * Z - 1.86e-4 * Z * Z + 8.3e-7 * Z * Z * Z;
}

// 전자 파장 [nm] (비상대론, V in volts)
export function electronWavelengthNm(V) {
  return 1.226 / Math.sqrt(Math.max(V, 1));
}

// 빔 수렴 반각 α [rad]
export function convergenceAngle(apertureDiaUm, wdMm) {
  const rMm = (apertureDiaUm / 2) * 1e-3;
  return rMm / Math.max(wdMm, 0.5);
}

// 초점심도 [mm] — DOF = 0.2mm / (M·α)
export function depthOfFieldMm(mag, alphaRad) {
  return 0.2 / (Math.max(mag, 1) * Math.max(alphaRad, 1e-5));
}

// 프로브 직경 [nm] — 기하/회절/구면/색수차 제곱합
// Cs, Cc: semi-in-lens 대물렌즈 대표값. dE: Schottky FEG ~0.6eV
export function probeDiameterNm({ kV, alphaRad, probeCurrentA, gentleBeam }) {
  const V = Math.max(kV * 1000, 50);
  const lambda = electronWavelengthNm(V);
  const Cs = 2.0e6, Cc = 2.0e6; // nm (≈2 mm)
  const dE = 0.6;
  // 기하항: 전류 증가 → 소스 축소율 완화 (I^0.5 근사), 기준 86pA에서 1nm@15kV
  const dg = 1.0 * Math.sqrt(probeCurrentA / 8.6e-11) * Math.pow(15 / Math.max(kV, 0.1), 0.35);
  const dd = 1.22 * lambda / Math.max(alphaRad, 1e-5);
  const ds = 0.5 * Cs * Math.pow(alphaRad, 3);
  let dc = Cc * alphaRad * (dE / V);
  if (gentleBeam && kV <= 5) dc *= 0.45; // GB: 저가속 색수차 완화(감속장 효과)
  return Math.sqrt(dg * dg + dd * dd + ds * ds + dc * dc);
}

// 검출기 수집효율 ε (WD 의존)
export function detectorEfficiency(detId, wdMm) {
  switch (detId) {
    case 'LED': // 챔버 측면 E-T: 짧은 WD에서 렌즈 자기장이 SE를 빨아올려 효율 저하
      return 0.35 + 0.65 * smoothstep(2, 8, wdMm);
    case 'UED': // in-lens: 짧은 WD에서 최적
      return 1.0 - 0.55 * smoothstep(6, 20, wdMm);
    default: // 환형 BSE: 폴피스 직하라 거의 일정
      return 0.9;
  }
}

// 픽셀당 신호 전자 수 N (SNR = √N)
export function electronsPerPixel({ probeCurrentA, frameTime, pixels, yieldFactor, efficiency }) {
  const dwell = frameTime / pixels;
  const n = (probeCurrentA / E_CHARGE) * dwell;
  return Math.max(n * yieldFactor * efficiency, 0.01);
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 시야폭 [mm]
export function fieldWidthMm(mag) {
  return SPEC.refWidthMm / Math.max(mag, 1);
}

// 스케일바: 시야폭에 맞는 1-2-5 단위 선택 → {lenMm, label}
export function scaleBar(fieldMm) {
  const targetMm = fieldMm * 0.22;
  const units = [
    { f: 1e-6, s: 'nm' },
    { f: 1e-3, s: 'µm' },
    { f: 1, s: 'mm' },
  ];
  let best = null;
  for (const u of units) {
    for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
      const len = m * u.f;
      if (!best || Math.abs(Math.log(len / targetMm)) < Math.abs(Math.log(best.lenMm / targetMm))) {
        best = { lenMm: len, label: `${m} ${u.s}` };
      }
    }
  }
  return best;
}
