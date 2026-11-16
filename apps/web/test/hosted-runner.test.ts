/** 托管生成循环：模型只回文字、不调用工具时提醒一次，再不调用才算 NO_FINISH。 */
import { describe, expect, it } from 'vitest';
import type { CreateMessageParams, ModelClient, ModelResponse } from '../src/hosted/model-client.js';
import { NO_TOOL_NUDGE, RunError, runGeneration } from '../src/hosted/runner.js';
import type { GenerationWorkspace } from '../src/hosted/tools.js';

const usage = { input_tokens: 1, output_tokens: 1 } as ModelResponse['usage'];
const text = (value: string): ModelResponse => ({ content: [{ type: 'text', text: value }], stop_reason: 'end_turn', usage });
const finish = (outcome: 'done' | 'clarify', message: string): ModelResponse => ({
  content: [{ type: 'tool_use', id: 'call_1', name: 'finish', input: { outcome, message } }], stop_reason: 'tool_use', usage,
});

function scripted(responses: ModelResponse[]) {
  const calls: CreateMessageParams[] = [];
  const client: ModelClient = {
    async createMessage(params) {
      calls.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error('脚本用完了');
      return next;
    },
  };
  // 只有 finish 会被调用：原样把参数当作结束信号。
  const workspace = { call: async (_name: string, input: unknown) => ({ content: 'ok', finish: input }) } as unknown as GenerationWorkspace;
  return { client, workspace, calls };
}

const run = (s: ReturnType<typeof scripted>) => runGeneration({ client: s.client, workspace: s.workspace, model: 'test', maxTurns: 5, firstMessage: '开始' });

describe('runGeneration：没有调用工具', () => {
  it('提醒一次后模型改用 finish(clarify)，任务正常结束', async () => {
    const s = scripted([text('想先和你确认一下改哪一块？'), finish('clarify', '改首屏还是全页？')]);
    const result = await run(s);
    expect(result.finish).toEqual({ outcome: 'clarify', message: '改首屏还是全页？' });
    expect(result.turns).toBe(2);
    const second = s.calls[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(second.at(-1))).toContain(NO_TOOL_NUDGE.slice(0, 20));
  });

  it('提醒后仍然只回文字，以 NO_FINISH 失败，且只提醒一次', async () => {
    const s = scripted([text('好的'), text('改好了')]);
    const error = await run(s).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunError);
    expect((error as RunError).code).toBe('NO_FINISH');
    expect((error as RunError).turns).toBe(2);
    expect(s.calls).toHaveLength(2);
  });
});
