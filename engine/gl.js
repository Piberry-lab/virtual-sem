// ============================================================
// gl.js — WebGL2 헬퍼: 셰이더 컴파일, FBO, 메시 업로드, 풀스크린 쿼드
// ============================================================

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true, // PHOTO 저장(toDataURL) 지원
  });
  if (!gl) throw new Error('WebGL2를 지원하지 않는 브라우저입니다.');
  const extCBF = gl.getExtension('EXT_color_buffer_float');
  gl.__hasFloatBuffer = !!extCBF;
  return gl;
}

export function compileProgram(gl, vsSrc, fsSrc, name = 'program') {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      throw new Error(`[${name}] shader compile error:\n${log}\n--- source ---\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
    }
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`[${name}] link error: ${gl.getProgramInfoLog(prog)}`);
  }
  // 유니폼 위치 캐시
  const uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const key = info.name.replace(/\[0\]$/, '');
    uniforms[key] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u: uniforms };
}

// 렌더타겟 생성: colorSpecs = [{internalFormat, format, type, filter}]
export function createRenderTarget(gl, w, h, colorSpecs, withDepth = true) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const textures = [];
  const drawBuffers = [];
  colorSpecs.forEach((spec, i) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, spec.internalFormat, w, h, 0, spec.format, spec.type, null);
    const filter = spec.filter ?? gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    textures.push(tex);
    drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
  });
  let depthBuf = null;
  if (withDepth) {
    depthBuf = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuf);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuf);
  }
  gl.drawBuffers(drawBuffers);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`FBO incomplete: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, textures, w, h, depthBuf };
}

export function destroyRenderTarget(gl, rt) {
  if (!rt) return;
  rt.textures.forEach((t) => gl.deleteTexture(t));
  if (rt.depthBuf) gl.deleteRenderbuffer(rt.depthBuf);
  gl.deleteFramebuffer(rt.fbo);
}

// 메시 업로드: mesh = {positions, normals, extras(옵션, vec2: [atomicZ, microRough]), indices}
export function uploadMesh(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  const nrmBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

  if (mesh.extras) {
    const exBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, exBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.extras, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
  } else {
    gl.disableVertexAttribArray(2);
    gl.vertexAttrib2f(2, 6.0, 1.0); // 기본: 탄소, 표준 거칠기
  }

  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, count: mesh.indices.length, indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
}

export function drawMesh(gl, m) {
  gl.bindVertexArray(m.vao);
  gl.drawElements(gl.TRIANGLES, m.count, m.indexType, 0);
  gl.bindVertexArray(null);
}

// 풀스크린 트라이앵글 (포스트프로세스 패스용)
export function createFullscreenQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export function drawFullscreen(gl, vao) {
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

export const FS_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
