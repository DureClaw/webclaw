---
name: webclaw
description: DureClaw 플릿의 브라우저 노드(webclaw Chrome 확장, v0.3.4+)에 마커 태스크를 디스패치해 로그인된 브라우저 세션으로 웹 작업(읽기·클릭·폼 입력·JS·다운로드)을 수행한다. 사용자가 "webclaw로", "브라우저 노드로", "플릿으로 웹 작업" 등을 요청할 때 사용. Trigger: /webclaw
---

# webclaw — DureClaw 브라우저 노드 조작 스킬

webclaw는 Chrome 확장 형태의 DureClaw 플릿 노드다. **사용자의 로그인 세션(쿠키)을 그대로 쓰는 브라우저 손**을 제공한다 — LMS·사내 시스템처럼 로그인이 필요한 사이트를 API 없이 자동화할 때 쓴다. 마스터(이 세션)가 두뇌, webclaw가 손이다.

## 0. 연결 확인 (항상 먼저)

```bash
SECRET=$(ps aux | grep 'phx.server' | grep -o 'OAH_SECRET=[^ ]*' | head -1 | cut -d= -f2)
curl -sf http://localhost:4000/api/health   # {"ok":true,...} 여야 함
curl -sf -H "Authorization: Bearer $SECRET" http://localhost:4000/api/presence | python3 -m json.tool
```

- presence에 `webclaw@chrome-XXXX` 노드가 있어야 한다. 없으면 사용자에게 확장 연결(팝업에서 connect) 요청.
- **노드가 2개 이상**(`webclaw@chrome-ab12`, `webclaw@chrome-cd34`)이면 Chrome 프로필이 여러 개다. 프로필마다 로그인 세션이 다르므로 **반드시 `to`로 특정 노드를 지정**하고, 어떤 프로필이 목적 사이트에 로그인돼 있는지 `[TABS]`로 먼저 확인한다.
- 버전 확인: presence의 `version`이 `webclaw/0.3.4` 미만이면 사용자에게 확장 재로드를 요청(구버전은 async [JS]·다운로드 완료 대기·[LINKS] 등이 없다).

## 1. 태스크 디스패치 / 결과 수신

```bash
# 디스패치
curl -sf -X POST -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"work_key":"<WORK_KEY>","to":"webclaw@chrome-XXXX","task_id":"<유니크ID>","instructions":"[마커] ..."}' \
  http://localhost:4000/api/task

# 결과 폴링 (1~2초 간격, 최대 ~40회)
curl -sf -H "Authorization: Bearer $SECRET" http://localhost:4000/api/task-result/<task_id>
```

- `work_key`는 **노드가 join한 키와 정확히 일치**해야 한다(presence에서 확인). 불일치하면 서버는 `queued`라 답하지만 영원히 pending — 폴링 40회 후에도 pending이면 work_key 불일치나 노드 부재를 의심하라 (이슈 #5).
- v0.3.3+는 수신 즉시 `task.ack` 이벤트를 보낸다(버스가 지원할 때 delivered 판별 가능).
- `task_id`는 항상 유니크하게(`이름-$(date +%s)` 패턴).

## 2. 마커 레퍼런스 (v0.3.4)

모든 마커는 `[NAME]` 또는 `[NAME@<url부분문자열>]` 형식. `@url부분문자열`은 열린 탭 중 URL에 그 문자열이 포함된 탭을 타깃(로그인 세션 탭 지정의 핵심). 생략 시 활성 탭.

| 마커 | 기능 | 응답 |
|---|---|---|
| `[TABS]` | 열린 탭 목록 (로그인 세션 탐색용) | `* [win] 제목 — URL` 줄들 |
| `[FETCH] <url>` | 확장 컨텍스트 fetch (CORS 우회, 쿠키 포함) | 응답 텍스트 (2MB 캡) |
| `[DOM@site] <css?>` | 대상 탭 텍스트 읽기 (빈 쿼리=페이지 전체) | innerText |
| `[LINKS@site] <css?>` | 앵커를 `{text, href}` JSON으로 (기본 `a[href]`) | JSON 배열 |
| `[ATTR@site] <css> :: <attr>` | 매칭 요소들의 속성값 | JSON 배열 |
| `[CLICK@site] <css>` | 클릭 | `clicked <css>` |
| `[FILL@site] <css> = <값>` | 입력 (input/change 이벤트 포함) | **실제 반영값** 반환 — 보낸 값과 다르면 WARNING 포함 |
| `[SUBMIT@site] <css>` | 폼 제출 (또는 요소의 form.submit / click) | `submitted <css>` |
| `[JS@site] <code>` | 페이지 컨텍스트 JS 실행. **Promise 반환 시 await됨** — `(async()=>{...})()` 사용 가능 | 결과 문자열/JSON |
| `[DOWNLOAD] <url> [:: <하위경로/파일명>]` | 세션 포함 실제 다운로드. **완료까지 대기** 후 최종 경로+바이트 반환 (120초 초과 시 `in_progress (id=N)`) | `download complete (id=N) → 경로 (N bytes)` |
| `[DOWNLOAD?] <id>` | 진행 중 다운로드 상태 재조회 | 상태+경로+바이트 |
| `[CANCEL] <id\|all>` | 다운로드 취소 | 취소 결과 |
| `[HUD@site] on\|off` | **시각 감독 레이어**(v0.4.0+): 작업 중 탭 형광 테두리 + [CLICK] 시 고스트 커서·리플 + 우측 작업 로그 패널(+입력창) | `hud on @ tab N` |
| `[SAY@site] <텍스트>` | 마스터의 답장을 HUD 패널에 🤖로 표시 (v0.4.1+) | `said @ tab N` |

- **HUD는 CSP 무관** — 확장의 정적 함수 주입(isolated world)이라 [JS]가 막히는 사이트에서도 동작한다. 사용자가 지켜보는 브라우저에서 작업할 땐 `[HUD] on`으로 어느 탭에서 무엇을 하는지 보여주는 것이 예의다.

### 양방향 HUD 채팅 — 페이지에서 직접 지시 받기 (v0.4.1+)
사용자가 HUD 패널 하단 입력창에 지시를 입력하면(Enter), 노드의 **고정 인박스 슬롯**에 게시된다. 마스터는 이 슬롯을 폴링해 수신한다:
```bash
# 슬롯 ID = hud-inbox-<노드명> (@는 %40으로 인코딩)
curl -sf -H "Authorization: Bearer $SECRET" \
  "http://localhost:4000/api/task-result/hud-inbox-webclaw%40chrome-XXXX"
# → output = {"text":"<사용자 지시>","url":"<입력한 탭>","seq":<타임스탬프>}
```
- **seq를 기억**하고 이전 seq와 같으면 새 메시지 없음(슬롯은 최신 1건만 유지 — 덮어쓰기).
- 사용자와 상호작용 세션 중에는 2~5초 간격 폴링, 지시 수신 → 수행 → `[SAY]`로 결과 회신 루프.
- 사용자 입력은 HUD 패널(🧑)과 팝업 피드에도 에코된다.

- `[FILL]` 값에 ` = `가 들어가면 셀렉터와 값을 **개행으로 구분**하는 대체 문법 사용: `[FILL] <css>\n<값>`.
- 마커 없는 instructions는 브레인(LLM)으로 위임된다 — 이 스킬에선 마커만 쓴다.

## 3. 핵심 패턴

### 로그인 탭 찾기 → 타깃 고정
```
[TABS]                          → 목적 사이트 URL 조각 확인 (예: learnus.org)
[DOM@learnus.org]               → 이후 모든 마커에 @learnus.org 고정
```

### 쓰기 → 저장 → 검증 (write→read-back, 필수 관행)
쓰기 액션의 성공 응답을 믿지 말고 **저장된 값을 서버에서 다시 읽어 검증**한다:
```
[FILL@site] input[name="score"] = 95     → 응답의 실제 반영값 확인 (WARNING 시 중단)
[CLICK@site] button[name="save"]
[JS@site] (async()=>{ await new Promise(r=>setTimeout(r,2500));
  location.reload; return document.querySelector('input[name="score"]').value; })()
```
페이지 리로드가 필요한 검증은 `[CLICK]`(리로드 유발) 후 `[DOM]`/`[JS]`를 다시 보낸다 — v0.3.3+는 탭 로딩 완료를 기다린 후 주입하므로 반쯤 로드된 페이지를 읽지 않는다.

### AJAX 대기 후 읽기 (async [JS])
```
[JS@site] (async()=>{ document.querySelector('.comment-link').click();
  await new Promise(r=>setTimeout(r,2500));
  return [...document.querySelectorAll('.comment-content')].map(e=>e.innerText); })()
```

### 대량 다운로드 (자동 직렬화)
`[DOWNLOAD]`는 내부 큐로 1개씩 처리되므로 여러 태스크를 연속 디스패치해도 브라우저의 다중 다운로드 차단이 걸리지 않는다. 같은 파일명 충돌은 `:: 하위폴더/파일명`으로 분리:
```
[DOWNLOAD] https://site/file.php?id=1 :: batch-a/report.pdf
[DOWNLOAD] https://site/file.php?id=2 :: batch-b/report.pdf
```
- 응답이 `in_progress (id=N)`이면(2분+ 소요) 나중에 `[DOWNLOAD?] N`으로 재조회. **디스크 폴링·맹목 재시도 금지** — 중복 다운로드의 원인이다.
- 폭주했으면 `[CANCEL] all`.

### 링크 수집 → 개별 처리
```
[LINKS@site] table a[href*="pluginfile"]   → {text, href} JSON
→ 각 href를 [DOWNLOAD] 또는 [FETCH]로 개별 처리
```

## 4. 함정과 한계

- **CSP 사이트에서 [JS] 불가**: `unsafe-eval` 금지 페이지에선 `js blocked by page CSP...` 응답이 온다 → `[DOM]/[LINKS]/[CLICK]/[FILL]/[SUBMIT]` 정적 마커로 우회.
- **출력 2MB 캡**: 초과 시 끝에 `…[truncated, N more bytes]` 트레일러가 붙는다. 트레일러가 보이면 셀렉터로 범위를 좁혀 다시 읽어라 — 잘린 결과를 전체로 착각하지 말 것.
- **응답 성공 ≠ 저장 완료**: 위 write→read-back 패턴을 생략하지 마라.
- **확장 업데이트 직후**: 노드가 재연결되는 동안 태스크가 유실될 수 있다. presence 재확인 후 디스패치.
- **바이너리(FETCH)**: `[FETCH]`는 텍스트 전용 — PDF 등 바이너리는 `[DOWNLOAD]`로 받아 로컬에서 처리.
- 소스: `~/dev/webclaw` (GitHub DureClaw/webclaw). 미해결: 버스 측 no_executor fail-fast(#5).

## 5. 도구 선택 기준

- **webclaw를 쓸 때**: 원격/헤드리스 머신에서 사용자 Chrome의 로그인 세션이 필요할 때, 플릿 파이프라인(다른 노드와 조합)의 일부일 때, 가벼운 정찰·다운로드.
- **claude-in-chrome(MCP)이 나을 때**: 마스터가 같은 머신에서 대화형으로 복잡한 다단계 페이지 작업을 할 때(스크린샷 확인, 세밀한 판단 루프). 둘은 배타적이지 않다 — 정찰·다운로드는 webclaw, 판단이 필요한 조작은 claude-in-chrome으로 분담하는 하이브리드가 실전 최적.
