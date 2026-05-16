const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "data", "u7buy-state.json");
const notifiedKeys = new Set();
const inFlightKeys = new Set();

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
    console.error("[u7buy-dedupe] Could not load state:", err.message);
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ notified: [...notifiedKeys].slice(-10000) }, null, 2)
    );
  } catch (err) {
    console.error("[u7buy-dedupe] Could not save state:", err.message);
  }
}

function dedupeKey(event, orderId) {
  return `${event}:${String(orderId)}`;
}

function beginNotification(event, orderId) {
  if (event !== "new_order_received" || orderId == null) {
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
  console.log(`[webhook] Will allow retry for: ${key}`);
}

function getStats() {
  return {
    notifiedCount: notifiedKeys.size,
    inFlightCount: inFlightKeys.size,
  };
}

loadState();

module.exports = {
  beginNotification,
  completeNotification,
  failNotification,
  getStats,
  loadState,
};
