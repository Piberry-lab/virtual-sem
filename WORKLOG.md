# Virtual SEM 작업 로그

## 2026-07-15 — 초기 제작 · 배포 · 배포 중단

### 요청 사항
- 3D 오브젝트를 넣고 틸트/초점 조작이 가능한 SEM 시뮬레이터 (렌더링 엔진 직접 제작)
- RBEI(인입식 BSE 검출기) 삽입 시 틸트 제한 등 실기 인터록 재현
- DOF(초점심도) / Focus depth 구현
- JSM-7610F 실기 사양 기반, GitHub에 올리고 웹으로 배포

### 리서치 (웹 검색, 3개 병렬 에이전트)
확정 수치 및 공식:
- **JSM-7610F 사양** (JEOL 카탈로그 No.1502H323C): 스테이지 Type IA2 X70/Y50mm,
  Z(WD) 1.0–40mm, 틸트 −5~+70°, 회전 360° 무한, 가속전압 0.1–30kV,
  프로브 전류 ~수pA–200nA, 배율 ×25–×1,000,000, 분해능 1.0nm@15kV / 1.5nm@1kV(GB)
- **검출기**: 상부(UED/SED, in-lens) · 하부(LED/LDD, E-T형) · r-filter · RBEI(인입식 환형 BSE)
- **RBEI 근거** (JEOL 용어집): 환형 BSE 검출기는 대물렌즈 직하 배치, WD 3mm 미만에서
  시료와 겹침 → 인입식으로 제작. 정확한 인터록 한계값은 비공개 → 기하 모델로 추정
- **SE**: δ(θ) = δ0·sec(θ)^n (n≈0.85), 가장자리 효과
- **BSE**: Reuter(1972) η(Z) = −0.0254 + 0.016Z − 1.86e-4·Z² + 8.3e-7·Z³,
  틸트 의존 η(φ) = 0.89·(η0/0.89)^cosφ
- **DOF**: DOF = 2r/α = 0.2mm/(M·α), α = R_aperture/WD (Semitracks 수치표로 검증)
- **노이즈**: N = (Ip·t_dwell/e)·yield·ε, SNR = √N (Rose criterion)

### 구현 (커스텀 WebGL2 엔진, 외부 라이브러리 없음)
```
engine/math.js       mat4/vec3 최소 수학
engine/gl.js         WebGL2 헬퍼 (셰이더/FBO/메시)
engine/mesh.js       시료 5종 + 챔버 부품 프로시저럴 생성
engine/physics.js    SEM 물리 공식 (위 리서치 수치)
engine/stage.js      5축 유센트릭 운동학 + RBEI 충돌 인터록
engine/semRenderer.js  G-buffer → 신호 → DOF/비점 블러 → 주사·노이즈 → 표시 (5패스)
engine/chamberRenderer.js  시료실 3D 뷰 (궤도 카메라, 빔/초점면/DOF 밴드)
app.js + index.html  콘솔 UI (한국어)
theory.html          기존 교육 페이지 동봉
```
- 충돌 모델: 시료 최고점 y = −Z + r_stub·sin|T| + h_시료·cos T,
  장애물 하단(폴피스 0 / RBEI −2.3mm) + 여유 0.5mm 기준으로 Z·T 클램프
- 비점수차: 직교 초점면 분리 모델(초점 전후 스트릭 90° 반전), STIGMA 노브로 상쇄
- PHOTO 스캔 완료 시 자동 프리즈, PNG 저장 버튼, ACB 자동 명암

### 발견·수정한 버그
1. rAF가 숨겨진 탭에서 멈춰 루프 정지 → rAF + setTimeout(80ms) 워치독 이중 스케줄
2. 구 시료 다각형 파셋 → 반경 비례 테셀레이션(최대 40세그), Sn 볼 거칠기 0.12로 하향
3. 기본 명암 과포화 → brightness 0.05 / contrast 1.25 / gamma 1.05
4. 900세그 하이트필드 생성 지연 → 560–640세그로 조정

### 검증 결과
- 인터록: WD 2mm에서 RBEI 삽입 거부(필요 2.9mm — JEOL "WD<3mm 간섭"과 일치),
  삽입+틸트70° 상태에서 WD 요청 시 8.6mm로 클램프, WD 1mm에서 틸트 3.5° 제한,
  유센트릭 틸트 45°에서 광축상 초점 유지 — 전부 통과
- 렌더 캡처 확인: Sn 볼 가장자리 효과, 틸트 45° 원근 단축·측벽 음영,
  BSE COMPO 원자번호 대비(C 기판 검정/중금속 밝음), 챔버 뷰 RBEI 슬라이드·DOF 밴드
- 물리 수치: α=2.50mrad(50µm/WD10), DOF=160µm(×500) — 공식과 일치

### 배포 이력
- 레포 생성: https://github.com/Piberry-lab/virtual-sem (public, main 브랜치)
- GitHub Pages 활성화 → https://piberry-lab.github.io/virtual-sem/ 빌드·동작 확인
- **같은 날 사용자 요청으로 Pages 배포 중단** (DELETE /pages, HTTP 204 → 사이트 404 확인)
- 레포와 코드는 그대로 유지됨

### 재배포 방법
레포 Settings → Pages → Source: `main` / root 선택, 또는:
```
curl -X POST -H "Authorization: token <TOKEN>" \
  https://api.github.com/repos/Piberry-lab/virtual-sem/pages \
  -d '{"source":{"branch":"main","path":"/"}}'
```

### 남은 불확실성 / 추후 과제
- RBEI 인터록 한계값은 기하 모델 추정 (JEOL 매뉴얼 실측값 아님)
- 프로브 지름 수차 계수(Cs=Cc=2mm)는 대표값 — 실기 보정 곡선과 다름
- 실화면 주사율(FPS) 미확인 (개발 환경에서 탭이 백그라운드였음)
- 아이디어: EDS 모드, 실측 SEM 텍스처 시료, 진공 시퀀스(EVAC/VENT) 시뮬레이션
