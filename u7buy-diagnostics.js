const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "data", "u7buy-diagnostics.json");

const webhookDiagnostics = {
  lastPostAt: null,
  lastPostEvent: null,
  lastPostOrderId: null,
  lastDiscordSentAt: null,
  lastDiscordError: null,
  lastContentType: null,
  lastUserAgent: null,
  postCount: 0,
};

function loadDiagnostics() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    Object.assign(webhookDiagnostics, data);
  } catch (err) {
    console.error("[u7buy-diagnostics] Could not load state:", err.message);
  }
}

function saveDiagnostics() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(webhookDiagnostics, null, 2));
  } catch (err) {
    console.error("[u7buy-diagnostics] Could not save state:", err.message);
  }
}

function recordWebhookPost(req, body) {
  webhookDiagnostics.postCount += 1;
  webhookDiagnostics.lastPostAt = new Date().toISOString();
  webhookDiagnostics.lastPostEvent =
    body?.event ?? body?.type ?? body?.eventType ?? null;
  webhookDiagnostics.lastPostOrderId =
    req?.preservedOrderId ??
    body?.data?.orderId ??
    body?.data?.order_id ??
    body?.orderId ??
    body?.order_id ??
    null;
  webhookDiagnostics.lastContentType = req.headers["content-type"] || null;
  webhookDiagnostics.lastUserAgent = req.headers["user-agent"] || null;
  saveDiagnostics();
}

function recordDiscordResult(result, errorMessage = null) {
  if (result?.sent) {
    webhookDiagnostics.lastDiscordSentAt = new Date().toISOString();
    webhookDiagnostics.lastDiscordError = null;
  } else {
    webhookDiagnostics.lastDiscordError = errorMessage || result?.reason || "not_sent";
  }
  saveDiagnostics();
}

function getDiagnostics() {
  return { ...webhookDiagnostics };
}

loadDiagnostics();

module.exports = {
  recordWebhookPost,
  recordDiscordResult,
  getDiagnostics,
  loadDiagnostics,
};
