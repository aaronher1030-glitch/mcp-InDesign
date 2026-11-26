const { app } = require("indesign");
const { entrypoints } = require("uxp");

const BRIDGE_HTTP = "http://127.0.0.1:3000";
const BRIDGE_WS = "ws://127.0.0.1:3001";
const SETTINGS_KEY = "indesign-copilot-settings";

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const emptyEl = document.getElementById("empty");
const activityEl = document.getElementById("activity");
const settingsEl = document.getElementById("settings");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");

let messages = [];
let turnAbort = null;

function serializeResult(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(serializeResult);
  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return String(value);
    }
  }
  return String(value);
}

const ALLOWED_MODULES = new Set(["indesign", "uxp"]);
function sandboxedRequire(moduleName) {
  if (!ALLOWED_MODULES.has(moduleName)) {
    throw new Error(`require('${moduleName}') is not allowed inside execute calls`);
  }
  return require(moduleName);
}

async function handleExecute(ws, msg) {
  let timerId;
  try {
    const fn = new Function("app", "require", `return (async () => { ${msg.code} })()`);
    const result = await Promise.race([
      fn(app, sandboxedRequire).finally(() => clearTimeout(timerId)),
      new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error("Execution timed out in plugin (25s)")), 25000);
      }),
    ]);
    ws.send(JSON.stringify({ type: "result", id: msg.id, result: serializeResult(result) }));
  } catch (e) {
    clearTimeout(timerId);
    ws.send(JSON.stringify({ type: "error", id: msg.id, error: e.message || String(e) }));
  }
}

function connectToBridge() {
  const ws = new WebSocket(BRIDGE_WS);

  ws.onopen = () => {
    statusEl.textContent = "Connected";
    console.log("[Plugin] Connected to bridge");
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error("[Plugin] Invalid JSON:", event.data);
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", id: msg.id }));
    } else if (msg.type === "execute") {
      handleExecute(ws, msg);
    }
  };

  ws.onerror = (err) => {
    statusEl.textContent = "Bridge error";
    console.error("[Plugin] WebSocket error:", err);
  };

  ws.onclose = () => {
    statusEl.textContent = "Bridge off";
    setTimeout(connectToBridge, 3000);
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    document.getElementById("provider").value = saved.provider === "anthropic" ? "anthropic" : "openai";
    document.getElementById("baseUrl").value = saved.baseUrl || "";
    document.getElementById("model").value = saved.model || "";
    document.getElementById("apiKey").value = saved.apiKey || "";
  } catch (e) {
    console.error("[Plugin] Could not read settings", e);
  }
}

function currentSettings() {
  return {
    provider: document.getElementById("provider").value,
    baseUrl: document.getElementById("baseUrl").value.trim(),
    model: document.getElementById("model").value.trim(),
    apiKey: document.getElementById("apiKey").value,
  };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings()));
  activityEl.textContent = "Model settings saved in this panel.";
}

function toolLabel(name) {
  return (name || "tool").replace(/_/g, " ");
}

function render() {
  logEl.textContent = "";
  if (messages.length === 0) {
    logEl.appendChild(emptyEl);
    return;
  }
  for (const message of messages) {
    if (message.role === "tool") {
      const details = document.createElement("details");
      details.className = "tool";
      const summary = document.createElement("summary");
      summary.textContent = toolLabel(message.name || "tool");
      const pre = document.createElement("div");
      pre.textContent = message.content || "";
      details.appendChild(summary);
      details.appendChild(pre);
      logEl.appendChild(details);
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant" && !message.content && message.tool_calls) continue;
    const div = document.createElement("div");
    div.className = `msg ${message.role}`;
    div.textContent = message.content || "";
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function applyEvent(event, live) {
  if (event.type === "status") {
    activityEl.textContent = event.text || "";
    return;
  }
  if (event.type === "token") {
    live.text += event.text || "";
    activityEl.textContent = "";
    let bubble = document.getElementById("live");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.id = "live";
      bubble.className = "msg assistant";
      logEl.appendChild(bubble);
    }
    bubble.textContent = live.text;
    logEl.scrollTop = logEl.scrollHeight;
    return;
  }
  if (event.type === "tool") {
    if (live.text) {
      messages.push({ role: "assistant", content: live.text });
      live.text = "";
    }
    activityEl.textContent = `Running ${toolLabel(event.name)}…`;
    messages.push({ role: "tool", name: event.name, tool_call_id: event.id, content: "Running…" });
    render();
    return;
  }
  if (event.type === "tool_result") {
    const found = [...messages].reverse().find((message) => message.role === "tool" && message.tool_call_id === event.id);
    if (found) found.content = event.preview || "";
    render();
    return;
  }
  if (event.type === "done" && Array.isArray(event.messages)) {
    messages = event.messages;
    live.text = "";
    activityEl.textContent = "";
    render();
    return;
  }
  if (event.type === "error") {
    activityEl.textContent = event.message || "The chat failed.";
  }
}

function parseSseBlock(block, onEvent) {
  const lines = block.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    onEvent(JSON.parse(data));
  }
}

async function readSse(response, onEvent) {
  if (!response.body || !response.body.getReader) {
    parseSseBlock(await response.text(), onEvent);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    for (const chunk of chunks) parseSseBlock(chunk, onEvent);
  }
  if (buffer.trim()) parseSseBlock(buffer, onEvent);
}

async function sendMessage(text) {
  const settings = currentSettings();
  if (!settings.model) {
    settingsEl.classList.add("open");
    activityEl.textContent = "Open Model and enter the model name for your API key.";
    return;
  }
  messages.push({ role: "user", content: text });
  render();
  inputEl.value = "";
  sendBtn.disabled = true;
  sendBtn.textContent = "Stop";
  const live = { text: "" };
  turnAbort = new AbortController();

  try {
    const response = await fetch(`${BRIDGE_HTTP}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, settings }),
      signal: turnAbort.signal,
    });
    if (!response.ok) {
      let message = `Chat failed (${response.status})`;
      try {
        const body = await response.json();
        if (body.error) message = body.error;
      } catch (e) { /* keep status text */ }
      activityEl.textContent = message;
      return;
    }
    await readSse(response, (event) => applyEvent(event, live));
    if (live.text) {
      messages.push({ role: "assistant", content: live.text });
      render();
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      activityEl.textContent = e.message || String(e);
    }
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
    turnAbort = null;
  }
}

document.getElementById("settingsBtn").addEventListener("click", () => {
  settingsEl.classList.toggle("open");
});

document.getElementById("saveSettings").addEventListener("click", saveSettings);

document.getElementById("clearBtn").addEventListener("click", () => {
  if (turnAbort) turnAbort.abort();
  messages = [];
  activityEl.textContent = "";
  render();
});

document.getElementById("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (turnAbort) {
    turnAbort.abort();
    return;
  }
  const text = inputEl.value.trim();
  if (!text) return;
  sendMessage(text);
});

entrypoints.setup({
  panels: {
    mainPanel: {
      show() {
        loadSettings();
        connectToBridge();
      }
    }
  }
});
