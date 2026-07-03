const BASE_URL = "https://gradsch.sogang.ac.kr";
const TIME_ZONE = "Asia/Seoul";
const BOT_TRIGGER_FUNCTION = "runSogangNoticeBot";
const PROPERTY_DISCORD_WEBHOOK_URL = "DISCORD_WEBHOOK_URL";
const PROPERTY_INITIALIZED = "INITIALIZED";
const SEEN_PREFIX = "seen.";
const REPORTED_PREFIX = "reported.";
const MAX_DISCORD_EMBEDS = 10;
const MAX_SEEN_PROPERTIES = 500;
const MAX_REPORTED_PROPERTIES = 120;
const DEFAULT_TRIGGER_HOURS_KST = [10, 17];
const DISCORD_USER_AGENT =
  "DiscordBot (https://github.com/Fragrance-min/discord-sogang-grad-notice, 1.0)";

const BOARDS = [
  {
    id: "academics",
    name: "학사·수업·졸업",
    url: "https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=401",
    color: 0x1f77b4,
  },
  {
    id: "scholarship_registration",
    name: "장학·등록",
    url: "https://gradsch.sogang.ac.kr/front/cmsboardlist.do?siteId=gradsch&bbsConfigFK=402",
    color: 0x2ca02c,
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
    const newNotices = notices.filter(function (notice) {
      return !state.seen[notice.id];
    });

    if (!state.initialized) {
      sendFirstRunMessage_(webhookUrl, notices.length);
      markSeen_(properties, notices, state);
      properties.setProperty(PROPERTY_INITIALIZED, "true");
      markReportedSlot_(properties, reportSlot);
      pruneProperties_(properties, SEEN_PREFIX, MAX_SEEN_PROPERTIES);
      pruneProperties_(properties, REPORTED_PREFIX, MAX_REPORTED_PROPERTIES);
      return;
    }

    if (newNotices.length) {
      sendNewNoticeMessages_(webhookUrl, newNotices);
    } else {
      sendNoNewMessage_(webhookUrl, notices.length);
    }

    markSeen_(properties, notices, state);
    markReportedSlot_(properties, reportSlot);
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
    parseNoticeList_(board, html).forEach(function (notice) {
      notices.push(notice);
    });
  });

  return notices;
}

function fetchText_(url) {
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

  if (status < 200 || status >= 300) {
    throw new Error("Failed to fetch " + url + " with HTTP " + status + ".");
  }

  return response.getContentText("UTF-8");
}

function parseNoticeList_(board, html) {
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
  if (/^https?:\/\//i.test(href)) {
    return href;
  }
  if (href.indexOf("/") === 0) {
    return BASE_URL + href;
  }
  return BASE_URL + "/" + href;
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
  const questionIndex = url.indexOf("?");
  if (questionIndex === -1) {
    return "";
  }
  return parseQuery_(url.slice(questionIndex + 1)).pkid || "";
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
        "서강대학교 일반대학원 새 공지 " +
        chunk.length +
        "건을 발견했어요. (" +
        checkedAt +
        ")",
      embeds: chunk.map(noticeToEmbed_),
    });
  }
}

function sendNoNewMessage_(webhookUrl, totalCount) {
  postDiscord_(webhookUrl, {
    content:
      "서강대학교 일반대학원 새 공지는 없습니다. 현재 확인한 목록 공지 " +
      totalCount +
      "건 기준입니다. (" +
      checkedAtText_() +
      ")",
  });
}

function sendFirstRunMessage_(webhookUrl, totalCount) {
  postDiscord_(webhookUrl, {
    content:
      "서강대학교 일반대학원 공지 알림 봇을 초기화했어요. 현재 목록 공지 " +
      totalCount +
      "건을 기준선으로 저장했고, 다음 실행부터 새 공지를 알려드립니다. (" +
      checkedAtText_() +
      ")",
  });
}

function postDiscord_(webhookUrl, payload) {
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

  if (status < 200 || status >= 300) {
    throw new Error(
      "Discord webhook failed with HTTP " +
        status +
        ". Response: " +
        truncate_(response.getContentText(), 500)
    );
  }
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
