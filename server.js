const express = require("express");
const axios = require("axios");
const {
  beginNotification,
  completeNotification,
  failNotification,
  getStats,
} = require("./u7buy-dedupe");
const {
  recordWebhookPost,
  recordDiscordResult,
  getDiagnostics,
} = require("./u7buy-diagnostics");
const {
  startGameflipPoller,
  getGameflipStatus,
  sendTestNotification,
} = require("./gameflip");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";

function sanitizeMentionUserId(raw) {
  if (raw == null || raw === "") {
    return "";
  }

  let id = String(raw).trim().replace(/^["']|["']$/g, "");
  const mentionMatch = id.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    id = mentionMatch[1];
  }

  return /^\d{17,20}$/.test(id) ? id : "";
}

function getU7buyMentionUserId() {
  const fromU7buy = sanitizeMentionUserId(
    process.env.DISCORD_MENTION_USER_ID_U7BUY
  );
  if (fromU7buy) {
    return fromU7buy;
  }

  return sanitizeMentionUserId(process.env.DISCORD_MENTION_USER_ID);
}

const U7BUY_ORDER_URL =
  process.env.U7BUY_ORDER_URL ||
  "https://www.u7buy.com/member/sold-order/details?orderId=";

/** U7BUY order IDs exceed JS safe integer — read digits from raw JSON before parse. */
function extractOrderIdFromRaw(raw) {
  const keys = ["orderId", "order_id", "orderNo", "order_no"];
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"?([\\d]+)"?`, "i");
    const match = raw.match(re);
    if (match) {
      return match[1];
    }
  }
  return null;
}

app.use(
  express.json({
    verify: (req, res, buf) => {
      const path = req.originalUrl || req.url || "";
      if (!path.includes("/webhook") && !path.includes("/u7buy")) {
        return;
      }
      const raw = buf.toString("utf8");
      req.rawBody = raw;
      req.preservedOrderId = extractOrderIdFromRaw(raw);
    },
  })
);

app.use(express.urlencoded({ extended: true }));

const okResponse = (res) => res.status(200).json({ status: "OK" });

function logWebhook(method, payload) {
  console.log(
    `[webhook] ${new Date().toISOString()} ${method}`,
    JSON.stringify(payload ?? {})
  );
}

function extractOrderId(data, req) {
  if (req?.preservedOrderId) {
    return req.preservedOrderId;
  }

  const block = data?.data ?? data;
  const parsed =
    block?.orderId ?? block?.order_id ?? data?.orderId ?? data?.order_id;

  if (parsed == null) {
    return null;
  }

  return String(parsed);
}

function extractEvent(data) {
  return data?.event ?? data?.type ?? data?.eventType;
}

function normalizeWebhookBody(body, raw = "") {
  let parsed = body;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
    } else {
      parsed = {};
    }
  }

  for (const key of ["payload", "body"]) {
    if (typeof parsed[key] === "string") {
      try {
        const inner = JSON.parse(parsed[key]);
        if (inner && typeof inner === "object") {
          parsed = inner;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (parsed.data && typeof parsed.data === "string") {
    try {
      parsed = { ...parsed, data: JSON.parse(parsed.data) };
    } catch {
      /* ignore */
    }
  }

  return parsed;
}

async function notifyDiscord(data, { skipDedupe = false, req = null } = {}) {
  if (!DISCORD_WEBHOOK) {
    console.warn("[webhook] DISCORD_WEBHOOK not set — skipping Discord");
    return { sent: false, reason: "no_webhook" };
  }

  const event = extractEvent(data);
  const orderId = extractOrderId(data, req);

  if (event !== "new_order_received") {
    console.log(
      `[webhook] No Discord alert for event "${event ?? "unknown"}"`
    );
    return { sent: false, reason: "ignored_event", event };
  }

  if (orderId == null) {
    console.warn("[webhook] new_order_received missing orderId:", data);
    return { sent: false, reason: "missing_order_id" };
  }

  let dedupeKey = null;
  if (!skipDedupe) {
    const dedupe = beginNotification(event, orderId);
    if (!dedupe.proceed) {
      return { sent: false, reason: dedupe.reason, orderId };
    }
    dedupeKey = dedupe.key;
  }

  const orderIdStr = String(orderId);
  const message = `🛒 NEW ORDER\nOrder ID: ${orderIdStr}\nOrder link: ${U7BUY_ORDER_URL}${orderIdStr}`;
  const payload = { content: message };
  const mentionUserId = getU7buyMentionUserId();

  if (mentionUserId) {
    payload.content += `\n<@${mentionUserId}>`;
    payload.allowed_mentions = { parse: [], users: [mentionUserId] };
  }

  try {
    await axios.post(DISCORD_WEBHOOK, payload, { timeout: 15000 });
    if (dedupeKey) {
      completeNotification(dedupeKey);
    }
    console.log(`[webhook] Discord sent for order ${orderId}`);
    return { sent: true, orderId };
  } catch (err) {
    if (dedupeKey) {
      failNotification(dedupeKey);
    }
    throw err;
  }
}

const webhookHandler = {
  get: (req, res) => {
    logWebhook("GET", req.query);
    return okResponse(res);
  },
  post: (req, res) => {
    const body = normalizeWebhookBody(req.body, req.rawBody || "");
    logWebhook("POST", body);
    recordWebhookPost(req, body);

    if (req.preservedOrderId) {
      const parsedId = extractOrderId(body);
      if (parsedId && parsedId !== req.preservedOrderId) {
        console.warn(
          `[webhook] orderId precision corrected: parsed=${parsedId} → preserved=${req.preservedOrderId}`
        );
      }
    }

    okResponse(res);

    notifyDiscord(body, { req })
      .then((result) => {
        recordDiscordResult(result);
      })
      .catch((err) => {
        recordDiscordResult(null, err.message);
        console.error("[webhook] Discord notification failed:", err.message);
      });
  },
};

app.get("/webhook", webhookHandler.get);
app.get("/webhook/", webhookHandler.get);
app.post("/webhook", webhookHandler.post);
app.post("/webhook/", webhookHandler.post);

// Alias — same handler (some setups use /u7buy by mistake)
app.get("/u7buy", webhookHandler.get);
app.get("/u7buy/", webhookHandler.get);
app.post("/u7buy", webhookHandler.post);
app.post("/u7buy/", webhookHandler.post);

app.get("/", (req, res) => {
  res.send("Webhook running");
});

app.get("/webhook/status", (req, res) => {
  res.status(200).json({
    discordWebhookConfigured: Boolean(DISCORD_WEBHOOK),
    mentionConfigured: Boolean(getU7buyMentionUserId()),
    mentionSource: process.env.DISCORD_MENTION_USER_ID_U7BUY
      ? "DISCORD_MENTION_USER_ID_U7BUY"
      : process.env.DISCORD_MENTION_USER_ID
        ? "DISCORD_MENTION_USER_ID"
        : null,
    dedupe: getStats(),
    lastWebhook: getDiagnostics(),
    hint:
      "If lastWebhook.lastPostAt is null after a real order, U7BUY is not calling this server.",
  });
});

app.get("/gameflip/status", (req, res) => {
  res.status(200).json(getGameflipStatus());
});

app.post("/gameflip/test", async (req, res) => {
  try {
    const result = await sendTestNotification();
    return res.status(200).json({
      status: "OK",
      message: "Gameflip test notification sent to Discord",
      ...result,
    });
  } catch (err) {
    console.error("[gameflip] Test failed:", err.message);
    return res.status(500).json({ status: "ERROR", message: err.message });
  }
});

app.post("/webhook/test", async (req, res) => {
  const event = req.body?.event || "new_order_received";
  const orderId = req.body?.orderId ?? Date.now();

  const payload = {
    event,
    data: { orderId },
  };

  logWebhook("POST", payload);

  try {
    if (!DISCORD_WEBHOOK) {
      return res.status(200).json({
        status: "OK",
        discord: false,
        message: "Webhook OK but DISCORD_WEBHOOK is not set on Render",
        payload,
      });
    }

    const result = await notifyDiscord(payload, { skipDedupe: true });
    return res.status(200).json({
      status: "OK",
      discord: result.sent,
      message: `U7BUY test notification sent (${event})`,
      payload,
      result,
    });
  } catch (err) {
    console.error("[webhook] Test failed:", err.message);
    return res.status(500).json({ status: "ERROR", message: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    hint: "Use GET or POST /webhook (or /u7buy)",
  });
});

function isU7buyWebhookPath(path) {
  return (
    path === "/webhook" ||
    path === "/webhook/" ||
    path === "/u7buy" ||
    path === "/u7buy/"
  );
}

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    if (isU7buyWebhookPath(req.path)) {
      console.error(
        "[webhook] Invalid JSON body — still returning OK for U7BUY:",
        err.message,
        req.rawBody?.slice(0, 300) || ""
      );
      recordWebhookPost(req, {});
      recordDiscordResult(null, "invalid_json_body");
      return okResponse(res);
    }
  }
  next(err);
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  startGameflipPoller();
});
