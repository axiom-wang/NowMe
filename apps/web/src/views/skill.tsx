/**
 * Skill 安装（contracts 4.5）：公开的 `/skill` 安装页，以及工作区里「安装 NOWMe Skill」用到的复制块。
 *
 * 文字来自 services/skill-install.ts（与 install.md、工作区一致）；通用写法，不写具体 Agent 的名字和目录。
 * 这里不出现任何 token 或凭证。
 */
import type { FC } from 'hono/jsx';
import { SKILL_BUNDLED_CLI_PATH, SKILL_NAME, SKILL_INSTALL_COMMAND, SKILL_GITHUB_URL, type SkillMarketConfig } from '@nowme/contracts';
import { skillCheckExpected, skillCheckPrompt, skillInstallPrompt } from '../services/skill-install.js';
import { skillArchiveUrl, skillInstallDocUrl, skillManifestUrl, type SkillPackage } from '../services/skill-package.js';
import { SKILL_VERSION } from '@nowme/skill';
import { Notice } from './forms.js';

/** 终端样式的一段可复制文字 + 复制按钮（app.js 的 `data-copy`）。 */
export const CopyBlock: FC<{ id: string; text: string; label: string; wrap?: boolean; variant?: 'accent' | 'ghost' }> = ({
  id,
  text,
  label,
  wrap = true,
  variant = 'ghost',
}) => (
  <div class="copy-block">
    <div class="terminal">
      <div class="terminal__bar" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <pre class={wrap ? 'code code--wrap' : 'code'} id={id}>
        {text}
      </pre>
    </div>
    <p>
      <button type="button" class={`btn btn--${variant} btn--small`} data-copy={id}>
        {label}
      </button>
    </p>
  </div>
);

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export interface SkillPageProps {
  webOrigin: string;
  skillPackage: SkillPackage | null;
  market: SkillMarketConfig | null;
  isProduction: boolean;
}

export const SkillPage: FC<SkillPageProps> = ({ webOrigin, skillPackage, market, isProduction }) => {
  const version = skillPackage?.manifest.version ?? SKILL_VERSION;
  return (
    <div class="container container--narrow skill-page">
      <section class="hero">
        <p class="eyebrow">NOWMe Skill</p>
        <h1 class="hero__title">给你的 Agent 装上 NOWMe Skill</h1>
        <p class="hero__lead">
          装好以后，把工作区里的 Agent 指令发给它，它就会采访你、帮你做墙上的那一页。适用于支持 Skill 的各种 AI
          Agent；不支持 Skill 的也有办法，见下文。
        </p>
      </section>

      {skillPackage ? (
        <dl class="facts skill-page__facts">
          <div>
            <dt>版本</dt>
            <dd>{skillPackage.manifest.version}</dd>
          </div>
          <div>
            <dt>大小</dt>
            <dd>{formatSize(skillPackage.manifest.bytes)}</dd>
          </div>
          <div>
            <dt>需要</dt>
            <dd>Node.js ≥ {skillPackage.manifest.minNode}</dd>
          </div>
        </dl>
      ) : (
        <Notice tone="warning">
          本机暂时没有离线安装包，仍可从 GitHub 安装。
          {isProduction ? null : (
            <>
              {' '}
              开发环境：运行 <code>pnpm --filter @nowme/skill pack:skill</code> 后重启主站。
            </>
          )}
        </Notice>
      )}

      <div class="stack">
        <section class="card" aria-labelledby="skill-agent">
          <h2 id="skill-agent">1. 让 Agent 自己安装（推荐）</h2>
          <p>把下面这句话发给你的 Agent。它会读安装说明、下载并核对 Skill 包，装到它自己的 Skill 目录里。</p>
          <CopyBlock id="nm-skill-install" text={skillInstallPrompt(webOrigin, version)} label="复制这句话" variant="accent" />
        </section>

        <section class="card" aria-labelledby="skill-github">
          <h2 id="skill-github">或者：用安装命令</h2>
          <p>在终端运行，按提示选择你的 Agent：</p>
          <CopyBlock id="nm-skill-github" text={SKILL_INSTALL_COMMAND} label="复制安装命令" />
          <p><a href={SKILL_GITHUB_URL}>查看 GitHub 仓库与更新说明</a></p>
        </section>

        {market ? (
          <section class="card" aria-labelledby="skill-market">
            <h2 id="skill-market">或者：从 {market.label} 安装</h2>
            <p>在终端里运行：</p>
            <CopyBlock id="nm-skill-market" text={market.command} label="复制命令" wrap={false} />
          </section>
        ) : null}

        {skillPackage ? <section class="card" aria-labelledby="skill-manual">
          <h2 id="skill-manual">或者：自己下载安装</h2>
          <ol class="skill-page__steps">
            <li>
              下载 <a href={skillArchiveUrl(webOrigin, skillPackage.manifest.version)}>{skillPackage.manifest.file}</a>
              ，核对 sha256：
              <code class="skill-page__hash">{skillPackage.manifest.sha256}</code>
            </li>
            <li>
              解压，得到 <code>{SKILL_NAME}/</code> 目录。
            </li>
            <li>
              把整个目录放进你的 Agent 读取个人 Skill 的目录（具体位置看 Agent 的文档），目录名保持 <code>{SKILL_NAME}</code>。
            </li>
          </ol>
          <p class="muted">
            给 Agent 读的安装说明：<a href={skillInstallDocUrl(webOrigin)}>{skillInstallDocUrl(webOrigin)}</a>
            <br />
            机器可读的清单：<a href={skillManifestUrl(webOrigin)}>{skillManifestUrl(webOrigin)}</a>
          </p>
        </section> : <p><a href={SKILL_GITHUB_URL + "/releases"}>从 GitHub Releases 下载安装包</a></p>}

        <section class="card" aria-labelledby="skill-check">
          <h2 id="skill-check">2. 重开会话，确认装好了</h2>
          <p>
            多数 Agent 只在会话开始时加载 Skill。装好后<strong>退出并重新打开一个会话</strong>，把下面这句话发给它：
          </p>
          <CopyBlock id="nm-skill-check" text={skillCheckPrompt()} label="复制这句话" />
          <p>
            它的回复里有 <code>{skillCheckExpected(version)}</code>，就说明装好了。很多 Agent 在输入{' '}
            <code>/</code> 时会列出可用的命令，能看到 <code>{SKILL_NAME}</code> 也说明已经加载。
          </p>
        </section>

        <section class="card" aria-labelledby="skill-next">
          <h2 id="skill-next">3. 回到工作区，把 Agent 指令发给它</h2>
          <p>
            在你加入的墙上打开「我的页面」，生成 Agent 指令，复制发给 Agent。指令里有一次性 token：只发给你自己的 Agent，不要发到群里。
          </p>
        </section>

        <section class="card card--quiet" aria-labelledby="skill-faq">
          <h2 id="skill-faq">常见问题</h2>
          <dl class="skill-faq">
            <dt>
              Agent 回复 <code>Unknown command: /{SKILL_NAME}</code>，或者说不认识这个命令？
            </dt>
            <dd>
              当前会话没有加载 NOWMe Skill：可能还没安装、装好后没有重开会话，或者装到了 Agent 读不到的位置。按上面的步骤装好并确认后，重开会话再粘贴<strong>同一条</strong>指令即可。只有 Agent 运行了 <code>nowme fetch</code>，token 才会被用掉；如果已经用掉了，或者找不到那条指令，就在工作区重新生成。
            </dd>
            <dt>我的 Agent 不支持 Skill？</dt>
            <dd>
              在工作区生成指令后，展开指令下方的「Agent 不支持 Skill？复制这段纯文本说明」，把整段发给 Agent。它会按说明下载同一个工具包来用，不需要安装成 Skill。
            </dd>
            <dt>怎么更新？</dt>
            <dd>
              用同样的方式重新安装，替换掉旧的 <code>{SKILL_NAME}/</code> 目录，再重开会话。Agent 连接时如果发现版本过旧，会提醒你；工作区里也会显示「有新版本」。
            </dd>
            <dt>Skill 能做什么、不能做什么？</dt>
            <dd>
              它只能拉取你这面墙的情境、提交新版本给你预览。<strong>发布需要你本人在工作区确认</strong>，Agent 不能替你发布。内置命令行在{' '}
              <code>{SKILL_BUNDLED_CLI_PATH}</code>，只需要 Node.js。
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
};
