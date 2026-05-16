const fs = require("fs");
const path = require("path");
const axios = require("axios");
const speakeasy = require("speakeasy");

const API_BASE =
  process.env.GAMEFLIP_API_BASE ||
  "https://production-gameflip.fingershock.com/api/v1";
const POLL_MS = Number(process.env.GAMEFLIP_POLL_INTERVAL_MS || 60000);
const STATE_FILE = path.join(__dirname, "data", "gameflip-state.json");

const seenIds = new Set();
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
  const fromGameflip = sanitizeMentionUserId(
    process.env.DISCORD_MENTION_USER_ID_GAMEFLIP
  );
  if (fromGameflip) {
    return fromGameflip;
  }

  return sanitizeMentionUserId(process.env.DISCORD_MENTION_USER_ID);
}

function getMentionSource() {
  if (sanitizeMentionUserId(process.env.DISCORD_MENTION_USER_ID_GAMEFLIP)) {
    return "DISCORD_MENTION_USER_ID_GAMEFLIP";
  }
  if (sanitizeMentionUserId(process.env.DISCORD_MENTION_USER_ID)) {
    return "DISCORD_MENTION_USER_ID";
  }
  return null;
}

function slugCategory(category) {
  return (category || "unknown")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
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

    const ids = data.seenIds || Object.keys(data.exchangeState || {});
    for (const id of ids) {
      seenIds.add(id);
    }
  } catch (err) {
    console.error("[gameflip] Could not load state:", err.message);
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ seenIds: [...seenIds].slice(-5000) }, null, 2)
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

function buildNewSaleMessage(exchange) {
  const category = exchange.category || "unknown";
  const mentionUserId = getMentionUserId();
  const mention = mentionUserId ? `<@${mentionUserId}>` : "";
  const lines = [
    "🛒 **NEW GAMEFLIP SALE**",
    `**Item:** ${exchange.name || "Unknown item"}`,
    `**Type:** ${category}`,
    `**Price:** ${formatPrice(exchange.price)}`,
    `**Exchange ID:** ${exchange.id}`,
    `**Status:** ${exchange.status || "pending"}`,
  ];

  if (mention) {
    lines.push(mention);
  }

  return { text: lines.join("\n"), mentionUserId };
}

async function postDiscord(webhookUrl, content, mentionUserId = null) {
  const userId = mentionUserId || getMentionUserId();
  const payload = { content };

  if (userId) {
    payload.allowed_mentions = { parse: [], users: [userId] };
  }

  await axios.post(webhookUrl, payload);
}

async function notifyNewSale(exchange) {
  const webhookUrl = webhookForCategory(exchange.category);
  if (!webhookUrl) {
    console.warn(
      `[gameflip] No Discord webhook for category "${exchange.category}" (exchange ${exchange.id})`
    );
    return;
  }

  const { text, mentionUserId } = buildNewSaleMessage(exchange);
  await postDiscord(webhookUrl, text, mentionUserId);
  console.log(
    `[gameflip] New sale: ${exchange.id} (${exchange.category})` +
      (mentionUserId ? ` mention=${mentionUserId}` : " (no mention id)")
  );
}

async function fetchSellerExchanges() {
  const bootstrapMinutes = Number(
    process.env.GAMEFLIP_BOOTSTRAP_MINUTES || 10
  );
  const since = new Date(Date.now() - bootstrapMinutes * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    role: "seller",
    created: `${since},any`,
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

async function pollOnce() {
  if (polling) {
    return;
  }
  polling = true;

  try {
    const exchanges = await fetchSellerExchanges();

    for (const exchange of exchanges) {
      if (!exchange?.id || seenIds.has(exchange.id)) {
        continue;
      }

      seenIds.add(exchange.id);

      if (exchange.status !== "pending") {
        continue;
      }

      await notifyNewSale(exchange);
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
  const mentionUserId = getMentionUserId();
  const mentionSource = getMentionSource();

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
  if (isConfigured() && !mentionUserId) {
    hints.push(
      "Set DISCORD_MENTION_USER_ID_GAMEFLIP to a numeric Discord user ID"
    );
  }

  return {
    enabled: isConfigured(),
    pollIntervalMs: POLL_MS,
    categories: Object.keys(channelWebhooks),
    seenCount: seenIds.size,
    mention: {
      configured: Boolean(mentionUserId),
      source: mentionSource,
    },
    checks: {
      hasApiKey,
      hasTotpSecret,
      hasChannelWebhooksEnv: hasChannelEnv,
      hasPrefixWebhooks,
      channelCount,
      channelParseError,
      hasGameflipMentionUserId: Boolean(mentionUserId),
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
  };

  await notifyNewSale(testExchange);
  return {
    exchange: testExchange,
    mentionConfigured: Boolean(getMentionUserId()),
    mentionSource: getMentionSource(),
  };
}

module.exports = {
  startGameflipPoller,
  stopGameflipPoller,
  getGameflipStatus: getStatus,
  sendTestNotification,
};
