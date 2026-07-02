# 서강대학교 일반대학원 공지 Discord 알림 봇

서강대학교 일반대학원 공지사항 두 게시판을 하루 두 번 확인하고 Discord 웹훅으로 결과를 보냅니다.

- 학사·수업·졸업: https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=401
- 장학·등록: https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=402

## 동작 방식

GitHub Actions가 한국시간 기준 매일 10시대, 17시대에 여러 번 실행을 시도하고, 각 시간대마다 한 번만 Discord로 결과를 보냅니다.

- 새 공지가 있으면 게시판명, 작성일, 제목, 상세 링크를 Discord로 보냅니다.
- 새 공지가 없으면 "새 공지는 없습니다" 메시지를 Discord로 보냅니다.
- GitHub 스케줄 지연/누락에 대비해 10:05, 10:15, 10:25, 10:35, 10:45, 10:55 및 17:05, 17:15, 17:25, 17:35, 17:45, 17:55에 실행 기회를 둡니다.
- 같은 시간대에 이미 결과를 보냈다면 나머지 실행은 중복 알림 없이 종료합니다.
- 첫 실행에서는 기존 공지를 새 공지로 쏟아내지 않고, 현재 목록을 기준선으로 저장합니다.
- 이후 실행부터 이전에 보지 못한 `pkid`를 새 공지로 판단합니다.

상태 파일은 `state/seen_notices.json`에 저장되고, 워크플로가 변경분을 자동 커밋합니다. 이 파일에는 확인한 공지와 이미 보고한 시간대가 함께 저장됩니다.

## GitHub 설정

1. Discord 채널 설정에서 웹훅 URL을 생성합니다.
2. GitHub 저장소의 `Settings` > `Secrets and variables` > `Actions`로 이동합니다.
3. `New repository secret`을 눌러 아래 Secret을 추가합니다.

```text
DISCORD_WEBHOOK_URL=디스코드_웹훅_URL
```

4. 저장소에 이 파일들을 push합니다.
5. `Actions` 탭에서 워크플로를 활성화합니다.
6. 필요하면 `Sogang graduate notice bot` 워크플로를 `Run workflow`로 수동 실행해 초기 상태를 만듭니다.

새 GitHub 저장소를 만든 뒤 이 로컬 저장소를 올릴 때는:

```bash
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Actions가 `state/seen_notices.json`을 자동 커밋해야 하므로, 저장소 설정에서 `Settings` > `Actions` > `General` > `Workflow permissions`가 `Read and write permissions`인지 확인하세요.

GitHub cron은 UTC 기준이라 워크플로에는 `5,15,25,35,45,55 1,8 * * *`로 설정되어 있습니다. 이는 한국시간 10:05-10:55, 17:05-17:55입니다. GitHub 스케줄 실행은 몇 분 지연되거나 일부 누락될 수 있어 여러 번 시도하고, 봇이 시간대별 중복 알림을 막습니다.

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
