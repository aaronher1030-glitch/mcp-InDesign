import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createBridgeApp, startBridge } from '../bridge/server.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('requires the bearer token on /status, /execute and /chat', async () => {
  const app = createBridgeApp({
    token: 'secret',
    isConnected: () => true,
    execute: async (code) => `ran:${code}`,
    chatTurn: async ({ emit }) => emit({ type: 'done', messages: [] }),
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/status', '/execute', '/chat']) {
      const response = await fetch(`${base}${path}`, {
        method: path === '/status' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: path === '/status' ? undefined : JSON.stringify({ code: '1+1', messages: [] }),
      });
      assert.equal(response.status, 401, `${path} should reject a missing token`);
    }

    const status = await fetch(`${base}/status`, { headers: { Authorization: 'Bearer secret' } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).connected, true);

    const execute = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '1+1' }),
    });
    assert.equal(execute.status, 200);
    assert.equal((await execute.json()).result, 'ran:1+1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('close() drops connected plugin sockets instead of waiting for them', async () => {
  const bridge = await startBridge({ httpPort: 0, wsPort: 0, token: null, log: () => {} });
  const port = bridge.wss.address().port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  assert.equal(bridge.isConnected(), true);

  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('bridge.close() waited for the plugin socket')), 5000);
    timer.unref();
  });
  try {
    await Promise.race([bridge.close(), timeout]);
  } finally {
    clearTimeout(timer);
    client.terminate();
  }
});

test('stays open when no token is configured', async () => {
  const app = createBridgeApp({ token: null, isConnected: () => false });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await fetch(`${base}/status`);
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.connected, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function openSocket(url, protocols) {
  return new Promise((resolve, reject) => {
    const ws = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => {
      const error = new Error(`Unexpected server response: ${response.statusCode}`);
      error.statusCode = response.statusCode;
      _request.destroy();
      reject(error);
    });
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

test('rejects unauthenticated WebSockets and still executes for an authenticated plugin', async () => {
  const bridge = await startBridge({ httpPort: 0, wsPort: 0, token: 'secret', log: () => {} });
  const wsUrl = `ws://127.0.0.1:${bridge.wss.address().port}`;
  const base = `http://127.0.0.1:${bridge.httpServer.address().port}`;
  try {
    for (const protocols of [undefined, 'indesign-auth.wrong']) {
      await assert.rejects(() => openSocket(wsUrl, protocols), (error) => error.statusCode === 401);
      assert.equal(bridge.isConnected(), false);
    }
    const unavailable = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'return 1;' }),
    });
    assert.equal(unavailable.status, 503);

    const plugin = await openSocket(wsUrl, 'indesign-auth.secret');
    assert.equal(bridge.isConnected(), true);
    const generated = nextMessage(plugin);
    const responsePromise = fetch(`${base}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'return 7;' }),
    });
    const message = await generated;
    assert.equal(message.type, 'execute');
    assert.equal(typeof message.id, 'string');
    assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(message.code, 'return 7;');
    plugin.send(JSON.stringify({ type: 'result', id: message.id, result: 7 }));
    const response = await responsePromise;
    assert.deepEqual(await response.json(), { result: 7 });
    plugin.close();
  } finally {
    await bridge.close();
  }
});

test('HTTP disconnect aborts the signal passed to a running chat turn', async () => {
  let turnStarted;
  const started = new Promise((resolve) => { turnStarted = resolve; });
  let turnFinished;
  const finished = new Promise((resolve) => { turnFinished = resolve; });
  let receivedSignal;
  const app = createBridgeApp({
    token: null,
    isConnected: () => true,
    chatTurn: async ({ signal, shouldStop }) => {
      receivedSignal = signal;
      turnStarted();
      if (!(signal instanceof AbortSignal)) {
        turnFinished();
        return;
      }
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
        if (shouldStop()) resolve();
      });
      turnFinished();
    },
  });
  const server = await listen(app);
  const controller = new AbortController();
  try {
    const responsePromise = fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Move it.' }], settings: {} }),
      signal: controller.signal,
    });
    responsePromise.catch(() => {});
    await started;
    controller.abort();
    await finished;
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, true);
    await assert.rejects(() => responsePromise, (error) => error.name === 'AbortError');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed HTTP execute bodies return structured errors without stopping the bridge', async () => {
  let executions = 0;
  const app = createBridgeApp({
    token: null,
    isConnected: () => true,
    execute: async (code) => {
      executions += 1;
      return `ran:${code}`;
    },
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const body of ['null', '[]', '{}', '{"code":42}', '{"code":""}']) {
      const response = await fetch(`${base}/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(response.status, 400, body);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const error = await response.json();
      assert.equal(error.success, false);
      assert.equal(error.code, 'INVALID_REQUEST');
    }
    assert.equal(executions, 0);
    const valid = await fetch(`${base}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'return 3;' }),
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).result, 'ran:return 3;');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed plugin messages return structured errors and the relay remains usable', async () => {
  const bridge = await startBridge({ httpPort: 0, wsPort: 0, token: null, log: () => {} });
  const plugin = await openSocket(`ws://127.0.0.1:${bridge.wss.address().port}`);
  try {
    for (const message of [
      null, [], { type: 'result', result: 1 },
      { id: 'missing-type', result: 1 }, { id: 42, type: 'result', result: 1 },
      { id: 'unknown', type: 'execute', code: 'return 1;' },
    ]) {
      const reply = nextMessage(plugin);
      plugin.send(JSON.stringify(message));
      const error = await reply;
      assert.equal(error.type, 'error');
      assert.equal(error.code, 'INVALID_MESSAGE');
      assert.equal(typeof error.error, 'string');
    }

    const generated = nextMessage(plugin);
    const responsePromise = fetch(`http://127.0.0.1:${bridge.httpServer.address().port}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'return 11;' }),
    });
    const message = await generated;
    assert.equal(message.type, 'execute');
    assert.equal(typeof message.id, 'string');
    assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(message.code, 'return 11;');
    plugin.send(JSON.stringify({ type: 'result', id: message.id, result: 11 }));
    const response = await responsePromise;
    assert.deepEqual(await response.json(), { result: 11 });
  } finally {
    plugin.close();
    await bridge.close();
  }
});
