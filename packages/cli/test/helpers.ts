/**
 * CLI 测试夹具：临时工作目录、合法页面、输出捕获。
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLES_DIR = fileURLToPath(new URL('../../../skill/examples/', import.meta.url));

export function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/** 脚本里有静态文本中没有的字（“额外”），用来测试 extraChars 自动补全。 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>测试</title>
<link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">
</head>
<body>
<section data-nm-id="hero"><h1>你好</h1><p id="line">世界</p></section>
<section data-nm-id="about"><p>关于我</p></section>
<section data-nm-id="more"><p>更多</p></section>
<script src="/_nowme/kit/v1/nowme.js"></script>
<script>
document.getElementById('line').addEventListener('click', (event) => { event.target.textContent = '额外'; });
</script>
</body>
</html>
`;

export const CARD = {
  schemaVersion: 1,
  displayName: '测试',
  tagline: '一个测试页面',
  hooks: [
    { id: 'hello', text: '你好世界', opener: '你好！' },
    { id: 'world', text: '关于我', opener: '你好呀' },
  ],
};

/** 手写格式的 manifest（紧凑数组、字段顺序）：自动补全只能改 extraChars 的值，别处一个字节都不能动。 */
export const MANIFEST_TEXT = `{
  "schemaVersion": 1,
  "sceneType": "general",
  "kitVersion": "1",
  "motionLevel": "calm",
  "fonts": [],
  "extraChars": "",
  "blocks": ["hero", "about", "more"],
  "generator": { "agent": "test", "skillVersion": "0.1.0" }
}
`;

export interface TempWorkdir {
  root: string;
  pageDir: string;
  cleanup: () => Promise<void>;
}

/** 新建临时工作目录 `<root>/page/`，写入合法页面（或复制一个 Skill 示例）。 */
export async function makeWorkdir(options: { example?: string; files?: Record<string, string> } = {}): Promise<TempWorkdir> {
  const root = await mkdtemp(join(tmpdir(), 'nowme-cli-'));
  const pageDir = join(root, 'page');
  if (options.example) {
    await cp(join(EXAMPLES_DIR, options.example), pageDir, { recursive: true });
    await rm(join(pageDir, 'cover.png'), { force: true });
  } else {
    await mkdir(pageDir, { recursive: true });
    await writeFile(join(pageDir, 'index.html'), PAGE_HTML);
    await writeFile(join(pageDir, 'card.json'), `${JSON.stringify(CARD, null, 2)}\n`);
    await writeFile(join(pageDir, 'manifest.json'), MANIFEST_TEXT);
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(join(pageDir, path, '..'), { recursive: true });
    await writeFile(join(pageDir, path), content);
  }
  return { root, pageDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}
