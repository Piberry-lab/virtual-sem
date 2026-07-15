// ============================================================
// math.js — 최소 행렬/벡터 유틸 (column-major mat4, WebGL 규약)
// ============================================================

export const DEG = Math.PI / 180;

export function mat4Identity() {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}

export function mat4Multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1] + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
    }
  }
  return o;
}

export function mat4Chain(...ms) {
  return ms.reduce((acc, m) => mat4Multiply(acc, m));
}

export function mat4Translate(x, y, z) {
  const m = mat4Identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function mat4Scale(x, y, z) {
  const m = mat4Identity();
  m[0] = x; m[5] = y; m[10] = z;
  return m;
}

export function mat4RotX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
}

export function mat4RotY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
}

export function mat4RotZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]);
}

// 직교 투영 (빔 시점: 화면 = 시료면, 깊이 = 빔 방향)
export function mat4Ortho(l, r, b, t, n, f) {
  const m = mat4Identity();
  m[0] = 2/(r-l); m[5] = 2/(t-b); m[10] = -2/(f-n);
  m[12] = -(r+l)/(r-l); m[13] = -(t+b)/(t-b); m[14] = -(f+n)/(f-n);
  return m;
}

export function mat4Perspective(fovyRad, aspect, n, f) {
  const t = 1 / Math.tan(fovyRad / 2);
  const m = new Float32Array(16);
  m[0] = t/aspect; m[5] = t; m[10] = (f+n)/(n-f); m[11] = -1;
  m[14] = 2*f*n/(n-f);
  return m;
}

export function mat4LookAt(eye, center, up) {
  const z = vNorm(vSub(eye, center));
  const x = vNorm(vCross(up, z));
  const y = vCross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -vDot(x, eye), -vDot(y, eye), -vDot(z, eye), 1,
  ]);
}

// 법선 변환용: 상단 3x3 (회전+균등스케일 가정)
export function mat3FromMat4(m) {
  return new Float32Array([m[0],m[1],m[2], m[4],m[5],m[6], m[8],m[9],m[10]]);
}

export function transformPoint(m, p) {
  return [
    m[0]*p[0] + m[4]*p[1] + m[8]*p[2] + m[12],
    m[1]*p[0] + m[5]*p[1] + m[9]*p[2] + m[13],
    m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14],
  ];
}

export function transformDir(m, d) {
  return [
    m[0]*d[0] + m[4]*d[1] + m[8]*d[2],
    m[1]*d[0] + m[5]*d[1] + m[9]*d[2],
    m[2]*d[0] + m[6]*d[1] + m[10]*d[2],
  ];
}

export const vSub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
export const vAdd = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
export const vScale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
export const vDot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
export const vCross = (a, b) => [
  a[1]*b[2] - a[2]*b[1],
  a[2]*b[0] - a[0]*b[2],
  a[0]*b[1] - a[1]*b[0],
];
export const vLen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vNorm = (a) => { const l = vLen(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// 결정적 시드 난수 (시료 지오메트리 재현성)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
