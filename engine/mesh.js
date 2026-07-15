// ============================================================
// mesh.js — 시료/챔버 지오메트리 생성 (단위: mm, y-up)
// 시료 표면 기준 y=0 (스텁 상면). 미세구조는 µm 스케일(mm로 환산).
// extras = [평균 원자번호 Z, 미세 거칠기 계수]
// ============================================================

import { mulberry32, vNorm, vCross, vSub, transformPoint, transformDir } from './math.js';

const UM = 0.001; // 1 µm = 0.001 mm

// ---------- 기본 빌더 ----------

function emptyMesh() {
  return { positions: [], normals: [], extras: [], colors: [], indices: [] };
}

function finalizeMesh(m) {
  return {
    positions: new Float32Array(m.positions),
    normals: new Float32Array(m.normals),
    extras: m.extras.length ? new Float32Array(m.extras) : null,
    colors: m.colors.length ? new Float32Array(m.colors) : null,
    indices: new Uint32Array(m.indices),
  };
}

export function mergeMeshes(list) {
  const out = emptyMesh();
  let base = 0;
  for (const mesh of list) {
    out.positions.push(...mesh.positions);
    out.normals.push(...mesh.normals);
    const nVerts = mesh.positions.length / 3;
    if (mesh.extras) out.extras.push(...mesh.extras);
    else for (let i = 0; i < nVerts; i++) out.extras.push(6, 1);
    if (mesh.colors) out.colors.push(...mesh.colors);
    else for (let i = 0; i < nVerts; i++) out.colors.push(0.7, 0.7, 0.7);
    for (const idx of mesh.indices) out.indices.push(idx + base);
    base += nVerts;
  }
  return finalizeMesh(out);
}

export function transformMesh(mesh, mat) {
  const p = mesh.positions, n = mesh.normals;
  for (let i = 0; i < p.length; i += 3) {
    const tp = transformPoint(mat, [p[i], p[i+1], p[i+2]]);
    p[i] = tp[0]; p[i+1] = tp[1]; p[i+2] = tp[2];
    const tn = vNorm(transformDir(mat, [n[i], n[i+1], n[i+2]]));
    n[i] = tn[0]; n[i+1] = tn[1]; n[i+2] = tn[2];
  }
  return mesh;
}

export function setExtras(mesh, Z, rough) {
  const nVerts = mesh.positions.length / 3;
  const ex = new Float32Array(nVerts * 2);
  for (let i = 0; i < nVerts; i++) { ex[i*2] = Z; ex[i*2+1] = rough; }
  mesh.extras = ex;
  return mesh;
}

export function setColor(mesh, r, g, b) {
  const nVerts = mesh.positions.length / 3;
  const c = new Float32Array(nVerts * 3);
  for (let i = 0; i < nVerts; i++) { c[i*3] = r; c[i*3+1] = g; c[i*3+2] = b; }
  mesh.colors = c;
  return mesh;
}

// ---------- 프리미티브 ----------

// 높이맵 그리드: fn(x,z)->y, extrasFn(x,z,y)->[Z,rough]
export function makeHeightfield(sizeX, sizeZ, seg, fn, extrasFn) {
  const positions = new Float32Array((seg + 1) * (seg + 1) * 3);
  const normals = new Float32Array((seg + 1) * (seg + 1) * 3);
  const extras = new Float32Array((seg + 1) * (seg + 1) * 2);
  const indices = new Uint32Array(seg * seg * 6);
  const dx = sizeX / seg, dz = sizeZ / seg;
  const heights = new Float32Array((seg + 1) * (seg + 1));

  for (let iz = 0; iz <= seg; iz++) {
    for (let ix = 0; ix <= seg; ix++) {
      const x = -sizeX / 2 + ix * dx;
      const z = -sizeZ / 2 + iz * dz;
      const y = fn(x, z);
      const vi = iz * (seg + 1) + ix;
      heights[vi] = y;
      positions[vi*3] = x; positions[vi*3+1] = y; positions[vi*3+2] = z;
      const ex = extrasFn ? extrasFn(x, z, y) : [6, 1];
      extras[vi*2] = ex[0]; extras[vi*2+1] = ex[1];
    }
  }
  // 법선: 중앙차분
  for (let iz = 0; iz <= seg; iz++) {
    for (let ix = 0; ix <= seg; ix++) {
      const vi = iz * (seg + 1) + ix;
      const hL = heights[iz * (seg + 1) + Math.max(0, ix - 1)];
      const hR = heights[iz * (seg + 1) + Math.min(seg, ix + 1)];
      const hD = heights[Math.max(0, iz - 1) * (seg + 1) + ix];
      const hU = heights[Math.min(seg, iz + 1) * (seg + 1) + ix];
      const n = vNorm([-(hR - hL) / (2 * dx), 1, -(hU - hD) / (2 * dz)]);
      normals[vi*3] = n[0]; normals[vi*3+1] = n[1]; normals[vi*3+2] = n[2];
    }
  }
  let t = 0;
  for (let iz = 0; iz < seg; iz++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iz * (seg + 1) + ix, b = a + 1, c = a + seg + 1, d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }
  return { positions, normals, extras, colors: null, indices };
}

export function makeUVSphere(r, latSeg, lonSeg) {
  const m = emptyMesh();
  for (let la = 0; la <= latSeg; la++) {
    const th = (la / latSeg) * Math.PI;
    for (let lo = 0; lo <= lonSeg; lo++) {
      const ph = (lo / lonSeg) * 2 * Math.PI;
      const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
      m.positions.push(r * nx, r * ny, r * nz);
      m.normals.push(nx, ny, nz);
    }
  }
  for (let la = 0; la < latSeg; la++) {
    for (let lo = 0; lo < lonSeg; lo++) {
      const a = la * (lonSeg + 1) + lo, b = a + 1, c = a + lonSeg + 1, d = c + 1;
      m.indices.push(a, b, c, b, d, c);
    }
  }
  return finalizeMesh(m);
}

// 원기둥/원뿔대: y ∈ [0, h]
export function makeCylinder(rBot, rTop, h, seg, capped = true) {
  const m = emptyMesh();
  const slope = (rBot - rTop) / h;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * 2 * Math.PI;
    const cx = Math.cos(a), sz = Math.sin(a);
    const n = vNorm([cx, slope, sz]);
    m.positions.push(rBot * cx, 0, rBot * sz);
    m.normals.push(...n);
    m.positions.push(rTop * cx, h, rTop * sz);
    m.normals.push(...n);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    m.indices.push(a, c, b, b, c, d);
  }
  if (capped) {
    for (const [yy, rr, ny] of [[0, rBot, -1], [h, rTop, 1]]) {
      const center = m.positions.length / 3;
      m.positions.push(0, yy, 0); m.normals.push(0, ny, 0);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * 2 * Math.PI;
        m.positions.push(rr * Math.cos(a), yy, rr * Math.sin(a));
        m.normals.push(0, ny, 0);
      }
      for (let i = 0; i < seg; i++) {
        if (ny > 0) m.indices.push(center, center + 1 + i, center + 2 + i);
        else m.indices.push(center, center + 2 + i, center + 1 + i);
      }
    }
  }
  return finalizeMesh(m);
}

export function makeBox(sx, sy, sz) {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const faces = [
    [[ 1,0,0], [[x,-y,-z],[x,y,-z],[x,y,z],[x,-y,z]]],
    [[-1,0,0], [[-x,-y,z],[-x,y,z],[-x,y,-z],[-x,-y,-z]]],
    [[0, 1,0], [[-x,y,-z],[-x,y,z],[x,y,z],[x,y,-z]]],
    [[0,-1,0], [[-x,-y,z],[-x,-y,-z],[x,-y,-z],[x,-y,z]]],
    [[0,0, 1], [[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]]],
    [[0,0,-1], [[x,-y,-z],[-x,-y,-z],[-x,y,-z],[x,y,-z]]],
  ];
  const m = emptyMesh();
  for (const [n, verts] of faces) {
    const base = m.positions.length / 3;
    for (const v of verts) { m.positions.push(...v); m.normals.push(...n); }
    m.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return finalizeMesh(m);
}

// 속이 뚫린 판 (RBEI 검출기 등): y ∈ [0, h]
export function makeAnnulus(rIn, rOut, h, seg) {
  const m = emptyMesh();
  const ring = (r, y, ny) => {
    const base = m.positions.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * 2 * Math.PI;
      m.positions.push(r * Math.cos(a), y, r * Math.sin(a));
      m.normals.push(0, ny, 0);
    }
    return base;
  };
  // 상/하면
  for (const [y, ny] of [[h, 1], [0, -1]]) {
    const bi = ring(rIn, y, ny), bo = ring(rOut, y, ny);
    for (let i = 0; i < seg; i++) {
      if (ny > 0) m.indices.push(bi + i, bo + i, bi + i + 1, bi + i + 1, bo + i, bo + i + 1);
      else m.indices.push(bi + i, bi + i + 1, bo + i, bi + i + 1, bo + i + 1, bo + i);
    }
  }
  // 외벽/내벽
  for (const [r, sign] of [[rOut, 1], [rIn, -1]]) {
    const base = m.positions.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * 2 * Math.PI;
      const cx = Math.cos(a), sz = Math.sin(a);
      m.positions.push(r * cx, 0, r * sz); m.normals.push(sign * cx, 0, sign * sz);
      m.positions.push(r * cx, h, r * sz); m.normals.push(sign * cx, 0, sign * sz);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (sign > 0) m.indices.push(a, c, b, b, c, d);
      else m.indices.push(a, b, c, b, d, c);
    }
  }
  return finalizeMesh(m);
}

// ---------- 노이즈 (시료 생성용) ----------

function makeValueNoise2D(seed, gridN = 64) {
  const rng = mulberry32(seed);
  const g = new Float32Array(gridN * gridN);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const at = (ix, iz) => g[((iz % gridN + gridN) % gridN) * gridN + ((ix % gridN + gridN) % gridN)];
  return (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const v00 = at(ix, iz), v10 = at(ix + 1, iz), v01 = at(ix, iz + 1), v11 = at(ix + 1, iz + 1);
    return (v00 * (1 - sx) + v10 * sx) * (1 - sz) + (v01 * (1 - sx) + v11 * sx) * sz;
  };
}

function fbm(noise, x, z, octaves = 5, lac = 2.1, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, z * freq);
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

// ---------- 시료 정의 ----------
// 각 시료: 3mm × 3mm 영역, 스텁(Ø12.2mm Al) 위에 배치
// 반환: { mesh(시그널용 extras 포함), name, desc, heightRange }

function makeStubBase(topZ = 6, rough = 1) {
  // 카본 테이프가 붙은 스텁 상면 (y=0 평면, 살짝 아래로)
  const hf = makeHeightfield(6, 6, 64, () => -0.5 * UM, () => [topZ, rough]);
  return hf;
}

export function makeSampleParticles() {
  // 다물질 입자: BSE COMPO 조성 대비 데모
  const rng = mulberry32(20260715);
  const parts = [makeStubBase(6, 0.8)];
  const mats = [
    { Z: 13, r: [30, 70] },   // Al
    { Z: 26, r: [25, 60] },   // Fe
    { Z: 29, r: [25, 55] },   // Cu
    { Z: 50, r: [20, 50] },   // Sn
    { Z: 74, r: [15, 45] },   // W
    { Z: 79, r: [15, 40] },   // Au
  ];
  for (let i = 0; i < 90; i++) {
    const mat = mats[Math.floor(rng() * mats.length)];
    const r = (mat.r[0] + rng() * (mat.r[1] - mat.r[0])) * UM;
    const x = (rng() - 0.5) * 2.6, z = (rng() - 0.5) * 2.6;
    const sink = r * (0.25 + rng() * 0.35); // 일부 매몰
    const seg = Math.min(32, Math.max(12, Math.round(r / UM / 2.5)));
    const sp = makeUVSphere(r, seg, Math.round(seg * 1.3));
    setExtras(sp, mat.Z, 0.5 + rng() * 0.8);
    const mat4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x, r - sink, z, 1]);
    parts.push(transformMesh(sp, mat4));
  }
  return {
    id: 'particles', name: '다물질 입자 (Al·Fe·Cu·Sn·W·Au)',
    desc: 'BSE COMPO에서 원자번호(Z) 대비 관찰. 무거운 원소일수록 밝음.',
    mesh: mergeMeshes(parts), heightRangeUm: 140,
  };
}

export function makeSampleSnBalls() {
  // Sn on C: 전통적 SEM 분해능/비점 시험 시료 — 다양한 크기의 주석 구
  const rng = mulberry32(77);
  const parts = [makeStubBase(6, 0.6)];
  // 큰 볼 주변에 미세 볼 군집 (프랙탈처럼 크기 분포)
  const placeBall = (x, z, r) => {
    // 큰 볼일수록 촘촘히 분할 (파셋 방지)
    const seg = Math.min(40, Math.max(10, Math.round(r / UM / 2.2)));
    const sp = makeUVSphere(r, seg, Math.round(seg * 1.3));
    setExtras(sp, 50, 0.12); // Sn 볼 표면은 매끈
    parts.push(transformMesh(sp, new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x, r * 0.7, z, 1])));
  };
  for (let i = 0; i < 40; i++) {
    const x = (rng() - 0.5) * 2.7, z = (rng() - 0.5) * 2.7;
    const r = (8 + rng() * 90) * UM;
    placeBall(x, z, r);
    const nSat = Math.floor(rng() * 8);
    for (let s = 0; s < nSat; s++) {
      const a = rng() * Math.PI * 2;
      const d = r * (1.3 + rng() * 2.0);
      placeBall(x + Math.cos(a) * d, z + Math.sin(a) * d, r * (0.1 + rng() * 0.3));
    }
  }
  return {
    id: 'snballs', name: 'Sn 볼 on Carbon (표준 시험시료)',
    desc: '초점·비점수차 조정 연습용 표준 시료. 구형 입자의 가장자리 효과 관찰.',
    mesh: mergeMeshes(parts), heightRangeUm: 130,
  };
}

export function makeSamplePillars() {
  // Si 마이크로필러 어레이: DOF(초점심도) 데모의 정석
  const pitch = 100 * UM, w = 42 * UM, h = 65 * UM;
  const hf = makeHeightfield(3, 3, 640, (x, z) => {
    const lx = ((x % pitch) + pitch) % pitch - pitch / 2;
    const lz = ((z % pitch) + pitch) % pitch - pitch / 2;
    const inPillar = Math.abs(lx) < w / 2 && Math.abs(lz) < w / 2;
    // 모서리 살짝 둥글게
    if (!inPillar) return 0;
    const ex = 1 - Math.pow(Math.abs(lx) / (w / 2), 8);
    const ez = 1 - Math.pow(Math.abs(lz) / (w / 2), 8);
    return h * Math.min(1, ex * ez * 4);
  }, () => [14, 0.35]);
  return {
    id: 'pillars', name: 'Si 마이크로필러 어레이 (100µm 피치)',
    desc: '틸트+고배율에서 초점심도(DOF) 한계 관찰. 조리개·WD로 DOF 조절.',
    mesh: hf, heightRangeUm: 65,
  };
}

export function makeSampleFracture() {
  // 금속 파단면: 거친 지형 — 가장자리 효과·음영 데모
  const noise = makeValueNoise2D(4242);
  const noise2 = makeValueNoise2D(999);
  const hf = makeHeightfield(3, 3, 560, (x, z) => {
    const base = fbm(noise, x * 3, z * 3, 6, 2.2, 0.55);
    const ridge = 1 - Math.abs(2 * fbm(noise2, x * 1.5, z * 1.5, 4) - 1);
    return (base * 120 + ridge * 160 - 140) * UM;
  }, () => [26, 1.4]);
  return {
    id: 'fracture', name: '강재 파단면 (Fe)',
    desc: '거친 지형의 가장자리 효과(edge effect)와 검출기 방향 음영 관찰.',
    mesh: hf, heightRangeUm: 280,
  };
}

export function makeSampleChip() {
  // IC 칩 표면: Al 배선 / Si 기판 — 단차 + 조성 대비 혼합
  const lineW = 20 * UM, gap = 14 * UM, lineH = 8 * UM;
  const period = lineW + gap;
  const hf = makeHeightfield(3, 3, 640, (x, z) => {
    // 가로 배선 밴드 + 세로 버스 + 패드
    const zi = ((z % period) + period) % period;
    const onLine = zi < lineW;
    const busX = ((x % (period * 6)) + period * 6) % (period * 6);
    const onBus = busX < lineW * 2;
    const padX = Math.abs(((x % 1.0) + 1.0) % 1.0 - 0.5) < 0.06;
    const padZ = Math.abs(((z % 1.0) + 1.0) % 1.0 - 0.5) < 0.06;
    if (padX && padZ) return lineH * 2.2;
    if (onBus) return lineH * 1.6;
    if (onLine) return lineH;
    return 0;
  }, (x, z, y) => (y > lineH * 0.5 ? [13, 0.25] : [14, 0.15]));
  return {
    id: 'chip', name: 'IC 칩 표면 (Al 배선 / Si)',
    desc: '저가속전압·UED에서 표면 디테일, BSE에서 Al/Si 조성 대비 관찰.',
    mesh: hf, heightRangeUm: 20,
  };
}

export function makeAllSamples() {
  return [
    makeSampleSnBalls(),
    makeSampleParticles(),
    makeSamplePillars(),
    makeSampleFracture(),
    makeSampleChip(),
  ];
}

// ---------- 챔버 부품 (chamberRenderer용, colors 사용) ----------

export function makeChamberParts() {
  const parts = {};

  // 폴피스: 하단면 y=0, 위로 원뿔대 + 컬럼
  parts.polePiece = mergeMeshes([
    setColor(makeCylinder(6, 16, 14, 48), 0.62, 0.65, 0.70),
    transformMesh(setColor(makeCylinder(16, 16, 26, 48), 0.55, 0.58, 0.63),
      new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,14,0,1])),
  ]);

  // ET(SEI/LED) 검출기: +X/+Z 사분면 측면에서 시료를 향함
  const etBody = mergeMeshes([
    setColor(makeCylinder(3.2, 3.2, 14, 24), 0.85, 0.68, 0.25),
    transformMesh(setColor(makeCylinder(4.2, 3.6, 3, 24), 0.9, 0.78, 0.4),
      new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-3,0,1])),
  ]);
  parts.etDetector = etBody; // 배치는 chamberRenderer에서

  // RBEI (인입식 반사전자 검출기): 도넛판 + 슬라이드 암
  parts.rbeiDisc = setColor(makeAnnulus(1.6, 8.5, 1.6, 48), 0.30, 0.75, 0.55);
  parts.rbeiArm = setColor(makeBox(46, 2.2, 7), 0.25, 0.55, 0.42);

  // 스테이지: 베이스 / 틸트 크래들 / 회전 플래터 / 스텁
  parts.stageBase = setColor(makeBox(64, 10, 48), 0.32, 0.35, 0.42);
  parts.tiltCradle = mergeMeshes([
    setColor(makeBox(44, 6, 34), 0.42, 0.46, 0.55),
    transformMesh(setColor(makeBox(4, 16, 34), 0.38, 0.42, 0.50),
      new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, -22,-6,0,1])),
    transformMesh(setColor(makeBox(4, 16, 34), 0.38, 0.42, 0.50),
      new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 22,-6,0,1])),
  ]);
  parts.rotPlatter = setColor(makeCylinder(11, 11, 4, 40), 0.5, 0.54, 0.62);
  parts.stub = mergeMeshes([
    setColor(makeCylinder(6.1, 6.1, 2.5, 36), 0.78, 0.80, 0.84),
    transformMesh(setColor(makeCylinder(1.6, 1.6, 6, 16), 0.6, 0.62, 0.66),
      new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-6,0,1])),
  ]);

  // 시료 자체(챔버 뷰 표시용 저해상 프록시): 납작 원판
  parts.sampleProxy = setColor(makeCylinder(1.55, 1.5, 0.6, 28), 0.82, 0.72, 0.45);

  // 초점면 표시용 사각 판 (반투명 렌더)
  parts.focalPlane = setColor(makeBox(30, 0.05, 30), 0.2, 0.85, 1.0);

  return parts;
}
