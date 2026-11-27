/**
 * Chat turn runner. The panel sends the conversation; this calls the model
 * the user configured, then runs the skill workflow tools.
 */
import { skillToolDefinitions } from '../types/toolDefinitionsSkills.js';
import {
  completeChat,
  resolveBaseUrl,
  toAnthropicTools,
  toOpenAITools,
} from './providers.js';

const MAX_ROUNDS = 12;
const MAX_TOOL_CHARS = 8000;

const SYSTEM_PROMPT = `You are InDesign Copilot, sitting in a panel inside Adobe InDesign. You can see and change the open document only by calling tools. The user watches the layout update as you work.

Work in this order, every time:
1. Call inspect_layout for the pages involved. Use the returned pageIndex, itemIndex, name and geometricBounds values. Page and item indexes are 0-based.
2. Choose the matching skill: safe-layout-edit, text-typography-edit, align-distribute, image-reframe, style-consistency, or multi-page-consistency.
3. Call plan_edit with targets (pageIndex, itemIndex, name, before: { geometricBounds }) and steps (toolName, arguments, expectedResult). Only use tools the skill allows. geometricBounds are [top, left, bottom, right] in points.
4. If plan_edit returns status "approval_required", show the plan summary, affected pages and the reason it is high risk. Never tell the user it is done. Wait for the approval card.
5. Otherwise call apply_edit_plan with the planId and expectedVersion.
6. Call verify_layout. Report structural results and visual results separately. Say "structurally checked only" when visual review is unavailable, never "visually verified".
7. Call preview_layout when the user wants to see the result.

Rules:
- Inspect before you edit; never guess indexes.
- Never send approved or approvalToken. Only the trusted approval UI can authorize a high-risk plan after the human accepts its exact version and before artifacts.
- Do not delete, close, print, package, or export unless the user asked for it.
- If no document is open, say so. Offer to create one only if that would help.
- Keep replies short, specific, and about the objects on the page.`;

let serverPromise;

function getServer() {
  if (!serverPromise) {
    serverPromise = import('../core/InDesignMCPServer.js').then(
      (mod) => new mod.InDesignMCPServer()
    );
  }
  return serverPromise;
}

async function defaultCallTool(name, args, { settings, signal, trustedApproval = false } = {}) {
  const server = await getServer();
  // SkillRuntime owns cancellation and rollback for apply. Keep the signal in
  // the trusted tool context rather than accepting it from model arguments.
  const toolArgs = name === 'apply_edit_plan' && signal
    ? { ...(args || {}), signal }
    : (args || {});
  return server.handleToolCall(name, toolArgs, {
    settings,
    signal,
    ...(name === 'apply_edit_plan'
      ? (trustedApproval ? { trustedApproval: true } : { deferApproval: true })
      : {}),
  });
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
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(baseUrl);
  if (!apiKey && !local) throw new Error('Enter an API key, or point the base URL at a local model server.');
  return { provider, model, apiKey, baseUrl };
}

function approvalFrom(result) {
  const value = result?.result ?? result;
  if (value && value.status === 'approval_required' && value.planId) return value;
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function defaultApprovalAuthorizer({ planId, expectedVersion }) {
  const server = await getServer();
  return server.runtime.issueApprovalCapability({ planId, expectedVersion }).approvalToken;
}

async function readApprovalPlan(planId) {
  try {
    const server = await getServer();
    const snapshot = server.runtime.getPlan(planId);
    return snapshot ? { ...snapshot.plan, beforeArtifactsSnapshot: snapshot.beforeArtifacts } : null;
  } catch {
    return null;
  }
}

function createCancellation({ signal, shouldStop }) {
  const controller = new AbortController();
  let requested = false;
  const stop = () => {
    if (requested) return;
    requested = true;
    controller.abort();
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });

  const isStopped = () => {
    if (requested || controller.signal.aborted || shouldStop?.()) {
      stop();
      return true;
    }
    return false;
  };
  const throwIfStopped = () => {
    if (isStopped()) {
      const error = new Error('The chat was stopped.');
      error.name = 'AbortError';
      throw error;
    }
  };
  return {
    signal: controller.signal,
    isStopped,
    throwIfStopped,
    dispose: () => signal?.removeEventListener('abort', stop),
  };
}

function validArtifactPaths(value) {
  const paths = Array.isArray(value)
    ? value
    : (isRecord(value) && Array.isArray(value.paths) ? value.paths : null);
  return Array.isArray(paths) && paths.length > 0
    && paths.every((path) => typeof path === 'string'
      && /^(?:[a-z]:[\\/]|[\\/])/i.test(path.trim())
      && /\.png$/i.test(path.trim())
      && !path.includes('\0'))
    && new Set(paths.map((path) => path.trim())).size === paths.length;
}

function validPageIndexes(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((page) => Number.isInteger(page) && page >= 0);
}

async function rollbackAfterAbort({ planId, settings, callTool, emit, runtimeRollback }) {
  if (runtimeRollback) {
    emit({
      type: 'tool_result', name: 'rollback_edit', id: 'abort_rollback',
      preview: clip(runtimeRollback).slice(0, 280),
    });
    if (runtimeRollback.status !== 'rolled_back') {
      emit({ type: 'error', message: 'Stopped, but the runtime could not finish rollback.' });
    }
    return runtimeRollback;
  }
  try {
    const result = await callTool('rollback_edit', {
      planId,
      reason: 'Chat stopped while applying; restoring the pre-edit state.',
    }, { settings });
    const value = result?.result ?? result;
    emit({
      type: 'tool_result', name: 'rollback_edit', id: 'abort_rollback',
      preview: clip(result).slice(0, 280),
    });
    if (result?.success === false || value?.status !== 'rolled_back') {
      emit({ type: 'error', message: 'Stopped, but rollback did not restore the pre-edit state.' });
    }
    return value;
  } catch (error) {
    emit({ type: 'error', message: `Stopped, but rollback failed: ${error.message || String(error)}` });
    return { status: 'ROLLBACK_FAILED', error: error.message || String(error) };
  }
}

export async function runChat({
  messages,
  settings,
  signal,
  emit,
  shouldStop,
  callTool = defaultCallTool,
  complete = completeChat,
  toolDefinitions = skillToolDefinitions,
}) {
  const config = normalizeSettings(settings);
  const history = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...sanitizeMessages(messages),
  ];
  const advertisedTools = Array.isArray(toolDefinitions)
    ? toolDefinitions.filter((tool) => isRecord(tool) && typeof tool.name === 'string' && tool.name)
    : [];
  const advertisedNames = new Set(advertisedTools.map((tool) => tool.name));
  const openAITools = toOpenAITools(advertisedTools);
  const anthropicTools = toAnthropicTools(advertisedTools);
  const cancellation = createCancellation({ signal, shouldStop });
  const stopped = cancellation.isStopped;

  if (!history.some((message) => message.role === 'user')) {
    cancellation.dispose();
    throw new Error('Send a message first.');
  }

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      cancellation.throwIfStopped();
      emit({ type: 'status', text: round === 0 ? 'Asking the model…' : 'Continuing…' });

      const reply = await complete({
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        messages: history,
        tools: config.provider === 'anthropic' ? anthropicTools : openAITools,
        signal: cancellation.signal,
      });

      cancellation.throwIfStopped();

      const toolCalls = reply.toolCalls || [];
      if (toolCalls.length === 0) {
        const content = reply.content || '';
        history.push({ role: 'assistant', content });
        if (content) emit({ type: 'token', text: content });
        emit({ type: 'done', messages: publicTranscript(history) });
        return { status: 'done' };
      }

      history.push({
        role: 'assistant',
        content: reply.content || '',
        tool_calls: toolCalls,
      });
      if (reply.content) emit({ type: 'token', text: reply.content });

      for (const call of toolCalls) {
        cancellation.throwIfStopped();
        const name = typeof call?.function?.name === 'string' ? call.function.name : '';
        let args = {};
        try {
          args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        emit({ type: 'tool', name, id: call?.id });
        let result;
        let toolError = null;
        if (!advertisedNames.has(name)) {
          result = {
            success: false,
            code: 'TOOL_NOT_ADVERTISED',
            error: `Tool "${name}" was not advertised to this model and cannot be called.`,
          };
        } else if (!isRecord(args)) {
          result = { success: false, code: 'INVALID_TOOL_ARGUMENTS', error: 'Tool arguments must be an object.' };
        } else {
          // Approval is a trusted UI capability, never a model-provided field.
          if (name === 'apply_edit_plan') {
            const { approved: _approved, approvalToken: _approvalToken, ...modelArgs } = args;
            args = modelArgs;
          }
          try {
            result = await callTool(name, args, { settings: config, signal: cancellation.signal });
          } catch (error) {
            toolError = error;
            result = { success: false, error: error.message || String(error) };
          }
        }

        if (stopped()) {
          const rollback = name === 'apply_edit_plan'
            ? await rollbackAfterAbort({
              planId: args?.planId, settings: config, callTool, emit,
              runtimeRollback: toolError?.rollback,
            })
            : null;
          return { status: 'stopped', rollback };
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

        const approval = approvalFrom(result);
        if (approval) {
          const plan = Array.isArray(approval.targets) && Array.isArray(approval.steps)
            ? null
            : await readApprovalPlan(approval.planId);
          const targets = approval.targets ?? approval.details?.targets ?? plan?.targets ?? [];
          const steps = approval.steps ?? approval.details?.steps ?? plan?.steps ?? [];
          let beforeArtifacts = approval.beforeArtifacts ?? approval.details?.beforeArtifacts ?? plan?.beforeArtifacts;
          let beforeArtifactsPageIndexes = approval.beforeArtifactsPageIndexes
            ?? approval.details?.beforeArtifactsPageIndexes
            ?? plan?.beforeArtifactsSnapshot?.pageIndexes;
          let beforeArtifactsError = approval.beforeArtifactsError
            ?? approval.details?.beforeArtifactsError
            ?? plan?.beforeArtifactsSnapshot?.error
            ?? null;
          if (!validArtifactPaths(beforeArtifacts) && !beforeArtifactsError
              && advertisedNames.has('preview_layout')) {
            const pages = approval.affectedPages ?? plan?.affectedPages ?? [];
            const previewId = `approval_before_${approval.planId}`;
            cancellation.throwIfStopped();
            emit({ type: 'tool', name: 'preview_layout', id: previewId });
            let preview;
            try {
              preview = await callTool('preview_layout', { pages, open: false }, {
                settings: config, signal: cancellation.signal,
              });
            } catch (error) {
              preview = { success: false, error: error.message || String(error) };
            }
            if (stopped()) return { status: 'stopped' };
            const previewContent = clip(preview);
            emit({ type: 'tool_result', name: 'preview_layout', id: previewId, preview: previewContent.slice(0, 280) });
            history.push({ role: 'tool', tool_call_id: previewId, name: 'preview_layout', content: previewContent });
            const rendered = preview?.result ?? preview;
            if (validArtifactPaths(rendered?.paths)) {
              beforeArtifacts = rendered.paths;
              beforeArtifactsPageIndexes = validPageIndexes(rendered.pageIndexes)
                ? rendered.pageIndexes
                : undefined;
            } else {
              beforeArtifacts = [];
              beforeArtifactsPageIndexes = [];
            }
            beforeArtifactsError = preview?.error ?? rendered?.error
              ?? (preview?.success === false ? 'Before-render unavailable' : null)
              ?? (!validArtifactPaths(beforeArtifacts) ? 'Before-render unavailable' : null);
          }
          if (!validArtifactPaths(beforeArtifacts) && !beforeArtifactsError) {
            beforeArtifactsError = 'Before-render artifacts are missing or invalid.';
          }
          cancellation.throwIfStopped();
          emit({
            type: 'approval',
            planId: approval.planId,
            version: approval.version ?? plan?.version,
            summary: approval.summary ?? plan?.summary,
            affectedPages: approval.affectedPages ?? plan?.affectedPages ?? [],
            risk: approval.risk ?? plan?.risk,
            targets: Array.isArray(targets) ? targets : [],
            steps: Array.isArray(steps) ? steps : [],
            beforeArtifacts: validArtifactPaths(beforeArtifacts) ? beforeArtifacts : [],
            beforeArtifactsPageIndexes: Array.isArray(beforeArtifactsPageIndexes)
              ? beforeArtifactsPageIndexes
              : undefined,
            beforeArtifactsError,
          });
          emit({ type: 'done', messages: publicTranscript(history) });
          return { status: 'approval_required' };
        }
      }
    }

    cancellation.throwIfStopped();
    const note = 'I stopped after several tool steps so I would not keep editing. Ask me to continue if you want another pass.';
    history.push({ role: 'assistant', content: note });
    emit({ type: 'token', text: note });
    emit({ type: 'done', messages: publicTranscript(history) });
    return { status: 'done' };
  } catch (error) {
    if (stopped() || error.name === 'AbortError') return { status: 'stopped' };
    throw error;
  } finally {
    cancellation.dispose();
  }
}

/**
 * Apply or cancel a plan from the trusted approval UI. After an explicit human
 * accept, a trusted authorizer issues a one-time capability for the exact
 * version displayed. The token stays between trusted adapters and is never
 * emitted to the model or UI transcript.
 */
export async function resolveApproval({
  approval,
  settings,
  signal,
  emit,
  shouldStop,
  callTool = defaultCallTool,
  approvalAuthorizer = defaultApprovalAuthorizer,
} = {}) {
  if (!isRecord(approval) || typeof approval.planId !== 'string' || !approval.planId) {
    throw new Error('An approval needs a planId.');
  }
  if (typeof approval.approved !== 'boolean') throw new Error('An approval needs a boolean approved value.');
  const planId = approval.planId;
  const approved = approval.approved;

  if (!approved) {
    emit({ type: 'tool_result', name: 'apply_edit_plan', id: 'approval', preview: 'Plan cancelled.' });
    emit({ type: 'token', text: 'Plan cancelled. Nothing was changed.' });
    emit({ type: 'done', messages: [] });
    return { status: 'cancelled' };
  }
  if (!Number.isInteger(approval.version) || approval.version < 1) {
    throw new Error('An approval needs the exact positive integer plan version.');
  }

  const cancellation = createCancellation({ signal, shouldStop });
  const stopped = cancellation.isStopped;
  let applyStarted = false;
  const stopAndRollback = async (runtimeRollback) => {
    if (!applyStarted) return { status: 'stopped' };
    const rollback = await rollbackAfterAbort({
      planId, settings, callTool, emit, runtimeRollback,
    });
    return { status: 'stopped', rollback };
  };

  try {
    cancellation.throwIfStopped();
    emit({ type: 'tool', name: 'apply_edit_plan', id: 'approval' });
    let approvalToken;
    try {
      approvalToken = await approvalAuthorizer({ planId, expectedVersion: approval.version });
      if (typeof approvalToken !== 'string' || !approvalToken) {
        throw new Error('The trusted approval authorizer did not return a capability.');
      }
    } catch (error) {
      if (stopped() || error.name === 'AbortError') return stopAndRollback(error.rollback);
      emit({ type: 'error', message: error.message || String(error) });
      return { status: 'failed' };
    }
    cancellation.throwIfStopped();
    let result;
    applyStarted = true;
    try {
      result = await callTool('apply_edit_plan', {
        planId,
        expectedVersion: approval.version,
        approvalToken,
      }, { settings, signal: cancellation.signal, trustedApproval: true });
    } catch (error) {
      if (stopped() || error.name === 'AbortError') return stopAndRollback(error.rollback);
      emit({ type: 'error', message: error.message || String(error) });
      return { status: 'failed' };
    }

    if (stopped()) return stopAndRollback(result?.result?.rollback ?? result?.rollback);
    emit({ type: 'tool_result', name: 'apply_edit_plan', id: 'approval', preview: clip(result).slice(0, 280) });

    cancellation.throwIfStopped();
    let verify;
    try {
      verify = await callTool('verify_layout', { planId }, { settings, signal: cancellation.signal });
    } catch (error) {
      if (stopped() || error.name === 'AbortError') return stopAndRollback(error.rollback);
      verify = { success: false, error: error.message || String(error) };
    }
    if (stopped()) return stopAndRollback(verify?.result?.rollback ?? verify?.rollback);
    emit({ type: 'tool_result', name: 'verify_layout', id: 'approval', preview: clip(verify).slice(0, 280) });
    emit({ type: 'done', messages: [{ role: 'tool', content: clip(verify) }] });
    return { status: 'applied', result, verify };
  } catch (error) {
    if (stopped() || error.name === 'AbortError') return stopAndRollback(error.rollback);
    throw error;
  } finally {
    cancellation.dispose();
  }
}
