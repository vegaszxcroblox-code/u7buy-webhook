const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "data", "u7buy-state.json");
const notifiedKeys = new Set();

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

/**
 * Returns true if this notification should be sent (first time for this order).
 * Returns false if duplicate (U7BUY retry or repeat POST).
 */
function claimNotification(event, orderId) {
  if (event !== "new_order_received" || orderId == null) {
    return true;
  }

  const key = dedupeKey(event, orderId);
  if (notifiedKeys.has(key)) {
    console.log(`[webhook] Duplicate skipped (already notified): ${key}`);
    return false;
  }

  notifiedKeys.add(key);
  saveState();
  return true;
}

loadState();

module.exports = { claimNotification, loadState };
