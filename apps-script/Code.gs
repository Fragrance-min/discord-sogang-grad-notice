const GRADSCH_BASE_URL = "https://gradsch.sogang.ac.kr";
const TIME_ZONE = "Asia/Seoul";
const BOT_TRIGGER_FUNCTION = "runSogangNoticeBot";
const PROPERTY_DISCORD_WEBHOOK_URL = "DISCORD_WEBHOOK_URL";
const PROPERTY_INITIALIZED = "INITIALIZED";
const PROPERTY_MECHANICAL_CANONICAL_MIGRATION = "MECHANICAL_CANONICAL_MIGRATION_V1";
const MECHANICAL_MIGRATION_CUTOFF = "2026-08-31";
const SEEN_PREFIX = "seen.";
const REPORTED_PREFIX = "reported.";
const MAX_DISCORD_EMBEDS = 10;
const DISCORD_MAX_RETRIES = 4;
const DISCORD_RETRY_BASE_MS = 5000;
const DISCORD_MESSAGE_GAP_MS = 3000;
const MAX_SEEN_PROPERTIES = 500;
const MAX_REPORTED_PROPERTIES = 120;
const DEFAULT_TRIGGER_HOURS_KST = [10, 17];
const DISCORD_USER_AGENT =
  "DiscordBot (https://github.com/Fragrance-min/discord-sogang-grad-notice, 1.0)";

const BOARDS = [
  {
    id: "academics",
    name: "학사·수업·졸업",
    parser: "sogang_cms",
    url: "https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=401",
    color: 0x1f77b4,
  },
  {
    id: "scholarship_registration",
    name: "장학·등록",
    parser: "sogang_cms",
    url: "https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=402",
    color: 0x2ca02c,
  },
  {
    id: "mechanical_engineering",
    name: "기계공학과 공지사항",
    parser: "gnuboard",
    url: "https://me.sogang.ac.kr/ko/board/notice",
    color: 0xe67e22,
  },
];

function runSogangNoticeBot() {
  return runSogangNoticeBot_({ force: false });
}

function runSogangNoticeBotManual() {
  return runSogangNoticeBot_({ force: true });
}

function installProductionTriggers() {
  deleteBotTriggers();

  DEFAULT_TRIGGER_HOURS_KST.forEach(function (hour) {
    ScriptApp.newTrigger(BOT_TRIGGER_FUNCTION)
      .timeBased()
      .atHour(hour)
      .nearMinute(0)
      .everyDays(1)
      .inTimezone(TIME_ZONE)
      .create();
  });

  const triggerHoursText = DEFAULT_TRIGGER_HOURS_KST.map(function (hour) {
    return hour + ":00";
  }).join(" and ");
  const message =
    "Installed Sogang notice triggers near " + triggerHoursText + " " + TIME_ZONE + ".";
  console.log(message);
  return message;
}

function deleteBotTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === BOT_TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function verifySetup() {
  const properties = PropertiesService.getScriptProperties();
  getWebhookUrl_(properties);

  const notices = collectNotices_();
  const message =
    "Setup OK. Found " + notices.length + " notices across " + BOARDS.length + " boards.";
  console.log(message);
  return message;
}

function resetBotState() {
  const properties = PropertiesService.getScriptProperties();
  const allProperties = properties.getProperties();

  Object.keys(allProperties).forEach(function (key) {
    if (
      key === PROPERTY_INITIALIZED ||
      key === PROPERTY_MECHANICAL_CANONICAL_MIGRATION ||
      key.indexOf(SEEN_PREFIX) === 0 ||
      key.indexOf(REPORTED_PREFIX) === 0
    ) {
      properties.deleteProperty(key);
    }
  });
}

function runSogangNoticeBot_(options) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("Another Sogang notice bot run is already in progress.");
  }

  try {
    const force = Boolean(options && options.force);
    const now = new Date();
    const properties = PropertiesService.getScriptProperties();
    const webhookUrl = getWebhookUrl_(properties);
    const state = readState_(properties);
    const reportSlot = force ? null : reportSlotForDate_(now);

    if (!force && isWeekendKst_(now)) {
      console.log("Weekend in " + TIME_ZONE + "; skipping Discord notification.");
      return;
    }

    if (!force && state.reportedSlots[reportSlot]) {
      console.log("Already reported for slot " + reportSlot + "; skipping duplicate notification.");
      return;
    }

    const notices = collectNotices_();
    const mechanicalMigrationPending =
      state.initialized &&
      properties.getProperty(PROPERTY_MECHANICAL_CANONICAL_MIGRATION) !== "true";
    if (mechanicalMigrationPending) {
      migrateMechanicalNoticeState_(properties, notices, state);
    }

    const initializedBoardIds = {};
    Object.keys(state.seen).forEach(function (noticeId) {
      initializedBoardIds[noticeId.split(":", 1)[0]] = true;
    });
    const baselineBoardIds = {};
    BOARDS.forEach(function (board) {
      if (!initializedBoardIds[board.id] &&
          !(mechanicalMigrationPending && board.id === "mechanical_engineering")) {
        baselineBoardIds[board.id] = true;
      }
    });
    const newNotices = notices.filter(function (notice) {
      return !baselineBoardIds[notice.boardId] && !state.seen[notice.id];
    });

    if (!state.initialized) {
      markSeen_(properties, notices, state);
      properties.setProperty(PROPERTY_INITIALIZED, "true");
      properties.setProperty(PROPERTY_MECHANICAL_CANONICAL_MIGRATION, "true");
      pruneProperties_(properties, SEEN_PREFIX, MAX_SEEN_PROPERTIES);
      pruneProperties_(properties, REPORTED_PREFIX, MAX_REPORTED_PROPERTIES);
      console.log("Initialized baseline with " + notices.length + " notices; no Discord notification sent.");
      return;
    }

    const baselineBoardNames = BOARDS.filter(function (board) {
      return baselineBoardIds[board.id];
    }).map(function (board) {
      return board.name;
    });
    if (baselineBoardNames.length) {
      console.log(
        "Initialized new board baseline without Discord notification: " +
          baselineBoardNames.join(", ")
      );
    }

    if (newNotices.length) {
      sendNewNoticeMessages_(webhookUrl, newNotices);
      markReportedSlot_(properties, reportSlot);
    } else {
      console.log("No new notices; no Discord notification sent.");
    }

    markSeen_(properties, notices, state);
    pruneProperties_(properties, SEEN_PREFIX, MAX_SEEN_PROPERTIES);
    pruneProperties_(properties, REPORTED_PREFIX, MAX_REPORTED_PROPERTIES);
  } finally {
    lock.releaseLock();
  }
}

function collectNotices_() {
  const notices = [];

  BOARDS.forEach(function (board) {
    const html = fetchText_(board.url);
    const boardNotices = parseNoticeList_(board, html);
    if (!boardNotices.length) {
      throw new Error(
        "No notices parsed from " +
          board.name +
          ". The page may be blocked or its HTML changed."
      );
    }
    boardNotices.forEach(function (notice) {
      notices.push(notice);
    });
  });

  return notices;
}

function fetchText_(url) {
  const maxRetries = 4;
  const baseDelayMs = 5000;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = UrlFetchApp.fetch(url, {
      method: "get",
      followRedirects: true,
      muteHttpExceptions: true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SogangNoticeBot/1.0; +https://github.com)",
      },
    });
    const status = response.getResponseCode();

    if (status >= 200 && status < 300) {
      return response.getContentText("UTF-8");
    }

    const retryable = status === 429 || (status >= 500 && status < 600);
    if (!retryable || attempt === maxRetries) {
      const body = response.getContentText("UTF-8").slice(0, 500);
      throw new Error(
        "Failed to fetch " + url + " with HTTP " + status + ". Response: " + body
      );
    }

    const delayMs = fetchRetryAfterMs_(response, attempt, baseDelayMs);
    console.log(
      "Notice board fetch returned HTTP " +
        status +
        "; retrying in " +
        delayMs +
        " ms (retry " +
        (attempt + 1) +
        "/" +
        maxRetries +")."
    );
    Utilities.sleep(delayMs);
  }

  throw new Error("Failed to fetch " + url + " after retries.");
}

function fetchRetryAfterMs_(response, attempt, baseDelayMs) {
  const headers = response.getAllHeaders ? response.getAllHeaders() : {};
  const rawRetryAfter = headers["Retry-After"] || headers["retry-after"];
  const retryAfter = Array.isArray(rawRetryAfter)
    ? rawRetryAfter[0]
    : rawRetryAfter;
  const seconds = Number(retryAfter);

  if (isFinite(seconds) && seconds > 0) {
    return Math.min(60000, Math.max(1000, Math.ceil(seconds * 1000)));
  }

  return Math.min(60000, baseDelayMs * Math.pow(2, attempt));
}

function parseNoticeList_(board, html) {
  if (board.parser === "gnuboard") {
    return parseGnuboardNoticeList_(board, html);
  }

  const notices = [];
  const seenPkids = {};
  const itemRegex = /<li\b[\s\S]*?<\/li>/gi;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(html)) !== null) {
    const itemHtml = itemMatch[0];
    const anchor = findTitleAnchor_(itemHtml);
    if (!anchor) {
      continue;
    }

    const url = normalizeNoticeUrl_(anchor.href);
    const pkid = extractPkid_(url);
    if (!pkid || seenPkids[pkid]) {
      continue;
    }

    const spans = extractSpanTexts_(itemHtml);
    const postedAt = findFirst_(spans, function (part) {
      return /^\d{4}\.\d{2}\.\d{2}$/.test(part);
    });
    const writer = findFirst_(spans, function (part) {
      return (
        part &&
        part !== postedAt &&
        part !== "첨부파일" &&
        !/^[\d,]+$/.test(part)
      );
    });

    seenPkids[pkid] = true;
    notices.push({
      id: board.id + ":" + pkid,
      boardId: board.id,
      boardName: board.name,
      boardUrl: board.url,
      title: cleanText_(stripTags_(anchor.html)),
      url: url,
      pkid: pkid,
      postedAt: postedAt || null,
      writer: writer || null,
      color: board.color,
    });
  }

  return notices;
}

function parseGnuboardNoticeList_(board, html) {
  const notices = [];
  const seenIds = {};
  const rowRegex = /<tr\b[\s\S]*?<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[0];
    const anchor = findGnuboardTitleAnchor_(rowHtml);
    if (!anchor) {
      continue;
    }

    const url = normalizeGnuboardNoticeUrl_(board, anchor.href);
    const wrId = extractGnuboardNoticeId_(url);
    if (!wrId || seenIds[wrId]) {
      continue;
    }

    const cells = extractCellTexts_(rowHtml);
    const postedAt = findFirst_(cells, function (part) {
      return /\d{4}[.-]\d{2}[.-]\d{2}/.test(part);
    });
    const normalizedPostedAt = postedAt
      ? /\d{4}[.-]\d{2}[.-]\d{2}/.exec(postedAt)[0]
      : null;
    let dateIndex = cells.findIndex(function (part) {
      return /^\d{4}[.-]\d{2}[.-]\d{2}$/.test(part);
    });
    if (dateIndex === -1) {
      dateIndex = cells.findIndex(function (part) {
        return /\d{4}[.-]\d{2}[.-]\d{2}/.test(part);
      });
    }
    const writer = dateIndex > 0 ? cells[dateIndex - 1] : null;

    seenIds[wrId] = true;
    notices.push({
      id: board.id + ":" + wrId,
      boardId: board.id,
      boardName: board.name,
      boardUrl: board.url,
      title: cleanText_(stripTags_(anchor.html)),
      url: url,
      pkid: wrId,
      postedAt: normalizedPostedAt,
      writer: writer || null,
      color: board.color,
    });
  }

  return notices;
}

function findGnuboardTitleAnchor_(html) {
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchorMatch;

  while ((anchorMatch = anchorRegex.exec(html)) !== null) {
    const href = decodeHtml_(extractAttribute_(anchorMatch[1], "href"));
    if (
      href &&
      ((href.indexOf("board.php") !== -1 && extractQueryValue_(href, "wr_id")) ||
        /\/ko\/board\/notice\/\d+/.test(href))
    ) {
      return { href: href, html: anchorMatch[2] };
    }
  }

  return null;
}

function extractCellTexts_(html) {
  const cells = [];
  const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let cellMatch;

  while ((cellMatch = cellRegex.exec(html)) !== null) {
    cells.push(cleanText_(stripTags_(cellMatch[1])));
  }

  return cells;
}

function normalizeGnuboardNoticeUrl_(board, href) {
  const absolute = toAbsoluteUrlForBase_(href, board.url);
  const newPathMatch = /^(https?:\/\/[^/]+\/ko\/board\/notice\/\d+)/i.exec(absolute);
  if (newPathMatch) {
    return newPathMatch[1];
  }
  const questionIndex = absolute.indexOf("?");
  const path = questionIndex === -1 ? absolute : absolute.slice(0, questionIndex);
  const query = parseQuery_(questionIndex === -1 ? "" : absolute.slice(questionIndex + 1));
  const keys = ["bo_table", "wr_id", "sca"];
  const parts = [];

  keys.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(query[key]));
    }
  });

  return parts.length ? path + "?" + parts.join("&") : path;
}

function findTitleAnchor_(html) {
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchorMatch;

  while ((anchorMatch = anchorRegex.exec(html)) !== null) {
    const attrs = anchorMatch[1];
    const href = extractAttribute_(attrs, "href");
    const className = extractAttribute_(attrs, "class");

    if (
      href &&
      href.indexOf("cmsboardview.do") !== -1 &&
      (" " + className + " ").indexOf(" title ") !== -1
    ) {
      return {
        href: decodeHtml_(href),
        html: anchorMatch[2],
      };
    }
  }

  return null;
}

function extractSpanTexts_(html) {
  const spans = [];
  const spanRegex = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
  let spanMatch;

  while ((spanMatch = spanRegex.exec(html)) !== null) {
    const value = cleanText_(stripTags_(spanMatch[1]));
    if (value) {
      spans.push(value);
    }
  }

  return spans;
}

function extractAttribute_(attrs, name) {
  const quoted = new RegExp(name + "\\s*=\\s*([\"'])(.*?)\\1", "i").exec(attrs);
  if (quoted) {
    return quoted[2];
  }

  const unquoted = new RegExp(name + "\\s*=\\s*([^\\s>]+)", "i").exec(attrs);
  return unquoted ? unquoted[1] : "";
}

function normalizeNoticeUrl_(href) {
  const absolute = toAbsoluteUrl_(decodeHtml_(href));
  const hashless = absolute.split("#")[0];
  const questionIndex = hashless.indexOf("?");
  if (questionIndex === -1) {
    return hashless;
  }

  const path = hashless.slice(0, questionIndex);
  const query = parseQuery_(hashless.slice(questionIndex + 1));
  const desiredKeys = [
    "bbsConfigFK",
    "siteId",
    "pkid",
    "currentPage",
    "searchField",
    "searchLowItem",
    "searchValue",
  ];
  const parts = [];

  desiredKeys.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(query[key]));
    }
  });

  return parts.length ? path + "?" + parts.join("&") : path;
}

function toAbsoluteUrl_(href) {
  return toAbsoluteUrlForBase_(href, GRADSCH_BASE_URL);
}

function toAbsoluteUrlForBase_(href, baseUrl) {
  if (/^https?:\/\//i.test(href)) {
    return href;
  }
  const baseMatch = /^(https?:\/\/[^/]+)/i.exec(baseUrl);
  const origin = baseMatch ? baseMatch[1] : GRADSCH_BASE_URL;
  if (href.indexOf("/") === 0) {
    return origin + href;
  }
  const basePath = baseUrl.split("?")[0];
  return basePath.slice(0, basePath.lastIndexOf("/") + 1) + href;
}

function parseQuery_(queryText) {
  const query = {};
  if (!queryText) {
    return query;
  }

  queryText.split("&").forEach(function (part) {
    if (!part) {
      return;
    }

    const separatorIndex = part.indexOf("=");
    const rawKey = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : part.slice(separatorIndex + 1);
    const key = safeDecodeURIComponent_(rawKey.replace(/\+/g, " "));
    if (!Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = safeDecodeURIComponent_(rawValue.replace(/\+/g, " "));
    }
  });

  return query;
}

function extractPkid_(url) {
  return extractQueryValue_(url, "pkid");
}

function extractQueryValue_(url, key) {
  const questionIndex = url.indexOf("?");
  if (questionIndex === -1) {
    return "";
  }
  return parseQuery_(url.slice(questionIndex + 1))[key] || "";
}

function extractGnuboardNoticeId_(url) {
  const queryId = extractQueryValue_(url, "wr_id");
  if (queryId) {
    return queryId;
  }
  const pathMatch = /\/ko\/board\/notice\/(\d+)/i.exec(url);
  return pathMatch ? pathMatch[1] : "";
}

function getWebhookUrl_(properties) {
  const webhookUrl = (properties.getProperty(PROPERTY_DISCORD_WEBHOOK_URL) || "").trim();
  if (!webhookUrl) {
    throw new Error(
      "Missing script property DISCORD_WEBHOOK_URL. Add it in Apps Script Project Settings."
    );
  }

  if (
    webhookUrl.indexOf("https://discord.com/api/webhooks/") !== 0 &&
    webhookUrl.indexOf("https://discordapp.com/api/webhooks/") !== 0
  ) {
    throw new Error("DISCORD_WEBHOOK_URL must be the full Discord webhook URL.");
  }

  return webhookUrl;
}

function readState_(properties) {
  const allProperties = properties.getProperties();
  const seen = {};
  const reportedSlots = {};

  Object.keys(allProperties).forEach(function (key) {
    if (key.indexOf(SEEN_PREFIX) === 0) {
      seen[key.slice(SEEN_PREFIX.length)] = parseJsonOrNull_(allProperties[key]) || {};
    }

    if (key.indexOf(REPORTED_PREFIX) === 0) {
      reportedSlots[key.slice(REPORTED_PREFIX.length)] = allProperties[key];
    }
  });

  return {
    initialized: allProperties[PROPERTY_INITIALIZED] === "true",
    seen: seen,
    reportedSlots: reportedSlots,
  };
}

function markSeen_(properties, notices, state) {
  const now = checkedAtIso_();
  const updates = {};

  notices.forEach(function (notice) {
    if (state.seen[notice.id]) {
      return;
    }

    updates[SEEN_PREFIX + notice.id] = JSON.stringify({
      boardName: notice.boardName,
      title: notice.title,
      url: notice.url,
      pkid: notice.pkid,
      postedAt: notice.postedAt,
      firstSeenAt: now,
    });
  });

  if (Object.keys(updates).length) {
    properties.setProperties(updates);
  }
}

function migrateMechanicalNoticeState_(properties, notices, state) {
  const oldMechanicalNotices = notices.filter(function (notice) {
    return (
      notice.boardId === "mechanical_engineering" &&
      normalizeNoticeDate_(notice.postedAt) <= MECHANICAL_MIGRATION_CUTOFF
    );
  });

  markSeen_(properties, oldMechanicalNotices, state);
  oldMechanicalNotices.forEach(function (notice) {
    state.seen[notice.id] = state.seen[notice.id] || {
      boardName: notice.boardName,
      title: notice.title,
      url: notice.url,
      pkid: notice.pkid,
      postedAt: notice.postedAt,
    };
  });
  properties.setProperty(PROPERTY_MECHANICAL_CANONICAL_MIGRATION, "true");
  console.log(
    "Migrated " + oldMechanicalNotices.length +
      " pre-September mechanical engineering notices without notification."
  );
}

function normalizeNoticeDate_(value) {
  return String(value || "").replace(/[.]/g, "-").slice(0, 10);
}

function markReportedSlot_(properties, reportSlot) {
  if (reportSlot) {
    properties.setProperty(REPORTED_PREFIX + reportSlot, checkedAtIso_());
  }
}

function pruneProperties_(properties, prefix, keepMax) {
  const allProperties = properties.getProperties();
  const entries = Object.keys(allProperties)
    .filter(function (key) {
      return key.indexOf(prefix) === 0;
    })
    .map(function (key) {
      const data = parseJsonOrNull_(allProperties[key]);
      return {
        key: key,
        timestamp:
          (data && (data.firstSeenAt || data.reportedAt)) || allProperties[key] || "",
      };
    })
    .sort(function (left, right) {
      return left.timestamp < right.timestamp ? -1 : left.timestamp > right.timestamp ? 1 : 0;
    });

  const deleteCount = entries.length - keepMax;
  if (deleteCount <= 0) {
    return;
  }

  entries.slice(0, deleteCount).forEach(function (entry) {
    properties.deleteProperty(entry.key);
  });
}

function reportSlotForDate_(date) {
  return Utilities.formatDate(date, TIME_ZONE, "yyyy-MM-dd-HH");
}

function isWeekendKst_(date) {
  const ymd = Utilities.formatDate(date, TIME_ZONE, "yyyy-MM-dd");
  const kstNoon = new Date(ymd + "T12:00:00+09:00");
  const day = kstNoon.getUTCDay();
  return day === 0 || day === 6;
}

function sendNewNoticeMessages_(webhookUrl, notices) {
  const sortedNotices = notices.slice().sort(compareNotices_);
  const checkedAt = checkedAtText_();

  for (let start = 0; start < sortedNotices.length; start += MAX_DISCORD_EMBEDS) {
    const chunk = sortedNotices.slice(start, start + MAX_DISCORD_EMBEDS);
    postDiscord_(webhookUrl, {
      content:
        "서강대학교 새 공지 " +
        chunk.length +
        "건을 발견했어요. (" +
        checkedAt +
        ")",
      embeds: chunk.map(noticeToEmbed_),
    });
    if (start + MAX_DISCORD_EMBEDS < sortedNotices.length) {
      Utilities.sleep(DISCORD_MESSAGE_GAP_MS);
    }
  }
}

function postDiscord_(webhookUrl, payload) {
  for (let attempt = 0; attempt <= DISCORD_MAX_RETRIES; attempt += 1) {
    const response = UrlFetchApp.fetch(webhookUrl, {
      method: "post",
      contentType: "application/json; charset=utf-8",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        Accept: "application/json",
        "User-Agent": DISCORD_USER_AGENT,
      },
    });
    const status = response.getResponseCode();

    if (status >= 200 && status < 300) {
      return;
    }

    const body = response.getContentText();
    if (status !== 429 || attempt === DISCORD_MAX_RETRIES) {
      throw new Error(
        "Discord webhook failed with HTTP " +
          status +
          ". Response: " +
          truncate_(body, 500)
      );
    }

    const retryAfterMs = discordRetryAfterMs_(response, attempt);
    console.log(
      "Discord rate limited the webhook; retrying in " +
        retryAfterMs +
        " ms (attempt " +
        (attempt + 1) +
        "/" +
        DISCORD_MAX_RETRIES +
        ")."
    );
    Utilities.sleep(retryAfterMs);
  }
}

function discordRetryAfterMs_(response, attempt) {
  const headers = response.getAllHeaders ? response.getAllHeaders() : {};
  const retryAfter = headers["Retry-After"] || headers["retry-after"];
  const retryAfterSeconds = parseFloat(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
  if (isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(60000, Math.max(1000, Math.ceil(retryAfterSeconds * 1000)));
  }
  return Math.min(60000, DISCORD_RETRY_BASE_MS * Math.pow(2, attempt));
}

function noticeToEmbed_(notice) {
  const fields = [{ name: "게시판", value: notice.boardName, inline: true }];

  if (notice.postedAt) {
    fields.push({ name: "작성일", value: notice.postedAt, inline: true });
  }
  if (notice.writer) {
    fields.push({ name: "작성자", value: notice.writer, inline: true });
  }

  return {
    title: truncate_(notice.title, 256),
    url: notice.url,
    color: notice.color,
    fields: fields,
  };
}

function compareNotices_(left, right) {
  const leftKey = [left.postedAt || "", left.boardId, left.pkid].join("\u0000");
  const rightKey = [right.postedAt || "", right.boardId, right.pkid].join("\u0000");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function truncate_(value, limit) {
  const text = String(value || "");
  if (limit <= 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit - 1).replace(/\s+$/g, "") + "…";
}

function cleanText_(value) {
  return decodeHtml_(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags_(html) {
  return String(html || "").replace(/<[^>]*>/g, " ");
}

function decodeHtml_(value) {
  return String(value || "")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_match, code) {
      return String.fromCharCode(parseInt(code, 16));
    })
    .replace(/&#(\d+);/g, function (_match, code) {
      return String.fromCharCode(parseInt(code, 10));
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function safeDecodeURIComponent_(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function parseJsonOrNull_(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function findFirst_(items, predicate) {
  for (let index = 0; index < items.length; index += 1) {
    if (predicate(items[index])) {
      return items[index];
    }
  }
  return null;
}

function checkedAtText_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss") + " KST";
}

function checkedAtIso_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss") + " KST";
}
