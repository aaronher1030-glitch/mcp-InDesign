/**
 * Chat turn runner. The panel sends the conversation; this calls the model
 * the user configured, then runs the existing InDesign tool handlers.
 */
import { allToolDefinitions } from '../types/index.js';
import {
  completeChat,
  resolveBaseUrl,
  toAnthropicTools,
  toOpenAITools,
} from './providers.js';

const MAX_ROUNDS = 12;
const MAX_TOOL_CHARS = 8000;

const SYSTEM_PROMPT = `You are InDesign Copilot, sitting in a panel inside Adobe InDesign. You can see and change the open document only by calling tools. The user watches the layout update as you work.

How to work:
- Inspect before you edit. Call get_document_info and list_page_items (or get_page_content_summary) so you know page indexes, item indexes, types, and geometricBounds.
- geometricBounds are [top, left, bottom, right] in points. move_page_item passes x and y straight to item.move([x, y]). Read the bounds again after a move and describe what changed.
- When you change an item, select it or navigate to its page so the user can see it.
- Do not delete, close, print, package, or export unless the user asked for that.
- If no document is open, say so. Offer to create one only if that would help.
- Page and item indexes are 0-based unless a tool description says otherwise.
- Talk like a layout assistant: short, specific, and about the objects on the page.`;

let serverPromise;

function getServer() {
  if (!serverPromise) {
    serverPromise = import('../core/InDesignMCPServer.js').then(
      (mod) => new mod.InDesignMCPServer()
    );
  }
  return serverPromise;
}

async function defaultCallTool(name, args) {
  const server = await getServer();
  return server.handleToolCall(name, args || {});
}

function clip(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_TOOL_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_CHARS)}… [truncated]`;
}

function sanitizeMessages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const message of list.slice(-40)) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user' && typeof message.content === 'string') {
      out.push({ role: 'user', content: message.content.slice(0, 20000) });
      continue;
    }
    if (message.role === 'assistant') {
      const next = {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content.slice(0, 20000) : '',
      };
      if (Array.isArray(message.tool_calls)) {
        next.tool_calls = message.tool_calls.slice(0, 16).map((call, index) => ({
          id: String(call.id || `call_${index}`).slice(0, 80),
          type: 'function',
          function: {
            name: String(call.function?.name || '').slice(0, 120),
            arguments: typeof call.function?.arguments === 'string'
              ? call.function.arguments.slice(0, 8000)
              : JSON.stringify(call.function?.arguments || {}),
          },
        })).filter((call) => call.function.name);
      }
      out.push(next);
      continue;
    }
    if (message.role === 'tool' && typeof message.content === 'string' && message.tool_call_id) {
      out.push({
        role: 'tool',
        tool_call_id: String(message.tool_call_id).slice(0, 80),
        content: message.content.slice(0, 12000),
      });
    }
  }
  return out;
}

function publicTranscript(history) {
  return history
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.tool_call_id,
          name: message.name,
          content: message.content,
        };
      }
      return message;
    });
}

export function normalizeSettings(settings) {
  const provider = settings?.provider === 'anthropic' ? 'anthropic' : 'openai';
  const model = String(settings?.model || '').trim();
  if (!model) throw new Error('Enter the model name your API key can call.');
  const apiKey = String(settings?.apiKey || '').trim();
  const baseUrl = resolveBaseUrl(provider, settings?.baseUrl);
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl);
  if (!apiKey && !local) throw new Error('Enter an API key, or point the base URL at a local model server.');
  return { provider, model, apiKey, baseUrl };
}

export async function runChat({
  messages,
  settings,
  emit,
  shouldStop,
  callTool = defaultCallTool,
  complete = completeChat,
  toolDefinitions = allToolDefinitions,
}) {
  const config = normalizeSettings(settings);
  const history = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...sanitizeMessages(messages),
  ];
  const openAITools = toOpenAITools(toolDefinitions);
  const anthropicTools = toAnthropicTools(toolDefinitions);
  const stopped = () => (shouldStop ? shouldStop() : false);

  if (!history.some((message) => message.role === 'user')) {
    throw new Error('Send a message first.');
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (stopped()) return;
    emit({ type: 'status', text: round === 0 ? 'Asking the model…' : 'Continuing…' });

    const reply = await complete({
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      messages: history,
      tools: config.provider === 'anthropic' ? anthropicTools : openAITools,
    });

    if (stopped()) return;

    const toolCalls = reply.toolCalls || [];
    if (toolCalls.length === 0) {
      const content = reply.content || '';
      history.push({ role: 'assistant', content });
      if (content) emit({ type: 'token', text: content });
      emit({ type: 'done', messages: publicTranscript(history) });
      return;
    }

    history.push({
      role: 'assistant',
      content: reply.content || '',
      tool_calls: toolCalls,
    });
    if (reply.content) emit({ type: 'token', text: reply.content });

    for (const call of toolCalls) {
      if (stopped()) return;
      const name = call.function.name;
      let args = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      emit({ type: 'tool', name, id: call.id });
      let result;
      try {
        result = await callTool(name, args);
      } catch (error) {
        result = { success: false, error: error.message || String(error) };
      }
      const content = clip(result);
      emit({
        type: 'tool_result',
        name,
        id: call.id,
        preview: content.slice(0, 280),
      });
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content,
      });
    }
  }

  const note = 'I stopped after several tool steps so I would not keep editing. Ask me to continue if you want another pass.';
  history.push({ role: 'assistant', content: note });
  emit({ type: 'token', text: note });
  emit({ type: 'done', messages: publicTranscript(history) });
}
