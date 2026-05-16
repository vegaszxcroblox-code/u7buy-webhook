const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";

app.use(express.json());

const okResponse = (res) => res.status(200).json({ status: "OK" });

function logWebhook(method, payload) {
  console.log(
    `[webhook] ${new Date().toISOString()} ${method}`,
    JSON.stringify(payload ?? {})
  );
}

async function notifyDiscord(data) {
  if (!DISCORD_WEBHOOK) {
    return;
  }

  let message = "";

  if (data?.event === "new_order_received") {
    message = `🛒 NEW ORDER\nOrder ID: ${data.data?.orderId}`;
  } else if (data?.event === "order_completed") {
    message = `✅ ORDER COMPLETED\nOrder ID: ${data.data?.orderId}`;
  }

  if (!message) {
    return;
  }

  await axios.post(DISCORD_WEBHOOK, { content: message });
}

app.get("/webhook", (req, res) => {
  logWebhook("GET", req.query);
  return okResponse(res);
});

app.post("/webhook", async (req, res) => {
  logWebhook("POST", req.body);

  try {
    await notifyDiscord(req.body);
  } catch (err) {
    console.error("[webhook] Discord notification failed:", err.message);
  }

  return okResponse(res);
});

app.get("/", (req, res) => {
  res.send("Webhook running");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
