# Google Apps Script 운영 방법

GitHub Actions 스케줄은 꺼두고, 실제 알림 실행은 Google Apps Script 시간 기반 트리거로 돌리는 버전입니다.

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
4. Discord에 초기화 메시지가 오면 정상입니다.

초기화 실행은 현재 목록을 기준선으로 저장하고, 다음 실행부터 새 공지만 알립니다.

## 기본 10시, 17시 트리거 설치

함수 선택 드롭다운에서 `installProductionTriggers`를 선택하고 한 번 실행합니다.

이 함수는 기존 `runSogangNoticeBot` 트리거를 지운 뒤, 한국시간 기준 매일 10:00 근처와 17:00 근처에 실행되는 시간 기반 트리거를 만듭니다. Apps Script의 `nearMinute(0)`은 정확히 0분 고정이 아니라 약간의 오차가 있을 수 있습니다.

설치 후 왼쪽 시계 아이콘 `Triggers`에서 `runSogangNoticeBot` 트리거 2개가 보이면 됩니다.

직접 트리거 시간을 추가하거나 바꾸면, `runSogangNoticeBot`은 그 트리거가 실행된 시간마다 Discord로 결과를 보냅니다. 같은 한국시간 날짜-시간대 안에서 중복 실행된 경우에만 한 번 더 보내지 않습니다.

## 수동 실행과 초기화

- `runSogangNoticeBotManual`: 지금 바로 한 번 확인하고 Discord로 결과를 보냅니다.
- `runSogangNoticeBot`: 트리거용 함수입니다. 트리거가 실행된 시간마다 결과를 보내고, 같은 시간대 중복 알림을 막습니다.
- `deleteBotTriggers`: 설치된 봇 트리거를 지웁니다.
- `resetBotState`: 저장된 공지 확인 상태를 지웁니다. 다음 실행 때 다시 초기화 메시지가 갑니다.
