/**
 * 开发用发件箱（contracts 0、4.2）：原型不发真实邮件，验证码写进 `<dataDir>/outbox.log`（每行一个 JSON）
 * 并打印到控制台；非生产环境可在 `GET /dev/outbox` 查看。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface OutboxMessage {
  /** ISO 8601 UTC。 */
  at: string;
  to: string;
  subject: string;
  body: string;
}

export interface Outbox {
  send(message: OutboxMessage): void;
  /** 最近的 `limit` 封，新的在前。 */
  list(limit: number): OutboxMessage[];
}

export function createFileOutbox(file: string, log: (line: string) => void = console.log): Outbox {
  return {
    send(message) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
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
    send(message) {
      messages.push(message);
    },
    list(limit) {
      return messages.slice(-limit).reverse();
    },
  };
}
