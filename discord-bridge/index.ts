#!/usr/bin/env bun
/**
 * Discord ↔ Fakechat bridge.
 *
 * Standalone process that bridges Discord messages into Claude Code's
 * fakechat plugin via WebSocket. Fakechat handles MCP channel delivery
 * and auto-wake — this adapter just translates between Discord and
 * fakechat's wire protocol.
 *
 * One instance per project. Reads config from env or .env file.
 *
 * Env vars:
 *   DISCORD_BOT_TOKEN  — bot token
 *   BRIDGE_CHANNEL_ID  — Discord channel to bridge
 *   FAKECHAT_PORT      — fakechat plugin port (default: 8787)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkMessage } from "@shunt/shared/chunk.ts";
import { RecentBuffer } from "@shunt/shared/recent-buffer.ts";
import { tailProjectSession } from "@shunt/shared/session-tail.ts";
import { Client, GatewayIntentBits, type Message, type TextChannel } from "discord.js";

// Load .env
try {
  for (const line of readFileSync(join(import.meta.dir, ".env"), "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.BRIDGE_CHANNEL_ID;
const FAKECHAT_PORT = Number(process.env.FAKECHAT_PORT ?? 8787);
const FAKECHAT_URL = `ws://localhost:${FAKECHAT_PORT}/ws`;
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://localhost:9000";
const PROJECT_NAME = process.env.PROJECT_NAME || "unknown";
const PROJECT_PATH = process.env.PROJECT_PATH;
const STATUS_UPDATE_INTERVAL = 60_000; // update status message every 60s

if (!TOKEN) {
  console.error("[discord-bridge] DISCORD_BOT_TOKEN required");
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error("[discord-bridge] BRIDGE_CHANNEL_ID required");
  process.exit(1);
}

// --- Discord Client ---

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Typing indicator ---
// Discord typing lasts ~10s, so we refresh on an interval.
// Cleared when the bot sends a message.
let typingInterval: ReturnType<typeof setInterval> | null = null;

function startTyping(channel: TextChannel) {
  stopTyping();
  channel.sendTyping().catch(() => {});
  typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 8000);
  // Safety: stop after 2 minutes regardless
  setTimeout(stopTyping, 120000);
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
}

// Track our own sent messages to avoid echo loops
const sentIds = new Set<string>();
const SENT_CAP = 200;

function noteSent(id: string) {
  sentIds.add(id);
  if (sentIds.size > SENT_CAP) {
    const first = sentIds.values().next().value;
    if (first) sentIds.delete(first);
  }
}

// --- Status Message ---

let statusMessageId: string | null = null;
let messageCount = 0;
const startTime = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function buildStatusEmbed(offline = false) {
  const uptime = formatUptime(Date.now() - startTime);
  const discordOk = !offline && discord.isReady();
  const fakechatOk = !offline && ws?.readyState === WebSocket.OPEN;
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });

  const status = offline ? "⚫ Offline" : discordOk && fakechatOk ? "🟢 Online" : "🔴 Degraded";

  return {
    embeds: [
      {
        title: `shunt — ${PROJECT_NAME}`,
        color: offline ? 0x484f58 : discordOk && fakechatOk ? 0x3fb950 : 0xf85149,
        fields: [
          { name: "Status", value: status, inline: true },
          { name: "Uptime", value: offline ? "—" : uptime, inline: true },
          { name: "Messages", value: `${messageCount}`, inline: true },
          { name: "Discord", value: discordOk ? "✓ Connected" : "✗ Disconnected", inline: true },
          {
            name: "Fakechat",
            value: fakechatOk ? `✓ :${FAKECHAT_PORT}` : "✗ Disconnected",
            inline: true,
          },
          { name: "Dashboard", value: DASHBOARD_URL, inline: true },
        ],
        footer: { text: offline ? `Went offline at ${ts}` : `Last updated ${ts}` },
      },
    ],
  };
}

async function updateStatusMessage() {
  try {
    const channel = (await discord.channels.fetch(CHANNEL_ID!)) as TextChannel;
    if (!channel) return;

    const embed = buildStatusEmbed();

    if (statusMessageId) {
      // Try to edit existing status message
      try {
        const msg = await channel.messages.fetch(statusMessageId);
        await msg.edit(embed);
        return;
      } catch {
        // Message was deleted or not found — create a new one
        statusMessageId = null;
      }
    }

    // Look for an existing pinned status message from this bot
    const pins = await channel.messages.fetchPins();
    const existing = pins.items.find(
      (p: { message: Message }) =>
        p.message.author.id === discord.user?.id &&
        p.message.embeds?.[0]?.title?.startsWith("shunt"),
    );
    if (existing) {
      statusMessageId = existing.message.id;
      await existing.message.edit(embed);
      return;
    }

    // Create and pin a new status message
    const sent = await channel.send(embed);
    noteSent(sent.id);
    statusMessageId = sent.id;
    await sent.pin().catch(() => {});
    console.log(`[discord-bridge] pinned status message: ${sent.id}`);
  } catch (err) {
    console.error("[discord-bridge] status update failed:", err);
  }
}

// --- Fakechat WebSocket Connection ---

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Dedup buffer: tracks (from, text) pairs seen via the fakechat WS so the
// jsonl tailer doesn't duplicate them when forwarding TUI-originated turns.
const recentFakechat = new RecentBuffer();

function connectFakechat() {
  console.log(`[discord-bridge] connecting to fakechat at ${FAKECHAT_URL}`);

  ws = new WebSocket(FAKECHAT_URL);

  ws.onopen = () => {
    console.log("[discord-bridge] connected to fakechat");
  };

  ws.onclose = () => {
    console.log("[discord-bridge] fakechat disconnected, reconnecting in 3s...");
    ws = null;
    reconnectTimer = setTimeout(connectFakechat, 3000);
  };

  ws.onerror = (err) => {
    console.error("[discord-bridge] fakechat ws error:", err);
  };

  // Listen for bot replies from fakechat → forward to Discord
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(String(event.data));

      if (data.type !== "msg") return;

      // Mark this turn as seen via the fakechat fast path so the jsonl
      // tailer (below) doesn't re-broadcast it a moment later.
      if (typeof data.text === "string" && (data.from === "user" || data.from === "assistant")) {
        recentFakechat.mark(data.from, data.text);
      }

      // Skip messages that originated from Discord (we prefixed them with [Discord])
      if (data.from === "user" && data.text?.startsWith("[Discord]")) return;

      // Forward bot replies and web user messages to Discord
      if (data.from === "assistant" || data.from === "user") {
        messageCount++;
        const channel = (await discord.channels.fetch(CHANNEL_ID!)) as TextChannel;
        if (!channel) return;

        // Prefix web user messages so Discord knows who sent them
        const text = data.from === "user" ? `**[Web]** ${data.text}` : data.text;
        const chunks = chunkMessage(text, 1900);
        for (let i = 0; i < chunks.length; i++) {
          const opts: Record<string, unknown> = { content: chunks[i] };
          if (i === 0 && data.replyTo) {
            // Only thread if the replyTo is a Discord message ID (numeric snowflake)
            if (/^\d+$/.test(data.replyTo)) {
              opts.reply = {
                messageReference: data.replyTo,
                failIfNotExists: false,
              };
            }
          }
          const sent = await channel.send(opts);
          noteSent(sent.id);
        }
        stopTyping();
        console.log(`[discord-bridge] → discord: ${data.text.slice(0, 60)}`);
      }
    } catch (err) {
      console.error("[discord-bridge] failed to forward to Discord:", err);
    }
  };
}

// --- Discord Inbound → Fakechat ---

discord.on("messageCreate", (msg: Message) => {
  if (msg.channelId !== CHANNEL_ID) return;
  if (msg.author.bot) return;
  if (sentIds.has(msg.id)) return;

  messageCount++;
  console.log(
    `[discord-bridge] discord → fakechat: ${msg.author.username}: ${msg.content.slice(0, 60)}`,
  );

  // Show typing indicator while CC processes the message
  startTyping(msg.channel as TextChannel);

  // Send to fakechat via WebSocket (same protocol fakechat's web UI uses)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        id: msg.id,
        text: `[Discord] ${msg.author.username}: ${msg.content}`,
      }),
    );

    // Also notify the dashboard so the user message appears there
    fetch(`${DASHBOARD_URL}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: PROJECT_NAME,
        user: msg.author.username,
        text: msg.content,
        id: msg.id,
        source: "discord",
      }),
    }).catch(() => {}); // dashboard may not be running
  } else {
    console.warn("[discord-bridge] fakechat not connected, message dropped");
    msg.react("❌").catch(() => {});
  }
});

discord.once("clientReady", (c) => {
  console.log(
    `[discord-bridge] Discord connected as ${c.user.tag}, bridging channel ${CHANNEL_ID}`,
  );
  // Post initial status message and start periodic updates
  updateStatusMessage();
  setInterval(updateStatusMessage, STATUS_UPDATE_INTERVAL);
});

// --- Health check server ---

const HEALTH_PORT = Number(process.env.BRIDGE_HEALTH_PORT ?? 8901);

Bun.serve({
  port: HEALTH_PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    // POST /api/to-discord — dashboard sends web user messages here
    if (url.pathname === "/api/to-discord" && req.method === "POST") {
      const body = (await req.json()) as { text: string; user?: string };
      if (!body.text?.trim()) {
        return Response.json({ error: "text required" }, { status: 400 });
      }
      const channel = (await discord.channels.fetch(CHANNEL_ID!)) as TextChannel;
      if (!channel) {
        return Response.json({ error: "channel not found" }, { status: 500 });
      }
      const label = body.user ? `**[Web] ${body.user}**` : "**[Web]**";
      const chunks = chunkMessage(`${label}: ${body.text}`, 1900);
      for (const chunk of chunks) {
        const sent = await channel.send({ content: chunk });
        noteSent(sent.id);
      }
      console.log(`[discord-bridge] web → discord: ${body.text.slice(0, 60)}`);
      return Response.json({ ok: true });
    }

    return Response.json({
      status: "ok",
      discord: discord.isReady(),
      fakechat: ws?.readyState === WebSocket.OPEN,
      channel: CHANNEL_ID,
      messageCount,
      uptime: formatUptime(Date.now() - startTime),
    });
  },
});

// --- TUI mirror via jsonl tail ---
// CC writes every turn to ~/.claude/projects/<encoded>/<session>.jsonl.
// The fakechat WS only emits frames for channel-originated turns, so
// messages typed directly in the CC terminal never hit fakechat. Tailing
// the jsonl catches them and forwards them to Discord.
//
// Dedup: turns that already flowed through fakechat are recorded in
// recentFakechat; the tailer skips anything it finds there.

let stopTail: (() => void) | null = null;

async function forwardTailEntryToDiscord(from: "user" | "assistant", text: string) {
  try {
    const channel = (await discord.channels.fetch(CHANNEL_ID!)) as TextChannel;
    if (!channel) return;

    // User entries from the TUI have no prefix; tag them so Discord readers
    // know the human was typing locally, not on Discord/web.
    const label = from === "user" ? "**[Terminal]**" : null;
    const body = label ? `${label} ${text}` : text;

    messageCount++;
    const chunks = chunkMessage(body, 1900);
    for (const chunk of chunks) {
      const sent = await channel.send({ content: chunk });
      noteSent(sent.id);
    }
    console.log(`[discord-bridge] tui → discord (${from}): ${text.slice(0, 60)}`);
  } catch (err) {
    console.error("[discord-bridge] tail forward failed:", err);
  }
}

function startTailMirror() {
  if (!PROJECT_PATH) {
    console.warn("[discord-bridge] PROJECT_PATH not set — TUI mirror disabled");
    return;
  }
  stopTail = tailProjectSession(PROJECT_PATH, (entry) => {
    // Channel-originated user turns land in the jsonl wrapped in
    // `<channel source="...">...</channel>` XML — fakechat already
    // forwarded the inner text, so skip the wrapped version.
    if (entry.from === "user" && entry.text.startsWith("<channel ")) return;
    // Already broadcast via fakechat; skip to avoid duplicates.
    if (recentFakechat.seen(entry.from, entry.text)) return;
    // Belt-and-braces for the old prefix-tagged format.
    if (entry.from === "user" && /^\[(Discord|Web)\]/.test(entry.text)) return;
    forwardTailEntryToDiscord(entry.from, entry.text);
  });
  console.log(`[discord-bridge] mirroring TUI turns from ${PROJECT_PATH}`);
}

// --- Startup ---

console.log(`[discord-bridge] health check on :${HEALTH_PORT}`);
connectFakechat();
startTailMirror();

discord.login(TOKEN).catch((err) => {
  console.error(`[discord-bridge] Discord login failed: ${err}`);
  process.exit(1);
});

// Graceful shutdown
async function gracefulShutdown() {
  console.log("[discord-bridge] shutting down...");
  // Update status message to offline before disconnecting
  if (statusMessageId && discord.isReady()) {
    try {
      const channel = (await discord.channels.fetch(CHANNEL_ID!)) as TextChannel;
      if (channel) {
        const msg = await channel.messages.fetch(statusMessageId);
        await msg.edit(buildStatusEmbed(true));
      }
    } catch {}
  }
  discord.destroy();
  ws?.close();
  stopTail?.();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
