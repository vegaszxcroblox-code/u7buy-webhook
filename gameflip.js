const fs = require("fs");
const path = require("path");
const axios = require("axios");
const speakeasy = require("speakeasy");

const API_BASE =
  process.env.GAMEFLIP_API_BASE ||
  "https://production-gameflip.fingershock.com/api/v1";
const API_KEY = process.env.GAMEFLIP_API_KEY || process.env.GFAPI_KEY || "";
const API_SECRET =
  process.env.GAMEFLIP_TOTP_SECRET || process.env.GFAPI_SECRET || "";
const POLL_MS = Number(process.env.GAMEFLIP_POLL_INTERVAL_MS || 60000);
const MENTION_USER_ID = process.env.DISCORD_MENTION_USER_ID || "";
const STATE_FILE = path.join(__dirname, "data", "gameflip-state.json");

const seenIds = new Set();
let channelWebhooks = {};
let pollTimer = null;
let polling = false;

function loadChannelWebhooks() {
  const raw = process.env.GAMEFLIP_CHANNEL_WEBHOOKS || "{}";
  try {
    channelWebhooks = JSON.parse(raw);
  } catch (err) {
    console.error("[gameflip] Invalid GAMEFLIP_CHANNEL_WEBHOOKS JSON:", err.message);
    channelWebhooks = {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(channelWebhooks)) {
    if (typeof value === "string" && value.trim()) {
      normalized[slugCategory(key)] = value.trim();
    }
  }
  channelWebhooks = normalized;
}

function slugCategory(category) {
  return (category || "unknown")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const id of data.seenIds || []) {
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
    secret: API_SECRET,
    encoding: "base32",
    algorithm: "sha1",
  });
  return `GFAPI ${API_KEY}:${totp}`;
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

function buildSaleMessage(exchange) {
  const category = exchange.category || "unknown";
  const mention = MENTION_USER_ID ? `<@${MENTION_USER_ID}>` : "";
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

  return lines.join("\n");
}

async function postDiscord(webhookUrl, content) {
  const payload = { content };
  if (MENTION_USER_ID) {
    payload.allowed_mentions = { users: [MENTION_USER_ID] };
  }
  await axios.post(webhookUrl, payload);
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

async function notifyNewSale(exchange) {
  const webhookUrl = webhookForCategory(exchange.category);
  if (!webhookUrl) {
    console.warn(
      `[gameflip] No Discord webhook for category "${exchange.category}" (exchange ${exchange.id})`
    );
    return;
  }

  await postDiscord(webhookUrl, buildSaleMessage(exchange));
  console.log(
    `[gameflip] Notified new sale: ${exchange.id} (${exchange.category}) → channel slug "${slugCategory(exchange.category)}"`
  );
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
  return Boolean(API_KEY && API_SECRET && Object.keys(channelWebhooks).length);
}

function getStatus() {
  return {
    enabled: isConfigured(),
    pollIntervalMs: POLL_MS,
    categories: Object.keys(channelWebhooks),
    seenCount: seenIds.size,
  };
}

function startGameflipPoller() {
  loadChannelWebhooks();

  if (!API_KEY || !API_SECRET) {
    console.log(
      "[gameflip] Poller disabled — set GAMEFLIP_API_KEY and GAMEFLIP_TOTP_SECRET"
    );
    return;
  }

  if (!Object.keys(channelWebhooks).length) {
    console.log(
      "[gameflip] Poller disabled — set GAMEFLIP_CHANNEL_WEBHOOKS (JSON map of category → webhook URL)"
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

module.exports = {
  startGameflipPoller,
  stopGameflipPoller,
  getGameflipStatus: getStatus,
};
