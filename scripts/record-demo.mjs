import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'docs', 'assets');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const port = 9333;
const frameRate = 10;
const duration = 28;
const width = 1280;
const height = 720;
const profile = await mkdtemp(path.join(tmpdir(), 'indesign-demo-'));
const frames = await mkdtemp(path.join(tmpdir(), 'indesign-frames-'));
let browser;
let socket;

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

async function endpoint() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome debugging endpoint did not start');
}

async function connect(url) {
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}

try {
  browser = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${width},${height}`, '--force-device-scale-factor=1',
    pathToFileURL(path.join(assets, 'demo.html')).href,
  ], { stdio: 'ignore' });
  const send = await connect(await endpoint());
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Demo page load timed out')), 10000);
    socket.addEventListener('message', function onLoad(event) {
      const message = JSON.parse(event.data);
      if (message.method === 'Page.loadEventFired') {
        clearTimeout(timer);
        socket.removeEventListener('message', onLoad);
        resolve();
      }
    });
  });
  await send('Page.navigate', { url: pathToFileURL(path.join(assets, 'demo.html')).href });
  await loaded;
  await send('Runtime.evaluate', { expression: 'typeof window.setDemoTime === "function"' });
  for (let frame = 0; frame < duration * frameRate; frame += 1) {
    await send('Runtime.evaluate', { expression: `window.setDemoTime(${frame * 1000 / frameRate})` });
    const capture = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true });
    await writeFile(path.join(frames, `frame-${String(frame).padStart(4, '0')}.jpg`), Buffer.from(capture.data, 'base64'));
  }
  await send('Runtime.evaluate', { expression: 'window.setDemoTime(24000)' });
  const poster = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92, fromSurface: true });
  await writeFile(path.join(assets, 'indesign-copilot-demo-poster.jpg'), Buffer.from(poster.data, 'base64'));
  run(ffmpeg, [
    '-y', '-loglevel', 'error', '-framerate', String(frameRate), '-i', path.join(frames, 'frame-%04d.jpg'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path.join(assets, 'indesign-copilot-demo.mp4'),
  ]);
  run(ffmpeg, [
    '-y', '-loglevel', 'error', '-framerate', String(frameRate), '-i', path.join(frames, 'frame-%04d.jpg'),
    '-vf', 'fps=8,scale=768:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
    '-loop', '0', path.join(assets, 'indesign-copilot-demo.gif'),
  ]);
  console.log(`Created demo assets in ${assets}`);
} finally {
  if (socket) socket.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise((resolve) => browser.once('exit', resolve));
  }
  for (const directory of [profile, frames]) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`Could not remove temporary directory ${directory}: ${error.message}`);
    }
  }
}
