# 서강대학교 일반대학원 공지 Discord 알림 봇

서강대학교 일반대학원 공지사항 두 게시판을 확인하고 Discord 웹훅으로 결과를 보냅니다.

- 학사·수업·졸업: https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=401
- 장학·등록: https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=402

## 동작 방식

현재 GitHub Actions 자동 스케줄은 꺼져 있습니다. GitHub 저장소는 코드 보관과 수동 테스트용으로 두고, 실제 운영은 `apps-script/`의 Google Apps Script 버전으로 실행합니다.

- 새 공지가 있으면 게시판명, 작성일, 제목, 상세 링크를 Discord로 보냅니다.
- 새 공지가 없으면 "새 공지는 없습니다" 메시지를 Discord로 보냅니다.
- Apps Script 운영 버전은 한국시간 기준 매일 10:00 근처와 17:00 근처에 확인합니다.
- 봇에는 시간대별 중복 알림 방지 로직이 들어 있어, 같은 시간대에 여러 번 실행되어도 한 번만 Discord로 말합니다.
- 첫 실행에서는 기존 공지를 새 공지로 쏟아내지 않고, 현재 목록을 기준선으로 저장합니다.
- 이후 실행부터 이전에 보지 못한 `pkid`를 새 공지로 판단합니다.

Python/GitHub Actions 버전의 상태 파일은 `state/seen_notices.json`에 저장됩니다. Apps Script 버전은 Google Apps Script의 Script Properties에 상태를 저장합니다.

## GitHub 설정

1. Discord 채널 설정에서 웹훅 URL을 생성합니다.
2. GitHub 저장소의 `Settings` > `Secrets and variables` > `Actions`로 이동합니다.
3. `New repository secret`을 눌러 아래 Secret을 추가합니다.

```text
DISCORD_WEBHOOK_URL=디스코드_웹훅_URL
```

4. 저장소에 이 파일들을 push합니다.
5. 필요하면 `Actions` 탭에서 `Sogang graduate notice bot` 워크플로를 `Run workflow`로 수동 실행합니다.

새 GitHub 저장소를 만든 뒤 이 로컬 저장소를 올릴 때는:

```bash
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Actions를 수동 실행할 때 `state/seen_notices.json`을 자동 커밋하려면, 저장소 설정에서 `Settings` > `Actions` > `General` > `Workflow permissions`가 `Read and write permissions`인지 확인하세요.

현재 워크플로에는 `schedule` 트리거가 없고 `workflow_dispatch`만 남아 있어 자동으로 돌지 않습니다.

## Google Apps Script 운영

실제 매일 알림 운영은 `apps-script/` 폴더를 사용합니다.

1. https://script.google.com 에서 새 Apps Script 프로젝트를 만듭니다.
2. `apps-script/Code.gs`와 `apps-script/appsscript.json` 내용을 업로드합니다.
3. Script Properties에 `DISCORD_WEBHOOK_URL`을 추가합니다.
4. `verifySetup`을 실행해 권한을 승인하고 설정을 확인합니다.
5. `runSogangNoticeBotManual`을 한 번 실행해 초기화 메시지를 받습니다.
6. `installProductionTriggers`를 한 번 실행해 한국시간 10시, 17시 트리거를 만듭니다.

자세한 순서는 `apps-script/README.md`에 정리되어 있습니다.

## 로컬 실행

Discord로 보내지 않고 페이로드만 확인하려면:

```bash
python sogang_notice_bot.py --dry-run
```

Discord로 실제 전송하려면:

```bash
set DISCORD_WEBHOOK_URL=디스코드_웹훅_URL
python sogang_notice_bot.py
```

PowerShell에서는:

```powershell
$env:DISCORD_WEBHOOK_URL="디스코드_웹훅_URL"
python sogang_notice_bot.py
```

첫 실행에서 현재 공지를 모두 새 공지로 보내고 싶다면:

```bash
python sogang_notice_bot.py --send-all-on-first-run
```

## 테스트

```bash
python -m unittest
```
