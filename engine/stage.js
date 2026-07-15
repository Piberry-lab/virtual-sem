// ============================================================
// stage.js — 5축 유센트릭 스테이지 운동학 + RBEI 충돌 인터록
//
// 좌표계: 폴피스 하단면 y=0, 빔은 -y 방향. 단위 mm.
// 시료 표면 기준점(유센트릭 포인트)은 y = -Z 에 위치.
// 모델행렬: M = T(0,-Z,0) · RotX(T) · T(X,0,Y) · RotY(R)
//  → 틸트축(월드 X축)이 시료 표면 높이를 지나는 완전 유센트릭 구조.
//    (X/Y 이동은 틸트된 평면을 따라감 — 실기와 동일하게 틸트 상태에서
//     Y 이동 시 초점이 어긋나는 현상이 재현됨)
//
// RBEI(인입식 반사전자 검출기): 삽입 시 폴피스 직하 y∈[-2.3,-0.7],
// 반경 8.5mm 도넛판. JEOL glossary: WD<3mm에서 시료와 겹침 → 인입 필수.
// 틸트 시 스텁 가장자리(반경 rs)가 rs·sin|T| 만큼 상승 → 허용 WD 증가.
// ============================================================

import { SPEC } from './physics.js';
import { mat4Chain, mat4Translate, mat4RotX, mat4RotY, DEG, clamp } from './math.js';

export const STUB_RADIUS = 6.1;      // mm (Ø12.2 스텁)
export const RBEI_BOTTOM = -2.3;     // 삽입 시 검출기 하단 y
export const RBEI_THICKNESS = 1.6;
export const SAFETY_MARGIN = 0.5;    // mm
export const POLE_BOTTOM = 0;

export class Stage {
  constructor() {
    // 현재값과 목표값 분리 → 모터 구동 느낌 (지수 접근 + 속도 제한)
    this.cur = { x: 0, y: 0, z: 10, t: 0, r: 0 };
    this.tgt = { x: 0, y: 0, z: 10, t: 0, r: 0 };
    this.rbeiInserted = false;
    this.rbeiPos = 0;          // 0=인출, 1=삽입 (애니메이션)
    this.sampleHeightMm = 0.3; // 시료 피처 최대 높이 (시료 교체 시 갱신)
    this.lastBlock = null;     // 마지막 인터록 사유 (UI 표시용)
  }

  // 시료 최고점의 y — 틸트로 상승하는 스텁 가장자리 + 피처 높이
  highestPointY(z, tDeg) {
    const s = Math.abs(Math.sin(tDeg * DEG));
    const c = Math.cos(tDeg * DEG);
    return -z + STUB_RADIUS * s + this.sampleHeightMm * c;
  }

  // 주어진 틸트에서 허용되는 최소 Z(WD)
  minZFor(tDeg, rbei) {
    const s = Math.abs(Math.sin(tDeg * DEG));
    const c = Math.cos(tDeg * DEG);
    const ceiling = rbei ? RBEI_BOTTOM : POLE_BOTTOM; // 장애물 하단
    // -z + rs·s + h·c <= ceiling - margin  →  z >= rs·s + h·c - ceiling + margin
    return STUB_RADIUS * s + this.sampleHeightMm * c - ceiling + SAFETY_MARGIN;
  }

  // 주어진 Z에서 허용되는 최대 틸트 (수치 탐색)
  maxTiltFor(z, rbei) {
    let lo = 0, hi = SPEC.stage.tMax;
    if (this.minZFor(hi, rbei) <= z) return hi;
    if (this.minZFor(lo, rbei) > z) return -1; // 0°조차 불가 (WD가 너무 짧음)
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.minZFor(mid, rbei) <= z) lo = mid; else hi = mid;
    }
    return lo;
  }

  // 목표값 요청 — 인터록으로 클램프, 사유 반환
  request(axis, value) {
    const S = SPEC.stage;
    this.lastBlock = null;
    if (axis === 'x') this.tgt.x = clamp(value, S.xMin, S.xMax);
    if (axis === 'y') this.tgt.y = clamp(value, S.yMin, S.yMax);
    if (axis === 'r') this.tgt.r = ((value % 360) + 360) % 360;
    if (axis === 'z') {
      const zMin = Math.max(S.zMin, this.minZFor(this.tgt.t, this.rbeiInserted));
      const v = clamp(value, S.zMin, S.zMax);
      if (v < zMin) {
        this.tgt.z = zMin;
        this.lastBlock = this.rbeiInserted
          ? `충돌 인터록: RBEI 삽입 상태에서 현재 틸트 기준 WD ≥ ${zMin.toFixed(1)}mm`
          : `충돌 인터록: 폴피스 접촉 방지, WD ≥ ${zMin.toFixed(1)}mm`;
      } else this.tgt.z = v;
    }
    if (axis === 't') {
      const v = clamp(value, S.tMin, S.tMax);
      const tMax = this.maxTiltFor(this.tgt.z, this.rbeiInserted);
      if (v > tMax) {
        this.tgt.t = Math.max(tMax, S.tMin);
        this.lastBlock = this.rbeiInserted
          ? `충돌 인터록: RBEI 삽입 중 → 틸트 ≤ ${tMax.toFixed(1)}° (인출하거나 WD를 늘리세요)`
          : `충돌 인터록: 현재 WD에서 틸트 ≤ ${tMax.toFixed(1)}° (WD를 늘리세요)`;
      } else this.tgt.t = v;
    }
    return this.lastBlock;
  }

  // RBEI 삽입 시도 — 현재 자세에서 안전해야만 허용 (실기 동작)
  requestRBEI(insert) {
    this.lastBlock = null;
    if (!insert) { this.rbeiInserted = false; return null; }
    const zNeed = this.minZFor(this.tgt.t, true);
    if (this.tgt.z < zNeed) {
      this.lastBlock = `RBEI 삽입 불가: WD ${this.tgt.z.toFixed(1)}mm < 필요 ${zNeed.toFixed(1)}mm — WD·틸트를 조정하세요`;
      return this.lastBlock;
    }
    this.rbeiInserted = true;
    return null;
  }

  // 프레임 틱: 모터 구동 시뮬레이션
  tick(dt) {
    const speeds = { x: 12, y: 12, z: 6, t: 25, r: 90 }; // mm/s, deg/s
    for (const k of ['x', 'y', 'z', 't']) {
      const d = this.tgt[k] - this.cur[k];
      const maxStep = speeds[k] * dt;
      this.cur[k] += clamp(d, -maxStep, maxStep);
    }
    // 회전: 최단 경로
    let dr = ((this.tgt.r - this.cur.r + 540) % 360) - 180;
    this.cur.r += clamp(dr, -speeds.r * dt, speeds.r * dt);
    this.cur.r = ((this.cur.r % 360) + 360) % 360;
    // RBEI 슬라이드 애니메이션
    const rbeiTgt = this.rbeiInserted ? 1 : 0;
    this.rbeiPos += clamp(rbeiTgt - this.rbeiPos, -dt * 1.2, dt * 1.2);
  }

  isMoving() {
    const e = 1e-3;
    return Math.abs(this.tgt.x - this.cur.x) > e || Math.abs(this.tgt.y - this.cur.y) > e ||
      Math.abs(this.tgt.z - this.cur.z) > e || Math.abs(this.tgt.t - this.cur.t) > e ||
      Math.abs(((this.tgt.r - this.cur.r + 540) % 360) - 180) > e ||
      Math.abs((this.rbeiInserted ? 1 : 0) - this.rbeiPos) > e;
  }

  // 시료 모델행렬 (mm)
  modelMatrix() {
    const { x, y, z, t, r } = this.cur;
    return mat4Chain(
      mat4Translate(0, -z, 0),
      mat4RotX(t * DEG),
      mat4Translate(x, 0, y),
      mat4RotY(r * DEG),
    );
  }

  // 광축(x=0,z=0 수직선)이 시료 기준면(local y=0)과 만나는 깊이 → 오토포커스용
  // 평면: 점 P0 = M·(0,0,0) = (0,-Z,0)+회전항, 법선 n = RotX(T)·(0,1,0)
  surfaceWDAtAxis() {
    const { x, y, z, t } = this.cur;
    const ct = Math.cos(t * DEG), st = Math.sin(t * DEG);
    // P0 = T(0,-z,0)·RotX(T)·(x,0,y) ; RotX: (px, -st·pz ... ) 계산:
    // RotX(T)·(x,0,y) = (x, -st·y? ) — RotX 정의: y' = c·y - s·z, z' = s·y + c·z
    // (x, 0, y) → (x, -st·y, ct·y)  [z성분이 y(스테이지 Y)임에 주의]
    const P0 = [x, -z - st * y, ct * y];
    const n = [0, ct, st]; // RotX(T)·(0,1,0) = (0, c, s)... (0,1,0)→(0, c, s)
    // 광축 상 점 (0, yy, 0): n·((0,yy,0) - P0) = 0 → yy = P0.y + (n.z·P0.z)/n.y... 전개:
    // n.x(0-P0x) + n.y(yy-P0y) + n.z(0-P0z) = 0
    const yy = P0[1] + (n[0] * P0[0] + n[2] * P0[2]) / Math.max(n[1], 1e-4);
    return -yy; // WD (mm)
  }
}
