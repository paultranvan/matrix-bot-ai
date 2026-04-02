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
