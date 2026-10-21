# webclaw 준거집단 분석·예측 (2026-10-21)

> 틀: ego lite(lite.ego.app)의 "Stop bouncing between browsers" 비교표(준거집단 5개 × 기준 11개)를
> **webclaw 기준**으로 확장. 준거집단을 6개로 나누고 webclaw 고유 기준 5개(12~16)를 더했다.
> 조사: 서브 에이전트 5개 병렬 웹 리서치(2026-10-21). 점수 ✓ 충족 · △ 부분 · ✗ 미충족.
> 업체 자체 발표·미확인 정보는 각 그룹 보고에서 (unverified)로 표시했고, 여기서는 그룹 대표값만 옮겼다.
>
> **갱신 2026-10-21 (v0.9.0)**: P1~P3 전 항목 구현·검증 — 결과 보고서 `docs/report-p1-p3-2026-10.md`.
>
> **갱신 2026-10-21 (v0.8.0 반영)**: P0 두 항목(MCP 서버·CLI·스킬 설치 경로, 버스 없는 standalone 모드)을
> 구현·검증했다. 아래 webclaw 행·각주·승패 표·예측 영향을 그에 맞게 고쳤다. 경쟁사 쪽 점수는 바꾸지 않았다.

## 1. 기준

| # | 기준 | 출처 |
|---|---|---|
| 1 | 어떤 AI 에이전트와도 동작 | ego 표 |
| 2 | 내 브라우저 로그인 그대로 | ego 표 |
| 3 | CAPTCHA 적음 | ego 표 |
| 4 | 컴퓨터 전체에서 작업 | ego 표 |
| 5 | 내 브라우저를 가로채지 않음 | ego 표 |
| 6 | 병렬 멀티태스킹 | ego 표 |
| 7 | 대규모 스크래핑 | ego 표 |
| 8 | 일상 브라우저로 사용 | ego 표 |
| 9 | 무료 | ego 표 |
| 10 | 데이터 로컬 저장 | ego 표 |
| 11 | 재사용 스킬 | ego 표 |
| 12 | 분산·플릿(여러 머신·프로필 오케스트레이션) | webclaw |
| 13 | 키리스(브라우저에 LLM 키 없음) | webclaw |
| 14 | 페이지 위 사람 개입 UI(감독·채팅·인계) | webclaw |
| 15 | 오픈소스 | webclaw |
| 16 | 외부 오케스트레이터용 API(REST/WS/MCP) | webclaw |

## 2. 통합 비교표 (그룹 대표값)

| 준거집단 (대표 제품) | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **webclaw v0.9.0** | ✓ | ✓ | ✓ | △¹ | △² | ✓ | △ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓³ |
| 브라우저 확장 (Claude in Chrome, Codex for Chrome, Nanobrowser, Playwright MCP Bridge, HARPA) | △ | ✓ | ✓ | ✗ | △ | △ | △ | ✓ | △ | △ | △ | ✗ | △ | △ | △ | △ |
| 앱 내장 브라우저 (Claude Cowork, ChatGPT 데스크톱/Work, Chrome auto browse, Manus) | ✗ | △ | △ | △ | ✓ | △ | ✗ | ✗ | ✗ | △ | ✓ | ✗ | △ | △ | ✗ | ✗ |
| AI 브라우저 (Comet, Dia, Opera Neon, Edge, Genspark/Fellou) | ✗ | ✓ | ✓ | ✗ | △ | △ | ✗ | ✓ | △ | △ | △ | ✗ | △ | ✓ | ✗ | ✗ |
| 클라우드 브라우저 (Browserbase, Browser Use, Kernel, Steel, Cloudflare, AgentCore) | ✓ | △ | △ | ✗ | ✓ | ✓ | ✓ | ✗ | △ | ✗ | △ | △ | ✓ | ✓ | △ | ✓ |
| 브라우저 CLI·MCP (playwright-cli/MCP, Chrome DevTools MCP, agent-browser, Browser Harness, Stagehand) | ✓ | △ | △ | ✗ | △ | △ | △ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ |
| 에이전트 네이티브 브라우저 (ego lite 실평가, BrowserOS neo, Lightpanda, Donut) | ✓ | △ | △ | ✗ | ✓ | ✓ | △ | △ | ✓ | ✓ | ✗⁴ | ✗ | ✓ | ✓ | △ | △ |

¹ webclaw 자체는 브라우저 전용. DureClaw 플릿의 셸·데스크톱 노드를 통해서만 컴퓨터 전체로 확장된다.
² Space(포커스 없는 에이전트 창)로 사용자 탭은 지키지만, CDP를 쓰는 동안 "디버깅 중" 안내줄이 뜨고 진짜 브라우저 컨텍스트 격리는 없다.
³ REST/WS 버스 + v0.8.0부터 MCP 서버(stdio, 도구 11개 → v0.11 기준 15개)·CLI(`webclaw`)·`npx skills add DureClaw/webclaw` 스킬. 분석 당시(v0.7.0) 1순위 공백이었고 해소됐다.
⁴ ego는 스킬이 아직 "coming soon". ego가 자사 표에서 ✓로 표시한 11개 중 실제로는 4(컴퓨터 전체)·11(스킬)이 ✗, 2·3·7·8이 △로 평가됐다.

## 3. 준거집단별 webclaw 승패

| 준거집단 | webclaw가 이기는 점 | webclaw가 지는 점 |
|---|---|---|
| 브라우저 확장 | 어떤 에이전트든 + 플릿 + 키리스 + HUD + 전용 창. 벤더 확장은 자사 에이전트와 사용량 한도에 묶이고, BYOK 확장은 키와 두뇌가 브라우저 안에 있다 | 내장 에이전트 없음, 브랜드·배포력. ~~설치 장벽(버스·마스터 필요)~~·~~MCP 없음~~은 v0.8.0에서 해소(standalone 미니버스 + MCP) — 단 확장은 여전히 웹스토어가 아닌 압축 해제 설치 |
| 앱 내장 브라우저 | 실제 Chrome·실제 로그인, 무료·무제한, 외부 API | 컴퓨터 전체 제어 없음, 안전 분류기·프롬프트 인젝션 방어 없음 |
| AI 브라우저 | 브라우저를 바꿀 필요 없음, 어떤 에이전트든, 오픈소스. 외부 에이전트용 공식 API를 연 AI 브라우저는 없다 | 소비자용 완성도, 내장 에이전트 |
| 클라우드 브라우저 | 실제 로그인(재로그인·MFA 없음), 가정용 IP로 CAPTCHA 비용 0, 로컬 데이터, 무료 | 탄력적 확장 불가(클라우드는 100~1,000개 이상 동시), 세션 녹화·리플레이 없음, 공개 벤치마크 없음 |
| 브라우저 CLI·MCP | Chrome 136+에서도 기본 프로필을 그대로 씀, 플릿, HUD, CORS 없는 [FETCH] | 벤치마크 없음, 도구 응답의 토큰 효율 미측정. ~~MCP·CLI·SKILL 설치 경로 없음~~은 v0.8.0에서 해소(MCP·CLI·SKILL 동시 제공 = 이 그룹의 표준 형태) |
| 에이전트 네이티브 | 브라우저 교체 불필요, 다중 머신, 완전 오픈소스, learnings를 이미 출시 | 엔진 수준 스냅샷·격리·안내줄 없는 제어는 확장 구조상 불가, 스타 수 격차(ego 약 18k, BrowserOS 약 14k) |

ego 대비 이미 따라잡은 것(v0.7.0~0.8.0): Space와 인계, @ref 스냅샷, [RUN] 배치 실행, CDP 실제 입력과 백그라운드 캡처, learnings(ego보다 먼저).
확장 구조상 따라잡을 수 없는 것: 엔진 네이티브 스냅샷(닫힌 shadow DOM 포함), 한 프로필 안의 컨텍스트 격리, 안내줄 없는 제어, Chromium 수준 지문 패치.

## 4. 기능별 수명 — 무엇이 범용화되고 무엇이 남는가

| 구분 | 기준 | 근거 |
|---|---|---|
| **12개월 안에 범용화** (차별점 소멸) | 5 가로채지 않음, 6 병렬 | Claude·Codex·Nanobrowser 모두 "CDP + 전용 탭 그룹 + 백그라운드" 구조로 수렴 |
| | 14 사람 개입 | Cloudflare 인계 API(2026-07), Browser Use takeover, Codex 사이트별 권한 |
| | 2 로그인 | 클라우드 profiles·managed auth, Chrome autoConnect(동의 기반) |
| | 11 스킬 | Claude 단축·스케줄, Browser Harness 자가 작성 스킬, ego "coming soon" |
| **지속 가능한 차별점** | 12 플릿 + 13 키리스 + 1 어떤 에이전트든 + 실제 Chrome 무이전 + 15 오픈소스 | 이 **조합**을 가진 제품은 6개 그룹 어디에도 없다 |

## 5. 12~18개월 예측

| # | 예측 | 근거 | 확신도 | webclaw 영향 |
|---|---|---|---|---|
| P1 | AI 기업들이 독립 브라우저를 접고 "데스크톱 앱 내장 브라우저 + 실제 Chrome 확장"으로 이동 | Atlas 종료(2026-08-09), Mariner 흡수(2026-05), Edge Copilot Mode 폐지, Claude in Chrome GA | 높음 | **위협 높음**: webclaw와 같은 자리 |
| P2 | 모든 도구가 MCP·CLI·SKILL.md를 함께 배포. CLI가 토큰 효율 기본값이 된다 | playwright-cli, Chrome DevTools CLI 1.0(2026-05) | 높음 | **v0.8.0으로 대응 완료** — 남은 일은 배포(마켓·플러그인 등록)와 토큰 효율 측정 |
| P3 | "명령 대신 코드(배치 스크립트)"가 벤치마크의 기준이 된다 | DevTools CLI 배치, ego JS, Browser Harness | 높음 | **기회**: [RUN]으로 이미 대응. 증명만 남음 |
| P4 | 클라우드 업체가 "로컬 Chrome 로그인 동기화"를 출시 | AgentCore profiles(2026-02), Kernel managed auth | 중간 | **최대 위협**: "실제 로그인" 강점 잠식 |
| P5 | Chrome이 `chrome.debugger`·에이전트 권한을 강화하거나 공식 에이전트 연결 권한을 도입 | autoConnect 동의창·배너, 웹스토어의 debugger 권한 심사, auto browse 내장 | 중간 | 정책 리스크 + 진입 장벽 상승(양면) |
| P6 | 서명된 에이전트 신원(Web Bot Auth)이 우대되고 스텔스는 쇠퇴 | Cloudflare×Browserbase, Fingerprint 인증 에이전트 목록 | 중간 | 서명 없으면 불리. 단 "사용자 위임 에이전트"라는 새 범주 기회 |
| P7 | 기업은 정책 통제 없는 AI 브라우저를 차단 | Gartner 2025-12 차단 권고, Comet·Cowork MDM | 높음 | 허용 목록·감사 로그가 있으면 셀프호스팅 오픈소스로 기회 |
| P8 | ego·BrowserOS가 MCP를 추가하고, 일부는 다중 머신이나 엔터프라이즈 등급으로 확장 | 2026 중반 동시 출시, YC·투자 | 중간 | 플릿 독점 지위가 2~3분기 내 도전받음 |
| P9 | 브라우저 사용 시간 가격이 원가 수준으로 붕괴 | Browser Use $0.02/hr | 높음 | "무료" 메시지는 약해지고 "로컬·실제 로그인·플릿" 메시지가 강해짐 |
| P10 | WebMCP가 정식화되며 사이트가 에이전트용 도구를 직접 노출 | Chrome 149+ origin trial, Edge trial | 중간 | **기회**: webclaw를 WebMCP 클라이언트이자 버스 중계로 |

## 6. 포지셔닝 제안

> **"에이전트 팀을 위한 실제 브라우저 컨트롤 플레인"**: 브라우저를 바꾸지 않고, 어떤 에이전트든,
> 여러 머신·프로필의 *진짜* 로그인 세션을 하나의 버스로 묶고, 사람이 페이지 위에서 감독·인계한다.

- 대 클라우드: 경쟁이 아니라 **하이브리드**. 탐색·대량 작업은 클라우드, 로그인·고신뢰 실행은 webclaw ("탐색은 클라우드, 실행은 엣지").
- 대 벤더 확장: "에이전트 종속 없음 + 플릿".
- 대 ego·BrowserOS: "브라우저 교체 없음 + 다중 머신 + 완전 오픈소스". (v0.8.0부터 BrowserOS neo처럼 MCP로도 붙는다 — 차이는 플릿과 실제 Chrome)

## 7. 로드맵 우선순위

| 우선 | 항목 | 대응 예측·공백 |
|---|---|---|
| **P0 ✅ v0.8.0** | **MCP 서버 + 얇은 CLI + `npx skills add` 형식 SKILL 배포** (버스 REST 위 어댑터) | P2, CLI 그룹 1순위 공백 |
| **P0 ✅ v0.8.0** | **버스 없는 standalone 모드**(로컬 미니버스 → 확장) — 설치 장벽 제거 | 확장 그룹 "설치 장벽" |
| **P1 ✅ v0.9.0** | **공개 벤치마크**: 결정론적 로컬 10과제 × 3전략(step/run/relay), `bench/` 공개 (LLM-in-the-loop·실사이트 버전은 남음) | P3, 전 그룹 "증거 없음" |
| **P1 ✅ v0.9.0** | **안전·정책 계층**: 허용·금지 목록, Ask/Auto 모드(HUD 승인), 감사 로그, 위험 동작 확인 | P7, 앱 내장 그룹 "안전 분류기" |
| **P1 ✅ v0.9.0** | **세션 녹화·리플레이**([REC]/[REPLAY], 단계별 스크린샷 HTML 타임라인) | 클라우드 그룹 live view·replay |
| **P2 ✅ v0.9.0** | **CDP 호환 엔드포인트**: Puppeteer `connect`·Playwright `connectOverCDP` 무수정 동작 검증(standalone) | P4 대응: "실제 브라우저 백엔드" |
| **P2 ✅ v0.9.0** | **learnings 공유**(스킬 레지스트리 push/pull, 파일 export/import) + `// @save` 레시피 자동 저장 | P8, 스킬 경쟁 |
| **P2 ✅ v0.9.0** | CDP minimal 모드(필요할 때만 붙고 즉시 해제)로 안내줄 노출 최소화 | 가로채지 않음 품질 |
| **P3 ✅ v0.9.0** | WebMCP 중계(네이티브 래핑 + 폴리필, list/call) | P10 |
| **P3 ✅ v0.9.0** | 사용자 위임 에이전트 신원(Web Bot Auth 서명, 확장 자체 [FETCH] 한정) | P6 |

## 8. 출처 (그룹 보고에서 발췌, 대표)
- ego lite: https://lite.ego.app · https://github.com/citrolabs/ego-lite
- Claude in Chrome: https://support.claude.com/en/articles/12012173-claude-in-chrome · Cowork 내장 브라우저: https://claude.com/resources/articles/cowork-built-in-browser
- Codex for Chrome: https://www.thurrott.com/a-i/openai-a-i/335842/openai-brings-codex-to-google-chrome
- Nanobrowser: https://github.com/nanobrowser/nanobrowser/releases
- Playwright MCP 확장 모드: https://playwright.dev/mcp/configuration/browser-extension
- Chrome DevTools for agents 1.0: https://developer.chrome.com/blog/devtools-for-agents-v1
- Chrome 136 원격 디버깅 변경: https://developer.chrome.com/blog/remote-debugging-port
- Atlas 종료: https://en.wikipedia.org/wiki/ChatGPT_Atlas · Mariner 종료: https://www.gigazine.net/gsc_news/en/20260507-google-shuts-down-project-mariner
- Chrome auto browse: https://9to5google.com/2026/01/28/chrome-gemini-auto-browse/
- Edge 업데이트: https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/
- WebMCP origin trial: https://developer.chrome.com/blog/ai-webmcp-origin-trial
- Gartner AI 브라우저 차단 권고: https://www.csoonline.com/article/4102571/keep-ai-browsers-out-of-your-enterprise-warns-gartner-2.html
- Browserbase 가격: https://www.browserbase.com/pricing · Browser Use 가격: https://browser-use.com/pricing.md · Kernel: https://www.kernel.sh/pricing · Steel: https://steel.dev/pricing
- Cloudflare Browser Run: https://developers.cloudflare.com/browser-run/changelog/
- AgentCore browser profiles: https://aws.amazon.com/ko/about-aws/whats-new/2026/02/amazon-bedrock-agentcore-browser-profiles/
- BrowserOS: https://github.com/browseros-ai/BrowserOS · Lightpanda: https://enterprisedna.co/directories/mcp/lightpanda-io-browser
