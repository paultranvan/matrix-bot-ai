# Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add natural-language reminder scheduling to the Matrix AI bot via OpenAI tool calling, with JSON file persistence and recurring support.

**Architecture:** New `reminders.js` module handles persistence, in-memory scheduling (setTimeout), and the hourly far-future scan. `bot.js` gains tool definitions, a tool-calling loop in `askAI`, tool execution handlers, and startup logic for missed reminders. The two files communicate via a fire callback passed during init.

**Tech Stack:** Node.js (ESM), matrix-bot-sdk, native fetch, fs (JSON persistence)

**Note:** This project has no test framework (see CLAUDE.md: "No build step, no tests, no linter"). Steps use manual verification instead of TDD.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `reminders.js` | Create | Reminder data model, JSON persistence, setTimeout scheduling, hourly scan, public API (schedule/list/cancel/loadAndProcessMissed) |
| `bot.js` | Modify | Tool definitions, system prompt injection, tool-calling loop in askAI, tool execution dispatch, fire callback, missed reminder notifications at startup |

---

### Task 1: Create `reminders.js` — persistence and scheduling

**Files:**
- Create: `reminders.js`

- [ ] **Step 1: Create `reminders.js` with full implementation**

```js
import { readFileSync, writeFileSync, existsSync } from "fs";

const REMINDERS_FILE = "./data/reminders.json";
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // ~24.8 days
const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Map<senderId, Map<reminderId, { reminder, timeoutHandle }>>
const active = new Map();
let onFire = null;

function generateId() {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function load() {
  if (!existsSync(REMINDERS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REMINDERS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(data) {
  writeFileSync(REMINDERS_FILE, JSON.stringify(data, null, 2));
}

function scheduleTimer(sender, reminder) {
  const delay = reminder.fireAt - Date.now();
  if (delay <= 0) {
    fire(sender, reminder);
    return;
  }
  const handle = setTimeout(() => {
    if (reminder.fireAt - Date.now() > 0) {
      scheduleTimer(sender, reminder);
    } else {
      fire(sender, reminder);
    }
  }, Math.min(delay, MAX_TIMEOUT_MS));

  if (!active.has(sender)) active.set(sender, new Map());
  active.get(sender).set(reminder.id, { reminder, timeoutHandle: handle });
}

function fire(sender, reminder) {
  const senderMap = active.get(sender);
  if (senderMap) senderMap.delete(reminder.id);

  if (onFire) onFire(sender, reminder);

  const data = load();
  if (reminder.repeatIntervalSeconds) {
    reminder.fireAt = Date.now() + reminder.repeatIntervalSeconds * 1000;
    const list = data[sender] || [];
    const idx = list.findIndex((r) => r.id === reminder.id);
    if (idx >= 0) list[idx] = reminder;
    data[sender] = list;
    save(data);
    scheduleTimer(sender, reminder);
  } else {
    if (data[sender]) {
      data[sender] = data[sender].filter((r) => r.id !== reminder.id);
      if (data[sender].length === 0) delete data[sender];
      save(data);
    }
  }
}

function startScan() {
  setInterval(() => {
    const now = Date.now();
    const data = load();
    for (const [sender, reminders] of Object.entries(data)) {
      for (const reminder of reminders) {
        const senderMap = active.get(sender);
        const isActive = senderMap && senderMap.has(reminder.id);
        if (
          !isActive &&
          reminder.fireAt > now &&
          reminder.fireAt - now <= SCAN_INTERVAL_MS + 60000
        ) {
          scheduleTimer(sender, reminder);
        }
      }
    }
  }, SCAN_INTERVAL_MS);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function init(callback) {
  onFire = callback;
}

export function scheduleReminder(
  sender,
  roomId,
  message,
  delaySeconds,
  repeatIntervalSeconds = null
) {
  const reminder = {
    id: generateId(),
    roomId,
    fireAt: Date.now() + delaySeconds * 1000,
    message,
    createdAt: Date.now(),
    repeatIntervalSeconds: repeatIntervalSeconds || null,
  };

  const data = load();
  if (!data[sender]) data[sender] = [];
  data[sender].push(reminder);
  save(data);

  scheduleTimer(sender, reminder);
  return reminder;
}

export function listReminders(sender, roomId) {
  const data = load();
  const list = data[sender] || [];
  return list.filter((r) => r.roomId === roomId);
}

export function cancelReminder(sender, reminderId) {
  const data = load();
  const list = data[sender] || [];
  const idx = list.findIndex((r) => r.id === reminderId);
  if (idx < 0) return false;

  list.splice(idx, 1);
  if (list.length === 0) delete data[sender];
  else data[sender] = list;
  save(data);

  const senderMap = active.get(sender);
  if (senderMap) {
    const entry = senderMap.get(reminderId);
    if (entry) {
      clearTimeout(entry.timeoutHandle);
      senderMap.delete(reminderId);
    }
  }

  return true;
}

export function loadAndProcessMissed() {
  const data = load();
  const now = Date.now();
  // missed: { sender: { roomId: [{ message, count }] } }
  const missed = {};

  for (const [sender, reminders] of Object.entries(data)) {
    const kept = [];
    for (const reminder of reminders) {
      if (reminder.fireAt <= now) {
        if (!missed[sender]) missed[sender] = {};
        if (!missed[sender][reminder.roomId])
          missed[sender][reminder.roomId] = [];

        if (reminder.repeatIntervalSeconds) {
          let missedCount = 0;
          let nextFire = reminder.fireAt;
          while (nextFire <= now) {
            missedCount++;
            nextFire += reminder.repeatIntervalSeconds * 1000;
          }
          missed[sender][reminder.roomId].push({
            message: reminder.message,
            count: missedCount,
          });
          reminder.fireAt = nextFire;
          kept.push(reminder);
        } else {
          missed[sender][reminder.roomId].push({
            message: reminder.message,
            count: 1,
          });
        }
      } else {
        kept.push(reminder);
      }
    }
    if (kept.length > 0) {
      data[sender] = kept;
    } else {
      delete data[sender];
    }
  }

  save(data);

  for (const [sender, reminders] of Object.entries(data)) {
    for (const reminder of reminders) {
      if (reminder.fireAt - now <= MAX_TIMEOUT_MS) {
        scheduleTimer(sender, reminder);
      }
    }
  }

  startScan();

  return missed;
}
```

- [ ] **Step 2: Verify the file parses correctly**

Run: `node -e "import('./reminders.js').then(() => console.log('OK'))"`
Expected: `OK` (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add reminders.js
git commit -m "Add reminders module with persistence and scheduling"
```

---

### Task 2: Add tool definitions and system prompt injection to `bot.js`

**Files:**
- Modify: `bot.js:1-18` (imports and config section)

- [ ] **Step 1: Add import for reminders.js**

After line 1 (`import "dotenv/config";`), add:

```js
import {
  init as initReminders,
  scheduleReminder,
  listReminders,
  cancelReminder,
  loadAndProcessMissed,
} from "./reminders.js";
```

- [ ] **Step 2: Add tool definitions and tool instructions after the config block**

After line 18 (`const AI_SYSTEM_PROMPT = ...`), add:

```js

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
```

- [ ] **Step 3: Verify it parses**

Run: `node -e "import('./bot.js')" 2>&1 | head -5`
Expected: may fail on missing env vars, but no syntax errors in the import/const sections.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "Add reminder tool definitions and prompt injection"
```

---

### Task 3: Rework `askAI` for tool-calling loop

**Files:**
- Modify: `bot.js` — replace the `askAI` function (lines 50-79)

- [ ] **Step 1: Add `executeToolCall` function before `askAI`**

Insert before the `askAI` function:

```js
function executeToolCall(name, args, sender, roomId) {
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
}
```

- [ ] **Step 2: Replace the `askAI` function**

Replace the entire `askAI` function (lines 50-79) with:

```js
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
      const args = JSON.parse(toolCall.function.arguments);
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
    const reply = followUpData.choices[0].message.content;
    pushToHistory(roomId, "assistant", reply);
    return reply;
  }

  const reply = choice.message.content;
  pushToHistory(roomId, "assistant", reply);
  return reply;
}
```

- [ ] **Step 3: Update the listener to pass `event.sender` to `askAI`**

In the `room.message` handler (line 118), change:

```js
    const reply = await askAI(roomId, userMessage);
```

to:

```js
    const reply = await askAI(roomId, event.sender, userMessage);
```

- [ ] **Step 4: Verify it parses**

Run: `node -e "import('./bot.js')" 2>&1 | head -5`

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "Rework askAI for tool-calling loop with reminder execution"
```

---

### Task 4: Wire up startup — fire callback and missed reminder notifications

**Files:**
- Modify: `bot.js` — replace the startup block (lines 134-142)

- [ ] **Step 1: Replace the startup block**

Replace the entire `client.start().then(...)` block with:

```js
client.start().then(async () => {
  botUserId = await client.getUserId();
  console.log(`✅ Bot started: ${botUserId}`);
  console.log(`🔗 AI: ${AI_API_URL} (model: ${AI_MODEL})`);

  // Fire callback: send reminder message to the room
  initReminders((sender, reminder) => {
    const body = `${sender} Reminder: ${reminder.message}`;
    const html = `<a href="https://matrix.to/#/${sender}">${sender}</a> Reminder: ${reminder.message}`;
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
      const html = `<a href="https://matrix.to/#/${sender}">${sender}</a> ${text}`;
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
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "import('./bot.js')" 2>&1 | head -5`

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "Wire up reminder fire callback and missed reminder notifications at startup"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Verify clean startup**

Run: `node bot.js` (with valid `.env`)
Expected output includes:
```
✅ Bot started: @bot:...
🔗 AI: ...
⏰ Reminders loaded
```

- [ ] **Step 2: Test scheduling a reminder**

Send a DM to the bot: "remind me in 1 minute to test the bot"
Expected: Bot responds with a confirmation. After 1 minute, bot sends a message mentioning you with "Reminder: test the bot".

Verify `./data/reminders.json` was created and contains the reminder (then is cleaned up after it fires).

- [ ] **Step 3: Test listing reminders**

Set a reminder for 10 minutes out, then ask: "what are my reminders?"
Expected: Bot lists the active reminder with its ID and fire time.

- [ ] **Step 4: Test cancelling a reminder**

Ask: "cancel that reminder"
Expected: Bot confirms cancellation. The reminder is removed from `./data/reminders.json`.

- [ ] **Step 5: Test recurring reminder**

Send: "remind me every 2 minutes to stretch"
Expected: Bot confirms. Reminder fires every 2 minutes. `reminders.json` shows `repeatIntervalSeconds: 120`.

- [ ] **Step 6: Test missed reminders on restart**

1. Set a reminder for 1 minute out.
2. Stop the bot before it fires.
3. Wait for the fire time to pass.
4. Restart the bot.
Expected: Bot sends one message: "Sorry for the inconvenience -- I was offline and missed some reminders: ..."

- [ ] **Step 7: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "Fix issues found during smoke testing"
```
