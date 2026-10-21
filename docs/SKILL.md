---
name: webclaw
description: DureClaw 플릿의 브라우저 노드(webclaw Chrome 확장, v0.11.0+; 플릿·curl 운영자용 가이드 — 에이전트용 요약은 skills/webclaw/SKILL.md)에 마커 태스크를 디스패치해 로그인된 브라우저 세션으로 웹 작업(읽기·클릭·폼 입력·JS·다운로드·탭 열기·CDP 네이티브 조작·@ref 아웃라인·[RUN] 스크립트·에이전트 Space)을 수행하고, 페이지 위 HUD 채팅으로 사용자와 양방향 대화하며 작업한다. 사용자가 "webclaw로", "브라우저 노드로", "HUD 채팅", "플릿으로 웹 작업" 등을 요청할 때 사용. Trigger: /webclaw
---

# webclaw — DureClaw 브라우저 노드 조작 스킬

webclaw는 Chrome 확장 형태의 DureClaw 플릿 노드다. **사용자의 로그인 세션(쿠키)을 그대로 쓰는 브라우저 손** + **페이지 위 양방향 채팅(HUD)** 을 제공한다. 마스터(이 세션)가 두뇌, webclaw가 손이다.

```
사용자 ⇄ 탭 위 HUD 채팅(💬 webclaw chat)
              ⇅ WebSocket
      dureclaw 버스 (localhost:4000, Phoenix) — 저장·중계만
              ⇅ HTTP API
      마스터(이 세션) — 판단·마커 디스패치·결과 회신
```

## 0-a. 가장 쉬운 길 (v0.8.0): CLI/MCP

`node ~/dev/webclaw/bin/webclaw.cjs doctor` 한 줄로 설정·버스·인증·노드·왕복을 전부 확인한다. 이후 `webclaw do "[마커]"`, `webclaw run flow.js`, 또는 MCP(`claude mcp add webclaw -- node ~/dev/webclaw/bin/webclaw.cjs mcp`)의 `webclaw_*` 도구를 쓰면 아래 curl 디스패치·폴링을 직접 할 필요가 없다. 노드 자동 선택(1개일 때), 구버전 버스 task_id 처리, 실패 reason 승격이 내장돼 있다. 서버 없이 쓰려면 `webclaw setup --standalone`(로컬 미니버스).

## 0-b. v0.9.0~0.11.0 — 정책·감사·녹화·릴레이·WebMCP·신원·System One 두뇌

- **정책은 사람만 설정**(팝업 🛡️): deny 도메인 → `policy_denied`, ask 모드 → HUD에 승인 요청 안내가 뜨고 툴바 배지가 켜지며, 사용자는 **사이드패널/팝업의 버튼**(이번만·이 사이트·거절)으로 답한다(120초 → `approval_timeout`). v0.11부터 HUD 채팅의 `/allow`는 받지 않는다 — 페이지 스크립트가 위조할 수 있기 때문. `confirmRisky`면 결제·삭제·송금처럼 보이는 동작은 매번 승인. 마스터는 `[POLICY]`로 읽기만 가능 — 거절은 우회하지 말고 사용자에게 보고.
- `[AUDIT] [n]` 감사 로그 · `[REC] on <라벨>` … `[REC] off` → `[REPLAY]` HTML 타임라인(단계별 스크린샷) 다운로드.
- `[RUN]` 첫 줄 `// @save <도메인>/<이름>` → 성공 시 레시피 자동 저장. `webclaw learnings push|pull`(레지스트리)·`export|import`(파일).
- **v0.11 System One 두뇌**: `webclaw goal '<값이 들어간 목표>' [--brain jev|laya] [--save d/n]` — 단계마다 LLM 대신 구조화 판단 1회. 저장 레시피는 값을 담지 않으므로 재생 시 `[RECIPE] d/n\n{"v1":"…","password":"…"}`로 넘긴다(시작 전에 모두 검사). `webclaw brain`(Brain URL)은 `setup`이 만든 brainToken이 필요하고 `mode:"goal"` 요청만 브라우저를 움직인다.
- 입력값(비밀번호 포함)은 HUD·감사 로그·녹화에 남지 않는다(길이만). CDP 접속 URL은 버스 secret이 아닌 CDP 전용 파생 토큰.
- `[WEBMCP] list` / `[WEBMCP] call <tool> {json}` — 페이지의 WebMCP 도구를 어떤 에이전트에든 중계.
- `[IDENTITY] init` → Ed25519 키, 팝업에서 켜면 `[FETCH]`에 Web Bot Auth 서명.
- standalone 모드: `webclaw cdp-url` → Puppeteer `connect` / Playwright `connectOverCDP` 그대로 사용(Space "cdp" 탭만 노출).
- CDP 모드(팝업): auto / minimal(필요할 때만 붙고 즉시 해제) / off.

## 0. 연결 확인 (항상 먼저)

```bash
# 버스 0.4.0+: 시크릿은 서버 데이터 디렉터리 파일에 있다
SECRET=$(cat ~/.oah-server/data/server.secret)
curl -sf http://localhost:4000/api/health          # {"ok":true,...}
curl -sf -H "Authorization: Bearer $SECRET" http://localhost:4000/api/presence
# 401이면 클라이언트 secret과 server.secret 비교
```

- presence에서 `webclaw@chrome-XXXX` 노드의 **정확한 이름·버전·work_key** 확인. 없으면 사용자에게 확장 연결 요청.
- **노드 2개 이상** = Chrome 프로필 여러 개(로그인 세션이 다름). 반드시 `to`로 특정 노드 지정, `[TABS]`로 목적 사이트 로그인 프로필 확인. 팝업 요약줄(`✓ webclaw@chrome-XXXX @ 버스 · 워크키 · 버전`)로 사용자도 구분 가능(v0.4.3+).
- 버전이 낮으면 사용자에게 **확장 재로드** 요청(chrome://extensions → 새로고침). 코드 수정 후에도 재로드 필수.

## 1. 태스크 디스패치 / 결과 수신

```bash
# 디스패치 (task_id는 항상 유니크: 이름-$(date +%s%N))
curl -sf -X POST -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"work_key":"<WORK_KEY>","to":"webclaw@chrome-XXXX","task_id":"<ID>","instructions":"[마커] ..."}' \
  http://localhost:4000/api/task
# 결과 폴링 (1초 간격 ~25회) — 응답 results 배열에서 event=="task.result"인 마지막 항목의 output
curl -sf -H "Authorization: Bearer $SECRET" http://localhost:4000/api/task-result/<ID>
```

- **접속 확인 빠른 길**: `curl -s http://localhost:4000/api/health`(생존) → `node ~/dev/webclaw/test/presence.cjs`(붙은 노드 목록, REST presence가 비어도 정확) → `[RUN] return 'pong';` 왕복. 버스 0.4.0+ secret은 `~/.oah-server/data/server.secret`, 같은 맥에서는 secret 없이도 REST 가능(`OAH_TRUST_LOOPBACK=1`).
- **구버전 버스 주의**: 2026-03 빌드(0.3.0)는 요청한 `task_id`를 무시하고 자체 `http-<ms>` id를 응답하며 `/api/task-result`가 없다(404). 항상 **POST 응답의 `task_id`로 `GET /api/task/<id>`** 폴링(200=완료, 202=대기) — 모든 버전에서 동작. `/api/presence`도 구버전은 빈 목록을 줄 수 있으니 노드 확인은 WS join 응답의 presences로.
- `work_key`는 노드가 join한 키와 **정확히 일치**(presence 확인). 불일치 시 `queued` 응답 후 영원히 pending (#5).
- 결과 JSON에 대형 텍스트가 담기면 **invalid escape로 파싱이 깨질 수 있음** — `json.loads(..., strict=False)` + try/except, 실패 시 셀렉터를 좁혀 재요청.
- v0.3.3+는 수신 즉시 `task.ack` 이벤트 발신(버스 지원 시 delivered 판별).

## 2. 마커 레퍼런스 (v0.4.6 기본 + v0.7.0 추가)

`[NAME]` 또는 `[NAME@<url부분문자열>]`. `@조각`은 그 문자열이 URL에 포함된 탭을 타깃(discarded 탭 자동 스킵, 활성·최근 우선 — v0.4.2+). 생략 시 활성 탭.

| 마커 | 기능 | 응답 |
|---|---|---|
| `[TABS]` | 열린 탭 목록 | `* [win] 제목 — URL` 줄들 |
| `[OPEN] <url>` | **새 포그라운드 탭으로 열기**(세션 포함, 로드 완료 대기). "검색해봐" 류 지시는 결과를 긁지 말고 이걸로 직접 보여줘라 | `opened (tab N): 제목 — URL` |
| `[FETCH] <url>` | 확장 fetch (CORS 우회, 쿠키 포함, 텍스트 전용) | 본문 (2MB 캡) |
| `[DOM@site] <css?>` | 텍스트 읽기 (빈 쿼리=페이지 전체) | innerText |
| `[LINKS@site] <css?>` | 앵커 `{text, href}` JSON (기본 `a[href]`) | JSON 배열 |
| `[ATTR@site] <css> :: <attr>` | 요소들의 속성값 (이미지 src 수집 등) | JSON 배열 |
| `[CLICK@site] <css>` | 클릭 (+HUD 고스트 커서·리플) | `clicked <css> @x,y` |
| `[FILL@site] <css> = <값>` | 입력 후 **실제 반영값 재읽기** — 다르면 WARNING | `filled … = 실제값` |
| `[SUBMIT@site] <css>` | 폼 제출 | `submitted <css>` |
| `[JS@site] <code>` | 페이지 JS. **Promise면 await** — `(async()=>{…})()` 가능 | 결과 |
| `[DOWNLOAD] <url> [:: 하위경로/파일명]` | 브라우저 다운로드(세션 포함). **저장 대화상자 없이 즉시 저장**(saveAs:false, v0.4.5+), **직렬 큐(동시 1)**, **완료까지 대기** 후 경로+바이트. 120초 초과 시 `in_progress (id=N)` | `download complete (id=N) → 경로 (N bytes)` |
| `[DOWNLOAD?] <id>` | 다운로드 상태 재조회 | 상태+경로+바이트 |
| `[CANCEL] <id\|all>` | 다운로드 취소 | 결과 |
| `[HUD@site] on\|off` | 시각 감독 레이어 토글 | `hud on @ tab N` |
| `[SAY@site] <텍스트>` | 마스터 발화를 그 탭 채팅에 🤖로 표시 | `said @ tab N` |

- `[FILL]` 값에 ` = `가 포함되면 개행 구분 문법: `[FILL] <css>\n<값>`.
- 마커 없는 instructions는 브레인(LLM)으로 위임 — 이 스킬에선 마커만 쓴다.

### v0.7.0 추가 마커 — 네이티브(CDP)·@ref·스크립트·Space·학습

CDP(`chrome.debugger`)는 **업그레이드일 뿐 필수 아님** — 안 되면 기존 경로로 자동 폴백. 붙어 있는 동안 탭 상단에 "디버깅 중" 바가 뜨고 30초 유휴 후 자동 해제. 사용자가 그 바를 취소하면 그 탭은 10분간 CDP 안 씀.

| 마커 | 기능 | 응답 |
|---|---|---|
| `[OUTLINE@site] [max]` (`[SNAPSHOT]`) | 모든 프레임(교차 출처 iframe·shadow DOM 포함)의 상호작용 요소를 `@N` ref로 | `@12 button "로그인"` 줄들 |
| `[CLICK@site] <css\|@N>` | CDP 실제 마우스 클릭(isTrusted). 오버레이에 가리면 스크립트 클릭으로 폴백 | `clicked … (trusted) @x,y` |
| `[TYPE@site] <css\|@N>\n<텍스트>` | CDP 실제 텍스트 입력 + 재읽기 (React 입력창용). `[FILL]`은 기존 setter 방식 | `typed … = 값 (trusted)` |
| `[UPLOAD@site] <css\|@N> :: <절대경로>[, …]` | 파일 input에 로컬 파일 지정 (CDP 전용) | `uploaded …` |
| `[WAIT@site] <css\|@N\|text:문구> [:: ms]` | 나타나고 보일 때까지 대기(기본 10초) | `found … after Nms` / `timeout` |
| `[CDP@site] Domain.method {json}` | 원시 CDP. 쿠키 덤프·`Browser.*`·`Target.*` 등은 거부(`cdp_denied`) | 결과 JSON |
| `[RUN@site] <js>` | **여러 단계를 한 번에** — async 함수 본문, 헬퍼 주입, 샌드박스 실행(CSP 무관) | `{"result":…,"log":[…]}` |
| `[SPACE] <이름>` / `off` / `close <이름>` · `[SPACES]` | 포커스 안 뺏는 에이전트 전용 창의 탭 그룹. 이후 `@` 없는 마커는 Space를 대상으로 | 상태 |
| `[HANDOFF] [이름] [:: 메모]` · `[TAKEOVER] [이름]` | 사용자에게 제어권 넘김/회수. 넘긴 동안 변경 마커는 `handed_off` 실패(읽기는 허용). 사용자가 HUD에 `/done` 입력 시 반환 + 인박스 알림 | 상태 |
| `[LEARN] <도메인>\n<json>` · `[LEARNED] [도메인\|url]` · `[FORGET] <도메인>` | 사이트별 노트·셀렉터·레시피 저장/조회/삭제. 저장된 노트는 브레인 위임 프롬프트에 자동 첨부 | 요약 |
| `[RECIPE@site] <도메인>/<이름> [\n<json args>]` | 저장된 `[RUN]` 레시피 실행 (`args` 주입) | `[RUN]`과 동일 |

- `@N`은 `[CLICK]/[FILL]/[TYPE]/[SUBMIT]/[DOM]/[ATTR]/[UPLOAD]/[WAIT]/[DIFF] click:@N` 어디서나 셀렉터 대신 사용. 페이지 이동·재렌더로 사라지면 `reason: stale_ref` → `[OUTLINE]` 재실행.
- `[RUN]` 헬퍼: `open, outline, dom, links, attr, click, clickText, fill, type, submit, upload, wait, js, cdp, shot, snap, diff, close, tabs, fetchText, download, say, learned, space, useSpace, useTab, handOff, log, sleep, marker`. 실패한 마커는 `e.reason`을 가진 예외 → `try/catch` 가능. 미처리 시 태스크가 그 reason으로 실패. 스크립트 안에서 `[RUN]` 중첩 불가, 제한 180초.
- Space 지정: `[CLICK@space:leads] …`, 스크립트는 `useSpace('leads')` — 병렬 스크립트끼리 충돌하지 않게 하려면 전역 `[SPACE]` 대신 이걸 써라.

## 3. HUD — 시각 감독 + 양방향 채팅

**구성** (CSP 무관 — 확장의 정적 함수 주입이라 [JS]가 막히는 사이트에서도 동작):
- 형광 테두리: **액션 실행 중에만** 점등, 마지막 동작 3초 후 소등 (v0.4.3+ — 상시 깜빡임은 소음)
- 고스트 커서 🖱️ + 리플: [CLICK] 좌표에 표시
- `💬 webclaw chat — 이 탭의 대화`: 액션 로그 + 채팅 + 하단 입력창

**탭 단위 세션 (v0.4.6)**: 대화는 탭별로 저장·복원 — 같은 탭에서 페이지를 이동해도 이어지고, 다른 탭에는 안 보인다. 탭을 닫으면 세션 종료. 다운로드 등 탭 무관 이벤트는 마지막 대화 탭에 **[전체]** 뱃지로 표시.

**사용자 지시 수신 (인박스 폴링)**:
```bash
# 슬롯 = hud-inbox-<노드명> (@는 %40). 서버는 누적 저장(유실 없음)
curl -sf -H "Authorization: Bearer $SECRET" \
  "http://localhost:4000/api/task-result/hud-inbox-webclaw%40chrome-XXXX"
# results[].output = {"text":"지시","url":"입력한 탭","seq":타임스탬프}
```
- **seq 기준으로 새 메시지 판별** — 마지막 처리 seq를 기억하고 초과분만 처리(과거분 재처리 금지, 밀린 지시는 최신 것 수행).
- 백그라운드 워처(3초 폴링, 감지 시 종료→알림) 패턴 사용. **워처는 1건 감지 후 죽는다 — 처리 후 반드시 재가동**. pkill 정리 후에도 재가동 확인. (빠뜨리면 사용자에겐 "연결 안 됨"으로 보인다 — 실제 사고 2회.)
- 워처는 1개만(같은 슬롯 동시 폴링은 진단을 꼬이게 함).

**처리 루프 (필수 관행)**:
```
수신 → [SAY] 📥 수신: "<지시>" — 실행합니다      (즉시, 침묵 금지)
→ 단계마다 [SAY] 🔍 조사중… / ⬇️ 다운로드 중 (n/N) / ⚙️ 실행 중…
→ 수행 (과정은 HUD 테두리·커서·로그로 자동 표시)
→ [SAY] ✅ 결과 요약  (+결과 페이지는 [OPEN]으로 눈앞에)
```
- 페이지 이동 후에도 [SAY]는 그 탭에 HUD를 재생성하며 대화를 복원한다.

## 4. 핵심 패턴

**로그인 탭 타깃 고정**: `[TABS]` → 목적 사이트 URL 조각 확인 → 이후 모든 마커에 `@조각` 고정.

**쓰기 → 저장 → 검증 (write→read-back, 필수)**: 액션 성공 응답을 믿지 말고 저장값을 다시 읽어라.
```
[FILL@site] input[name="x"] = 95      → 반영값 확인 (WARNING 시 중단)
[CLICK@site] button[name="save"]
[JS@site] (async()=>{ await new Promise(r=>setTimeout(r,2500));
  return document.querySelector('input[name="x"]').value; })()
```

**대량 다운로드**: 직렬 큐가 브라우저의 다중 다운로드 차단·중복을 원천 방지. 파일명 충돌은 `:: 폴더/이름`으로. `in_progress`면 `[DOWNLOAD?] id`로 재조회 — **디스크 폴링·맹목 재시도 금지**. 실전 검증: `[ATTR] img :: src` 수집 → 개별 `[DOWNLOAD] url :: tigers/tiger-N.jpg` 10연속 10/10 무결.

**아웃라인 → ref로 조작 (v0.7.0, 셀렉터 추측 금지)**: `[OUTLINE@site]` → 원하는 줄의 `@N` → `[CLICK@site] @N` / `[TYPE@site] @N\n값`. 다단계는 `[RUN]` 한 번으로:
```
[RUN@site]
const o = await outline(); log(o.split('\n').slice(0, 30).join('\n'));
await type('@7', 'webclaw'); await click('@8'); await wait('text:결과');
return await links('.result a');
```

**사용자 개입이 필요한 단계(로그인·캡차·결제 확인)**: `[SPACE] job` → 작업 → `[HANDOFF] job :: 로그인 부탁드립니다` → 인박스에서 `[space job] user returned control (/done)` 수신 → 재개.

**링크·속성 수집 → 개별 처리**: `[LINKS] table a[href*="…"]` 또는 `[ATTR] img :: src` → 각 URL을 [DOWNLOAD]/[FETCH]/[OPEN].

## 5. 함정과 한계

- **CSP 사이트에서 [JS]**: v0.7.0부터 CDP `Runtime.evaluate`로 자동 재시도. CDP가 꺼져 있으면 여전히 `js blocked by page CSP…` → 정적 마커로 우회. HUD·[SAY]·[RUN]은 CSP 무관.
- **CDP 한계**: 메인 프레임 기준 — iframe 안 `@N` 클릭은 스크립트 클릭으로 폴백, `[UPLOAD]`는 메인 프레임만. 다른 디버거(DevTools 확장 등)가 붙어 있거나 `cfg.cdp:"off"`면 `cdp_unavailable`.
- **Space 창은 포커스되지 않은 별도 창** — 가려진 창은 렌더링이 느려질 수 있다. 화면이 필요한 작업은 `[SHOT]`(CDP 캡처)로 확인.
- **설치/업데이트 직후 수 초**: offscreen 문서가 재생성되며 그 사이 받은 태스크 응답이 유실될 수 있다 — presence 재확인 후 디스패치.
- **출력 2MB 캡**: 초과 시 `…[truncated, N more bytes]` 트레일러. 보이면 셀렉터로 좁혀 재요청 — 잘린 결과를 전체로 착각 금지.
- **task-result JSON 파싱 실패 가능**(대형 output의 invalid escape) — strict=False+예외 처리.
- **응답 성공 ≠ 저장 완료** — write→read-back 생략 금지.
- **확장 업데이트/재로드 직후**: 노드 재연결 사이 태스크 유실 가능 — presence 재확인 후 디스패치.
- **[FETCH]는 텍스트 전용** — 바이너리(PDF·이미지)는 [DOWNLOAD]로 받아 로컬 처리.
- 소스: `~/dev/webclaw` (GitHub DureClaw/webclaw). 오픈 이슈: 버스 no_executor fail-fast(#5). 미구현: 브레인 자동 라우팅 — 현재 HUD 채팅은 **마스터가 폴링 중일 때만** 응답한다.

## 6. 도구 선택 기준

- **webclaw**: 사용자 Chrome 로그인 세션 필요, HUD로 사용자와 페이지 위 협업, 대량 다운로드, 플릿 파이프라인, 원격 머신.
- **claude-in-chrome(MCP)**: 같은 머신에서 스크린샷 확인·세밀한 판단 루프가 필요한 다단계 작업.
- 하이브리드 최적: 정찰·다운로드·사용자 대화는 webclaw, 시각 판단 조작은 claude-in-chrome.

## 부록: 버전 요약 (2026-07-03 하루의 진화)
0.3.2→0.3.3 신뢰성(async JS·다운로드 완료 대기·read-back·네비게이션 대기·task.ack) → 0.3.4 큐·[CANCEL]·[LINKS]/[ATTR]·truncation/CSP 명시 → 0.4.0 HUD(테두리·커서·로그) → 0.4.1 양방향 채팅+팝업 개편 → 0.4.2 discarded 탭 스킵·[OPEN] → 0.4.3 노드 신원 표시·동작 중에만 점등 → 0.4.4 대화 영속화 → 0.4.5 무클릭 저장(saveAs:false) → 0.4.6 탭 단위 세션+[전체] 뱃지. (이슈 #2~#11 전부 이 흐름에서 표준화→구현)
