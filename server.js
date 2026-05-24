const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const ORDER_URL =
  process.env.U7BUY_ORDER_URL ||
  "https://www.u7buy.com/member/sold-order/details?orderId=";
const NEW_ORDER_EVENT = "new_order_received";
const ORDER_ID_KEYS = ["orderId", "order_id", "orderNo", "order_no"];
const STATE_FILE = path.join(__dirname, "data", "u7buy-state.json");
const WEBHOOK_PATHS = ["/webhook", "/u7buy"];

const notifiedKeys = new Set();
const inFlightKeys = new Set();
let lastWebhookAt = null;

if (!DISCORD_WEBHOOK) {
  console.warn(
    "[startup] DISCORD_WEBHOOK is not set — notifications will be skipped."
  );
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const key of data.notified || []) {
      notifiedKeys.add(key);
    }
  } catch (err) {
    console.error("[dedupe] Could not load state:", err.message);
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ notified: [...notifiedKeys].slice(-1000) }, null, 2)
    );
  } catch (err) {
    console.error("[dedupe] Could not save state:", err.message);
  }
}

function dedupeKey(event, orderId) {
  return `${event}:${String(orderId)}`;
}

function beginNotification(event, orderId) {
  if (event !== NEW_ORDER_EVENT || orderId == null) {
    return { proceed: true, key: null };
  }

  const key = dedupeKey(event, orderId);

  if (notifiedKeys.has(key)) {
    console.log(`[webhook] Duplicate skipped (already notified): ${key}`);
    return { proceed: false, key, reason: "already_notified" };
  }

  if (inFlightKeys.has(key)) {
    console.log(`[webhook] Duplicate skipped (in progress): ${key}`);
    return { proceed: false, key, reason: "in_flight" };
  }

  inFlightKeys.add(key);
  return { proceed: true, key };
}

function completeNotification(key) {
  if (!key) {
    return;
  }
  notifiedKeys.add(key);
  inFlightKeys.delete(key);
  saveState();
}

function failNotification(key) {
  if (!key) {
    return;
  }
  inFlightKeys.delete(key);
}

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

function getMentionUserId() {
  return sanitizeMentionUserId(process.env.DISCORD_MENTION_USER_ID);
}

/** U7BUY order IDs exceed JS safe integer — read digits from raw JSON before parse. */
function extractOrderIdFromRaw(raw) {
  for (const key of ORDER_ID_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"?([\\d]+)"?`, "i");
    const match = raw.match(re);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function isWebhookPath(pathname) {
  return WEBHOOK_PATHS.some(
    (base) => pathname === base || pathname === `${base}/`
  );
}

function isWebhookRequest(url) {
  return url.includes("/webhook") || url.includes("/u7buy");
}

function extractEvent(data) {
  return (
    data?.event ??
    data?.type ??
    data?.eventType ??
    data?.data?.event ??
    data?.data?.type ??
    null
  );
}

function extractOrderId(data, req) {
  if (req?.preservedOrderId) {
    return req.preservedOrderId;
  }

  const block = data?.data ?? data;
  const parsed =
    ORDER_ID_KEYS.map((key) => block?.[key])
      .concat(ORDER_ID_KEYS.map((key) => data?.[key]))
      .find((value) => value != null) ?? null;

  return parsed == null ? null : String(parsed);
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
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
  }

  for (const key of ["payload", "body"]) {
    if (typeof parsed[key] === "string") {
      try {
        const inner = JSON.parse(parsed[key]);
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          parsed = { ...parsed, ...inner };
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof parsed.data === "string") {
    try {
      parsed = { ...parsed, data: JSON.parse(parsed.data) };
    } catch {
      /* ignore */
    }
  }

  return parsed;
}

function logWebhook(method, payload) {
  console.log(
    `[webhook] ${new Date().toISOString()} ${method}`,
    JSON.stringify(payload ?? {})
  );
}

const okResponse = (res) => res.status(200).json({ status: "OK" });

async function notifyDiscord(data, { skipDedupe = false, req = null } = {}) {
  if (!DISCORD_WEBHOOK) {
    return { sent: false, reason: "no_webhook" };
  }

  const event = extractEvent(data);
  const orderId = extractOrderId(data, req);

  if (event !== NEW_ORDER_EVENT) {
    console.log(`[webhook] Ignored event "${event ?? "unknown"}"`);
    return { sent: false, reason: "ignored_event", event };
  }

  if (orderId == null) {
    console.warn("[webhook] new_order_received missing orderId");
    return { sent: false, reason: "missing_order_id" };
  }

  let key = null;
  if (!skipDedupe) {
    const dedupe = beginNotification(event, orderId);
    if (!dedupe.proceed) {
      return { sent: false, reason: dedupe.reason, orderId };
    }
    key = dedupe.key;
  }

  const orderIdStr = String(orderId);
  const message = `NEW ORDER\nOrder ID: ${orderIdStr}\nOrder link: ${ORDER_URL}${orderIdStr}`;
  const payload = { content: message };
  const mentionUserId = getMentionUserId();

  if (mentionUserId) {
    payload.content += `\n<@${mentionUserId}>`;
    payload.allowed_mentions = { parse: [], users: [mentionUserId] };
  }

  try {
    await axios.post(DISCORD_WEBHOOK, payload, { timeout: 15000 });
    if (key) {
      completeNotification(key);
    }
    console.log(`[webhook] Discord sent for order ${orderIdStr}`);
    return { sent: true, orderId: orderIdStr };
  } catch (err) {
    if (key) {
      failNotification(key);
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
    lastWebhookAt = new Date().toISOString();

    if (req.preservedOrderId) {
      const parsedId = extractOrderId(body, null);
      if (parsedId && parsedId !== req.preservedOrderId) {
        console.warn(
          `[webhook] orderId corrected: parsed=${parsedId} preserved=${req.preservedOrderId}`
        );
      }
    }

    okResponse(res);

    notifyDiscord(body, { req }).catch((err) => {
      console.error("[webhook] Discord failed:", err.message);
    });
  },
};

app.use(
  express.json({
    verify: (req, res, buf) => {
      const url = req.originalUrl || req.url || "";
      if (!isWebhookRequest(url)) {
        return;
      }
      const raw = buf.toString("utf8");
      req.rawBody = raw;
      req.preservedOrderId = extractOrderIdFromRaw(raw);
    },
  })
);
app.use(express.urlencoded({ extended: true }));

for (const base of WEBHOOK_PATHS) {
  app.get(base, webhookHandler.get);
  app.get(`${base}/`, webhookHandler.get);
  app.post(base, webhookHandler.post);
  app.post(`${base}/`, webhookHandler.post);
}

app.get("/", (req, res) => {
  res.send("Webhook running");
});

app.get("/webhook/status", (req, res) => {
  res.status(200).json({
    discordWebhookConfigured: Boolean(DISCORD_WEBHOOK),
    mentionConfigured: Boolean(getMentionUserId()),
    dedupe: {
      notifiedCount: notifiedKeys.size,
      inFlightCount: inFlightKeys.size,
    },
    lastWebhookAt,
    hint: lastWebhookAt
      ? "Webhook is receiving requests from U7BUY."
      : "If lastWebhookAt stays null after a real order, U7BUY is not calling this server.",
  });
});

app.post("/webhook/test", async (req, res) => {
  const payload = {
    event: req.body?.event || NEW_ORDER_EVENT,
    data: { orderId: req.body?.orderId ?? String(Date.now()) },
  };

  try {
    if (!DISCORD_WEBHOOK) {
      return res.status(200).json({
        status: "OK",
        discord: false,
        message: "DISCORD_WEBHOOK is not set",
        payload,
      });
    }

    const result = await notifyDiscord(payload, { skipDedupe: true });
    return res.status(200).json({
      status: "OK",
      discord: result.sent,
      payload,
      result,
    });
  } catch (err) {
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

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    if (isWebhookPath(req.path)) {
      console.error("[webhook] Invalid JSON — returning OK:", err.message);
      lastWebhookAt = new Date().toISOString();
      return okResponse(res);
    }
  }
  next(err);
});

loadState();

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
