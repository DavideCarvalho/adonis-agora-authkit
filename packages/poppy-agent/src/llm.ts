import type { CompanyClient } from './company.js';
import { ConversationClient, newMessageId, poppyProtocol } from './conversations.js';
import { PoppyError } from './errors.js';
import { connectMcp, type McpConnection } from './mcp.js';
import type { ConversationEvent, MessageContext } from './types.js';
import type { FetchLike } from './util.js';

/** Cheap, capable, tool-calling model on OpenRouter. Override with --model / POPPY_AGENT_MODEL. */
export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface AskOptions {
  apiKey: string;
  model?: string;
  /** Hard cap on LLM turns. */
  maxSteps?: number;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Transcript sink. */
  log: (line: string) => void;
  /** Lets MCP tools without `readOnlyHint` run. Otherwise `confirm` is asked, or they're refused. */
  allowWrites?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  context?: MessageContext;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function summarize(events: ConversationEvent[]) {
  const out: Record<string, unknown>[] = [];
  for (const ev of events) {
    if (ev.type === 'message' && ev.message?.role !== 'user') {
      out.push({
        from: `company:${ev.message?.sender}`,
        text: ev.message?.text,
        data: ev.message?.data,
      });
    } else if (ev.type === 'authorization') {
      out.push({
        notice: `The company needs the user to sign in (${ev.error}${ev.scope ? `, scope "${ev.scope}"` : ''}). You cannot sign in yourself; tell the user to run "poppy-agent signin".`,
      });
    } else if (ev.type === 'user_requested') {
      out.push({
        notice: `The company asked to talk with the user directly: ${ev.reason}. The user is not available in this mode.`,
      });
    }
  }
  return out;
}

/**
 * "LLM mode": a tiny autonomous Personal Agent. It uses an OpenRouter model to work on `task`
 * through the Company's conversation endpoint and/or MCP tools, within `maxSteps`. It never
 * sees tokens: tools return only what the Company said.
 */
export async function ask(
  company: CompanyClient,
  task: string,
  opts: AskOptions,
): Promise<{ answer?: string; steps: number; conversationId?: string }> {
  const doFetch = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const maxSteps = opts.maxSteps ?? 8;
  const tools: ToolDef[] = [];
  const conv = poppyProtocol(company) ? new ConversationClient(company) : undefined;
  let conversationId: string | undefined;
  let mcp: McpConnection | undefined;
  const mcpTools = new Map<string, { name: string; readOnly: boolean }>();

  if (conv) {
    tools.push({
      type: 'function',
      function: {
        name: 'talk_to_company',
        description:
          "Send a message to the company's own agent and get its reply. Use plain text; put structured details in data.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            data: { type: 'object', description: 'Optional structured details.' },
          },
          required: ['text'],
        },
      },
    });
  }
  if ((company.document.apis ?? []).some((a) => a?.type === 'mcp')) {
    try {
      mcp = await connectMcp(company);
      const { tools: list } = await mcp.client.listTools();
      for (const t of list) {
        const name = `mcp_${t.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
        mcpTools.set(name, { name: t.name, readOnly: t.annotations?.readOnlyHint === true });
        tools.push({
          type: 'function',
          function: {
            name,
            description: `[company MCP tool] ${t.description ?? t.name}`,
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
          },
        });
      }
    } catch (e) {
      opts.log(`! MCP unavailable: ${(e as Error).message}`);
    }
  }
  if (tools.length === 0) {
    throw new PoppyError('nothing_to_use', 'Company offers no conversation endpoint or MCP tools');
  }
  tools.push({
    type: 'function',
    function: {
      name: 'finish',
      description: 'Finish with the answer for the user.',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    },
  });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        `You are a personal agent acting for one user at ${company.document.organization.name} (${company.document.organization.domain}).`,
        'Accomplish the user task with the tools. Be brief with the company agent: no greetings.',
        'Never invent personal data about the user. If something needs the user (sign-in, a decision, personal data you do not have), stop and say so in finish.',
        'Call finish exactly once when done.',
      ].join(' '),
    },
    { role: 'user', content: task },
  ];

  const runTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'talk_to_company' && conv) {
      const message = {
        id: newMessageId(),
        sender: 'agent' as const,
        text: String(args.text ?? ''),
        data:
          typeof args.data === 'object' && args.data
            ? (args.data as Record<string, unknown>)
            : undefined,
        context: conversationId ? undefined : { ...opts.context, user_available: false },
      };
      if (!conversationId) {
        conversationId = (await conv.start(message)).conversation_id;
        opts.log(`  (conversation ${conversationId})`);
      } else {
        await conv.send(conversationId, message);
      }
      const { events, state } = await conv.collect(conversationId);
      for (const ev of events) {
        if (ev.type === 'message' && ev.message?.role !== 'user') {
          opts.log(
            `  company[${ev.message?.sender}]: ${ev.message?.text ?? ''}${ev.message?.data ? ` ${JSON.stringify(ev.message.data)}` : ''}`,
          );
        }
        if (ev.type === 'user_requested') {
          // 7.10: only the Personal Agent starts Direct Conversations; the user isn't here.
          await conv.send(conversationId, {
            id: newMessageId(),
            sender: 'agent',
            text: 'The user is not available to talk right now.',
            context: { user_available: false },
          });
        }
      }
      return { status: state.status, responder: state.responder, replies: summarize(events) };
    }
    const mt = mcpTools.get(name);
    if (mt && mcp) {
      if (!mt.readOnly && !opts.allowWrites) {
        const ok = opts.confirm
          ? await opts.confirm(`Allow MCP tool ${mt.name}(${JSON.stringify(args)})?`)
          : false;
        if (!ok)
          return { error: 'refused: this tool may change things and the user did not allow it' };
      }
      const r = await mcp.client.callTool({ name: mt.name, arguments: args });
      return r;
    }
    return { error: `unknown tool ${name}` };
  };

  let answer: string | undefined;
  let steps = 0;
  try {
    while (steps < maxSteps && answer === undefined) {
      steps++;
      const res = await doFetch(opts.baseUrl ?? OPENROUTER_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'poppy-agent',
        },
        body: JSON.stringify({
          model: opts.model ?? DEFAULT_MODEL,
          messages,
          tools,
          tool_choice: 'auto',
        }),
      });
      if (!res.ok)
        throw new PoppyError(
          'llm_error',
          `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      const json = (await res.json()) as { choices?: { message: ChatMessage }[] };
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new PoppyError('llm_error', 'LLM returned no message');
      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });
      if (msg.content) opts.log(`agent: ${msg.content}`);
      if (!msg.tool_calls?.length) {
        answer = msg.content ?? '';
        break;
      }
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {}
        opts.log(`> ${call.function.name}(${JSON.stringify(args)})`);
        if (call.function.name === 'finish') {
          answer = String(args.answer ?? '');
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
          continue;
        }
        let result: unknown;
        try {
          result = await runTool(call.function.name, args);
        } catch (e) {
          result = { error: (e as Error).message };
        }
        const text = JSON.stringify(result);
        opts.log(`< ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
  } finally {
    if (conversationId && conv) await conv.close(conversationId).catch(() => {});
    await mcp?.close().catch(() => {});
  }
  if (answer === undefined) opts.log(`! stopped after ${maxSteps} steps without finishing`);
  return { answer, steps, conversationId };
}
