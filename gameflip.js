const fs = require("fs");
const path = require("path");
const axios = require("axios");
const speakeasy = require("speakeasy");

const API_BASE =
  process.env.GAMEFLIP_API_BASE ||
  "https://production-gameflip.fingershock.com/api/v1";
const POLL_MS = Number(process.env.GAMEFLIP_POLL_INTERVAL_MS || 60000);
const STATE_FILE = path.join(__dirname, "data", "gameflip-state.json");

/** @type {Record<string, { status: string, handling_status: string, notified: object }>} */
const exchangeState = {};
let channelWebhooks = {};
let channelParseError = null;
let pollTimer = null;
let polling = false;

function getApiKey() {
  return process.env.GAMEFLIP_API_KEY || process.env.GFAPI_KEY || "";
}

function getApiSecret() {
  return process.env.GAMEFLIP_TOTP_SECRET || process.env.GFAPI_SECRET || "";
}

function getMentionUserId() {
  return process.env.DISCORD_MENTION_USER_ID || "";
}

function slugCategory(category) {
  return (category || "unknown")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function defaultNotified() {
  return { sale: false, shipped: false, delivered: false, complete: false };
}

function parseChannelWebhooksJson(raw) {
  if (!raw || !raw.trim()) {
    return {};
  }

  let text = raw.trim();

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }

  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function loadChannelWebhooksFromPrefix() {
  const prefix = "DISCORD_WEBHOOK_GAMEFLIP_";
  const map = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !value?.trim()) {
      continue;
    }
    const category = key.slice(prefix.length);
    map[slugCategory(category)] = value.trim();
  }

  return map;
}

function loadChannelWebhooks() {
  channelParseError = null;
  const raw = process.env.GAMEFLIP_CHANNEL_WEBHOOKS || "";
  let fromJson = {};

  if (raw.trim()) {
    try {
      fromJson = parseChannelWebhooksJson(raw);
    } catch (err) {
      channelParseError = err.message;
      console.error(
        "[gameflip] Invalid GAMEFLIP_CHANNEL_WEBHOOKS JSON:",
        err.message
      );
    }
  }

  const fromPrefix = loadChannelWebhooksFromPrefix();
  const merged = { ...fromJson, ...fromPrefix };
  const normalized = {};

  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string" && value.trim()) {
      normalized[slugCategory(key)] = value.trim();
    }
  }

  channelWebhooks = normalized;
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    if (data.exchangeState && typeof data.exchangeState === "object") {
      for (const [id, entry] of Object.entries(data.exchangeState)) {
        exchangeState[id] = {
          status: entry.status || "",
          handling_status: entry.handling_status || "",
          notified: { ...defaultNotified(), ...entry.notified },
        };
      }
      return;
    }

    // Migrate old seenIds-only state
    for (const id of data.seenIds || []) {
      exchangeState[id] = {
        status: "",
        handling_status: "",
        notified: { ...defaultNotified(), sale: true },
      };
    }
  } catch (err) {
    console.error("[gameflip] Could not load state:", err.message);
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const entries = Object.entries(exchangeState);
    const trimmed = entries.slice(-5000);
    const exchangeStateToSave = Object.fromEntries(trimmed);
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ exchangeState: exchangeStateToSave }, null, 2)
    );
  } catch (err) {
    console.error("[gameflip] Could not save state:", err.message);
  }
}

function authHeader() {
  const totp = speakeasy.totp({
    secret: getApiSecret(),
    encoding: "base32",
    algorithm: "sha1",
  });
  return `GFAPI ${getApiKey()}:${totp}`;
}

function webhookForCategory(category) {
  const slug = slugCategory(category);
  return (
    channelWebhooks[slug] ||
    channelWebhooks[category] ||
    channelWebhooks.default ||
    null
  );
}

function formatPrice(cents) {
  if (cents == null || Number.isNaN(Number(cents))) {
    return "—";
  }
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function exchangeDetails(exchange) {
  return [
    `**Item:** ${exchange.name || "Unknown item"}`,
    `**Type:** ${exchange.category || "unknown"}`,
    `**Price:** ${formatPrice(exchange.price)}`,
    `**Exchange ID:** ${exchange.id}`,
    `**Status:** ${exchange.status || "—"}`,
    `**Handling:** ${exchange.handling_status || "—"}`,
  ].join("\n");
}

function buildNewSaleMessage(exchange) {
  const mention = getMentionUserId() ? `<@${getMentionUserId()}>` : "";
  const lines = ["🛒 **NEW GAMEFLIP SALE**", exchangeDetails(exchange)];
  if (mention) {
    lines.push(mention);
  }
  return lines.join("\n");
}

function buildShippedMessage(exchange) {
  return ["📦 **GAMEFLIP ORDER SHIPPED**", exchangeDetails(exchange)].join(
    "\n"
  );
}

function buildDeliveredMessage(exchange) {
  return ["✅ **GAMEFLIP ORDER DELIVERED**", exchangeDetails(exchange)].join(
    "\n"
  );
}

function buildCompletedMessage(exchange) {
  return ["🏁 **GAMEFLIP ORDER COMPLETED**", exchangeDetails(exchange)].join(
    "\n"
  );
}

async function postDiscord(webhookUrl, content, { mention = false } = {}) {
  const payload = { content };
  const mentionUserId = mention ? getMentionUserId() : "";
  if (mentionUserId) {
    payload.allowed_mentions = { users: [mentionUserId] };
  }
  await axios.post(webhookUrl, payload);
}

async function sendExchangeNotification(exchange, message, options = {}) {
  const webhookUrl = webhookForCategory(exchange.category);
  if (!webhookUrl) {
    console.warn(
      `[gameflip] No Discord webhook for category "${exchange.category}" (exchange ${exchange.id})`
    );
    return;
  }
  await postDiscord(webhookUrl, message, options);
}

async function fetchSellerExchanges() {
  const lookbackDays = Number(process.env.GAMEFLIP_POLL_LOOKBACK_DAYS || 14);
  const since = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const params = new URLSearchParams({
    role: "seller",
    updated: `${since},any`,
  });

  const response = await axios.get(`${API_BASE}/exchange?${params}`, {
    headers: { Authorization: authHeader() },
    timeout: 30000,
  });

  if (response.data?.status !== "SUCCESS") {
    throw new Error(
      response.data?.error?.message || "Gameflip API returned non-success status"
    );
  }

  return response.data?.data?.exchanges || [];
}

function isShipped(exchange) {
  return exchange.handling_status === "shipped";
}

function isDelivered(exchange) {
  return exchange.status === "received";
}

function isComplete(exchange) {
  return exchange.status === "complete";
}

function isNewSale(exchange) {
  return exchange.status === "pending";
}

async function processExchangeUpdates(exchange) {
  if (!exchange?.id) {
    return;
  }

  const id = exchange.id;
  const current = {
    status: exchange.status || "",
    handling_status: exchange.handling_status || "",
  };

  let state = exchangeState[id];

  if (!state) {
    state = {
      ...current,
      notified: defaultNotified(),
    };
    exchangeState[id] = state;
  }

  if (isNewSale(exchange) && !state.notified.sale) {
    await sendExchangeNotification(
      exchange,
      buildNewSaleMessage(exchange),
      { mention: true }
    );
    state.notified.sale = true;
    console.log(`[gameflip] New sale: ${id}`);
  }

  if (isShipped(exchange) && !state.notified.shipped) {
    await sendExchangeNotification(exchange, buildShippedMessage(exchange));
    state.notified.shipped = true;
    console.log(`[gameflip] Shipped: ${id}`);
  }

  if (isDelivered(exchange) && !state.notified.delivered) {
    await sendExchangeNotification(exchange, buildDeliveredMessage(exchange));
    state.notified.delivered = true;
    console.log(`[gameflip] Delivered: ${id}`);
  }

  if (isComplete(exchange) && !state.notified.complete) {
    await sendExchangeNotification(exchange, buildCompletedMessage(exchange));
    state.notified.complete = true;
    console.log(`[gameflip] Completed: ${id}`);
  }

  state.status = current.status;
  state.handling_status = current.handling_status;
}

async function pollOnce() {
  if (polling) {
    return;
  }
  polling = true;

  try {
    const exchanges = await fetchSellerExchanges();

    for (const exchange of exchanges) {
      await processExchangeUpdates(exchange);
    }

    saveState();
  } catch (err) {
    console.error("[gameflip] Poll failed:", err.message);
  } finally {
    polling = false;
  }
}

function isConfigured() {
  return Boolean(
    getApiKey() && getApiSecret() && Object.keys(channelWebhooks).length
  );
}

function getStatus() {
  loadChannelWebhooks();

  const hasApiKey = Boolean(getApiKey());
  const hasTotpSecret = Boolean(getApiSecret());
  const hasChannelEnv = Boolean(process.env.GAMEFLIP_CHANNEL_WEBHOOKS?.trim());
  const hasPrefixWebhooks = Object.keys(process.env).some((k) =>
    k.startsWith("DISCORD_WEBHOOK_GAMEFLIP_")
  );
  const channelCount = Object.keys(channelWebhooks).length;

  const hints = [];
  if (!hasApiKey) {
    hints.push("Set GAMEFLIP_API_KEY in Render Environment");
  }
  if (!hasTotpSecret) {
    hints.push("Set GAMEFLIP_TOTP_SECRET in Render Environment");
  }
  if (!channelCount) {
    hints.push(
      "Set GAMEFLIP_CHANNEL_WEBHOOKS JSON or DISCORD_WEBHOOK_GAMEFLIP_DEFAULT (and others)"
    );
  }
  if (channelParseError) {
    hints.push(`Fix GAMEFLIP_CHANNEL_WEBHOOKS JSON: ${channelParseError}`);
  }
  if ((hasApiKey || hasTotpSecret || hasChannelEnv) && !isConfigured()) {
    hints.push("After saving env vars, wait for Render redeploy (Live)");
  }

  return {
    enabled: isConfigured(),
    pollIntervalMs: POLL_MS,
    lookbackDays: Number(process.env.GAMEFLIP_POLL_LOOKBACK_DAYS || 14),
    categories: Object.keys(channelWebhooks),
    trackedExchanges: Object.keys(exchangeState).length,
    checks: {
      hasApiKey,
      hasTotpSecret,
      hasChannelWebhooksEnv: hasChannelEnv,
      hasPrefixWebhooks,
      channelCount,
      channelParseError,
    },
    hints,
  };
}

function startGameflipPoller() {
  loadChannelWebhooks();

  if (!getApiKey() || !getApiSecret()) {
    console.log(
      "[gameflip] Poller disabled — set GAMEFLIP_API_KEY and GAMEFLIP_TOTP_SECRET"
    );
    return;
  }

  if (!Object.keys(channelWebhooks).length) {
    console.log(
      "[gameflip] Poller disabled — set GAMEFLIP_CHANNEL_WEBHOOKS or DISCORD_WEBHOOK_GAMEFLIP_*"
    );
    return;
  }

  loadState();
  console.log("[gameflip] Poller started", getStatus());

  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function stopGameflipPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function sendTestNotification() {
  loadChannelWebhooks();

  if (!isConfigured()) {
    throw new Error("Gameflip notifier is not configured");
  }

  const testExchange = {
    id: `test-${Date.now()}`,
    name: "Test Item (not a real sale)",
    category: "default",
    price: 1999,
    status: "pending",
    handling_status: "need_label",
  };

  await sendExchangeNotification(
    testExchange,
    buildNewSaleMessage(testExchange),
    { mention: true }
  );
  return testExchange;
}

module.exports = {
  startGameflipPoller,
  stopGameflipPoller,
  getGameflipStatus: getStatus,
  sendTestNotification,
};
