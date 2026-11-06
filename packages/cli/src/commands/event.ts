/**
 * `nowme event <type> [--ok|--no-ok] [--duration-ms N] [--count N] [--json]`：供 Skill 上报事件。
 * 没有凭证时静默成功。props 只含数字与布尔值。
 */
import { AGENT_EVENT_TYPES, type AgentEventType } from '@nowme/contracts';
import type { ParsedArgs } from '../args.js';
import type { CliContext } from '../context.js';
import { readPageCredential, readWorkdirLink, sanitizeEventProps, type EventProps } from '../events.js';

export async function runEvent(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const json = args.flags.get('json') === true;
  const [type] = args.positionals;
  if (args.positionals.length !== 1 || !AGENT_EVENT_TYPES.includes(type as AgentEventType)) {
    ctx.io.stderr(`用法：nowme event <type>；type 只能是 ${AGENT_EVENT_TYPES.join(' / ')}\n`);
    return 1;
  }
  const props: Record<string, unknown> = {};
  if (args.flags.get('ok') === true) props.ok = true;
  if (args.flags.get('no-ok') === true) props.ok = false;
  const durationMs = args.flags.get('duration-ms');
  const count = args.flags.get('count');
  if (typeof durationMs === 'number') props.durationMs = durationMs;
  if (typeof count === 'number') props.count = count;
  const clean: EventProps = sanitizeEventProps(props);

  let sent = false;
  let reason: string | null = null;
  const link = await readWorkdirLink(ctx.cwd);
  const credential = link ? await readPageCredential(ctx.env, link.pageId) : null;
  if (!link || !credential) {
    reason = '没有凭证，未上报';
  } else {
    try {
      await ctx.sendEvent({ link, credential, type: type as AgentEventType, props: clean });
      sent = true;
    } catch {
      reason = '上报失败（不影响后续步骤）';
    }
  }
  if (json) ctx.io.stdout(`${JSON.stringify({ command: 'event', type, props: clean, sent, reason }, null, 2)}\n`);
  return 0;
}
