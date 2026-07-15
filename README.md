# Virtual SEM — JEOL JSM-7610F 3D 실기 시뮬레이터

브라우저에서 동작하는 **주사전자현미경(SEM) 3D 시뮬레이터**입니다.
Three.js 같은 외부 라이브러리 없이 **커스텀 WebGL2 렌더링 엔진**으로,
SEM의 이미지 형성 물리를 셰이더 파이프라인으로 직접 구현했습니다.

▶ **실행**: https://piberry-lab.github.io/virtual-sem/
▶ **이론 교재**: https://piberry-lab.github.io/virtual-sem/theory.html

## 주요 기능

| 기능 | 구현 |
|---|---|
| 5축 유센트릭 스테이지 | X ±35 / Y ±25 / Z(WD) 1–40 mm / 틸트 −5~+70° / 회전 360° (JSM-7610F 사양) |
| 틸트 & 초점 | 틸트축이 시료면을 지나는 유센트릭 운동학. 틸트 상태에서 Y 이동 시 초점 이탈 재현 |
| RBEI 인터록 | 인입식 BSE 검출기 삽입 시 **틸트·WD 제한** — 스텁 가장자리 상승량(r·sin T) 기반 충돌 기하 모델, 삽입 거부/모션 클램프/근접 경고 |
| 초점심도(DOF) | DOF = 0.2mm/(M·α), α = r_ap/WD. 초점면에서 벗어난 픽셀은 d = 2α·Δz 원추 흐림. 챔버 뷰에 DOF 밴드 시각화 |
| 검출기 5모드 | SEI(LED: E-T 방향성 음영 / UED: in-lens 등방·표면 민감), BSE COMPO(조성)·TOPO(지형)·SHADOW |
| 신호 물리 | SE: δ∝sec^0.85 θ (가장자리 효과 포함) · BSE: Reuter(1972) η(Z) + 틸트 η=0.89(η0/0.89)^cosθ |
| 비점수차 | 두 직교 초점면 분리 모델 — 초점 전후로 스트릭 방향 90° 반전, STIGMA X/Y로 상쇄 |
| 주사·노이즈 | TV/SLOW/PHOTO 주사 속도, 샷노이즈 SNR=√N (프로브 전류·dwell time 연동), 주사선 진행 표시 |
| 차징 | 미코팅 시료 토글 — 라인 지터 + 플레어 (저kV/GENTLEBEAM으로 완화) |
| 시료 5종 | Sn 볼(표준 시험시료) · 다물질 입자(Z 대비) · Si 필러(DOF 데모) · 파단면 · IC 칩 |

## 구조

```
index.html            UI (JEOL PC-SEM 스타일 콘솔)
app.js                상태·UI·메인 루프
engine/
  math.js             mat4/vec3 최소 수학
  gl.js               WebGL2 헬퍼 (셰이더/FBO/메시)
  mesh.js             시료·챔버 지오메트리 (프로시저럴 생성)
  physics.js          SEM 물리 공식 (DOF·프로브 지름·SNR·Reuter η)
  stage.js            5축 운동학 + RBEI 충돌 인터록
  semRenderer.js      SEM 파이프라인: G-buffer → 신호 → DOF 블러 → 주사/노이즈 → 표시
  chamberRenderer.js  시료실 3D 뷰 (궤도 카메라, 빔·초점면·DOF 밴드)
theory.html           SEM 이론 교재 (10장 + 퀴즈 + 2D 시뮬레이터)
```

### 렌더 파이프라인 (semRenderer.js)

1. **G-buffer** — 빔 시점(수직 직교투영, 시야폭 = 128mm/배율)에서 법선·위치·원자번호 렌더
2. **Signal** — SE/BSE 수율 물리 모델 + 검출기 기하 + 상호작용 부피 기반 가장자리 효과 + 배율 적응형 프로시저럴 미세지형
3. **Blur** — 픽셀별 디포커스 Δz → 타원(비점수차) 원추 흐림, 프로브 지름 합성
4. **Compose** — 라스터 주사 진행 밴드에만 새 신호 기록 + Box-Muller 샷노이즈
5. **Display** — 밝기/명암/감마 LUT + 주사선 마커

## 근거 자료

- JEOL JSM-7610F 카탈로그 (No.1502H323C): 스테이지/WD/kV/배율/검출기/분해능 사양
- JEOL SEM 용어집: secant law, BSE 검출기 기하(WD<3mm에서 시료와 간섭 → 인입식)
- Reuter (1972): η(Z) = −0.0254 + 0.016Z − 1.86×10⁻⁴Z² + 8.3×10⁻⁷Z³
- Semitracks SEM 노트: DOF = 2r/α (r = 0.1mm/M) 수치표 검증
- Everhart–Thornley 검출기: +200~300V 컬렉터 — 부드러운 방향성 음영

**주의**: 교육용 단순화 모델입니다. RBEI 인터록 한계값은 JEOL 공개 문서에 없어
기하 모델(스텁 반경 6.1mm, 검출기 하단 −2.3mm, 여유 0.5mm)로 계산합니다.
프로브 지름·수차 계수(Cs=Cc=2mm)는 대표값이며 실기 보정 곡선과 다릅니다.

## 로컬 실행

정적 파일이므로 아무 웹서버나 사용:

```bash
python -m http.server 8000
# → http://localhost:8000
```

(ES 모듈 사용으로 `file://` 직접 열기는 불가)
