# webclaw System One 두뇌(Jev) 보고서 (v0.10.0, 2026-10-21)

> 요청: "처리 속도가 느린 것이 한계 — 두뇌 역할을 LLM이 아니라 jev 혹은 leva로."
> 결과: **Jev(TypeSafe System One 모델)를 두뇌로 쓰는 목표 루프를 구현·검증**했다.
> "leva"는 TypeSafe 문서·블로그·로컬 어디에서도 찾지 못해 미구현 — 두뇌 인터페이스는 교체 가능하게 두었다.

## 1. 왜 느렸고, 무엇을 바꿨나

- 지금까지 webclaw의 "두뇌"는 LLM이었다(마스터 에이전트, 또는 확장의 Brain URL `/brain/exec`). 웹 작업은 단계마다 "다음에 무엇을 누를까"를 묻는데, 그때마다 LLM이 **텍스트를 생성**하므로 단계당 수 초가 걸린다.
- 그런데 이 질문은 대부분 **보기 중 고르기**다(어느 버튼? 어떤 값? 끝났나?). Jev는 바로 그 형태 — `state` + 질문(Choice/Score/Noul) → 확률이 붙은 구조화된 답 — 에 특화된 모델이고, 벤더 주장 응답 70~500ms다([소개 글](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [API](https://docs.typesafe.ai/api/system-one)).

## 2. 구현 — `bridge/brain/`

| 파일 | 역할 |
|---|---|
| `jev.cjs` | Jev REST 클라이언트(`POST /v1/systemone`, Bearer 키, 429/5xx 재시도·`retry-after`, 타임아웃), 무의존 |
| `agent.cjs` | **목표 루프**: 아웃라인 파싱 → state 구성 → 한 요청에 질문 4개 병렬 → confidence 게이트 → 마커 1개 실행 → 반복 |
| `server.cjs` | `webclaw brain` — 확장의 기존 두뇌 계약 `/brain/exec`를 그대로 제공 → HUD 채팅·버스 자유문 과제가 Jev 속도로 동작 |

한 단계 = Jev 요청 1회(질문 4개를 병렬로 평가):
- `done` (Noul) — 목표가 이미 달성됐나 (≥ 0.8이면 종료)
- `kind` (Choice) — click · type · select · wait · need_human
- `target` (Choice) — 페이지의 `@ref` 중 하나(최대 250개, 넘으면 목표 관련도로 선별)
- `value` (Choice) — 목표 문장에서 뽑은 값 후보 중 하나(인용구·이메일·숫자·"as X"·KR 같은 코드)

안전장치:
- **confidence 게이트**: 0.5 미만이면 실행하지 않고 LLM 폴백(`--fallback`, 기존 brainUrl)이나 중단(`low_confidence`). TypeSafe 문서의 "신뢰도 기반 라우팅" 권고를 따름.
- **위험 동작**: 결제·삭제·송금처럼 보이는 대상은 0.85 이상이어야 실행, 아니면 `needs_confirmation`. 브라우저 쪽 정책(confirmRisky·ask·deny)도 그대로 적용.
- **같은 동작 3회 반복·진전 없음 → `stuck`**, 정책 거절(`policy_denied`·`approval_*`·`handed_off`)은 즉시 중단.
- **선택지가 1개일 때**는 판단이 아니므로 confidence를 1로 취급(그렇지 않으면 공식상 정의되지 않음).

학습 효과:
- 성공하면 `--save 도메인/이름`으로 경로를 `[RUN]` 레시피로 저장 — `@ref` 대신 **역할+이름**으로 요소를 다시 찾으므로 다음 실행에서 **모델 호출 0회**로 재생.

사용:
```bash
export TYPESAFE_API_KEY=…    # 또는 ~/.webclaw/config.json {"jev":{"apiKey":"…","model":"jev-latest"}}
webclaw goal 'Log in as alice with password "s3cret"' --tab space:job --save example.com/login
webclaw goal '…' --fallback   # 신뢰도 낮은 단계만 LLM(brainUrl)에게
webclaw brain --port 4111     # 확장 팝업의 Brain URL을 http://127.0.0.1:4111 로
```
MCP 도구 `webclaw_goal {goal, tab, save}`.

## 3. 검증

### 3.1 단위 테스트 — 52/52 (신규 9)
모의 Jev **오라클**(알려진 목표에 대해 정해진 다음 단계를 답하는 테스트 대역)과 가짜 페이지로: 아웃라인·값 후보·선별, 요청 구성(질문 4종·옵션 매핑), 목표 달성과 레시피 저장, 낮은 신뢰도 중단·폴백 위임, 위험 대상 `needs_confirmation`, `stuck`, 키 없음·잘못된 키, `/brain/exec` 계약(인증·HUD 프롬프트 파싱).

### 3.2 실브라우저 E2E — 11/11 (Chrome for Testing 153 headless, 확장 실제 로드)

| 과제 | 두뇌 | 성공 | 판단 | 동작 | 총 시간 | 모델 | 브라우저 |
|---|---|---|---|---|---|---|---|
| login | Jev(모의, 150ms) | ✓ | 4 | 3 | 0.70 s | 0.61 s | 0.09 s |
| search | Jev(모의) | ✓ | 3 | 2 | 0.53 s | 0.46 s | 0.07 s |
| wizard | Jev(모의) | ✓ | 7 | 6 | 1.26 s | 1.08 s | 0.18 s |
| controlled-input | Jev(모의) | ✓ | 3 | 2 | 0.53 s | 0.46 s | 0.07 s |
| modal | Jev(모의) | ✓ | 3 | 2 | 0.53 s | 0.46 s | 0.07 s |
| wizard | 저장된 레시피 재생(모델 없음) | ✓ | 0 | 6 | 0.15 s | 0 | 0.15 s |
| login | LLM 매 단계(`claude -p` Haiku) | ✓ | 6 | 3 | 67.1 s | — | 0.23 s |
| search | LLM 매 단계 | ✓ | 4 | 3 | 39.6 s | — | 0.18 s |
| modal | LLM 매 단계 | ✓ | 3 | 2 | 29.6 s | — | 0.26 s |

추가로 확인: 알 수 없는 목표는 추측하지 않고 `low_confidence`로 멈춤 · **HUD 채팅에 목표를 입력 → 확장 Brain URL → `webclaw brain` → 로그인 완료**, HUD에 "✅ 완료" 표시.

## 4. 해석과 한계 (정직하게)

1. **Jev 자체는 아직 측정하지 못했다.** 이 환경에 `TYPESAFE_API_KEY`가 없어, 같은 API 계약을 따르는 **모의 서버(150ms 지연, 벤더 범위의 하단)**로 루프·통합·속도 구조를 검증했다. 모의 서버는 정답을 아는 오라클이므로 **정확도에 대해서는 아무것도 증명하지 않는다.** 실제 Jev가 이 페이지들에서 올바른 버튼·값을 고르는지는 키를 받아 같은 E2E를 돌려야 알 수 있다(하네스는 `WEBCLAW_JEV_URL`만 빼면 실제 API로 그대로 실행).
2. **속도 이득의 근거**: 모델 밖 루프 비용은 판단당 약 25~35ms(아웃라인+마커)로 작다. 따라서 단계 시간 ≈ 모델 지연이며, Jev가 벤더 주장(70~500ms)대로라면 단계당 0.1~0.5초, LLM 단계(수 초)보다 한 자릿수 이상 빠르다.
3. **LLM 기준선은 `claude -p` CLI 기준**이라 프로세스 기동·하네스 오버헤드가 포함된다(판단당 ≈10초). API를 직접 호출하면 더 빠르다(대략 1~3초 수준으로 예상되나 이번에 측정하지 않음). 그래도 "판단 = 수 초 vs 수백 ms"라는 차이의 방향은 유지된다. LLM은 login에서 불필요한 단계를 더 밟아 판단 수도 많았다(6 vs 4).
4. **Jev는 글을 쓰지 못한다**: 입력할 값이 목표 문장에 있어야 한다. 값이 페이지·다른 데이터에서 와야 하는 과제, 자유 서술이 필요한 과제는 LLM 폴백이나 레시피가 필요하다. 자연어 이해는 영어가 가장 좋고 한국어 등은 정확도가 낮을 수 있다(벤더 문서).
5. **클라우드 전송**: Jev는 호스팅 API다. 페이지 아웃라인(요소 이름·입력값)이 TypeSafe로 전송된다. 금지 목록 사이트는 읽지 않으므로 전송되지 않지만, 민감한 사이트는 deny에 두거나 레시피 재생(모델 없음)을 쓰는 편이 맞다. 로컬 실행("이 Mac")은 제어 루프에만 해당하고, 판단은 원격이다.
6. **"leva"**: 확인되지 않음. 무엇인지 알려주시면 `createJev`와 같은 `systemOne(state, questions)` 형태의 어댑터로 붙일 수 있다(루프는 모델 독립).

## 5. 다음 단계
1. **API 키로 실측**: 같은 E2E(5과제) + 벤치마크 10과제를 실제 Jev로 — 정확도·지연·비용(입력 토큰) 기록.
2. 실패 유형별 보강: 값이 목표에 없을 때(폼 기본값·페이지 데이터) Score/Noul로 "이미 올바른가" 확인, 페이지 내 후보를 value 선택지에 추가.
3. 이미지 입력(`jev-preview` + 이미지 헤더)로 아웃라인에 안 잡히는 캔버스·아이콘 버튼 대응.
4. 확신도 임계값을 감사 로그·녹화 데이터로 보정.
