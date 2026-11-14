/**
 * 备份与恢复命令行（contracts 17）。
 *
 *   pnpm --filter @nowme/web backup [--keep 7]
 *       把 NOWME_DATA_DIR 备份到 NOWME_BACKUP_DIR（默认 <数据目录>/../backups），保留份数默认取 NOWME_BACKUP_KEEP 或 7。
 *   pnpm --filter @nowme/web restore <备份文件> --to <空目录>
 *       恢复到一个不存在或为空的数据目录，并做 PRAGMA integrity_check。不带 --to 时恢复到 NOWME_DATA_DIR（同样必须为空）。
 *
 * 构建后：node --disable-warning=ExperimentalWarning dist/ops/backup-cli.js backup|restore ...
 */
import { dirname, join } from 'node:path';
import { loadConfig, loadRepoDotEnv } from '@nowme/contracts';
import { BackupError, createBackup, DEFAULT_BACKUP_KEEP, restoreBackup } from './backup.js';

function fail(message: string): never {
  console.error(`[backup] ${message}`);
  process.exit(1);
}

function flags(args: string[]): { positional: string[]; options: Record<string, string> } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const value = args[i + 1];
      if (value === undefined) fail(`${arg} 缺少参数`);
      options[arg.slice(2)] = value;
      i++;
    } else positional.push(arg);
  }
  return { positional, options };
}

loadRepoDotEnv();
const [command, ...rest] = process.argv.slice(2);
const { positional, options } = flags(rest);
const config = loadConfig();

try {
  if (command === 'backup') {
    const keepText = options.keep ?? process.env.NOWME_BACKUP_KEEP ?? String(DEFAULT_BACKUP_KEEP);
    if (!/^\d+$/.test(keepText) || Number(keepText) < 1) fail('保留份数（--keep / NOWME_BACKUP_KEEP）应为正整数');
    const backupDir = process.env.NOWME_BACKUP_DIR?.trim() || join(dirname(config.dataDir), 'backups');
    const result = createBackup({ dataDir: config.dataDir, backupDir, keep: Number(keepText) });
    console.log(`[backup] 已备份：${result.file}（${(result.bytes / 1024 / 1024).toFixed(2)} MB）`);
    if (result.pruned.length > 0) console.log(`[backup] 已清理旧备份 ${result.pruned.length} 份（保留 ${keepText} 份）`);
    console.log('[backup] 提醒：NOWME_AI_ENCRYPTION_KEY 不在备份里，请单独保管。');
  } else if (command === 'restore') {
    const archive = positional[0];
    if (!archive) fail('用法：restore <备份文件> --to <空目录>');
    const result = restoreBackup({ archive, targetDir: options.to ?? config.dataDir });
    console.log(`[backup] 已恢复到 ${result.targetDir}：完整性检查 ${result.integrity}，${result.tables} 张表，${result.revisions} 个页面版本`);
  } else {
    fail('用法：backup [--keep N] | restore <备份文件> --to <空目录>');
  }
} catch (error) {
  if (error instanceof BackupError) fail(error.message);
  throw error;
}
