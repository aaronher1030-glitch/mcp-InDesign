/**
 * HTTP + WebSocket bridge between the MCP server / Copilot panel and the
 * InDesign UXP plugin. Importable so the packaged executable can run it
 * in-process; `node bridge/server.js` still runs it standalone.
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { BRIDGE_HTTP_PORT, BRIDGE_WS_PORT } from '../src/version.js';

const TIMEOUT_MS = 30000;
const AUTH_PATHS = ['/execute', '/chat', '/status'];
const WS_AUTH_PREFIX = 'indesign-auth.';
const PLUGIN_MESSAGE_TYPES = new Set(['result', 'error', 'pong']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultLog(...args) {
  // stdout is reserved for the MCP protocol, so all bridge logs go to stderr.
  console.error('[Bridge]', ...args);
}

function bearerMiddleware(token) {
  return (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid BRIDGE_TOKEN' });
    }
    next();
  };
}

function authenticatedUpgrade(token, info) {
  if (info.req.headers.authorization === `Bearer ${token}`) return true;
  const protocol = info.req.headers['sec-websocket-protocol'];
  if (typeof protocol !== 'string' || !protocol.startsWith(WS_AUTH_PREFIX)) return false;
  try {
    return decodeURIComponent(protocol.slice(WS_AUTH_PREFIX.length)) === token;
  } catch {
    return false;
  }
}

function invalidRequest(res, error) {
  return res.status(400).json({ success: false, code: 'INVALID_REQUEST', error });
}

function pluginMessageError(message) {
  if (!isRecord(message)) return 'Plugin message must be a non-null object.';
  if (typeof message.id !== 'string' || !message.id) return 'Plugin message needs a non-empty string id.';
  if (typeof message.type !== 'string' || !PLUGIN_MESSAGE_TYPES.has(message.type)) {
    return 'Plugin message type must be result, error, or pong.';
  }
  if (message.type === 'error' && (typeof message.error !== 'string' || !message.error)) {
    return 'Plugin error messages need a non-empty string error.';
  }
  return null;
}

function sse(res, emit) {
  const write = (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  return write;
}

/**
 * Express app with no listening socket, used by startBridge and by tests.
 */
export function createBridgeApp({
  token = null,
  isConnected = () => false,
  execute = async () => {
    throw new Error('Plugin not connected. In InDesign, open Window -> Plugins -> InDesign Copilot.');
  },
  chatTurn = null,
  approvalTurn = null,
  status = () => ({}),
  log = defaultLog,
} = {}) {
  const app = express();
  app.use(express.json({ limit: '4mb', strict: false }));
  if (token) app.use(AUTH_PATHS, bearerMiddleware(token));

  app.get('/status', (req, res) => {
    res.json({ connected: Boolean(isConnected()), ...status() });
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, connected: Boolean(isConnected()) });
  });

  app.post('/execute', async (req, res) => {
    if (!isConnected()) {
      return res.status(503).json({
        error: 'Plugin not connected. In InDesign, open Window -> Plugins -> InDesign Copilot.',
      });
    }
    const { code } = isRecord(req.body) ? req.body : {};
    if (typeof code !== 'string' || !code.trim()) {
      return invalidRequest(res, 'Request body must be an object with a non-empty string "code".');
    }
    try {
      res.json({ result: await execute(code) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  let chatActive = false;

  app.post('/chat', async (req, res) => {
    if (!chatTurn) return res.status(503).json({ error: 'Chat is not available in this mode.' });
    if (!isRecord(req.body)) return invalidRequest(res, 'Chat request body must be a non-null object.');
    const body = req.body;
    const approval = body.approval;
    if (approval !== undefined) {
      if (!isRecord(approval) || typeof approval.planId !== 'string' || !approval.planId
          || typeof approval.approved !== 'boolean') {
        return invalidRequest(res, 'Approval needs a planId and boolean approved value.');
      }
      if (approval.approved && (!Number.isInteger(approval.version) || approval.version < 1)) {
        return invalidRequest(res, 'Approval needs the exact positive integer plan version.');
      }
    }
    if (!approval && !isConnected()) {
      return res.status(503).json({
        error: 'InDesign is not connected. Open Window -> Plugins -> InDesign Copilot and wait until it says connected.',
      });
    }
    if (chatActive) return res.status(409).json({ error: 'A chat turn is already running.' });

    chatActive = true;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const controller = new AbortController();
    const stop = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', stop);
    req.on('aborted', stop);
    const emit = sse(res, null);

    try {
      if (approval) {
        if (!approvalTurn) throw new Error('Approval is not available.');
        await approvalTurn({
          approval,
          settings: body.settings,
          emit,
          signal: controller.signal,
          shouldStop: () => controller.signal.aborted,
        });
      } else {
        await chatTurn({
          messages: body.messages,
          settings: body.settings,
          emit,
          signal: controller.signal,
          shouldStop: () => controller.signal.aborted,
        });
      }
    } catch (error) {
      emit({ type: 'error', message: error.message || String(error) });
    } finally {
      req.removeListener('aborted', stop);
      res.removeListener('close', stop);
      chatActive = false;
      if (!res.writableEnded) res.end();
    }
    return undefined;
  });

  app.use((error, req, res, next) => {
    log('HTTP error:', error.message);
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed' || error.status === 400) {
      return invalidRequest(res, 'Request body must contain valid JSON.');
    }
    return res.status(500).json({ error: error.message || 'Bridge error' });
  });

  return app;
}

/**
 * Start the WebSocket relay and HTTP API on loopback.
 */
export async function startBridge({
  httpPort = BRIDGE_HTTP_PORT,
  wsPort = BRIDGE_WS_PORT,
  token = process.env.BRIDGE_TOKEN || null,
  log = defaultLog,
} = {}) {
  const state = {
    pluginSocket: null,
    pending: new Map(),
    queue: [],
    processing: false,
  };

  const drainQueue = () => {
    if (state.processing || state.queue.length === 0) return;
    const socket = state.pluginSocket;
    if (!socket) {
      while (state.queue.length > 0) {
        state.queue.shift().reject(new Error('Plugin not connected'));
      }
      return;
    }
    state.processing = true;
    const { code, resolve, reject } = state.queue.shift();
    const id = randomUUID();
    const timer = setTimeout(() => {
      state.pending.delete(id);
      state.processing = false;
      reject(new Error('Execution timed out after 30s'));
      drainQueue();
    }, TIMEOUT_MS);

    state.pending.set(id, {
      resolve: (result) => {
        state.processing = false;
        resolve(result);
        drainQueue();
      },
      reject: (error) => {
        state.processing = false;
        reject(error);
        drainQueue();
      },
      timer,
    });

    try {
      socket.send(JSON.stringify({ type: 'execute', id, code }));
      log('Sending execute:', id, code.slice(0, 100));
    } catch (error) {
      clearTimeout(timer);
      state.pending.delete(id);
      state.processing = false;
      reject(new Error(`Failed to send to plugin: ${error.message}`));
      drainQueue();
    }
  };

  const enqueueExecution = (code) => new Promise((resolve, reject) => {
    if (typeof code !== 'string' || !code.trim()) {
      reject(new TypeError('Execution code must be a non-empty string.'));
      return;
    }
    state.queue.push({ code, resolve, reject });
    drainQueue();
  });

  const wss = new WebSocketServer({
    port: wsPort,
    host: '127.0.0.1',
    ...(token ? { verifyClient: (info) => authenticatedUpgrade(token, info) } : {}),
  });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (ws) => {
    log('Plugin connected');
    state.pluginSocket = ws;

    ws.on('message', (data) => {
      let msg;
      let parseFailed = false;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log('Invalid JSON from plugin:', data.toString().slice(0, 200));
        msg = null;
        parseFailed = true;
      }
      const validationError = parseFailed
        ? 'Plugin message must contain valid JSON.'
        : pluginMessageError(msg);
      if (validationError) {
        try {
          ws.send(JSON.stringify({
            type: 'error',
            id: isRecord(msg) && typeof msg.id === 'string' ? msg.id : null,
            code: 'INVALID_MESSAGE',
            error: validationError,
          }));
        } catch (error) {
          log('Could not return plugin validation error:', error.message);
        }
        return;
      }
      const item = state.pending.get(msg.id);
      if (!item) return;
      clearTimeout(item.timer);
      state.pending.delete(msg.id);
      if (msg.type === 'result') item.resolve(msg.result);
      else if (msg.type === 'error') item.reject(new Error(msg.error));
      else if (msg.type === 'pong') item.resolve('pong');
    });

    ws.on('close', () => {
      log('Plugin disconnected');
      state.pluginSocket = null;
      for (const [id, item] of state.pending.entries()) {
        clearTimeout(item.timer);
        item.reject(new Error('Plugin disconnected'));
        state.pending.delete(id);
      }
      state.processing = false;
      drainQueue();
    });

    ws.on('error', (error) => log('WebSocket error:', error.message));
  });

  const chatTurn = async ({ messages, settings, emit, signal, shouldStop }) => {
    const { runChat } = await import('../src/chat/agent.js');
    await runChat({ messages, settings, emit, signal, shouldStop });
  };

  const approvalTurn = async ({ approval, settings, emit, signal, shouldStop }) => {
    const { resolveApproval } = await import('../src/chat/agent.js');
    await resolveApproval({ approval, settings, emit, signal, shouldStop });
  };

  const app = createBridgeApp({
    token,
    isConnected: () => state.pluginSocket !== null,
    execute: enqueueExecution,
    chatTurn,
    approvalTurn,
    status: () => ({ queueDepth: state.queue.length }),
    log,
  });

  const httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(httpPort, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });

  log(`HTTP server on http://127.0.0.1:${httpPort}`);
  log(`WebSocket server on ws://127.0.0.1:${wsPort}`);
  log('Waiting for UXP plugin to connect...');
  if (!token) {
    log('WARNING: BRIDGE_TOKEN not set. Any local process can send InDesign commands.');
  }

  return {
    httpServer,
    wss,
    httpPort,
    wsPort,
    isConnected: () => state.pluginSocket !== null,
    close: async () => {
      await new Promise((resolve) => httpServer.close(resolve));
      // wss.close() only settles once every client disconnects, so drop the
      // plugin sockets first; otherwise shutdown waits on the plugin.
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

const invokedDirectly = typeof process.argv[1] === 'string'
  && /([\\/])bridge([\\/])server\.js$/.test(process.argv[1]);

if (invokedDirectly) {
  startBridge().catch((error) => {
    console.error('[Bridge] Failed to start:', error.message);
    process.exit(1);
  });
}
