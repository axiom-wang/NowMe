/**
 * 命令运行环境：输出、环境变量、用户目录、事件上报、等待 Ctrl+C。测试可以整体替换。
 */
import type { AgentEventType } from '@nowme/contracts';
import { createEventReporter, type EventProps, type EventSender } from './events.js';
import { sendEventHttp } from './api-client.js';
import { userCwd } from './workdir.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface RunOptions {
  /** 环境变量，默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 进程 cwd，默认 process.cwd()（用户目录优先取 env.INIT_CWD）。 */
  cwd?: string;
  /** 事件发送函数；默认真实发送（没有凭证时静默跳过）。 */
  sendEvent?: EventSender;
  /** `--serve` 时等待退出信号，默认等 SIGINT / SIGTERM。 */
  untilInterrupted?: () => Promise<void>;
}

export interface CliContext {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  /** 用户执行命令时所在的目录（相对路径都按它解析）。 */
  cwd: string;
  /** 上报事件（只带数字 / 布尔属性；没有凭证时静默跳过；失败不影响命令）。 */
  reportEvent: (workDir: string, type: AgentEventType, props: EventProps) => Promise<void>;
  /** 事件发送函数（event 命令直接使用，以便报告是否发送）。 */
  sendEvent: EventSender;
  untilInterrupted: () => Promise<void>;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

export function createContext(io: CliIo, options: RunOptions = {}): CliContext {
  const env = options.env ?? process.env;
  const sendEvent = options.sendEvent ?? sendEventHttp;
  return {
    sendEvent,
    io,
    env,
    cwd: userCwd(env, options.cwd ?? process.cwd()),
    reportEvent: (workDir, type, props) => createEventReporter({ workDir, env, send: sendEvent })(type, props),
    untilInterrupted: options.untilInterrupted ?? waitForSignal,
  };
}
