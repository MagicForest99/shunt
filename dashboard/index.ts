#!/usr/bin/env bun
/**
 * shunt dashboard — Aggregated view of all Claude Code sessions.
 *
 * Connects to each project's fakechat WebSocket, shows messages from
 * all sources (Discord, web), provides per-project chat, and displays
 * session health status.
 *
 * Reads project config from shunt.yaml.
 */

import { loadConfig } from "@shunt/shared/config.ts";
import { RecentBuffer } from "@shunt/shared/recent-buffer.ts";
import { tailProjectSession } from "@shunt/shared/session-tail.ts";
import type { ServerWebSocket } from "bun";

const config = loadConfig();
const DASHBOARD_PORT = config.dashboard?.port ?? 9000;

// --- Per-project state ---

interface ProjectState {
  name: string;
  fakechatPort: number;
  bridgePort: number;
  discordChannelId: string;
  path: string;
  ws: WebSocket | null;
  connected: boolean;
  messages: Msg[];
  reconnectTimer?: ReturnType<typeof setTimeout>;
  recentFakechat: RecentBuffer;
  stopTail?: () => void;
}

interface Msg {
  id: string;
  from: "user" | "assistant";
  project: string;
  text: string;
  ts: number;
  replyTo?: string;
  source?: "discord" | "web" | "fakechat" | "terminal";
  user?: string;
}

type DashboardWire =
  | { type: "init"; projects: ProjectInfo[]; messages: Msg[] }
  | { type: "msg"; msg: Msg }
  | { type: "edit"; project: string; id: string; text: string }
  | { type: "status"; project: string; connected: boolean }
  | { type: "typing"; project: string; active: boolean };

interface ProjectInfo {
  name: string;
  fakechatPort: number;
  discordChannelId: string;
  path: string;
  connected: boolean;
  messageCount: number;
}

const MSG_CAP = 500;
const typingProjects = new Set<string>();
const projects = new Map<string, ProjectState>();

for (const [name, proj] of Object.entries(config.projects)) {
  projects.set(name, {
    name,
    fakechatPort: proj.fakechat_port,
    bridgePort: proj.bridge_port,
    discordChannelId: proj.discord_channel_id,
    path: proj.path,
    ws: null,
    connected: false,
    messages: [],
    recentFakechat: new RecentBuffer(),
  });
}

// --- Dashboard WebSocket clients ---

const dashClients = new Set<ServerWebSocket<unknown>>();

function broadcastDash(wire: DashboardWire) {
  const data = JSON.stringify(wire);
  for (const ws of dashClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function getProjectInfos(): ProjectInfo[] {
  return Array.from(projects.values()).map((p) => ({
    name: p.name,
    fakechatPort: p.fakechatPort,
    discordChannelId: p.discordChannelId,
    path: p.path,
    connected: p.connected,
    messageCount: p.messages.length,
  }));
}

function getAllMessages(): Msg[] {
  const all: Msg[] = [];
  for (const p of projects.values()) all.push(...p.messages);
  all.sort((a, b) => a.ts - b.ts);
  return all.slice(-MSG_CAP);
}

// --- Connect to each project's fakechat ---

function connectProject(proj: ProjectState) {
  const url = `ws://localhost:${proj.fakechatPort}/ws`;
  process.stderr.write(`[dashboard] connecting to ${proj.name} at ${url}\n`);

  try {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      proj.connected = true;
      proj.ws = ws;
      process.stderr.write(`[dashboard] ${proj.name} connected\n`);
      broadcastDash({ type: "status", project: proj.name, connected: true });
    };

    ws.onclose = () => {
      proj.connected = false;
      proj.ws = null;
      process.stderr.write(`[dashboard] ${proj.name} disconnected\n`);
      broadcastDash({ type: "status", project: proj.name, connected: false });
      proj.reconnectTimer = setTimeout(() => connectProject(proj), 5000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));

        if (data.type === "msg") {
          // Record in dedup buffer so the jsonl tail doesn't re-emit this turn.
          if (
            typeof data.text === "string" &&
            (data.from === "user" || data.from === "assistant")
          ) {
            proj.recentFakechat.mark(data.from, data.text);
          }

          const msg: Msg = {
            id: data.id,
            from: data.from,
            project: proj.name,
            text: data.text,
            ts: data.ts || Date.now(),
            replyTo: data.replyTo,
          };
          proj.messages.push(msg);
          if (proj.messages.length > MSG_CAP) proj.messages.shift();

          // Typing indicator: assistant reply clears it
          if (data.from === "assistant" && typingProjects.has(proj.name)) {
            typingProjects.delete(proj.name);
            broadcastDash({ type: "typing", project: proj.name, active: false });
          }

          broadcastDash({ type: "msg", msg });
        }

        if (data.type === "edit") {
          broadcastDash({
            type: "edit",
            project: proj.name,
            id: data.id,
            text: data.text,
          });
        }
      } catch {}
    };
  } catch {
    proj.reconnectTimer = setTimeout(() => connectProject(proj), 5000);
  }
}

// Forward web messages to Discord via the bridge
function forwardToDiscord(proj: ProjectState, text: string, user?: string) {
  if (!proj.bridgePort) return;
  fetch(`http://localhost:${proj.bridgePort}/api/to-discord`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, user: user || "web" }),
  }).catch(() => {}); // bridge may not be running
}

// Start tailing each project's CC session jsonl.
// The fakechat WS only emits frames for turns that entered through a
// channel (Discord or web). Turns typed directly in the CC terminal
// never hit fakechat, so the dashboard would miss them entirely.
// The jsonl is the ground truth — tail it and emit anything fakechat
// didn't already show us.
function startTailFor(proj: ProjectState) {
  proj.stopTail = tailProjectSession(proj.path, (entry) => {
    // Channel-originated user turns appear in the jsonl as
    // `<channel source="...">...</channel>` wrappers; fakechat already
    // delivered the inner text via its WS, so skip the wrapped copy.
    if (entry.from === "user" && entry.text.startsWith("<channel ")) return;
    if (proj.recentFakechat.seen(entry.from, entry.text)) return;
    // Belt-and-braces for the legacy prefix format.
    if (entry.from === "user" && /^\[(Discord|Web)\]/.test(entry.text)) return;

    const msg: Msg = {
      id: `tail-${entry.uuid || Date.now()}`,
      from: entry.from,
      project: proj.name,
      text: entry.text,
      ts: entry.ts,
      source: "terminal",
    };
    proj.messages.push(msg);
    if (proj.messages.length > MSG_CAP) proj.messages.shift();

    // Assistant reply from the terminal clears any stale typing state.
    if (entry.from === "assistant" && typingProjects.has(proj.name)) {
      typingProjects.delete(proj.name);
      broadcastDash({ type: "typing", project: proj.name, active: false });
    }

    broadcastDash({ type: "msg", msg });
  });
}

// Start connecting to all projects
for (const proj of projects.values()) {
  connectProject(proj);
  startTailFor(proj);
}

// --- HTTP Server ---

Bun.serve({
  port: DASHBOARD_PORT,
  hostname: "0.0.0.0",

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/api/status") {
      return Response.json({
        status: "ok",
        projects: getProjectInfos(),
        totalMessages: getAllMessages().length,
      });
    }

    // Send message from dashboard to a project's fakechat
    if (url.pathname === "/api/send" && req.method === "POST") {
      return (async () => {
        const body = (await req.json()) as {
          project: string;
          text: string;
        };
        const proj = projects.get(body.project);
        if (!proj) {
          return Response.json({ error: "unknown project" }, { status: 404 });
        }
        if (!proj.ws || proj.ws.readyState !== WebSocket.OPEN) {
          return Response.json({ error: "project not connected" }, { status: 503 });
        }

        const id = `dash-${Date.now()}`;
        // Send to fakechat (which delivers to CC)
        proj.ws.send(JSON.stringify({ id, text: body.text }));

        // Forward to Discord via bridge
        forwardToDiscord(proj, body.text);

        // Start typing indicator
        typingProjects.add(body.project);
        broadcastDash({ type: "typing", project: body.project, active: true });

        // Also store + broadcast so all dashboard clients see the user message
        const msg: Msg = {
          id,
          from: "user",
          project: body.project,
          text: body.text,
          ts: Date.now(),
          source: "web",
        };
        proj.messages.push(msg);
        if (proj.messages.length > MSG_CAP) proj.messages.shift();
        broadcastDash({ type: "msg", msg });

        return Response.json({ ok: true });
      })();
    }

    // Ingest endpoint — discord-bridge pushes Discord user messages here
    if (url.pathname === "/api/ingest" && req.method === "POST") {
      return (async () => {
        const body = (await req.json()) as {
          project: string;
          user: string;
          text: string;
          id?: string;
          source?: "discord" | "web" | "fakechat" | "terminal";
        };
        const proj = projects.get(body.project);
        if (!proj) {
          return Response.json({ error: "unknown project" }, { status: 404 });
        }

        const msg: Msg = {
          id: body.id || `ext-${Date.now()}`,
          from: "user",
          project: body.project,
          text: body.text,
          ts: Date.now(),
          source: body.source || "discord",
          user: body.user,
        };
        proj.messages.push(msg);
        if (proj.messages.length > MSG_CAP) proj.messages.shift();
        broadcastDash({ type: "msg", msg });

        // Start typing indicator (CC is processing)
        typingProjects.add(body.project);
        broadcastDash({ type: "typing", project: body.project, active: true });

        return Response.json({ ok: true });
      })();
    }

    if (url.pathname === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      dashClients.add(ws);
      ws.send(
        JSON.stringify({
          type: "init",
          projects: getProjectInfos(),
          messages: getAllMessages(),
        }),
      );
    },
    close(ws) {
      dashClients.delete(ws);
    },
    message(_, raw) {
      // Dashboard clients can send messages to projects
      try {
        const data = JSON.parse(String(raw)) as {
          project: string;
          text: string;
        };
        const proj = projects.get(data.project);
        if (proj?.ws?.readyState === WebSocket.OPEN) {
          const id = `dash-${Date.now()}`;
          proj.ws.send(JSON.stringify({ id, text: data.text }));

          // Forward to Discord via bridge
          forwardToDiscord(proj, data.text);

          // Start typing indicator
          typingProjects.add(data.project);
          broadcastDash({ type: "typing", project: data.project, active: true });

          // Store + broadcast user message
          const msg: Msg = {
            id,
            from: "user",
            project: data.project,
            text: data.text,
            ts: Date.now(),
            source: "web",
          };
          proj.messages.push(msg);
          if (proj.messages.length > MSG_CAP) proj.messages.shift();
          broadcastDash({ type: "msg", msg });
        }
      } catch {}
    },
  },
});

process.stderr.write(
  `[dashboard] http://localhost:${DASHBOARD_PORT} — ${projects.size} projects\n`,
);

// --- Dashboard HTML ---

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shunt dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0d1117; --bg2: #161b22; --border: #30363d;
    --text: #c9d1d9; --text-dim: #484f58; --text-bright: #f0f6fc;
    --blue: #7289da; --green: #3fb950; --orange: #f0883e; --red: #f85149;
  }
  body { font-family: 'JetBrains Mono', 'Fira Code', monospace; background: var(--bg); color: var(--text); height: 100vh; display: flex; }

  /* Sidebar */
  #sidebar { width: 240px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  #sidebar header { padding: 16px; border-bottom: 1px solid var(--border); }
  #sidebar header h1 { font-size: 16px; color: var(--text-bright); }
  #sidebar header .subtitle { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
  #project-list { flex: 1; overflow-y: auto; padding: 8px; }
  .project-item { padding: 10px 12px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; font-size: 12px; }
  .project-item:hover { background: #1c2129; }
  .project-item.active { background: #1f2937; border: 1px solid var(--border); }
  .project-name { font-weight: 600; color: var(--text-bright); display: flex; align-items: center; gap: 6px; }
  .project-meta { color: var(--text-dim); font-size: 10px; margin-top: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot-green { background: var(--green); }
  .dot-red { background: var(--red); }
  .dot-yellow { background: #d29922; }
  #sidebar-footer { padding: 12px 16px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-dim); }

  /* Main area */
  #main { flex: 1; display: flex; flex-direction: column; }
  #main-header { padding: 12px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  #main-header h2 { font-size: 14px; color: var(--text-bright); }
  .badge { font-size: 10px; padding: 2px 8px; border-radius: 12px; }
  .badge-blue { background: #5865f233; color: var(--blue); }
  .badge-green { background: #23863633; color: var(--green); }
  .header-status { margin-left: auto; font-size: 11px; color: var(--text-dim); }

  /* Messages */
  #log { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .msg { padding: 3px 0; line-height: 1.6; word-break: break-word; font-size: 13px; }
  .msg-ts { color: var(--text-dim); font-size: 11px; }
  .msg-project { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: #30363d; color: var(--text-dim); margin-right: 4px; }
  .msg-from-user .msg-user { color: var(--blue); }
  .msg-from-assistant .msg-user { color: var(--orange); }
  .msg-user { font-weight: 600; }
  .msg-text { color: var(--text); white-space: pre-wrap; }
  .msg-source { font-size: 9px; padding: 1px 5px; border-radius: 3px; margin-right: 4px; vertical-align: middle; }
  .src-discord { background: #5865f233; color: var(--blue); }
  .src-web { background: #23863633; color: var(--green); }
  .src-bot { background: #f0883e33; color: var(--orange); }
  .md-codeblock { background: #161b22; border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin: 4px 0; overflow-x: auto; display: block; }
  .md-codeblock code { color: #e6edf3; font-size: 12px; }
  .md-code { background: #343942; padding: 1px 5px; border-radius: 3px; font-size: 12px; color: #e6edf3; }
  .md-h1 { font-size: 16px; font-weight: 700; color: var(--text-bright); display: block; margin: 8px 0 4px; }
  .md-h2 { font-size: 14px; font-weight: 700; color: var(--text-bright); display: block; margin: 6px 0 3px; }
  .md-h3 { font-size: 13px; font-weight: 600; color: var(--text-bright); display: block; margin: 4px 0 2px; }
  .md-li { display: block; padding-left: 16px; }
  .md-li::before { content: "\\2022 "; color: var(--text-dim); margin-left: -12px; }
  .md-link { color: #58a6ff; text-decoration: none; }
  .md-link:hover { text-decoration: underline; }

  /* Input */
  #input-area { padding: 12px 16px; background: var(--bg2); border-top: 1px solid var(--border); flex-shrink: 0; }
  #input-row { display: flex; gap: 8px; }
  #text { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font: inherit; font-size: 13px; padding: 8px 12px; resize: none; outline: none; }
  #text:focus { border-color: #58a6ff; }
  #send { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font: inherit; font-size: 13px; cursor: pointer; }
  #send:hover { background: #2ea043; }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
  .input-meta { font-size: 10px; color: var(--text-dim); margin-top: 6px; }

  /* All view */
  .view-toggle { display: flex; gap: 4px; }
  .view-btn { background: none; border: 1px solid var(--border); color: var(--text-dim); padding: 2px 10px; border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer; }
  .view-btn.active { background: var(--border); color: var(--text-bright); }

  /* Typing indicator */
  #typing { padding: 4px 16px; font-size: 12px; color: var(--orange); display: none; }
  #typing.active { display: flex; align-items: center; gap: 8px; }
  .typing-dots { display: flex; gap: 3px; }
  .typing-dots span { width: 5px; height: 5px; border-radius: 50%; background: var(--orange); animation: blink 1.4s infinite both; }
  .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

  /* Empty state */
  .empty { color: var(--text-dim); text-align: center; padding: 40px; font-size: 13px; }
</style>
</head>
<body>
<div id="sidebar">
  <header>
    <h1>shunt</h1>
    <div class="subtitle">Claude Code session manager</div>
  </header>
  <div id="project-list"></div>
  <div id="sidebar-footer">
    <span id="total-msgs">0</span> messages &middot; <span id="ws-status">connecting</span>
  </div>
</div>
<div id="main">
  <div id="main-header">
    <div class="view-toggle">
      <button class="view-btn active" data-view="all">All</button>
    </div>
    <h2 id="view-title">All projects</h2>
    <div class="header-status" id="conn-count"></div>
  </div>
  <div id="log"></div>
  <div id="typing"><div class="typing-dots"><span></span><span></span><span></span></div><span id="typing-label">Claude is thinking...</span></div>
  <div id="input-area">
    <div id="input-row">
      <textarea id="text" rows="2" placeholder="Send a message..." autocomplete="off"></textarea>
      <button id="send" disabled>Send</button>
    </div>
    <div class="input-meta">Select a project to send messages. Enter to send, Shift+Enter for newline.</div>
  </div>
</div>

<script>
const log = document.getElementById('log')
const text = document.getElementById('text')
const sendBtn = document.getElementById('send')
const projectList = document.getElementById('project-list')
const viewTitle = document.getElementById('view-title')
const connCount = document.getElementById('conn-count')
const totalMsgs = document.getElementById('total-msgs')
const wsStatus = document.getElementById('ws-status')
const typingEl = document.getElementById('typing')
const typingLabel = document.getElementById('typing-label')

let ws
let projects = {}
let allMessages = []
let currentView = 'all' // 'all' or project name
let msgCount = 0
let typingState = {} // project -> boolean

function connect() {
  ws = new WebSocket('ws://' + location.host + '/ws')
  ws.onopen = () => { wsStatus.textContent = 'connected' }
  ws.onclose = () => { wsStatus.textContent = 'reconnecting...'; setTimeout(connect, 2000) }
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data)

    if (data.type === 'init') {
      projects = {}
      data.projects.forEach(p => { projects[p.name] = p })
      allMessages = data.messages
      msgCount = allMessages.length
      renderSidebar()
      renderMessages()
      updateHeader()
    }

    if (data.type === 'msg') {
      allMessages.push(data.msg)
      if (projects[data.msg.project]) projects[data.msg.project].messageCount++
      msgCount++
      totalMsgs.textContent = msgCount
      if (currentView === 'all' || currentView === data.msg.project) {
        appendMsg(data.msg)
      }
      renderSidebar()
    }

    if (data.type === 'status') {
      if (projects[data.project]) {
        projects[data.project].connected = data.connected
        renderSidebar()
        updateHeader()
      }
    }

    if (data.type === 'typing') {
      typingState[data.project] = data.active
      updateTyping()
    }

    if (data.type === 'edit') {
      const el = document.getElementById('msg-' + data.id)
      if (el) {
        const t = el.querySelector('.msg-text')
        if (t) t.textContent = data.text + ' (edited)'
      }
    }
  }
}

function renderSidebar() {
  const names = Object.keys(projects).sort()
  projectList.innerHTML = ''

  // All button
  const allEl = document.createElement('div')
  allEl.className = 'project-item' + (currentView === 'all' ? ' active' : '')
  allEl.innerHTML = '<div class="project-name">All projects</div><div class="project-meta">' + msgCount + ' messages</div>'
  allEl.onclick = () => switchView('all')
  projectList.appendChild(allEl)

  names.forEach(name => {
    const p = projects[name]
    const el = document.createElement('div')
    el.className = 'project-item' + (currentView === name ? ' active' : '')
    el.innerHTML = '<div class="project-name"><span class="dot ' + (p.connected ? 'dot-green' : 'dot-red') + '"></span>' + esc(name) + '</div>'
      + '<div class="project-meta">:' + p.fakechatPort + ' &middot; ' + p.messageCount + ' msgs</div>'
    el.onclick = () => switchView(name)
    projectList.appendChild(el)
  })
}

function switchView(view) {
  currentView = view
  renderSidebar()
  renderMessages()
  updateHeader()
  updateTyping()
  sendBtn.disabled = (view === 'all')
  text.placeholder = view === 'all' ? 'Select a project to send messages...' : 'Send to ' + view + '...'
}

function updateHeader() {
  if (currentView === 'all') {
    viewTitle.textContent = 'All projects'
  } else {
    viewTitle.textContent = currentView
  }
  const connected = Object.values(projects).filter(p => p.connected).length
  const total = Object.keys(projects).length
  connCount.textContent = connected + '/' + total + ' connected'
}

function renderMessages() {
  log.innerHTML = ''
  const msgs = currentView === 'all'
    ? allMessages
    : allMessages.filter(m => m.project === currentView)

  if (msgs.length === 0) {
    log.innerHTML = '<div class="empty">No messages yet</div>'
    return
  }
  msgs.forEach(m => appendMsg(m))
}

function appendMsg(m) {
  const div = document.createElement('div')
  div.className = 'msg msg-from-' + m.from
  div.id = 'msg-' + m.id
  const t = new Date(m.ts).toLocaleTimeString()
  const showProject = currentView === 'all' ? '<span class="msg-project">' + esc(m.project) + '</span>' : ''
  const who = m.from === 'assistant' ? 'claude' : (m.user || m.from)
  const src = m.source || (m.from === 'assistant' ? 'bot' : 'web')
  const srcClass = src === 'discord' ? 'src-discord' : src === 'web' ? 'src-web' : 'src-bot'
  const srcLabel = src === 'discord' ? 'D' : src === 'web' ? 'W' : 'C'
  div.innerHTML = '<span class="msg-ts">' + t + '</span> '
    + showProject
    + '<span class="msg-source ' + srcClass + '">' + srcLabel + '</span>'
    + '<span class="msg-user">' + esc(who) + '</span>: '
    + '<span class="msg-text">' + renderMarkdown(m.text) + '</span>'
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
}

function updateTyping() {
  const active = currentView === 'all'
    ? Object.values(typingState).some(v => v)
    : typingState[currentView]
  if (active) {
    const names = currentView === 'all'
      ? Object.keys(typingState).filter(k => typingState[k])
      : [currentView]
    typingLabel.textContent = names.length > 1
      ? 'Claude is thinking (' + names.join(', ') + ')...'
      : 'Claude is thinking...'
    typingEl.classList.add('active')
    log.scrollTop = log.scrollHeight
  } else {
    typingEl.classList.remove('active')
  }
}

function send() {
  if (currentView === 'all' || !ws || ws.readyState !== 1) return
  const val = text.value.trim()
  if (!val) return
  ws.send(JSON.stringify({ project: currentView, text: val }))
  text.value = ''
}

sendBtn.onclick = send
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})

function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML }

function renderMarkdown(text) {
  var s = esc(text)
  var bt = '\\x60' // backtick
  s = s.replace(new RegExp(bt+bt+bt+'(\\w*)\\n?([\\s\\S]*?)'+bt+bt+bt, 'g'), '<pre class="md-codeblock"><code>$2</code></pre>')
  s = s.replace(new RegExp(bt+'([^'+bt+']+)'+bt, 'g'), '<code class="md-code">$1</code>')
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>')
  s = s.replace(/^### (.+)$/gm, '<span class="md-h3">$1</span>')
  s = s.replace(/^## (.+)$/gm, '<span class="md-h2">$1</span>')
  s = s.replace(/^# (.+)$/gm, '<span class="md-h1">$1</span>')
  s = s.replace(/^[*-] (.+)$/gm, '<span class="md-li">$1</span>')
  s = s.replace(/^\\d+\\. (.+)$/gm, '<span class="md-li">$1</span>')
  return s
}

totalMsgs.textContent = '0'
connect()
</script>
</body>
</html>`;
