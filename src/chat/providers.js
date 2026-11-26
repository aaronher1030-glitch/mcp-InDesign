/**
 * Model adapters for the in-app chat.
 * OpenAI-compatible covers OpenAI, OpenRouter, Groq, Together, Ollama,
 * LM Studio, and Gemini's OpenAI endpoint. Anthropic has its own shape.
 */

const DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export function resolveBaseUrl(provider, baseUrl) {
  const trimmed = (baseUrl || '').trim();
  const raw = trimmed || DEFAULTS[provider];
  if (!raw) {
    throw new Error('Choose a provider or enter a base URL.');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Base URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must start with http:// or https://.');
  }
  return raw.replace(/\/$/, '');
}

export function chatCompletionsUrl(baseUrl) {
  if (baseUrl.endsWith('/chat/completions')) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

export function anthropicMessagesUrl(baseUrl) {
  if (baseUrl.endsWith('/messages')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/messages`;
  return `${baseUrl}/v1/messages`;
}

export function toAnthropic(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const out = [];
  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseArgs(call.function.arguments),
        });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content });
      continue;
    }

    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }

  return { system, messages: out };
}

export function toOpenAITools(definitions) {
  return definitions.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: (def.description || '').slice(0, 1024),
      parameters: def.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

export function toAnthropicTools(definitions) {
  return definitions.map((def) => ({
    name: def.name,
    description: (def.description || '').slice(0, 1024),
    input_schema: def.inputSchema || { type: 'object', properties: {} },
  }));
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeApiError(status, bodyText) {
  const snippet = (bodyText || '').replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) {
    return `The model rejected the API key (${status}). ${snippet}`;
  }
  return `The model request failed (${status}). ${snippet}`;
}

async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * One non-streaming completion. Returns { content, toolCalls }.
 * toolCalls use the OpenAI shape so the agent loop stays provider-neutral.
 */
export async function completeChat({ provider, baseUrl, model, apiKey, messages, tools, signal }) {
  if (provider === 'anthropic') {
    return completeAnthropic({ baseUrl, model, apiKey, messages, tools, signal });
  }
  return completeOpenAI({ baseUrl, model, apiKey, messages, tools, signal });
}

async function completeOpenAI({ baseUrl, model, apiKey, messages, tools, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
    }),
  });

  const text = await readBody(response);
  if (!response.ok) throw new Error(safeApiError(response.status, text));

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The model returned a response that was not JSON.');
  }

  const choice = data.choices && data.choices[0] && data.choices[0].message;
  if (!choice) throw new Error('The model returned no message.');

  const toolCalls = (choice.tool_calls || []).map((call, index) => ({
    id: call.id || `call_${index}`,
    type: 'function',
    function: {
      name: call.function?.name || '',
      arguments: typeof call.function?.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call.function?.arguments || {}),
    },
  }));

  return { content: choice.content || '', toolCalls };
}

async function completeAnthropic({ baseUrl, model, apiKey, messages, tools, signal }) {
  if (!apiKey) throw new Error('Anthropic requires an API key.');
  const converted = toAnthropic(messages);

  const response = await fetch(anthropicMessagesUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: converted.system,
      messages: converted.messages,
      tools: tools.length ? tools : undefined,
    }),
  });

  const text = await readBody(response);
  if (!response.ok) throw new Error(safeApiError(response.status, text));

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The model returned a response that was not JSON.');
  }

  const blocks = Array.isArray(data.content) ? data.content : [];
  const content = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b, index) => ({
    id: b.id || `call_${index}`,
    type: 'function',
    function: {
      name: b.name || '',
      arguments: JSON.stringify(b.input || {}),
    },
  }));

  return { content, toolCalls };
}
