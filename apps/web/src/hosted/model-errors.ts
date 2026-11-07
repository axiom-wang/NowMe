/** 固定错误码，禁止携带供应商响应或凭证。 */
export type ModelAccessCode = 'MODEL_CONFIG' | 'MODEL_AUTH' | 'MODEL_RATE_LIMITED' | 'MODEL_UNAVAILABLE';
export class ModelAccessError extends Error {
  override name = 'ModelAccessError';
  constructor(readonly code: ModelAccessCode) { super(code); }
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
