import "dotenv/config";
import {
  init as initReminders,
  scheduleReminder,
  listReminders,
  cancelReminder,
  loadAndProcessMissed,
} from "./reminders.js";
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

const TOOL_INSTRUCTIONS = `
You can schedule reminders for the user. When they ask to be reminded of something, use the schedule_reminder tool. Convert relative times ("in 30 minutes", "in 2 hours", "tomorrow at 9am") into a number of seconds from now. When they ask to see or cancel reminders, use list_reminders and cancel_reminder.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "schedule_reminder",
      description: "Schedule a reminder for the user.",
      parameters: {
        type: "object",
        properties: {
          delay_seconds: {
            type: "integer",
            description: "Number of seconds from now until the reminder fires",
          },
          message: {
            type: "string",
            description: "What to remind the user about",
          },
          repeat_interval_seconds: {
            type: "integer",
            description: "If set, the reminder recurs at this interval in seconds",
          },
        },
        required: ["delay_seconds", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "List the user's active reminders in the current room.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "Cancel a pending reminder by its ID.",
      parameters: {
        type: "object",
        properties: {
          reminder_id: {
            type: "string",
            description: "The ID of the reminder to cancel",
          },
        },
        required: ["reminder_id"],
      },
    },
  },
];
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

// ─── Tool execution ─────────────────────────────────────────────────────────
function executeToolCall(name, args, sender, roomId) {
  try {
    switch (name) {
      case "schedule_reminder": {
        const reminder = scheduleReminder(
          sender,
          roomId,
          args.message,
          args.delay_seconds,
          args.repeat_interval_seconds
        );
        return {
          success: true,
          reminder_id: reminder.id,
          fire_at: new Date(reminder.fireAt).toISOString(),
        };
      }
      case "list_reminders": {
        const reminders = listReminders(sender, roomId);
        return reminders.map((r) => ({
          id: r.id,
          message: r.message,
          fire_at: new Date(r.fireAt).toISOString(),
          recurring: r.repeatIntervalSeconds
            ? `every ${r.repeatIntervalSeconds}s`
            : null,
        }));
      }
      case "cancel_reminder": {
        const success = cancelReminder(sender, args.reminder_id);
        return {
          success,
          message: success ? "Reminder cancelled." : "Reminder not found.",
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── AI call ─────────────────────────────────────────────────────────────────
async function askAI(roomId, sender, userMessage) {
  pushToHistory(roomId, "user", userMessage);

  const base = AI_API_URL.endsWith("/") ? AI_API_URL : AI_API_URL + "/";
  const url = new URL("v1/chat/completions", base);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${AI_API_KEY}`,
  };

  const messages = [
    { role: "system", content: AI_SYSTEM_PROMPT + TOOL_INSTRUCTIONS },
    ...getHistory(roomId),
  ];

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: AI_MODEL, messages, tools: TOOLS }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const choice = data.choices[0];

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    messages.push(choice.message);

    for (const toolCall of choice.message.tool_calls) {
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: "Invalid JSON arguments" }),
        });
        continue;
      }
      const result = executeToolCall(
        toolCall.function.name,
        args,
        sender,
        roomId
      );
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    // Follow-up call so the AI can craft a natural confirmation
    const followUp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: AI_MODEL, messages, tools: TOOLS }),
    });

    if (!followUp.ok) {
      const err = await followUp.text();
      throw new Error(`AI API error ${followUp.status}: ${err}`);
    }

    const followUpData = await followUp.json();
    const reply = followUpData.choices[0].message.content || "";
    pushToHistory(roomId, "assistant", reply);
    return reply;
  }

  const reply = choice.message.content;
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
    const reply = await askAI(roomId, event.sender, userMessage);

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

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Startup ─────────────────────────────────────────────────────────────────
client.start().then(async () => {
  botUserId = await client.getUserId();
  console.log(`✅ Bot started: ${botUserId}`);
  console.log(`🔗 AI: ${AI_API_URL} (model: ${AI_MODEL})`);

  // Fire callback: send reminder message to the room
  initReminders((sender, reminder) => {
    const body = `${sender} Reminder: ${reminder.message}`;
    const html = `<a href="https://matrix.to/#/${sender}">${sender}</a> Reminder: ${escapeHtml(reminder.message)}`;
    client
      .sendMessage(reminder.roomId, {
        msgtype: "m.text",
        body,
        format: "org.matrix.custom.html",
        formatted_body: html,
      })
      .catch((err) => {
        console.error(
          `❌ Failed to send reminder to ${reminder.roomId}:`,
          err.message
        );
      });
  });

  // Load reminders and notify about missed ones
  const missed = loadAndProcessMissed();

  for (const [sender, rooms] of Object.entries(missed)) {
    for (const [roomId, reminders] of Object.entries(rooms)) {
      const parts = reminders.map((r) =>
        r.count > 1 ? `${r.message} (x${r.count})` : r.message
      );
      const text = `Sorry for the inconvenience -- I was offline and missed some reminders: ${parts.join(", ")}`;
      const body = `${sender} ${text}`;
      const html = `<a href="https://matrix.to/#/${sender}">${sender}</a> ${escapeHtml(text)}`;
      await client
        .sendMessage(roomId, {
          msgtype: "m.text",
          body,
          format: "org.matrix.custom.html",
          formatted_body: html,
        })
        .catch((err) => {
          console.error(
            `❌ Failed to send missed reminder notice to ${roomId}:`,
            err.message
          );
        });
    }
  }

  console.log(`⏰ Reminders loaded`);
}).catch((err) => {
  console.error("❌ Failed to start bot:", err);
  process.exit(1);
});
