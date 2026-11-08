import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dataPaths } from '@nowme/contracts';

/** 默认保留数据库及版本文件；只有维护者显式重置才清空。 */
export function prepareDemoDirectory(dataDir: string, reset: boolean): boolean {
  if (reset) rmSync(dataDir, { recursive: true, force: true });
  const reuse = existsSync(dataPaths(dataDir).db);
  mkdirSync(dataDir, { recursive: true });
  return reuse;
}
