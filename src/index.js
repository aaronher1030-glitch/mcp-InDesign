/**
 * InDesignAaronV1.1 entry point.
 *
 * One process serves both roles:
 *  - MCP stdio server for Claude Desktop / Cursor / any MCP client
 *  - HTTP + WebSocket bridge for the InDesign Copilot UXP panel
 *
 * The packaged InDesignAaronV1.1.exe behaves exactly the same, so the plugin
 * and any MCP client talk to the single executable.
 */
import net from 'node:net';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startBridge } from '../bridge/server.js';
import { InDesignMCPServer } from './core/InDesignMCPServer.js';
import {
  DEFAULT_SELFTEST_TIMEOUT_MS,
  runSelftest,
  waitForPlugin,
} from './core/selftest.js';
import { embeddedPluginFiles } from './assets/embeddedPlugin.js';
import { APP_NAME, APP_VERSION, BRIDGE_HTTP_PORT, BRIDGE_WS_PORT } from './version.js';

const args = process.argv.slice(2);
const hasFlag = (...names) => names.some((name) => args.includes(name));

function log(message) {
  console.error(`[${APP_NAME}] ${message}`);
}

function isPackaged() {
  return Boolean(process.pkg) || !/node(\.exe)?$/i.test(process.execPath);
}

function executablePath() {
  return isPackaged() ? process.execPath : join(process.cwd(), 'src', 'index.js');
}

function isBridgeRunning(port = BRIDGE_WS_PORT) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function detectInDesign() {
  const roots = [
    'C:\\Program Files\\Adobe',
    'C:\\Program Files (x86)\\Adobe',
    '/Applications',
  ].filter((root) => existsSync(root));
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/Adobe InDesign/i.test(entry.name)) continue;
      const version = (entry.name.match(/(\d{4})/) || [])[1] ?? null;
      found.push({ name: entry.name, version: Number(version) || null, path: join(root, entry.name) });
    }
  }
  return found.sort((left, right) => (right.version ?? 0) - (left.version ?? 0));
}

function installPlugin() {
  const destination = isPackaged()
    ? join(dirname(process.execPath), 'plugin')
    : join(process.cwd(), 'plugin');
  const files = embeddedPluginFiles && Object.keys(embeddedPluginFiles).length > 0
    ? embeddedPluginFiles
    : null;
  if (!files) {
    console.log(`Plugin sources are at ${destination}. Run "node scripts/embed-assets.mjs" to embed them for packaging.`);
    return destination;
  }
  mkdirSync(destination, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(destination, name), content, 'utf8');
  }
  console.log(`Installed ${APP_NAME} UXP plugin to:\n  ${destination}`);
  console.log('\nNext steps:');
  console.log('  1. Open Adobe UXP Developer Tool.');
  console.log('  2. Add Plugin -> select the manifest.json in that folder.');
  console.log('  3. Click Load, then in InDesign open Window -> Plugins -> InDesign Copilot.');
  return destination;
}

function printConfig() {
  const command = executablePath();
  const config = {
    mcpServers: {
      indesign: {
        command,
        args: isPackaged() ? [] : [command],
      },
    },
  };
  console.log(JSON.stringify(config, null, 2));
}

async function printDoctor() {
  console.log(`${APP_NAME} ${APP_VERSION}`);
  console.log(`Runtime: ${process.version}${isPackaged() ? ' (packaged)' : ''}`);
  const installations = detectInDesign();
  if (installations.length === 0) {
    console.log('InDesign: not found in the default Adobe install folders.');
  } else {
    for (const entry of installations) {
      console.log(`InDesign: ${entry.name}${entry.version ? `  (${entry.version})` : ''}`);
    }
  }
  let status = null;
  try {
    const token = process.env.BRIDGE_TOKEN;
    const response = await fetch(`http://127.0.0.1:${BRIDGE_HTTP_PORT}/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    status = await response.json();
  } catch {
    status = null;
  }
  if (!status) console.log('Bridge: not running');
  else console.log(`Bridge: running, plugin connected: ${status.connected === true}`);
  console.log('Plugin requirement: InDesign 2021 (17.0) or newer with UXP support.');
}

function numericFlag(name, fallback) {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return fallback;
  const raw = args[index].includes('=')
    ? args[index].slice(args[index].indexOf('=') + 1)
    : args[index + 1];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function runSelftestCli() {
  const timeoutMs = numericFlag('--timeout', DEFAULT_SELFTEST_TIMEOUT_MS / 1000) * 1000;
  console.log(`${APP_NAME} ${APP_VERSION} - live self test`);
  const bridge = await ensureBridge();
  try {
    const server = new InDesignMCPServer();
    const summary = await runSelftest({
      toolCall: (name, toolArgs) => server.handleToolCall(name, toolArgs, {}),
      wait: () => waitForPlugin({ timeoutMs, log }),
      log,
    });
    console.log('');
    console.log('Self test passed: the plugin answered, inspection and direct view both worked.');
    console.log(`  Document:   ${summary.document ?? '(unsaved document)'}`);
    console.log(`  Inspection: ${summary.inspectionId}`);
    console.log(`  Page:       ${summary.pageIndexes.map((page) => page + 1).join(', ')}`);
    for (const path of summary.previewPaths) console.log(`  Preview:    ${path}`);
    return 0;
  } catch (error) {
    console.error(`[${APP_NAME}] ${error.message}`);
    return 1;
  } finally {
    if (bridge) await bridge.close();
  }
}

function printHelp() {
  console.log(`${APP_NAME} ${APP_VERSION} - InDesign MCP server, skill runtime and Copilot bridge
`);
  console.log('Usage:');
  console.log('  InDesignAaronV1.1                  Start the bridge and the MCP stdio server');
  console.log('  InDesignAaronV1.1 --bridge         Start only the Copilot bridge (ports 3000/3001)');
  console.log('  InDesignAaronV1.1 --install-plugin Write the InDesign UXP plugin next to the exe');
  console.log('  InDesignAaronV1.1 --print-config   Print the MCP client configuration JSON');
  console.log('  InDesignAaronV1.1 --doctor         Check InDesign, bridge and plugin status');
  console.log('  InDesignAaronV1.1 --selftest       Wait for the plugin, then inspect and preview the live document');
  console.log('  InDesignAaronV1.1 --selftest --timeout 120   Same, waiting up to 120 seconds');
  console.log('  InDesignAaronV1.1 --version        Print the version');
  console.log('');
  console.log('Env: BRIDGE_TOKEN (optional bearer token for /execute, /chat and /status)');
}

async function ensureBridge() {
  if (await isBridgeRunning()) {
    log(`Bridge already running on port ${BRIDGE_WS_PORT}; reusing it.`);
    return null;
  }
  try {
    return await startBridge({ httpPort: BRIDGE_HTTP_PORT, wsPort: BRIDGE_WS_PORT });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      log('Bridge ports are in use; assuming another bridge instance owns them.');
      return null;
    }
    log(`Bridge failed to start: ${error.message}`);
    return null;
  }
}

async function runBridgeOnly() {
  console.log(`${APP_NAME} ${APP_VERSION}`);
  console.log('InDesign Copilot bridge');
  console.log(`  HTTP  http://127.0.0.1:${BRIDGE_HTTP_PORT}`);
  console.log(`  WS    ws://127.0.0.1:${BRIDGE_WS_PORT}`);
  console.log('');
  console.log('Load the plugin with --install-plugin, then open Window -> Plugins -> InDesign Copilot.');
  console.log('Press Ctrl+C to stop.');
  const bridge = await startBridge({ httpPort: BRIDGE_HTTP_PORT, wsPort: BRIDGE_WS_PORT });
  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

async function runMcp() {
  await ensureBridge();
  const server = new InDesignMCPServer();
  await server.run();
  // MCP clients close stdin when they stop; exit so the bridge ports are released.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}

async function main() {
  if (hasFlag('--version', '-v')) {
    console.log(`${APP_NAME} ${APP_VERSION}`);
    return;
  }
  if (hasFlag('--help', '-h')) {
    printHelp();
    return;
  }
  if (hasFlag('--install-plugin')) {
    installPlugin();
    return;
  }
  if (hasFlag('--print-config')) {
    printConfig();
    return;
  }
  if (hasFlag('--doctor')) {
    await printDoctor();
    return;
  }
  if (hasFlag('--selftest')) {
    process.exitCode = await runSelftestCli();
    return;
  }
  if (hasFlag('--bridge')) {
    await runBridgeOnly();
    return;
  }
  if (hasFlag('--mcp') || !process.stdin.isTTY) {
    await runMcp();
    return;
  }

  printHelp();
  console.log('');
  await runBridgeOnly();
}

main().catch((error) => {
  console.error(`[${APP_NAME}] Failed to start:`, error);
  process.exit(1);
});

export { detectInDesign, installPlugin, executablePath };
