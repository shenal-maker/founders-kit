require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const Groq = require("groq-sdk");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // set after first run
const RESOURCES = fs.readFileSync(path.join(__dirname, "../README.md"), "utf-8");
const COACHING = fs.readFileSync(path.join(__dirname, "knowledge/coaching.md"), "utf-8");
const MAX_HISTORY = 40; // messages kept in memory for context

// ── State ─────────────────────────────────────────────────────────────────────
// [ { role: "user" | "assistant", content: "..." } ]
let messageHistory = [];

// ── Anthropic ─────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });

const SYSTEM_PROMPT = `You are a startup coach in a WhatsApp group chat for founders. You are knowledgeable, direct, and practical. You ask good questions and give actionable advice.

You have deep knowledge of the following startup resource hub — use it to recommend specific tools, essays, accelerators, funding sources, and frameworks when relevant:

--- COACHING PHILOSOPHY & FOUNDER CONTEXT ---
${COACHING}
--- END COACHING PHILOSOPHY ---

--- FOUNDERS KIT RESOURCES ---
${RESOURCES}
--- END RESOURCES ---

Guidelines:
- Be concise — this is WhatsApp, not a blog post
- Reference specific resources from the hub when helpful (name + link)
- Ask one focused follow-up question at a time
- Adapt your coaching to the current stage of their startup based on the conversation
- For morning check-ins: help set clear intentions and priorities for the day
- For evening check-ins: prompt reflection on what was learned and what moves the needle`;

async function askClaude(userMessage) {
  messageHistory.push({ role: "user", content: userMessage });
  if (messageHistory.length > MAX_HISTORY) {
    messageHistory = messageHistory.slice(-MAX_HISTORY);
  }

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 500,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messageHistory],
  });

  const reply = response.choices[0].message.content;
  messageHistory.push({ role: "assistant", content: reply });
  return reply;
}

async function generateCheckIn(type) {
  const context =
    messageHistory.length > 0
      ? `Recent conversation context:\n${messageHistory
          .slice(-10)
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")}`
      : "No prior conversation yet — this may be the first check-in.";

  const prompt =
    type === "morning"
      ? `Generate a fresh morning check-in message for the founders group. It should help them set intentions and identify their #1 priority for the day. Keep it under 3 sentences + 1 question. Base it on their startup stage from recent context and reference a relevant resource from the hub if fitting.\n\n${context}`
      : `Generate a fresh evening check-in message for the founders group. It should prompt reflection on the day — what moved the needle, what they learned, what to carry forward. Keep it under 3 sentences + 1 question. Reference a relevant resource from the hub if fitting.\n\n${context}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 300,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });

  return response.choices[0].message.content;
}

// ── WhatsApp Client ───────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox"] },
});

client.on("qr", (qr) => {
  console.log("Scan this QR code with WhatsApp:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Bot is ready!");
  if (!GROUP_CHAT_ID) {
    console.log(
      "\n⚠️  GROUP_CHAT_ID not set. Send a message in your group — the chat ID will be logged here.\n"
    );
  }
});

client.on("message", async (msg) => {
  const chat = await msg.getChat();

  // Log chat ID if GROUP_CHAT_ID not set yet
  if (!GROUP_CHAT_ID && chat.isGroup) {
    console.log(`Group chat ID: ${chat.id._serialized}`);
    console.log("Add this to your .env as GROUP_CHAT_ID");
  }

  // Only respond in the configured group when @mentioned
  if (!GROUP_CHAT_ID || chat.id._serialized !== GROUP_CHAT_ID) return;
  if (!chat.isGroup) return;

  const botNumber = client.info.wid._serialized;
  const mentioned = msg.mentionedIds?.some((id) => id._serialized === botNumber);
  if (!mentioned) return;

  try {
    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.number;
    const text = `${senderName}: ${msg.body}`;
    const reply = await askClaude(text);
    await msg.reply(reply);
  } catch (err) {
    console.error("Error responding to message:", err);
  }
});

// ── Scheduled Check-ins (Central Time) ───────────────────────────────────────
// Morning: 8:00 AM CT
cron.schedule(
  "0 8 * * *",
  async () => {
    if (!GROUP_CHAT_ID) return;
    try {
      const message = await generateCheckIn("morning");
      const chat = await client.getChatById(GROUP_CHAT_ID);
      await chat.sendMessage(`☀️ *Morning check-in*\n\n${message}`);
    } catch (err) {
      console.error("Error sending morning check-in:", err);
    }
  },
  { timezone: "America/Chicago" }
);

// Evening: 7:00 PM CT
cron.schedule(
  "0 19 * * *",
  async () => {
    if (!GROUP_CHAT_ID) return;
    try {
      const message = await generateCheckIn("evening");
      const chat = await client.getChatById(GROUP_CHAT_ID);
      await chat.sendMessage(`🌙 *Evening check-in*\n\n${message}`);
    } catch (err) {
      console.error("Error sending evening check-in:", err);
    }
  },
  { timezone: "America/Chicago" }
);

client.initialize();
