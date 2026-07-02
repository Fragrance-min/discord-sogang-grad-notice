import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from unittest import mock

from sogang_notice_bot import (
    BOARDS,
    already_reported_slot,
    find_new_notices,
    load_state,
    parse_notice_list,
    report_slot_for_time,
    save_state,
    should_retry_discord_with_curl,
)


SAMPLE_HTML = """
<div class="list_box">
  <ul>
    <li>
      <div>
        <a href="/front/cmsboardview.do?currentPage=1&amp;bbsConfigFK=401&amp;siteId=gradsch&amp;pkid=938030" class="title">
          <strong>[공지] </strong>
          [학점교류] 2026학년도 2학기 서울대학교 학점교류 안내 (~7/9)
        </a>
        <div class="info">
          <span>gradsch</span>
          <span>2026.07.01</span>
          <span>41</span>
        </div>
        <a href="/Download?fileName=test.hwp" class="file_link"><span style="display:none;">첨부파일</span></a>
      </div>
    </li>
    <li>
      <div>
        <div>744</div>
        <a href="/front/cmsboardview.do?currentPage=1&amp;bbsConfigFK=401&amp;siteId=gradsch&amp;pkid=937001" class="title">
          2026-1 종합시험 결과 안내
        </a>
        <div class="info">
          <span>gradsch</span>
          <span>2026.04.24</span>
          <span>825</span>
        </div>
      </div>
    </li>
  </ul>
</div>
"""


class SogangNoticeBotTests(unittest.TestCase):
    def test_parse_notice_list_extracts_title_date_writer_and_pkid(self):
        notices = parse_notice_list(BOARDS[0], SAMPLE_HTML)

        self.assertEqual(len(notices), 2)
        self.assertEqual(notices[0].pkid, "938030")
        self.assertEqual(notices[0].posted_at, "2026.07.01")
        self.assertEqual(notices[0].writer, "gradsch")
        self.assertIn("[공지] [학점교류]", notices[0].title)
        self.assertTrue(notices[0].url.startswith("https://gradsch.sogang.ac.kr/front/cmsboardview.do"))

    def test_state_roundtrip_prevents_duplicate_notifications(self):
        notices = parse_notice_list(BOARDS[0], SAMPLE_HTML)

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "seen_notices.json"
            state = load_state(path)

            self.assertEqual(len(find_new_notices(notices, state)), 2)
            self.assertTrue(save_state(path, notices, state))
            next_state = load_state(path)
            self.assertEqual(find_new_notices(notices, next_state), [])

    def test_state_records_reported_slot(self):
        notices = parse_notice_list(BOARDS[0], SAMPLE_HTML)

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "seen_notices.json"
            state = load_state(path)

            self.assertTrue(save_state(path, notices, state, reported_slot="2026-07-02-17"))
            next_state = load_state(path)
            self.assertTrue(already_reported_slot(next_state, "2026-07-02-17"))
            self.assertFalse(save_state(path, notices, next_state, reported_slot="2026-07-02-17"))

    def test_report_slot_for_target_and_delayed_times(self):
        kst = ZoneInfo("Asia/Seoul")

        self.assertEqual(
            report_slot_for_time(datetime(2026, 7, 2, 17, 15, tzinfo=kst)),
            "2026-07-02-17",
        )
        self.assertEqual(
            report_slot_for_time(datetime(2026, 7, 2, 18, 20, tzinfo=kst)),
            "2026-07-02-17",
        )
        self.assertIsNone(report_slot_for_time(datetime(2026, 7, 2, 16, 59, tzinfo=kst)))

    def test_discord_cloudflare_1010_retries_only_when_curl_is_available(self):
        with mock.patch("sogang_notice_bot.shutil.which", return_value="/usr/bin/curl"):
            self.assertTrue(should_retry_discord_with_curl(403, "error code: 1010"))

        with mock.patch("sogang_notice_bot.shutil.which", return_value=None):
            self.assertFalse(should_retry_discord_with_curl(403, "error code: 1010"))

        with mock.patch("sogang_notice_bot.shutil.which", return_value="/usr/bin/curl"):
            self.assertFalse(should_retry_discord_with_curl(404, "error code: 1010"))


if __name__ == "__main__":
    unittest.main()
