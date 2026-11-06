# Google Apps Script 운영 방법

GitHub Actions 스케줄은 꺼두고, 실제 알림 실행은 Google Apps Script 시간 기반 트리거로 돌리는 버전입니다.

감시 대상은 대학원 공지사항 2개 게시판, 기계공학과 공지사항 게시판, 서강대 일반공지 게시판입니다.

## 서강대 일반공지 게시판

- https://www.sogang.ac.kr/ko/story/notification-general 은 페이지 HTML에 목록이 없고, 브라우저가 `https://www.sogang.ac.kr/api/api/v1/mainKo/BbsData/boardList?...&bbsConfigFk=1` API로 목록을 불러옵니다. 봇도 이 API를 직접 읽습니다. 주소에 `api`가 두 번 들어가는 것이 맞습니다. `/api/v1/...`로 부르면 403이 납니다.
- 알림의 링크는 `https://www.sogang.ac.kr/ko/detail/{pkId}?bbsConfigFk=1` 형식입니다.
- 이 게시판은 실패해도 건너뛰도록(`optional: true`) 되어 있어서, API가 막히거나 형식이 바뀌어도 나머지 게시판 알림은 계속 갑니다. 건너뛴 경우 실행 로그에 `Skipping 서강대 일반공지 ...` 경고가 남습니다.
- 처음 추가된 뒤 첫 실행에서는 현재 일반공지 목록을 기준선으로 저장하고 알림을 보내지 않습니다. 기존 공지가 한꺼번에 쏟아지지 않습니다.
- 설치 후 `verifySetup`을 한 번 실행해서 로그에 `서강대 일반공지: N notices`가 보이는지 확인하세요. `FAILED (skipped)`가 보이면 Apps Script에서 이 API에 접근하지 못하는 상태입니다.

## 업로드

1. https://script.google.com 에서 새 프로젝트를 만듭니다.
2. `Code.gs` 내용을 Apps Script의 `Code.gs`에 붙여넣습니다.
3. 왼쪽 톱니바퀴 `Project Settings`에서 `Show "appsscript.json" manifest file in editor`를 켭니다.
4. 편집기에 보이는 `appsscript.json` 내용을 이 폴더의 `appsscript.json`로 교체합니다.

## Discord 웹훅 설정

`Project Settings` > `Script properties`에 아래 값을 추가합니다.

```text
DISCORD_WEBHOOK_URL=디스코드_웹훅_URL
```

이 값은 Apps Script 프로젝트 속성에만 저장되며, GitHub public repo에는 올라가지 않습니다.

## 최초 실행

1. 함수 선택 드롭다운에서 `verifySetup`을 선택하고 `Run`을 누릅니다.
2. Google 권한 승인 화면이 뜨면 승인합니다.
3. 함수 선택 드롭다운에서 `runSogangNoticeBotManual`을 선택하고 `Run`을 누릅니다.
4. 실행 로그에 현재 공지 목록을 기준선으로 저장했다는 메시지가 보이면 정상입니다.

초기화 실행은 현재 목록을 기준선으로 저장하고 Discord 메시지는 보내지 않습니다. 다음 실행부터 새 공지가 있을 때만 알립니다.

## 원하는 시간에 트리거 설치

함수 선택 드롭다운에서 `installProductionTriggers`를 선택하고 한 번 실행합니다.

이 함수는 기존 `runSogangNoticeBot` 트리거를 지운 뒤, 한국시간 기준 매일 10:00 근처와 17:00 근처에 실행되는 시간 기반 트리거를 만듭니다. Apps Script의 `nearMinute(0)`은 정확히 0분 고정이 아니라 약간의 오차가 있을 수 있습니다.

설치 후 왼쪽 시계 아이콘 `Triggers`에서 `runSogangNoticeBot` 트리거 2개가 보이면 됩니다.

직접 트리거 시간을 추가하거나 바꾸면, `runSogangNoticeBot`은 그 트리거가 실행된 시간마다 확인하고 새 공지가 있을 때만 Discord로 보냅니다. 같은 한국시간 날짜-시간대 안에서 이미 보낸 새 공지 알림은 한 번 더 보내지 않습니다.

원하는 기본 시간을 코드로 바꾸고 싶다면 `Code.gs` 맨 위의 값을 수정한 뒤 `installProductionTriggers`를 다시 실행합니다.

```js
const DEFAULT_TRIGGER_HOURS_KST = [10, 17];
```

예를 들어 9시, 13시, 18시에 받고 싶으면:

```js
const DEFAULT_TRIGGER_HOURS_KST = [9, 13, 18];
```

토요일과 일요일에는 트리거가 실행되어도 Discord 알림을 보내지 않습니다. 수동 테스트 함수 `runSogangNoticeBotManual`은 주말 제한을 무시하고 바로 확인하지만, 새 공지가 없으면 Discord 메시지를 보내지 않습니다.

## 재시도 동작

- 공지 게시판 요청이 HTTP 429 또는 5xx로 실패하면 최대 4번 다시 시도합니다. 응답에 `Retry-After` 헤더가 있으면 그 시간만큼 기다리고, 없으면 5초부터 두 배씩 늘려 기다립니다(최대 60초).
- Discord 웹훅이 HTTP 429(요청 제한)를 돌려주면 같은 방식으로 최대 4번 다시 보냅니다. 그 밖의 오류는 바로 실패로 처리합니다.
- 새 공지가 10건을 넘어 메시지를 여러 번 나눠 보낼 때는 메시지 사이에 3초씩 쉽니다.

관련 값은 `Code.gs` 맨 위의 `DISCORD_MAX_RETRIES`, `DISCORD_RETRY_BASE_MS`, `DISCORD_MESSAGE_GAP_MS`에서 바꿀 수 있습니다. 게시판 요청 재시도 값은 `fetchText_` 함수 안에 있습니다.

## 수동 실행과 초기화

- `runSogangNoticeBotManual`: 지금 바로 한 번 확인하고, 새 공지가 있을 때만 Discord로 보냅니다.
- `runSogangNoticeBot`: 트리거용 함수입니다. 트리거가 실행된 시간마다 확인하고, 새 공지가 있을 때만 Discord로 보냅니다.
- `deleteBotTriggers`: 설치된 봇 트리거를 지웁니다.
- `resetBotState`: 저장된 공지 확인 상태를 지웁니다. 다음 실행 때 현재 목록을 다시 기준선으로 저장합니다.
