import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { marked } from "marked";
import cron from "node-cron";
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

// ─── Scheduling ──────────────────────────────────────────────────────────────
const SCHEDULES_FILE = "./data/schedules.json";
let schedules = [];
const activeTimers = new Map();
const activeCrons = new Map();
let nextScheduleId = 1;

function loadSchedules() {
  try {
    if (existsSync(SCHEDULES_FILE)) {
      schedules = JSON.parse(readFileSync(SCHEDULES_FILE, "utf-8"));
      nextScheduleId = schedules.reduce((max, s) => Math.max(max, s.id), 0) + 1;
    }
  } catch { schedules = []; }
}

function saveSchedules() {
  mkdirSync("./data", { recursive: true });
  writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
}

function activateSchedule(schedule) {
  if (schedule.type === "once") {
    const delay = schedule.timestamp - Date.now();
    if (delay <= 0) {
      schedules = schedules.filter(s => s.id !== schedule.id);
      saveSchedules();
      return;
    }
    const timer = setTimeout(async () => {
      try {
        await client.sendMessage(schedule.roomId, {
          msgtype: "m.text",
          body: `⏰ Rappel / Reminder: ${schedule.message}`,
        });
      } catch (err) {
        console.error(`❌ Failed to send reminder #${schedule.id}:`, err.message);
      }
      schedules = schedules.filter(s => s.id !== schedule.id);
      activeTimers.delete(schedule.id);
      saveSchedules();
    }, delay);
    activeTimers.set(schedule.id, timer);
  } else if (schedule.type === "recurring") {
    const job = cron.schedule(schedule.cronExpr, async () => {
      try {
        await client.sendMessage(schedule.roomId, {
          msgtype: "m.text",
          body: `⏰ ${schedule.message}`,
        });
      } catch (err) {
        console.error(`❌ Failed to send recurring #${schedule.id}:`, err.message);
      }
    });
    activeCrons.set(schedule.id, job);
  }
}

function reloadAllSchedules() {
  loadSchedules();
  for (const schedule of schedules) {
    activateSchedule(schedule);
  }
  if (schedules.length > 0) {
    console.log(`📅 Reloaded ${schedules.length} schedule(s)`);
  }
}

// ─── Time parsing helpers ────────────────────────────────────────────────────
const TIME_UNITS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  seconde: 1000, secondes: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  heure: 3600000, heures: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  jour: 86400000, jours: 86400000,
};

const DAY_NAMES = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
  lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 0,
  lundis: 1, mardis: 2, mercredis: 3, jeudis: 4, vendredis: 5, samedis: 6, dimanches: 0,
};

function parseTimeExpr(timeStr) {
  timeStr = timeStr.trim().toLowerCase();
  // French: 14h, 14h30, 9h
  let match = timeStr.match(/^(\d{1,2})h(\d{2})?$/);
  if (match) return { hours: parseInt(match[1]), minutes: parseInt(match[2] || "0") };
  // English: 2pm, 2:30pm, 14:00, 9am
  match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (match) {
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2] || "0");
    if (match[3] === "pm" && hours < 12) hours += 12;
    if (match[3] === "am" && hours === 12) hours = 0;
    return { hours, minutes };
  }
  return null;
}

// ─── Schedule intent detection (EN + FR, natural language) ───────────────────
function tryParseSchedule(text, roomId) {
  const lower = text.toLowerCase().trim();

  // ── List reminders ──
  if (/^(?:list|show|mes|liste|voir)[\s]*(reminders?|rappels?|scheduled?|schedules?|planifi.*)$/i.test(lower)
    || /^(?:rappels?|reminders?)$/i.test(lower)) {
    const roomSchedules = schedules.filter(s => s.roomId === roomId);
    if (roomSchedules.length === 0) {
      return { response: "No active reminders. / Aucun rappel actif." };
    }
    const lines = roomSchedules.map(s => {
      if (s.type === "once") {
        return `**#${s.id}** — ${new Date(s.timestamp).toLocaleString()} — ${s.message}`;
      }
      return `**#${s.id}** — 🔁 \`${s.cronExpr}\` — ${s.message}`;
    });
    return { response: "**📅 Reminders / Rappels :**\n" + lines.join("\n") };
  }

  // ── Cancel reminder ──
  let match = lower.match(
    /^(?:cancel|delete|remove|stop|annule|supprime|retire|arrête|stoppe?)[\s]*(?:le\s+|the\s+)?(?:reminder|rappel|schedule|#)?[\s]*#?(\d+)$/
  );
  if (match) {
    const id = parseInt(match[1]);
    const idx = schedules.findIndex(s => s.id === id && s.roomId === roomId);
    if (idx === -1) return { response: `Reminder #${id} not found. / Rappel #${id} introuvable.` };
    if (activeTimers.has(id)) { clearTimeout(activeTimers.get(id)); activeTimers.delete(id); }
    if (activeCrons.has(id)) { activeCrons.get(id).stop(); activeCrons.delete(id); }
    schedules.splice(idx, 1);
    saveSchedules();
    return { response: `✅ Reminder #${id} cancelled. / Rappel #${id} annulé.` };
  }

  // ── Recurring: "every day at 9am do X" / "tous les jours à 9h faire X" ──
  match = lower.match(
    /^(?:every|tous\s+les|chaque)\s+(day|days|jours?|weekdays?|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)s?)\s+(?:at|à)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}h\d{0,2})\s+(?:to\s+|de\s+|d'|pour\s+|:\s*)?(.+)$/i
  );
  if (match) {
    const dayStr = match[1].toLowerCase().replace(/s$/, "");
    const time = parseTimeExpr(match[2]);
    const message = match[3].trim();
    if (!time) return null;
    let cronExpr;
    if (["day", "jour"].includes(dayStr)) {
      cronExpr = `${time.minutes} ${time.hours} * * *`;
    } else if (["weekday"].includes(dayStr)) {
      cronExpr = `${time.minutes} ${time.hours} * * 1-5`;
    } else {
      const dayNum = DAY_NAMES[dayStr];
      if (dayNum === undefined) return null;
      cronExpr = `${time.minutes} ${time.hours} * * ${dayNum}`;
    }
    const schedule = { id: nextScheduleId++, type: "recurring", roomId, cronExpr, message, createdAt: Date.now() };
    schedules.push(schedule);
    saveSchedules();
    activateSchedule(schedule);
    return { response: `✅ Recurring reminder #${schedule.id} set (\`${cronExpr}\`): "${message}"` };
  }

  // ── One-shot relative: "remind me in 30 minutes to X" / "rappelle-moi dans 30 min de X" ──
  match = lower.match(
    /^(?:remind\s*(?:me)?|rappelle[- ]?moi|rappel)\s+(?:in|dans)\s+(\d+)\s*(seconds?|secondes?|secs?|s|minutes?|mins?|m|hours?|heures?|hrs?|h|days?|jours?|j|d)\s+(?:to\s+|de\s+|d'|pour\s+|que\s+|:\s*)?(.+)$/i
  );
  if (match) {
    const amount = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const message = match[3].trim();
    const ms = TIME_UNITS[unit];
    if (!ms) return null;
    const timestamp = Date.now() + amount * ms;
    const schedule = { id: nextScheduleId++, type: "once", roomId, timestamp, message, createdAt: Date.now() };
    schedules.push(schedule);
    saveSchedules();
    activateSchedule(schedule);
    return { response: `✅ Reminder #${schedule.id} set for ${new Date(timestamp).toLocaleString()}: "${message}"` };
  }

  // ── One-shot "tomorrow at": "remind me tomorrow at 9am to X" / "rappelle-moi demain à 9h de X" ──
  match = lower.match(
    /^(?:remind\s*(?:me)?|rappelle[- ]?moi|rappel)\s+(?:tomorrow|demain)\s+(?:at|à)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}h\d{0,2})\s+(?:to\s+|de\s+|d'|pour\s+|que\s+|:\s*)?(.+)$/i
  );
  if (match) {
    const time = parseTimeExpr(match[1]);
    const message = match[2].trim();
    if (!time) return null;
    const target = new Date();
    target.setDate(target.getDate() + 1);
    target.setHours(time.hours, time.minutes, 0, 0);
    const schedule = { id: nextScheduleId++, type: "once", roomId, timestamp: target.getTime(), message, createdAt: Date.now() };
    schedules.push(schedule);
    saveSchedules();
    activateSchedule(schedule);
    return { response: `✅ Reminder #${schedule.id} set for ${target.toLocaleString()}: "${message}"` };
  }

  // ── One-shot absolute: "remind me at 14:00 to X" / "rappelle-moi à 14h de X" ──
  match = lower.match(
    /^(?:remind\s*(?:me)?|rappelle[- ]?moi|rappel)\s+(?:at|à)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}h\d{0,2})\s+(?:to\s+|de\s+|d'|pour\s+|que\s+|:\s*)?(.+)$/i
  );
  if (match) {
    const time = parseTimeExpr(match[1]);
    const message = match[2].trim();
    if (!time) return null;
    const now = new Date();
    const target = new Date();
    target.setHours(time.hours, time.minutes, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const schedule = { id: nextScheduleId++, type: "once", roomId, timestamp: target.getTime(), message, createdAt: Date.now() };
    schedules.push(schedule);
    saveSchedules();
    activateSchedule(schedule);
    return { response: `✅ Reminder #${schedule.id} set for ${target.toLocaleString()}: "${message}"` };
  }

  return null;
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

  // Check for scheduling intent before calling AI
  const scheduleResult = tryParseSchedule(userMessage, roomId);
  if (scheduleResult) {
    await client.replyText(roomId, event, scheduleResult.response, marked(scheduleResult.response));
    console.log(`📅 [${roomId}] Schedule: ${scheduleResult.response}`);
    return;
  }

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
  reloadAllSchedules();
  console.log(`✅ Bot started: ${botUserId}`);
  console.log(`🔗 AI: ${AI_API_URL} (model: ${AI_MODEL})`);
}).catch((err) => {
  console.error("❌ Failed to start bot:", err);
  process.exit(1);
});
