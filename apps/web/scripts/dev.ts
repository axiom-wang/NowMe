import { dataPaths, loadConfig, loadRepoDotEnv, resolveTicketSecret } from '@nowme/contracts';
import { createWebApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { checkLocalPorts, handleLocalShutdown, startLocalServers } from './local-server.js';

loadRepoDotEnv();
const config = loadConfig();
await checkLocalPorts(config);
const db = openDatabase(dataPaths(config.dataDir).db);
const runtimeConfig = { ...config, ticketSecret: resolveTicketSecret(config) };
const web = createWebApp({ config: runtimeConfig, db, secretEnv: process.env });
try {
  const servers = await startLocalServers(runtimeConfig, web);
  handleLocalShutdown(async () => {
    await servers.close();
    try { await web.close(); } finally { db.close(); }
  });
  console.log(`[NOWMe] 已启动，只需打开：${config.webOrigin}`);
  console.log('[NOWMe] 页面沙箱已在同一进程启动，无需单独运行。按 Ctrl+C 全部关闭。');
  console.log(`[NOWMe] 数据目录：${config.dataDir}`);
} catch (error) {
  await web.close();
  db.close();
  throw error;
}
