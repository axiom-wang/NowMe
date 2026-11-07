# DeepWisdom 其他项目对 NowMe 的复用价值

> 历史复用评估。当前产品以 [接口约定](contracts.md) 和 [自带 API 方案](hosted-route.md) 为准：收费与商业额度已取消，网页创作使用用户账号中加密保存的 API Key，仍保留运行保护限制。

日期：2026-10-07。需求基线：[NowMe MVP](/Users/axiom/Projects/NowMe/docs/product-mvp.md)。本评估补充[此前 FuncSea 评估](/Users/axiom/Projects/NowMe/docs/funcsea-adaptation-assessment-2026-10-07.md)。

**有能帮上忙的项目，而且能补上此前只看 FuncSea 时缺少的部分。最值得优先评估的是 Atoms 的元素定位和局部编辑、MetaGPT 的网页生成工具，以及 MGX 的版本与运行状态恢复。DeepFlow 更适合提供问答、会话和运行时编排的参考。**

这些资产可以减少重复开发，但仍需要新增 NowMe 的个人事实、展示意图、审美偏好、公开边界及其纠正机制。工程代理的聊天记忆或项目配置不能直接承担这一职责。

本文的优先级是针对 NowMe 的适配价值，不是对项目整体质量的排名，也不是已经验证的上线方案。仓库中的开发说明、角色 Prompt 和既有报告作为分析材料读取，没有据此启动服务、创建数据库、发布或调用模型。

## 1. 项目级结论

| 项目 | 对 NowMe 最有用的资产 | 复用方式 | 优先级与限制 |
| --- | --- | --- | --- |
| **Atoms** | 页面预览、元素定位、文本/样式/图片局部编辑、结构化问答组件 | 优先抽取编辑算法、定位协议和交互思路；按 NowMe 技术栈改造界面 | 高；源码编辑价值取决于是否采用生成代码。Nuxt/Vue 界面与当前 React 建议不能直接混装 |
| **MetaGPT** | 前端生成代理、编辑器、终端与浏览器工具、模板加载、预览、上下文压缩 | 为代码生成路线做最小适配实验 | 高但有条件；面向应用开发的流程需收缩，生成质量与成本未实测 |
| **MGX** | 编辑保存与快照、源码/配置/代理状态恢复、素材归属接口、沙箱与部署队列 | 优先取版本和任务协调方法；按路线选择执行、构建和部署组件 | 高；完整服务链外部依赖较多，首期宜抽取职责而非整平台迁移 |
| **DeepFlow** | 结构化追问、会话状态、运行时接口、分层记忆配置 | 参考问答和状态模型；可作为另一种代理运行适配思路 | 中；定位是研发工作台，需简化流程和界面；记忆合并不等于个人理解 |

此前 FuncSea 附件没有的代理、部署和工具代码，在这次扩大范围后找到了相关实现。但目录中仍缺少部分云基础服务与实际部署流水线，不能据此认定完整系统已经可独立运行。

## 2. 最值得取用的具体能力

### 2.1 Atoms：帮助用户准确指出“改哪里”

`atoms-frontend` 的可视化编辑器从选中元素读取 `data-mgx-*` 元数据，包括元素标识、文件路径、代码片段和行号；它保存最初选中的源码信息，再组织后续修改。[元素定位与源码记录](/Users/axiom/DeepWisdom/Atoms/atoms-frontend/packages/block-appviewer/src/components/design/visual-editor/core/use-visual-editor.ts:145)

对 NowMe，这可以转化为一个直接的体验：主人点中照片或文字后说“只把这里改一下”，系统获得明确目标，不必让主人描述源码位置。即使最终采用结构化页面而非源码，也值得保留稳定元素标识、目标选择和范围限制的设计。

代码编辑部分按 React、Vue、HTML 选择解析器，将文本、样式、图片和删除操作写回源文件；准备失败时不提交，保存成功才清空本次编辑状态，并调用后端生成快照。[解析器选择](/Users/axiom/DeepWisdom/Atoms/atoms-frontend/packages/block-appviewer/src/components/design/visual-editor/core/ast/parser-factory.ts:37)、[保存流程](/Users/axiom/DeepWisdom/Atoms/atoms-frontend/packages/block-appviewer/src/components/design/visual-editor/core/use-visual-editor.ts:398)

建议取用：

- 元素选择及预览消息协议，服务自然语言目标定位。
- 文本、样式、图片的转换逻辑；若采用代码路线，优先验证 React/HTML 两类实际产物。
- 修改失败后保留操作、保存后形成版本的交互方法。
- 单选、多选、自由输入的追问组件思路，改成简短、可跳过的创作引导。

仍需补齐：源版本前置条件、逐操作成功判定、修改后的语法/构建与视觉检查、手机目标选择，以及多文件写入失败的恢复。当前转换器捕获单项异常后可以继续执行，因此“保存有变化”不能等同于每项修改都成功。[转换执行](/Users/axiom/DeepWisdom/Atoms/atoms-frontend/packages/block-appviewer/src/components/design/visual-editor/core/use-ast-content-replacer.ts:119)

Atoms 界面主要使用 Nuxt/Vue；部分转换代码是 TypeScript，但编辑状态、路由、API 和组件仍与原平台耦合。应按 NowMe 的最终技术栈取用，避免同时维护 Vue、React 两套创作界面。

### 2.2 MetaGPT：提供实际生成和修改网页的代理工具

`MetaGPT/MetaGPT` 中有 `RoleZero` 的代理内核，以及 `FrontendEngineer` 的前端任务实现。它们接入文件编辑、终端、浏览器、模板初始化和预览；前端角色还在写文件时处理图片引用。[代理内核](/Users/axiom/DeepWisdom/MetaGPT/MetaGPT/metagpt/roles/di/role_zero.py:96)、[图片与文件写入](/Users/axiom/DeepWisdom/MetaGPT/MetaGPT/metagpt/roles/di/frontend_engineer.py:441)

这使“用素材和自然语言生成一页，再继续修改”有了可取用的执行实现。模板加载器可以复制工程起点，预览器会写运行配置并启动预览流程。[模板初始化](/Users/axiom/DeepWisdom/MetaGPT/MetaGPT/metagpt/roles/di/frontend_engineer.py:679)、[预览入口](/Users/axiom/DeepWisdom/MetaGPT/MetaGPT/metagpt/tools/libs/previewer.py:31)

对 NowMe，建议实验使用最小的前端生成与编辑路径：输入有效 context、允许公开的素材、目标元素及变更范围，输出候选产物与可检查的变更。产品流程不必展示团队角色、研发计划、终端或技术配置。

注意两个边界：

- 当前模板加载主要按场景取得路径；这不证明已经实现“依据个人审美自动选到合适设计”。NowMe 的设计选择与内容组织仍需建设。
- 代理执行是面向任意应用开发的。生成个人空间时，应限定实际需要的工具、依赖、资源和重试范围，再验证生成效果与局部修改稳定性。

MetaGPT 有上下文压缩和长期工程记忆代码，可用于降低连续创作的上下文负担。不过会话摘要不能成为唯一的事实和边界记录；学校信息被删除后，也不能依靠摘要保证它不再出现。[会话压缩](/Users/axiom/DeepWisdom/MetaGPT/MetaGPT/metagpt/memory/compaction/auto_compaction.py:35)

`MetaGPT/mgx_tools_server` 提供了另一组工具实现，是 MGX Tool 的依赖候选。它的存在补充了完整执行链的材料，但本次没有运行工具服务。

### 2.3 MGX：帮助修改后继续工作、恢复后状态一致

`metagptx-backend` 有编辑会话服务：核对项目归属和路径，写入修改文件，然后创建快照消息；Atoms 编辑器调用的 `edit-session` 接口与这一职责对应。[后端编辑会话](/Users/axiom/DeepWisdom/MGX/metagptx-backend/src/service/chat/chat_edit_session.py:73)、[前端保存请求](/Users/axiom/DeepWisdom/Atoms/atoms-frontend/packages/api-client/src/api/files.ts:216)

版本恢复涉及源码、数据库快照和项目配置。`mgx-thinking` 取得恢复后的配置，调整相关后端状态，重新加载 `.MGXEnv.json` 中的代理环境，再创建恢复版本。[后端恢复编排](/Users/axiom/DeepWisdom/MGX/metagptx-backend/src/service/snapshot/restore.py:372)、[恢复后的运行状态同步](/Users/axiom/DeepWisdom/MGX/mgx-thinking/mgx_thinking/chat.py:12148)

这对 NowMe 的启发很具体：撤销不能只换回页面外观，还要使后续编辑使用的理解和创作状态与该页面一致。MGX 提供了实现参考，但其中版本化的是项目配置和代理状态，不是已经定义好的 NowMe 事实、意图、偏好、边界模型。

可以优先取用：

- 源码/产物、任务、配置和代理状态的版本关联方法。
- 生成与提交的协调、取消和恢复流程，以及对应的测试案例。
- 编辑会话到快照的链路，扩展为 NowMe 的候选、接受、撤销和发布。
- 明确项目主人并传递 `user_id + app_id` 的素材接口方法。[素材归属接入](/Users/axiom/DeepWisdom/MGX/metagptx-backend/src/service/chat/storage.py:73)

该素材接口实际调用 `funcsea_infra_client`，外部存储服务本体仍未在本次目录中找到。可以参考归属和接口契约，但不能将客户端当成完整存储服务。

当前编辑保存按文件顺序写入，不能仅凭前端准备检查或快照接口认定多文件更新已经原子化。版本恢复也有允许配置恢复失败后继续的处理，不应当作 NowMe 的强一致性保证。新业务要明确失败时是否接受结果，并验证继续编辑的行为。

### 2.4 MGX 模板：比旧附件更贴近当前代理的起点

`MGX/mgx_template/templates` 中有 Web、HTML、原型和其他产物模板；其中 `function_sea` 保留认证、数据库、存储、AI、支付五个通用模块。当前 MetaGPT 加载器使用的 `templates/base/frontend` 路径在这份模板中存在，适合作为代码生成实验的候选基线。[模板路径规则](/Users/axiom/DeepWisdom/MetaGPT/MetaGPT/metagpt/tools/libs/search_template.py:27)

本次还核对到，存储请求会保留对象 key 的完整路径和非 ASCII 字符，避免旧模板将路径压成 basename 或替换中文后失配。[当前模板的对象 key 处理](/Users/axiom/DeepWisdom/MGX/mgx_template/templates/function_sea/modules/storage/backend/schemas/storage.py:57)

但它的 `manager.py` 与此前 FuncSea 的安装器字节内容完全相同。临时组装四个通用模块后，仍未复制认证前端、未注入 Lambda 数据库初始化，并保留 16 处配置占位符。**模板有所演进，不代表本地安装器已解决集成缺口。**

这份资产主要提供工程起点，不能按模板数量推断个人空间的设计丰富程度。现有名片字段、职业或 MBTI 等示例，也不应变成 NowMe 的必填资料或审美分类。

### 2.5 DeepFlow：参考追问、状态和模型运行适配

DeepFlow Web 有结构化人类决策面板，支持选项、自定义答案等输入；Core 有会话服务和运行时接口。可以为 NowMe 的必要追问、等待反馈、任务失败和继续创作提供实现参考。[追问面板](/Users/axiom/DeepWisdom/DeepFlow/deepflowweb/src/components/iteration/chat/HumanDecisionPanel.tsx:42)、[运行时接口](/Users/axiom/DeepWisdom/DeepFlow/DeepFlowCore/app/_harness_zone/ports/runtime.py:30)

其 Memory 配置按系统、用户、仓库三层合并，并记录来源；Core 再将结果写入代理运行环境。这可启发“平台表达规则、用户明确偏好、本页意图”分层，但现有合并仅按条目标识覆盖，不能直接处理个人事实确认、纠正和删除。[记忆配置合并](/Users/axiom/DeepWisdom/DeepFlow/deepflowweb/src/lib/configuration/memory-resolution.ts:10)、[运行环境记忆写入](/Users/axiom/DeepWisdom/DeepFlow/DeepFlowCore/app/iterations/memory_setup.py:60)

DeepFlow 的整体界面和流程面向研发，包含需求池、迭代、代码审查、仓库、组织集成等。对 NowMe，应选择性取用上述小块能力，重新组织为轻量的个人创作流程。

## 3. 有价值但首期宜暂缓的部分

| 资产 | 能帮助什么 | 暂缓整套引入的原因 |
| --- | --- | --- |
| `MGX/mgx-runtime` | 创建、分配、回收运行环境，容器池、挂载及失败补偿 | 依赖 Kubernetes、数据库、Redis、用户服务和存储挂载；若先用结构化页面，没有必要为每位主人运行开发环境 |
| `MGX/mgx-tool` 与工具服务器 | 命令执行、工具路由、开发预览 | 代码生成路线有用；需先对齐依赖和验证资源限制，不能仅凭“沙箱”名称确认隔离强度 |
| `MGX/deploysvc` | 部署队列、并发槽位、构建状态和回调 | 实际触发 Jenkins 作业；作业定义、云资源和完整流水线不在服务源码里，不能原样变为 NowMe 发布服务 |
| `MGX/mgx-worksapce` | 团队、成员、邀请、权限、用量 | 当前每账号一个个人主页的建议范围更简单，先做主人归属和额度即可 |
| Race Mode | 多方案生成、结果比较、选择后继续开发 | 可参考结果选择与状态迁移；同时生成多套完整应用的开销需测，首期可先做少量局部表达对照 |
| Growth、广告、商业计费、应用广场 | 发布后经营与增长 | 不直接解决首期个人表达、准确编辑和分享闭环 |
| `Atoms/atoms-python` | JWT、HTTP 客户端、OIDC、服务注册和日志查询 | 是内部 SDK，不是生成引擎；只有接入相应服务时才有直接价值 |
| `MetaGPT/metagpt-backend` | 历史智能体应用后端 | 本地快照提交日期为 2024-04-03；首期优先分析较新的 MGX 生命周期链路 |

运行环境与部署的实现证据：[容器池服务](/Users/axiom/DeepWisdom/MGX/mgx-runtime/internal/service/pool_service.go:326)、[分配补偿](/Users/axiom/DeepWisdom/MGX/mgx-runtime/internal/allocation/compensation.go:26)、[触发 Jenkins](/Users/axiom/DeepWisdom/MGX/deploysvc/services/proxy.py:388)。这里确认的是实现存在，未测冷启动、隔离、成本或部署成功率。

`atoms-python` 的 SDK 定位由其公开入口和架构说明共同确认。此前 FuncSea README 列出的同名镜像，不能据名字推断就是编程代理。[SDK 架构](/Users/axiom/DeepWisdom/Atoms/atoms-python/docs/architecture.md:7)

## 4. 这些代码能否直接拼起来

**具备拼接的候选资产，但当前不能视为一套已经对齐的可运行版本。**

本次对本地依赖提交做了核对：

| 依赖关系 | 父仓库要求的提交 | 本地候选提交 | 结果 |
| --- | --- | --- | --- |
| MGX Thinking → MetaGPT | `2cd47dc44f63` | `8c5179af84b2` | 不一致 |
| MGX Thinking → 模板 | `36b6a66d3e77` | `15d46cabb308` | 不一致 |
| MGX Thinking → 协议 | `7fa868da90b6` | `a22da8ca70d0` | 不一致 |
| MGX Tool → 工具服务器 | `bf1a67028629` | `bf1a67028629` | 一致；仍需对齐其余依赖和验证接口 |

这些父仓库的相关子模块本地未初始化。旁边的独立仓库可以用于补齐候选依赖；提交不同不证明接口不兼容，也不证明可以直接替换。必须固定一组版本，核对导入、协议和工具参数，再跑最小生成任务。

另外，用户/模型网关、部分内部 SDK、`funcsea-infra`、实际云资源和 Jenkins 作业仍是外部依赖。替换或取得这些接口需要在后续原型中明确，当前不以“目录里有部署服务”代替真实发布验证。

## 5. 对 NowMe 的推荐组合

底层生成机制尚未决定，建议保留两条实验路线，避免因现有仓库多而扩大首期范围。

| 路线 | 建议取用 | 新增重点 |
| --- | --- | --- |
| **结构化页面路线** | FuncSea/MGX 模板中的基础服务；Atoms 的元素选择与变更交互方法；MGX 的版本关联思路；按需参考 DeepFlow 的问答和任务状态 | 自由组合页面描述与渲染器、个人 context、定向变更、公开快照 |
| **生成代码路线** | MetaGPT 前端生成与编辑工具；MGX 模板；Atoms 的源码定位和转换；MGX 版本/执行链中实际必要的部分 | NowMe 创作编排、个人 context、受约束执行、修改检查、发布隔离与稳定入口 |

两条路线都需要主人素材与事实的来源管理、确认状态、当前页面与长期偏好的范围区分、纠正和删除规则，以及公开内容确认。这些是 NowMe 自己要实现和验证的核心。

推荐先建立三份明确接口：

1. **有效 context 与素材 → 候选页面**：同一素材可以表达不同意图，允许改变内容组织，不能只换模板字段。
2. **当前版本与选中目标 → 候选变更**：同时返回修改范围和校验结果，失败不覆盖可用版本。
3. **主人接受的版本 → 发布快照**：公开只读已确认作品；撤销同步当前创作状态；删除和公开边界不会因恢复旧版本而失效。

先用这三个接口验证可取用资产，之后再决定需要引入多少 MGX 服务或采用哪种代理内核。MetaGPT 和 DeepFlow 的运行方案可作为候选，不必同时运行两套代理系统。

## 6. 最小验证顺序

1. 固定模板、代理、工具与协议版本，生成一页包含虚构文字、三张图片和链接的作品，预览成功。
2. 用相同素材生成“随手贴的卧室墙”和“安静记录本”，验证结构与表现确实不同。
3. 点中两张照片，要求只改它们的排列；检查目标、未涉及内容、语法和手机呈现。
4. 去掉学校信息，再改版、撤销、恢复并继续编辑，检查个人边界与当前创作状态。
5. 接受、发布、改草稿、模拟失败、更新、撤回，验证访客只看到正确公开版本。
6. 用真实微信入口完成打开、输入、目标选择与分享，再确认承载方案。

记录成功率、耗时、模型费用、重试与人工修复；当前不估算复用比例或上线工期。小规模用户验证仍需观察结果是否“像自己”、修改是否达意以及是否愿意真实分享。

## 7. 本次证据与验证范围

本次盘点四组其他项目下的 16 个代码项目目录，另有一个 `agents` 提示资料目录；其中 14 个代码项目有独立 Git 元数据。主要能力结论来自关键源码抽样及调用关系核对，既有技术报告仅作定位参考。[结构化证据](/Users/axiom/Projects/NowMe/docs/deepwisdom-reuse-evidence-2026-10-07.json)

完成了两项小范围验证：

- 在临时目录组装 MGX 模板通用模块，重新确认安装器及生命周期的缺口。
- 用虚构数据执行 MGX 的持久化投影函数，确认它不修改输入、剔除可重建的运行字段、保留嵌套会话记忆，并稳定集合类字段顺序。此验证不证明真实版本恢复正确，更不证明个人 context 语义已满足 NowMe。

没有安装依赖、启动完整应用、调用真实模型、部署或进行端到端验收。14 个 Git 工作区的状态在检查前后均未变化；DeepFlow 的两个代码目录本地未见独立 Git 元数据，本次只读其文件。新增产物均保存在 NowMe 的 `docs` 中。

**建议下一步优先验证 Atoms 的目标编辑体验、MetaGPT 的最小生成路径和 MGX 的版本恢复方法。它们能帮助完成创作闭环；NowMe 的个人理解与公开控制仍由自己的业务层负责。**
