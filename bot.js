import "dotenv/config";
import { readFileSync } from "fs";
import { marked } from "marked";
import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  LogService,
  LogLevel,
} from "matrix-bot-sdk";

// ─── Config ───────────────────────────────────────────────────────────────────
const MATRIX_HOMESERVER    = process.env.MATRIX_HOMESERVER;     // ex: https://matrix.maboite.com
const MATRIX_ACCESS_TOKEN  = process.env.MATRIX_ACCESS_TOKEN;
const AI_API_URL           = process.env.AI_API_URL;
const AI_API_KEY           = process.env.AI_API_KEY || "none";
const AI_MODEL             = process.env.AI_MODEL || "gpt-4o";
const AI_SYSTEM_PROMPT     = readFileSync("./prompt.txt", "utf-8").trim();
// ──────────────────────────────────────────────────────────────────────────────

if (!MATRIX_HOMESERVER || !MATRIX_ACCESS_TOKEN || !AI_API_URL) {
  console.error("❌ Missing variables: MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, AI_API_URL");
  process.exit(1);
}

LogService.setLevel(LogLevel.WARN);

const storage = new SimpleFsStorageProvider("./data/bot.json");
const client  = new MatrixClient(MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, storage);
AutojoinRoomsMixin.setupOnClient(client);

let botUserId = null;

// ─── History ─────────────────────────────────────────────────────────────────
const histories = {};
const MAX_HISTORY = 20;

function getHistory(roomId) {
  if (!histories[roomId]) histories[roomId] = [];
  return histories[roomId];
}

function pushToHistory(roomId, role, content) {
  const history = getHistory(roomId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

// ─── AI call ─────────────────────────────────────────────────────────────────
async function askAI(roomId, userMessage) {
  pushToHistory(roomId, "user", userMessage);

  const base = AI_API_URL.endsWith("/") ? AI_API_URL : AI_API_URL + "/";
  const response = await fetch(new URL("v1/chat/completions", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        ...getHistory(roomId),
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const reply = data.choices[0].message.content;

  pushToHistory(roomId, "assistant", reply);
  return reply;
}

// ─── DM or mention? ─────────────────────────────────────────────────────────
async function shouldRespond(roomId, event) {
  const body = event.content?.body || "";

  // DM = room with only 2 members
  const members = await client.getJoinedRoomMembers(roomId);
  const isDM = members.length === 2;
  if (isDM) return true;

  // In a room: only respond if the bot is mentioned
  const formattedBody = event.content?.formatted_body || "";
  const mentionedIds = event.content?.["m.mentions"]?.user_ids || [];
  return body.includes(botUserId)
    || formattedBody.includes(botUserId)
    || mentionedIds.includes(botUserId);
}

// ─── Strip bot mention from message ──────────────────────────────────────────
function stripBotMention(text) {
  // Remove "@bot:server.com" and extra whitespace
  return text.replace(new RegExp(botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "").trim();
}

// ─── Main listener ───────────────────────────────────────────────────────────
client.on("room.message", async (roomId, event) => {
  if (event.sender === botUserId) return;
  if (!event.content || event.content.msgtype !== "m.text") return;

  if (!await shouldRespond(roomId, event)) return;

  const userMessage = stripBotMention(event.content.body || "");
  console.log(`📨 [${roomId}] ${event.sender}: ${userMessage}`);

  // Typing indicator while AI is thinking
  await client.setTyping(roomId, true, 10000);

  try {
    const reply = await askAI(roomId, userMessage);

    await client.setTyping(roomId, false);
    await client.replyText(roomId, event, reply, marked(reply));

    console.log(`🤖 [${roomId}] Bot: ${reply.slice(0, 80)}...`);
  } catch (err) {
    await client.setTyping(roomId, false);
    console.error("❌ AI error:", err.message);
    await client.sendMessage(roomId, {
      msgtype: "m.text",
      body: "Sorry, something went wrong. Try again in a moment.",
    });
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────
client.start().then(async () => {
  botUserId = await client.getUserId();
  console.log(`✅ Bot started: ${botUserId}`);
  console.log(`🔗 AI: ${AI_API_URL} (model: ${AI_MODEL})`);
}).catch((err) => {
  console.error("❌ Failed to start bot:", err);
  process.exit(1);
});
