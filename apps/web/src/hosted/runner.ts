/**
 * 托管生成的 Agent 循环（hosted-route 3.1 第 3 步、3.2）：Messages API + 受限工具，最多 `maxTurns` 轮。
 * 结束条件：模型调用 `finish`；只回文字、没有调用工具时提醒一次，再不调用视为失败（NO_FINISH）；超过轮数（MAX_TURNS）；被取消（TIMEOUT）。
 * 循环里的校验结果不被信任：调用方在结束后用平台的提交管线重新校验（3.1 第 4 步）。
 */
import { addUsage, emptyUsage, type ModelClient, type ModelMessage, type ToolResultBlock, type UsageTotals } from './model-client.js';
import { modelFailureCode, modelFailureStatus, type ModelAccessCode } from './model-errors.js';
import { generationSystem } from './prompts.js';
import { GENERATION_TOOLS, type FinishSignal, type GenerationWorkspace } from './tools.js';

export type RunErrorCode = ModelAccessCode | 'MAX_TURNS' | 'NO_FINISH' | 'TIMEOUT' | 'API_ERROR' | 'REFUSED';

export class RunError extends Error {
  override name = 'RunError';
  constructor(
    readonly code: RunErrorCode,
    readonly turns: number,
    readonly usage: UsageTotals,
    /** 诊断用：失败时的 HTTP 状态码（只记数字）。 */
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

export interface RunResult {
  finish: FinishSignal;
  turns: number;
  usage: UsageTotals;
}

export interface RunOptions {
  client: ModelClient;
  model: string;
  maxTurns: number;
  workspace: GenerationWorkspace;
  /** 第一条用户消息（墙的情境、场景指南、brief、修改要求，均已用 untrusted() 包好）。 */
  firstMessage: string;
  signal?: AbortSignal;
  maxTokens?: number;
  /** 每一轮调用模型之前（进度事件用，只给轮次）。 */
  onTurn?: (turn: number) => void;
  /** 每次执行工具之前（进度事件用，只给工具名）。 */
  onTool?: (name: string) => void;
}

/**
 * 在最后一条用户消息的最后一块上加缓存断点（滚动）：多轮工具循环里，之前的对话作为缓存前缀复用。
 * 加上 tools 与 system 的断点共 3 个（API 上限 4 个）。不修改原数组。
 */
export function withRollingCache(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.content === 'string' || last.content.length === 0) return messages;
  const content = last.content.slice();
  const tail = content[content.length - 1];
  if (tail) content[content.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { role: 'user', content }];
}

/** 模型只回文字、没调用工具时补发的提醒（每次任务只发一次；部分模型会直接用文字反问或汇报）。 */
export const NO_TOOL_NUDGE = '你刚才只回复了文字，没有调用工具，任务还没有结束。请继续用工具完成；做完了调用 finish（outcome: "done"）。如果是修改任务且需要主人先确认范围，调用 finish（outcome: "clarify"），把一个简短的问题写在 message 里，不要用纯文字回复。';

export async function runGeneration(options: RunOptions): Promise<RunResult> {
  const { client, workspace } = options;
  const usage = emptyUsage();
  const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'text', text: options.firstMessage }] }];
  const system = generationSystem();
  let nudged = false;

  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    if (options.signal?.aborted) throw new RunError('TIMEOUT', turn - 1, usage);
    options.onTurn?.(turn);
    let response;
    try {
      response = await client.createMessage(
        {
          model: options.model,
          max_tokens: options.maxTokens ?? 32000,
          system,
          messages: withRollingCache(messages),
          tools: GENERATION_TOOLS,
          tool_choice: { type: 'auto' },
        },
        { signal: options.signal },
      );
    } catch (error) {
      throw new RunError(options.signal?.aborted ? 'TIMEOUT' : modelFailureCode(error) ?? 'API_ERROR', turn - 1, usage, modelFailureStatus(error));
    }
    addUsage(usage, response.usage);
    if (response.stop_reason === 'refusal') throw new RunError('REFUSED', turn, usage);
    messages.push({ role: 'assistant', content: response.content });

    const calls = response.content.filter((block) => block.type === 'tool_use');
    if (calls.length === 0) {
      if (nudged) throw new RunError('NO_FINISH', turn, usage);
      nudged = true;
      messages.push({ role: 'user', content: [{ type: 'text', text: NO_TOOL_NUDGE }] });
      continue;
    }

    const results: ToolResultBlock[] = [];
    let finish: FinishSignal | undefined;
    for (const call of calls) {
      if (finish) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: '任务已结束', is_error: true });
        continue;
      }
      options.onTool?.(call.name);
      const result = await workspace.call(call.name, call.input);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
      if (result.finish) finish = result.finish;
    }
    if (finish) return { finish, turns: turn, usage };
    messages.push({ role: 'user', content: results });
  }
  throw new RunError('MAX_TURNS', options.maxTurns, usage);
}
