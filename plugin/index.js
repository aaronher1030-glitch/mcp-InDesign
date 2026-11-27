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
const approvalEl = document.getElementById("approval");
const approvalSummaryEl = document.getElementById("approvalSummary");
const approvalPagesEl = document.getElementById("approvalPages");
const approvalPlanEl = document.getElementById("approvalPlan");
const approveBtn = document.getElementById("approveBtn");
const cancelBtn = document.getElementById("cancelBtn");

let messages = [];
let turnAbort = null;
let pendingApproval = null;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function sendMessageError(ws, id, error) {
  ws.send(JSON.stringify({ type: "error", id: id ?? null, code: "INVALID_MESSAGE", error }));
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
    if (!isRecord(msg) || typeof msg.id !== "string" || !msg.id
        || msg.type !== "execute" || typeof msg.code !== "string" || !msg.code.trim()) {
      throw new Error("Execute messages need a non-empty string id, type, and code.");
    }
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
    const id = isRecord(msg) && typeof msg.id === "string" ? msg.id : null;
    ws.send(JSON.stringify({ type: "error", id, error: e.message || String(e) }));
  }
}

function connectToBridge() {
  const token = currentSettings().bridgeToken;
  const ws = token
    ? new WebSocket(BRIDGE_WS, "indesign-auth." + encodeURIComponent(token))
    : new WebSocket(BRIDGE_WS);

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
      sendMessageError(ws, null, "Bridge message must contain valid JSON.");
      return;
    }
    if (!isRecord(msg)) {
      sendMessageError(ws, null, "Bridge message must be a non-null object.");
      return;
    }
    if (typeof msg.id !== "string" || !msg.id) {
      sendMessageError(ws, null, "Bridge message needs a non-empty string id.");
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", id: msg.id }));
    } else if (msg.type === "execute") {
      if (typeof msg.code !== "string" || !msg.code.trim()) {
        sendMessageError(ws, msg.id, "Execute messages need a non-empty string code.");
        return;
      }
      handleExecute(ws, msg);
    } else {
      sendMessageError(ws, msg.id, "Bridge message type must be ping or execute.");
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
  document.getElementById("apiKey").value = "";
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!isRecord(saved)) throw new Error("Saved settings must be an object.");
    document.getElementById("provider").value = saved.provider === "anthropic" ? "anthropic" : "openai";
    document.getElementById("baseUrl").value = typeof saved.baseUrl === "string" ? saved.baseUrl : "";
    document.getElementById("model").value = typeof saved.model === "string" ? saved.model : "";
    document.getElementById("bridgeToken").value = typeof saved.bridgeToken === "string" ? saved.bridgeToken : "";
    // Migrate legacy settings by replacing the record with non-secret fields only.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistedSettings()));
  } catch (e) {
    localStorage.removeItem(SETTINGS_KEY);
    console.error("[Plugin] Could not read settings", e);
  }
}

function currentSettings() {
  return {
    provider: document.getElementById("provider").value,
    baseUrl: document.getElementById("baseUrl").value.trim(),
    model: document.getElementById("model").value.trim(),
    apiKey: document.getElementById("apiKey").value,
    bridgeToken: document.getElementById("bridgeToken").value.trim(),
  };
}

function persistedSettings() {
  const settings = currentSettings();
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    bridgeToken: settings.bridgeToken,
  };
}

function bridgeHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = currentSettings().bridgeToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function hasPlanDetails(approval) {
  return isRecord(approval)
    && typeof approval.planId === "string" && approval.planId.trim().length > 0
    && Number.isInteger(approval.version) && approval.version > 0
    && Array.isArray(approval.targets) && Array.isArray(approval.steps);
}

function normalizedAffectedPages(approval) {
  const pages = isRecord(approval) && Array.isArray(approval.affectedPages)
    ? approval.affectedPages
    : null;
  if (!pages || pages.length === 0
      || pages.some((page) => !Number.isInteger(page) || page < 0)
      || new Set(pages).size !== pages.length) return null;
  return [...pages].sort((left, right) => left - right);
}

function isArtifactPath(path) {
  return typeof path === "string"
    && /^(?:[a-z]:[\\/]|[\\/])/i.test(path.trim())
    && /\.png$/i.test(path.trim())
    && !path.includes("\0");
}

function beforeArtifactPaths(approval) {
  const value = isRecord(approval) ? approval.beforeArtifacts : null;
  const paths = Array.isArray(value)
    ? value
    : (isRecord(value) && Array.isArray(value.paths) ? value.paths : null);
  if (!paths || paths.length === 0 || paths.some((path) => !isArtifactPath(path))) {
    return null;
  }
  const normalized = paths.map((path) => path.trim());
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function beforeRenderError(approval) {
  if (!isRecord(approval)) return "Before-render details are unavailable.";
  const nested = isRecord(approval.beforeArtifacts) ? approval.beforeArtifacts.error : null;
  const error = approval.beforeArtifactsError ?? nested;
  if (error === undefined || error === null || error === "") return null;
  return typeof error === "string" && error.trim()
    ? error.trim()
    : "The before-render operation reported an error.";
}

function samePages(left, right) {
  return left.length === right.length && left.every((page, index) => page === right[index]);
}

function hasCompleteRenderCoverage(approval, paths, affectedPages) {
  let pageIndexes = approval.beforeArtifactsPageIndexes;
  if (pageIndexes === undefined) {
    // Older events can still prove coverage when every path is a renderer PNG.
    pageIndexes = paths.map((path) => {
      const match = path.match(/(?:^|[\\/])page_(\d+)\.png$/i);
      return match ? Number(match[1]) - 1 : null;
    });
  }
  if (!Array.isArray(pageIndexes) || pageIndexes.length !== paths.length
      || pageIndexes.some((page) => !Number.isInteger(page) || page < 0)
      || new Set(pageIndexes).size !== pageIndexes.length) return false;
  return samePages([...pageIndexes].sort((left, right) => left - right), affectedPages);
}

function approvalDetailsError(approval) {
  if (!hasPlanDetails(approval)) return "Exact plan details are unavailable.";
  const affectedPages = normalizedAffectedPages(approval);
  if (!affectedPages) return "The affected-page list is missing or invalid.";
  const renderError = beforeRenderError(approval);
  if (renderError) return `Before-render failed: ${renderError}.`;
  const paths = beforeArtifactPaths(approval);
  if (!paths) return "Before-render artifacts are missing or invalid.";
  if (!hasCompleteRenderCoverage(approval, paths, affectedPages)) {
    return `Before-render coverage is incomplete for affected pages ${affectedPages.map((page) => page + 1).join(", ")}.`;
  }
  return null;
}

function hasExactApproval(approval) {
  return approvalDetailsError(approval) === null;
}

function showApproval(approval) {
  const error = approvalDetailsError(approval);
  const exact = error === null;
  const details = hasPlanDetails(approval);
  pendingApproval = exact ? approval : null;
  approveBtn.disabled = !exact;
  approvalSummaryEl.textContent = approval && approval.summary ? approval.summary : "This plan is high risk.";
  const pages = normalizedAffectedPages(approval);
  approvalPagesEl.textContent = pages
    ? `Pages: ${pages.map((page) => page + 1).join(", ")} - applied only if you approve.`
    : "";
  if (error) approvalPagesEl.textContent += ` ${error} Approval is disabled; ask Copilot to plan again.`;
  approvalPlanEl.textContent = details
    ? `${error ? `Approval disabled: ${error}\n\n` : ""}Exact plan version ${approval.version}\n${JSON.stringify({
      targets: approval.targets,
      steps: approval.steps,
      beforeArtifacts: approval.beforeArtifacts,
      beforeArtifactsPageIndexes: approval.beforeArtifactsPageIndexes,
    }, null, 2)}`
    : `Exact plan details are unavailable. ${error || "Approval is disabled; ask Copilot to plan again."}`;
  approvalEl.classList.add("open");
  activityEl.textContent = exact ? "Waiting for your approval." : `Approval disabled: ${error}`;
}

function clearApproval() {
  pendingApproval = null;
  approvalSummaryEl.textContent = "";
  approvalPagesEl.textContent = "";
  approvalPlanEl.textContent = "";
  approveBtn.disabled = false;
  approvalEl.classList.remove("open");
}

async function sendApproval(approved) {
  if (!pendingApproval || !hasExactApproval(pendingApproval)) return;
  const approval = { planId: pendingApproval.planId, approved, version: pendingApproval.version };
  clearApproval();
  sendBtn.disabled = true;
  sendBtn.textContent = "Stop";
  const live = { text: "" };
  turnAbort = new AbortController();
  try {
    const response = await fetch(`${BRIDGE_HTTP}/chat`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify({ approval, settings: currentSettings() }),
      signal: turnAbort.signal,
    });
    if (!response.ok) {
      let message = `Approval failed (${response.status})`;
      try {
        const body = await response.json();
        if (body.error) message = body.error;
      } catch (e) { /* keep status text */ }
      activityEl.textContent = message;
      return;
    }
    await readSse(response, (event) => applyEvent(event, live));
    if (live.text) messages.push({ role: "assistant", content: live.text });
    render();
  } catch (e) {
    if (e.name !== "AbortError") activityEl.textContent = e.message || String(e);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
    turnAbort = null;
    document.getElementById("apiKey").value = "";
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistedSettings()));
  activityEl.textContent = "Non-secret settings saved. The API key was not saved.";
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
  if (event.type === "approval") {
    if (live.text) {
      messages.push({ role: "assistant", content: live.text });
      live.text = "";
    }
    render();
    showApproval(event);
    return;
  }
  if (event.type === "done" && Array.isArray(event.messages)) {
    if (event.messages.length > 0) messages = event.messages;
    live.text = "";
    activityEl.textContent = "";
    render();
    return;
  }
  if (event.type === "error") {
    clearApproval();
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
      headers: bridgeHeaders(),
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
    document.getElementById("apiKey").value = "";
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
  clearApproval();
  render();
});

approveBtn.addEventListener("click", () => sendApproval(true));
cancelBtn.addEventListener("click", () => sendApproval(false));

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
