/** 固定错误码，禁止携带供应商响应或凭证。 */
export type ModelAccessCode = 'MODEL_CONFIG' | 'MODEL_AUTH' | 'MODEL_RATE_LIMITED' | 'MODEL_UNAVAILABLE';
export class ModelAccessError extends Error {
  override name = 'ModelAccessError';
  /** 只用于服务端诊断日志：HTTP 状态码（无则 null），不含响应内容。 */
  constructor(readonly code: ModelAccessCode, readonly status: number | null = null) { super(code); }
}
/** 从错误链上取 HTTP 状态码（只取数字），用于诊断日志。 */
export function modelFailureStatus(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) break;
    const status = 'status' in current ? current.status : null;
    if (typeof status === 'number') return status;
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}
export function modelFailureCode(error: unknown): ModelAccessCode | null {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof ModelAccessError) return current.code;
    if (typeof current !== 'object' || current === null) break;
    const status = 'status' in current ? current.status : null;
    if (status === 401 || status === 403) return 'MODEL_AUTH';
    if (status === 429) return 'MODEL_RATE_LIMITED';
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}
