#!/usr/bin/env python3
"""Check Sogang Graduate School notice boards and notify Discord."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


BASE_URL = "https://gradsch.sogang.ac.kr"
KST = ZoneInfo("Asia/Seoul")
DEFAULT_STATE_PATH = Path("state/seen_notices.json")
MAX_DISCORD_EMBEDS = 10
DISCORD_USER_AGENT = "DiscordBot (https://github.com/Fragrance-min/discord-sogang-grad-notice, 1.0)"

BOARDS = [
    {
        "id": "academics",
        "name": "학사·수업·졸업",
        "bbs_config_fk": "401",
        "url": "https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=401",
        "color": 0x1F77B4,
    },
    {
        "id": "scholarship_registration",
        "name": "장학·등록",
        "bbs_config_fk": "402",
        "url": "https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=402",
        "color": 0x2CA02C,
    },
]


@dataclass(frozen=True)
class Notice:
    board_id: str
    board_name: str
    board_url: str
    title: str
    url: str
    pkid: str
    posted_at: str | None
    writer: str | None

    @property
    def notice_id(self) -> str:
        return f"{self.board_id}:{self.pkid}"


class NoticeListParser(HTMLParser):
    """Extract notice rows from Sogang CMS board list HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.notices: list[dict[str, Any]] = []
        self._li_depth = 0
        self._current: dict[str, Any] | None = None
        self._in_title = False
        self._title_parts: list[str] = []
        self._span_depth = 0
        self._span_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {key: value or "" for key, value in attrs}

        if tag == "li":
            self._li_depth += 1
            self._current = None

        if tag == "a" and self._li_depth:
            classes = set(attr.get("class", "").split())
            href = attr.get("href", "")
            if "title" in classes and "cmsboardview.do" in href:
                self._current = {"href": href, "spans": []}
                self._title_parts = []
                self._in_title = True

        if tag == "span" and self._current is not None:
            self._span_depth += 1
            if self._span_depth == 1:
                self._span_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        elif self._span_depth and self._current is not None:
            self._span_parts.append(data)

    def handle_entityref(self, name: str) -> None:
        self.handle_data(html.unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        self.handle_data(html.unescape(f"&#{name};"))

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_title and self._current is not None:
            self._current["title"] = clean_text(" ".join(self._title_parts))
            self._in_title = False

        if tag == "span" and self._span_depth and self._current is not None:
            self._span_depth -= 1
            if self._span_depth == 0:
                text = clean_text(" ".join(self._span_parts))
                if text:
                    self._current["spans"].append(text)
                self._span_parts = []

        if tag == "li" and self._li_depth:
            if self._current and self._current.get("title") and self._current.get("href"):
                self.notices.append(self._current)
            self._current = None
            self._li_depth -= 1


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def fetch_text(url: str, retries: int = 3, timeout: int = 20) -> str:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            request = Request(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (compatible; SogangNoticeBot/1.0; "
                        "+https://github.com)"
                    )
                },
            )
            with urlopen(request, timeout=timeout) as response:
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                return raw.decode(charset, errors="replace")
        except (HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(2**attempt)
    raise RuntimeError(f"Failed to fetch {url}: {last_error}") from last_error


def parse_notice_list(board: dict[str, str], html_text: str) -> list[Notice]:
    parser = NoticeListParser()
    parser.feed(html_text)

    notices: list[Notice] = []
    for row in parser.notices:
        absolute_url = normalize_notice_url(row["href"])
        pkid = extract_pkid(absolute_url)
        if not pkid:
            continue

        spans = row.get("spans", [])
        posted_at = next((part for part in spans if re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", part)), None)
        writer = next((part for part in spans if part and part != posted_at and not part.replace(",", "").isdigit()), None)

        notices.append(
            Notice(
                board_id=board["id"],
                board_name=board["name"],
                board_url=board["url"],
                title=row["title"],
                url=absolute_url,
                pkid=pkid,
                posted_at=posted_at,
                writer=writer,
            )
        )
    return notices


def normalize_notice_url(href: str) -> str:
    absolute = urljoin(BASE_URL, href)
    parsed = urlparse(absolute)
    query = parse_qs(parsed.query, keep_blank_values=True)

    desired_keys = ["bbsConfigFK", "siteId", "pkid", "currentPage", "searchField", "searchLowItem", "searchValue"]
    normalized_query = {}
    for key in desired_keys:
        if key in query:
            normalized_query[key] = query[key][0]

    return parsed._replace(query=urlencode(normalized_query)).geturl()


def extract_pkid(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    return query.get("pkid", [""])[0]


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"seen": {}}
    with path.open("r", encoding="utf-8") as file:
        state = json.load(file)
    if "seen" not in state or not isinstance(state["seen"], dict):
        raise ValueError(f"Invalid state file: {path}")
    return state


def save_state(path: Path, notices: list[Notice], previous_state: dict[str, Any]) -> bool:
    now = datetime.now(KST).isoformat(timespec="seconds")
    seen = dict(previous_state.get("seen", {}))
    changed = False

    for notice in notices:
        if notice.notice_id not in seen:
            seen[notice.notice_id] = {
                "board_name": notice.board_name,
                "title": notice.title,
                "url": notice.url,
                "pkid": notice.pkid,
                "posted_at": notice.posted_at,
                "first_seen_at": now,
            }
            changed = True

    if not changed and path.exists():
        return False

    path.parent.mkdir(parents=True, exist_ok=True)
    next_state = {
        "generated_by": "sogang_notice_bot.py",
        "seen": dict(sorted(seen.items())),
    }
    with path.open("w", encoding="utf-8") as file:
        json.dump(next_state, file, ensure_ascii=False, indent=2)
        file.write("\n")
    return True


def collect_notices() -> list[Notice]:
    notices: list[Notice] = []
    for board in BOARDS:
        page = fetch_text(board["url"])
        notices.extend(parse_notice_list(board, page))
    return notices


def find_new_notices(notices: list[Notice], state: dict[str, Any]) -> list[Notice]:
    seen = state.get("seen", {})
    return [notice for notice in notices if notice.notice_id not in seen]


def post_discord(webhook_url: str, payload: dict[str, Any], dry_run: bool = False) -> None:
    if dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    post_discord_with_urllib(webhook_url, data)


def post_discord_with_urllib(webhook_url: str, data: bytes) -> None:
    request = Request(
        webhook_url,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": DISCORD_USER_AGENT,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            if response.status >= 300:
                body = response.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"Discord webhook failed with HTTP {response.status}: {truncate(body, 500)}"
                )
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if should_retry_discord_with_curl(exc.code, body):
            print(
                "Discord webhook returned Cloudflare 1010 via urllib; retrying once with curl.",
                file=sys.stderr,
            )
            post_discord_with_curl(webhook_url, data)
            return

        hint = discord_error_hint(exc.code)
        detail = f" Response: {truncate(body, 500)}" if body else ""
        raise RuntimeError(
            f"Discord webhook failed with HTTP {exc.code} {exc.reason}. {hint}{detail}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(f"Discord webhook request failed: {exc}") from exc


def should_retry_discord_with_curl(status_code: int, response_body: str) -> bool:
    return status_code == 403 and "1010" in response_body and shutil.which("curl") is not None


def post_discord_with_curl(webhook_url: str, data: bytes) -> None:
    curl_path = shutil.which("curl")
    if not curl_path:
        raise RuntimeError("Discord webhook urllib request hit Cloudflare 1010, and curl is not available.")

    result = subprocess.run(
        [
            curl_path,
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            "20",
            "--retry",
            "2",
            "--retry-delay",
            "2",
            "--retry-all-errors",
            "--request",
            "POST",
            "--header",
            "Content-Type: application/json; charset=utf-8",
            "--header",
            "Accept: application/json",
            "--header",
            f"User-Agent: {DISCORD_USER_AGENT}",
            "--data-binary",
            "@-",
            "--write-out",
            "\n%{http_code}",
            webhook_url,
        ],
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace").strip()

    if result.returncode != 0:
        detail = f" {truncate(stderr, 500)}" if stderr else ""
        raise RuntimeError(f"Discord webhook curl retry failed with exit code {result.returncode}.{detail}")

    body, separator, status_text = stdout.rpartition("\n")
    if not separator or not status_text.isdigit():
        raise RuntimeError(f"Discord webhook curl retry returned an unreadable response: {truncate(stdout, 500)}")

    status_code = int(status_text)
    if 200 <= status_code < 300:
        return

    hint = discord_error_hint(status_code)
    detail = f" Response: {truncate(body, 500)}" if body else ""
    raise RuntimeError(f"Discord webhook curl retry failed with HTTP {status_code}. {hint}{detail}")


def board_color(board_id: str) -> int:
    board = next((board for board in BOARDS if board["id"] == board_id), None)
    return int(board["color"]) if board else 0x5865F2


def send_new_notice_messages(webhook_url: str, notices: list[Notice], dry_run: bool = False) -> None:
    notices = sorted(notices, key=lambda item: (item.posted_at or "", item.board_id, item.pkid))
    checked_at = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST")

    for start in range(0, len(notices), MAX_DISCORD_EMBEDS):
        chunk = notices[start : start + MAX_DISCORD_EMBEDS]
        payload = {
            "content": f"서강대학교 일반대학원 새 공지 {len(chunk)}건을 발견했어요. ({checked_at})",
            "embeds": [notice_to_embed(notice) for notice in chunk],
        }
        post_discord(webhook_url, payload, dry_run=dry_run)


def notice_to_embed(notice: Notice) -> dict[str, Any]:
    fields = [
        {"name": "게시판", "value": notice.board_name, "inline": True},
    ]
    if notice.posted_at:
        fields.append({"name": "작성일", "value": notice.posted_at, "inline": True})
    if notice.writer:
        fields.append({"name": "작성자", "value": notice.writer, "inline": True})

    return {
        "title": truncate(notice.title, 256),
        "url": notice.url,
        "color": board_color(notice.board_id),
        "fields": fields,
    }


def send_no_new_message(webhook_url: str, total_count: int, dry_run: bool = False) -> None:
    checked_at = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST")
    payload = {
        "content": (
            "서강대학교 일반대학원 새 공지는 없습니다. "
            f"현재 확인한 목록 공지 {total_count}건 기준입니다. ({checked_at})"
        )
    }
    post_discord(webhook_url, payload, dry_run=dry_run)


def send_first_run_message(webhook_url: str, total_count: int, dry_run: bool = False) -> None:
    checked_at = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST")
    payload = {
        "content": (
            "서강대학교 일반대학원 공지 알림 봇을 초기화했어요. "
            f"현재 목록 공지 {total_count}건을 기준선으로 저장했고, 다음 실행부터 새 공지를 알려드립니다. "
            f"({checked_at})"
        )
    }
    post_discord(webhook_url, payload, dry_run=dry_run)


def truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def discord_error_hint(status_code: int) -> str:
    if status_code in {401, 403, 404}:
        return (
            "Check that DISCORD_WEBHOOK_URL is the full webhook URL from Discord "
            "and that the webhook was not deleted."
        )
    if status_code == 429:
        return "Discord rate-limited the webhook request. Retry the workflow later."
    if 400 <= status_code < 500:
        return "Discord rejected the webhook payload or URL."
    return "Discord returned a server error. Retry the workflow later."


def github_actions_escape(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def truthy_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def run(args: argparse.Namespace) -> int:
    state_path = Path(args.state)
    webhook_url = args.webhook_url or os.getenv("DISCORD_WEBHOOK_URL", "")
    dry_run = args.dry_run

    if not webhook_url and not dry_run:
        raise RuntimeError("DISCORD_WEBHOOK_URL is required unless --dry-run is used.")

    state_existed = state_path.exists()
    state = load_state(state_path)
    notices = collect_notices()
    new_notices = find_new_notices(notices, state)

    send_all_on_first_run = args.send_all_on_first_run or truthy_env("SEND_ALL_ON_FIRST_RUN")
    if not state_existed and not send_all_on_first_run:
        send_first_run_message(webhook_url, len(notices), dry_run=dry_run)
        if not dry_run:
            save_state(state_path, notices, state)
        return 0

    if new_notices:
        send_new_notice_messages(webhook_url, new_notices, dry_run=dry_run)
        if not dry_run:
            save_state(state_path, notices, state)
        return 0

    send_no_new_message(webhook_url, len(notices), dry_run=dry_run)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", default=str(DEFAULT_STATE_PATH), help="Path to the JSON state file.")
    parser.add_argument("--webhook-url", help="Discord webhook URL. Defaults to DISCORD_WEBHOOK_URL.")
    parser.add_argument("--dry-run", action="store_true", help="Print Discord payloads instead of sending.")
    parser.add_argument(
        "--send-all-on-first-run",
        action="store_true",
        help="Treat every current notice as new when the state file does not exist.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        if os.getenv("GITHUB_ACTIONS"):
            print(
                f"::error title=Sogang notice bot failed::{github_actions_escape(str(exc))}",
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
