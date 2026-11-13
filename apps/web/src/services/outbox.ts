/**
 * 发件箱（contracts 4.2、10.2）：登录验证码的投递。
 *
 * - `file`（本地开发默认）：写进 `<dataDir>/outbox.log`（每行一个 JSON）并打印到控制台；非生产环境可在 `GET /dev/outbox` 查看。
 * - `smtp`（真实投递）：见 services/mailer.ts。生产环境必须用它（`checkProductionConfig`）。
 * - 内存发件箱：测试用。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface OutboxMessage {
  /** ISO 8601 UTC。 */
  at: string;
  to: string;
  subject: string;
  /** 纯文本正文。 */
  body: string;
  /** 可选的 HTML 正文（真实邮件用；本地发件箱只记纯文本）。 */
  html?: string;
}

export interface Outbox {
  /** 投递一封邮件。真实投递是异步的，失败时抛错（调用方向用户说明“暂时发不出去”）。 */
  send(message: OutboxMessage): void | Promise<void>;
  /** 最近的 `limit` 封，新的在前。只有本地发件箱有内容。 */
  list(limit: number): OutboxMessage[];
  /** 能不能在 `/dev/outbox` 查看（本地文件 / 内存发件箱）。真实投递为 false：验证码只在用户的邮箱里。 */
  readonly inspectable: boolean;
  close?(): void | Promise<void>;
}

export function createFileOutbox(file: string, log: (line: string) => void = console.log): Outbox {
  return {
    inspectable: true,
    send(message) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const { html: _html, ...plain } = message;
      appendFileSync(file, `${JSON.stringify(plain)}\n`, { mode: 0o600 });
      log(`[web] 发件箱 → ${message.to}：${message.subject}｜${message.body}`);
    },
    list(limit) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const messages: OutboxMessage[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Partial<OutboxMessage>;
          if (typeof parsed.to === 'string' && typeof parsed.body === 'string') {
            messages.push({ at: String(parsed.at ?? ''), to: parsed.to, subject: String(parsed.subject ?? ''), body: parsed.body });
          }
        } catch {
          // 跳过损坏的行
        }
      }
      return messages.slice(-limit).reverse();
    },
  };
}

/** 内存发件箱（测试用）。 */
export function createMemoryOutbox(): Outbox & { messages: OutboxMessage[] } {
  const messages: OutboxMessage[] = [];
  return {
    messages,
    inspectable: true,
    send(message) {
      messages.push(message);
    },
    list(limit) {
      return messages.slice(-limit).reverse();
    },
  };
}
