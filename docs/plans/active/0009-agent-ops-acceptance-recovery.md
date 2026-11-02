# 0009 Agent Ops 验收整改计划

状态：用户已批准持续推进。R1 至 R6 已分别验收并推送 `98501c5`、`f320f97`、`dd6be3b`、`1a5d677`、`6b99dfd`、`efa9779`，均已核对远端 SHA。R7 的计量、预算、trace、heartbeat、告警、审批保留策略已完成工作区验收；真实 DeepSeek usage 对照、调用中途 SIGKILL 恢复、桌面/手机及调度/记忆回归通过。冻结代码全量测试 319 项，317 reported pass、2 skipped、0 failed。R7 独立提交、clean exact-head 复验与推送核对待完成；R8-R10 待开始。证据见 `docs/evidence/R7-observability-monitoring.md`。

复核日期：2026-11-01。代码基线：`797ccb8`。

## 目标与范围

完成一个能够私有部署、供受邀用户操作的 Agent Ops Dashboard。用户能配置内容来源，触发真实 DeepSeek agent，检查结果，反馈偏好，安排后续任务，并追踪错误、成本、延迟和安全决策。

沿用 [0008 production plan](0008-agent-ops-dashboard-production.md) 的全部要求和技术栈。保留 TypeScript、npm workspaces、Fastify、React、Vite、Tailwind、TanStack Query、SSE、SQLite、Drizzle、node-cron、Playwright、DeepSeek，以及 Node test runner。依赖版本在实现时验证兼容性，并写入 lockfile。

本计划把整改拆为 R1 到 R10，便于单独交付。R 编号是整改批次，不替换原 Phase 编号。调整执行顺序的原因是权限与持久化必须先于真实工具执行，真实执行和指标必须先于完整 UI 验收。原计划里的页面、模块和验收要求全部保留。

部署边界保持单实例、单工作区、SQLite 持久磁盘。受邀用户有 viewer 或 operator 权限。Postgres、多租户和分布式队列保持原有升级路径，不作为当前完成声明。云平台、域名和预算在 R10 部署前确认。平台必须支持常驻进程和持久磁盘。

## 已复现的问题

以下结果来自基线代码的实际复核。它们是整改输入，不是新增的完成证据。

| 问题 | 观察结果 | 整改批次 |
| --- | --- | --- |
| 构建依赖本机工具 | 去掉全局编译器后，`npm run check` 报 `tsc: command not found` | R1 |
| Docker 无法构建 | Linux arm64 构建在 better-sqlite3 安装时因缺少 Python 失败 | R1、R10 |
| API 无访问控制 | 无凭证请求可以写入和导出 memory | R2 |
| 审批来自客户端声明 | 请求传 `approved: true`，高风险工具策略返回允许 | R2 |
| URL 策略未接入抓取 | 不在 allowlist 的 URL 仍进入 fetch adapter | R2、R4 |
| Dashboard 默认执行 mock | 禁止外部请求后，Run now 仍成功并报告 2,380 input tokens、$0.0029 | R4、R7 |
| 没有报告却显示通过 | 空 eval_reports 表对应四项 passed，sandbox 默认显示 enabled | R7、R9 |
| 重复运行结果不一致 | 第二次运行的 digest 非空，最新 run 的 contentItems 为空 | R3 |
| 调度忽略时区 | UTC 环境把上海 9 点计算成 UTC 9 点 | R5 |
| cancel_previous 不取消 | 原任务和替代任务都继续产生结果 | R5 |
| UI 操作不足 | 主要可操作项是 Run now 与暂停、恢复 | R8 |

## 每批次的执行约定

1. 开工前列出该批次的文件范围、接口变化、AC 编号和复现步骤。
2. 对已复现的问题补行为回归检查，再实现修复。文档格式调整不新增测试。
3. 运行该批次的自动验收和手动验收。相关既有测试不得退化。
4. 记录证据、未通过项和限制。未执行的检查标记为未验证，不能改成 passed。
5. 本批次全部 AC 通过后提交独立 commit。推送至工作分支，核对远程 SHA。
6. 给用户一份阶段报告。上一批次未关闭时，不开始下一批次的实现。

阶段报告固定包含：批次、AC 结果、修改摘要、复现前后结果、测试环境、命令退出码、手动步骤、证据位置、commit SHA、远程同步状态，以及下一批次。

实现与验收可以在同一轮完成，但不能用同一套假数据同时生成结果和证明结果。测试允许受控 provider 与本地内容源。真实模型验收必须明确标记为 live，并保存真实请求的脱敏证据。

## 执行顺序与原计划对应关系

| 批次 | 交付结果 | 对应原 Phase | 主要代码范围 | 当前状态 |
| --- | --- | --- | --- | --- |
| R1 | 干净环境可以安装、构建和启动 | 0、1、10 | package manifests、Docker、CI、README | 验收通过 |
| R2 | 服务端权限、工具审批和网络限制生效 | 3、10 | security、server、工具执行入口 | 验收通过，已推送 |
| R3 | run、内容、投递和事件状态一致 | 2、6 | db、runtime | 验收通过，已推送 |
| R4 | Dashboard 运行真实 agent 与内容流程 | 3、6 | runtime、server、已有 ai/agent 组合 | 验收通过，已推送 |
| R5 | 定时、排队、取消和重启恢复正确 | 5 | runtime、server | 验收通过，已推送 `6b99dfd`，远端 SHA 已核对 |
| R6 | 偏好、检索和实践更新影响后续运行 | 7 | db、runtime、coding-agent、tui、dashboard | 验收通过，已推送 `efa9779`，远端 SHA 已核对 |
| R7 | 指标、trace 和 heartbeat 来自实际运行 | 9、10 | runtime、server、ai 调用监测 | 工作区 AC、live usage、进程/界面及冻结回归通过；独立提交、clean exact-head 与远端核对待完成 |
| R8 | Dashboard 完成全部用户操作流程 | 4 | dashboard、对应 server API | 待开始 |
| R9 | harness 能阻止已知坏行为重新上线 | 8 | evals、各包行为测试、CI | 待开始 |
| R10 | 本地容器与受控云环境通过发布验收 | 10，以及所有 Phase 的最终复核 | Docker、部署配置、发布与证据文档 | 待开始 |

## R1：干净环境构建

计划：

- 在 package.json 声明 TypeScript 和构建所需依赖。固定用于 CI、Docker 和本地校验的 Node 版本。
- 使用 lockfile 安装。补齐 Docker 构建上下文中的 tsconfig.base.json 和必要源码文件。
- 分开镜像的构建阶段与运行阶段。构建阶段包含必要编译工具，运行阶段使用非 root 用户。
- 处理 better-sqlite3 的原生依赖。支持的 CPU 架构必须分别构建验证。
- R1 先验证本机对应的 Linux arm64；云平台架构确定后，R10 在对应架构验证。未通过验证前不声明支持该架构，本机 amd64 仿真不作为推进前置条件。
- 明确 `.env` 的加载方式，修正 README 的实际端口，保留已有 key 文件。
- 明确生产 UI 的 API 路由。采用同源访问，让容器中的前端能够访问 API。

验收标准：

- R1.1：全新 checkout 不安装全局 tsc，执行 `npm ci`、`npm run check`、`npm run build`、`npm run check:package-boundaries` 和 `npm run dashboard:build` 成功。
- R1.2：实际 Docker build 成功。构建不读取宿主 node_modules、dist 或 `.env`。
- R1.3：实际容器能返回 health/readiness。用浏览器访问容器 UI 时，snapshot 来自 API，页面没有 API offline。
- R1.4：CLI 和 TUI 的 help 可运行。缺失 key 的真实运行明确失败。缺 key 时不能自动切换为未标记的 mock。
- R1.5：README 的安装和启动步骤可以在上述干净环境复现。

证据：干净环境日志、镜像与平台信息、health/readiness 响应、浏览器请求结果。

手动验收：在新目录按 README 启动，打开 UI，运行 CLI/TUI help。

## R2：权限与工具执行门禁

计划：

- 在 Fastify 请求入口验证身份。提供 viewer 只读权限和 operator 操作权限。服务端会话使用 HttpOnly cookie，生产开启 Secure，写请求验证 CSRF。
- 初始化身份凭证来自服务端 secret。限制登录和运行请求频率，限制输入大小。登录凭证不进入日志或业务事件。
- 工具审批绑定 run、工具名、规范化参数摘要、审批人、过期时间和使用状态。执行器查验服务端记录。
- 客户端不能提供 `sourceTrust: system` 或自行设置 `approved` 来获得权限。未知工具默认拒绝。
- 在实际 URL、RSS 和浏览器执行入口检查 allowlist。验证重定向和目标地址，拒绝内网及云 metadata 地址。浏览器子请求同样受策略约束。
- 云端不注册宿主机 bash 和任意文件写入工具。需要受限执行环境的能力，必须有实际隔离证据。
- 在写入事件、trace、memory 导出、错误和日志之前统一处理 secret。只做响应字符串替换不够。

验收标准：

- R2.1：无凭证访问受保护 API 返回 401。viewer 写入、执行、审批返回 403。SSE 和 memory export 同样受保护。
- R2.2：伪造 approved、sourceTrust、审批人或 runId 不能获得执行权限。
- R2.3：未批准、已过期、已消费、参数被修改的审批全部拒绝。有效批准只允许绑定操作执行一次。
- R2.4：直接调用真实抓取入口时，非 allowlist URL、内网目标和违规重定向均被阻止。拒绝发生在向违规目标发出 HTTP 请求之前。
- R2.5：受控 secret 样本不会出现在数据库事件、日志、trace、API、导出文件或 UI。审计记录含操作者、动作、决策和关联 ID。

证据：身份与权限测试、实际执行器拒绝记录、网络边界测试、脱敏后的审计记录。

手动验收：退出登录后访问 API，再以 viewer 登录尝试 Run now，最后用 operator 审批一项绑定操作。

## R3：运行与结果持久化

计划：

- 分开内容实体和每次 run 的结果。内容身份用于去重，run 结果保留本次分数、摘要、证据和投递决策。
- 持久化投递记录，定义跨 run 去重。没有新内容时明确返回 no_new_items，并保留历史结果。
- 为手动触发、重试和关键写入定义幂等键。事务提交结果后再产生成功投递事件。
- 使用 schema 校验事件类型、payload 和时间字段。区分失败、取消、运行中和完成状态。
- snapshot、readiness 和其他读取操作不再隐式运行 demo 或写入虚构状态。demo seed 必须显式调用并标记来源。
- 用有版本的 migration 更新已有数据库，覆盖重复迁移和旧数据升级。

验收标准：

- R3.1：连续运行三次，事件计数、run 结果、digest 和投递记录一致。重复内容不重复投递。
- R3.2：第二次没有新内容时，UI/API 明确显示该原因。第一次运行的结果仍能查询。
- R3.3：同一个幂等键重试请求只创建一个逻辑 run 和一次投递。
- R3.4：进程重启后可以从 SQLite 重建历史 run。畸形事件不能入库。
- R3.5：migration 重复执行和从基线数据库升级均成功。

证据：重复运行测试、投递表检查、事件 replay、迁移前后数据库校验。

手动验收：连点运行、切换历史 run、重启 API，再查看原结果。

## R4：真实 agent 与内容流程

计划：

- 在 Dashboard 的服务端执行路径组合已有 Agent loop、DeepSeek provider 和受限工具。保留 CLI/TUI 的运行能力。
- 手动触发与定时触发调用同一个执行入口。任务定义包含来源、偏好引用、模型配置和预算。
- 支持 mock、RSS、URL、Playwright 只读采集。mock 仅用于明确标记的 demo 和测试。
- 模型基于实际工具结果生成结构化摘要。校验输出 schema，保留原始来源和引用关系。
- 设置来源超时、运行超时、工具步数和输出 token 上限。区分可重试的网络错误与不可重试的验证错误。
- 每项来源失败均产生可诊断事件。全部来源失败时 run 失败，部分失败时报告降级状态。

验收标准：

- R4.1：受控 provider 验收覆盖 prompt、tool call、tool result、最终输出和错误路径。
- R4.2：真实 DeepSeek 验收产生实际 provider 响应与 usage。调用不可用时报告失败，不能显示固定成功结果。
- R4.3：至少一个真实公开内容源及一个真实浏览器采集场景通过验收。页面中的新内容会出现在工具结果和最终输出。
- R4.4：每条结果有 source、URL、summary、reason、score 和 evidence。引用指向本次实际读取内容。
- R4.5：RSS、URL 和浏览器来源的超时、单源失败、全源失败均有行为测试。CLI/TUI streaming 与 tool calling 相关回归通过。

证据：受控运行 transcript、live runId、脱敏 provider usage、浏览器采集结果、来源与摘要对应关系。

手动验收：配置一个 RSS/URL 来源，Run now，打开来源核对摘要，再查看实际工具调用。

## R5：调度、取消与恢复

计划：

- 使用 node-cron 的时区能力和经过验证的 cron 解析，删除当前不完整的手写日期推算。
- 保留 cron、interval、Run now、暂停和恢复。无效表达式和时区返回明确 4xx。
- 通过 AbortSignal 把取消传到 agent、provider、fetch 和 browser。取消完成后旧任务不能投递。
- 持久化排队状态、触发时间和幂等键。采用明确的 missed-run 规则：重启后每个 schedule 最多补跑一次，记录合并的错过触发。
- 单工作区只启用一个调度实例。启动检查阻止意外的第二调度实例。分布式调度保留为升级路径。

验收标准：

- R5.1：同一上海 9 点任务在 TZ=UTC 和 TZ=Asia/Shanghai 下计算出相同 UTC 触发时间。周任务及夏令时场景也有测试。
- R5.2：skip 不重复执行，queue 按持久化顺序运行，cancel_previous 阻止旧任务继续调用工具和投递。
- R5.3：重启后任务、队列和 nextRunAt 保留，不重复产生同一逻辑触发。
- R5.4：暂停后无新自动触发，恢复后按明确时间运行。定时和手动结果经过同一执行路径。
- R5.5：UI/API 的 nextRunAt、lastRunAt、触发原因与实际时间相符。

证据：跨时区运行日志、受控时钟测试、取消后的副作用检查、重启恢复记录。

手动验收：建一个短间隔任务，暂停和恢复，再取消一项正在采集的任务。

## R6：记忆、反馈与实践沉淀

计划：

- 让用户偏好、blocked topics、source weights 和反馈来自持久化状态。清空后不重新混入默认用户记忆。
- 保留 SQLite FTS 检索，并把相关知识及来源真正传入本次模型上下文。
- 从服务端推导写入主体和信任来源。外部内容只能成为待检查资料，不能写入系统规则。
- 建立实践候选、审核、评测、启用和回滚流程。候选包含原 run/反馈证据和版本。
- 实践启用前运行回归评测。失败则不启用；通过并获准后，后续 run 引用对应实践版本。
- 整理现有 CLI/TUI task 与 SQLite 内容任务的重复实现，迁移调用方并删除被替代路径。保留原有 CLI/TUI 能力。

验收标准：

- R6.1：保存或不感兴趣后，同一组候选的下一次排序出现可解释变化。重复反馈不重复计权。
- R6.2：检索命中能追溯到 memory entry、来源和实际模型输入。无命中如实显示为空。
- R6.3：外部提示注入不能获得系统信任或直接启用实践。用户可以导出与清空自身记忆。
- R6.4：一项带证据的实践经审核和 eval 后影响下一次 run；回滚恢复旧版本；失败候选不生效。
- R6.5：Dashboard API 与 task 命令读取同一内容任务状态，迁移后的兼容命令通过行为检查。

证据：固定候选集的前后排序、检索上下文、实践版本与激活记录、注入拒绝测试。

手动验收：反馈一条内容，重跑查看排序；审核一条实践，查看下一次 run 使用的版本。

## R7：真实指标、trace 与 heartbeat

计划：

- 删除固定的 latency、tokens、cost 和伪造通过状态。无测量结果返回 unknown 或 not_run。
- 用实际开始与结束时间记录 span。traceId 与 spanId 使用符合 OTel 格式的标识，并保留父子关系。
- tokens 读取 provider usage；成本按明确版本的价格配置计算并标记估算属性。缺少 usage 或价格时显示未知。
- 分别计算 run 延迟和工具延迟的分位数，标记统计窗口和样本数。
- 在调用前检查预算、步数和 token 上限，并在结束后核对实际用量。超出运行期限会实际中止执行。
- 记录 worker heartbeat，初始间隔 30 秒、stale 阈值 90 秒，均可配置。包括 workerId、活跃 run 和调度状态。
- 区分进程存活、数据库就绪和 worker 状态，明确记录 stale、失败和恢复。采集运行日志、错误告警和数据保留策略。

验收标准：

- R7.1：没有调用模型的运行不会报告付费模型 usage。真实调用的 usage 与 provider 响应一致。
- R7.2：每个工具/模型调用有实际时长、状态和错误。取消及来源失败不被投影为成功 span。
- R7.3：空数据库不显示 eval passed 或未经验证的 sandbox enabled。生产页面不混入 demo 数据。
- R7.4：触发预算和超时后，后续昂贵调用确实停止。降级原因及已发生费用仍可查询。
- R7.5：停止 heartbeat 后显示 stale，恢复后显示 fresh。健康检查不通过时 readiness 返回 503，且不写入 demo。

证据：provider usage 对照、trace 导出、已知延迟样本的分位数检查、budget/timeout 中止记录、heartbeat 故障恢复记录。

手动验收：查看真实 run 成本与工具耗时，触发低预算运行，再停止 worker 检查 stale 状态。

## R8：完整 Dashboard 操作流程

计划：

- 用原定 React、Tailwind 和 TanStack Query 实现原 Phase 4 的全部页面。定义导航、详情和返回路径。
- 保留 Cockpit、Runs、Run detail/trace、Scheduler、Content pipeline、Inbox/delivery、Memory、Evals、Security 和 Settings。
- 接入创建与编辑任务、来源配置、历史 run、反馈、记忆检索/导出/清空、审批和非敏感设置。
- SSE 使用事件 ID 与重连游标。新事件增量更新 UI，不每秒重发整批历史事件。
- 给加载、空结果、来源失败、取消、权限不足和 API 断线提供可操作状态。
- 区分 viewer 与 operator，展示实际能力。密钥只允许写入，不回显。

验收标准：

- R8.1：用户通过 UI 完成登录、建任务、设来源、Run now、查 trace、反馈、重跑和查看偏好变化。
- R8.2：用户能查看历史运行、创建日程、修改时区、暂停/恢复、取消运行，并查看准确结果。
- R8.3：用户能读取真实 eval 报告、处理有权限的审批、导出/清空记忆和修改非敏感设置。
- R8.4：桌面 1440x1000 与移动端 390x844 的关键流程都能操作，无页面级横向溢出和控件遮挡。
- R8.5：Playwright 实际点击并断言 API/数据库结果。SSE 断线重连后无事件重复或丢失。截图仅作为视觉证据。

证据：浏览器行为测试、桌面/移动截图、Playwright trace、关联 API 和数据库状态。

手动验收：从空工作区开始，完整执行 R8.1，再以 viewer 登录确认只读体验。

## R9：能拦住坏结果的 harness

计划：

- 汇总 R1 到 R8 的回归案例。每个案例绑定需求、输入、预期输出、失败条件和证据来源。
- 保留 runtime replay、overlap、dedupe、feedback、tool order、memory poisoning、prompt injection、secret redaction、budget 等既定 eval。
- 加入行为故障注入，验证取消失效、allowlist 绕过、固定 usage、重复投递和虚假通过等坏行为确实触发失败。
- 将报告写入被测环境的数据库，关联 commit、dataset/prompt/policy 版本、runId、spanId 与 eventId。CI 的临时数据库报告不冒充线上环境结果。
- 运行 real browser 测试和单独的 DeepSeek live gate。普通 CI 使用受控 provider，不消耗真实 key。

验收标准：

- R9.1：未产生报告时，界面显示 not_run。失败报告可追到本次输入、调用和结果。未执行 live gate 必须显示 skipped 或未验证。
- R9.2：上述故障注入分别导致相应验收失败。用真实行为证明检查有效，不以 bundle 中出现词语作为功能通过依据。
- R9.3：完整 `check`、`build`、`check:package-boundaries`、`dashboard:build`、`test`、`eval` 通过，新增浏览器行为 gate 通过。
- R9.4：所有核心模块均有对应 eval；真实 DeepSeek 和 browser 验收有独立结果，不能用 mock 通过替代。
- R9.5：报告和构建证据记录确切 SHA。验收之后代码若变化，相关 gate 重新运行。

证据：需求到测试矩阵、故障注入失败报告、修复后报告、CI 产物、对应数据库报告。

手动验收：打开一份刻意失败的报告，按关联 ID 找到失败工具调用和输出，再查看修复后的报告。

## R10：发布与云端验收

计划：

- 使用已通过 R1 的镜像构建路径，补齐生产配置、Playwright 运行依赖、资源限制、优雅关闭、备份和恢复流程。
- 统一域名与 TLS，UI/API/SSE 同源访问。确认请求身份和审批不能被直连 API 绕过。
- 将 SQLite 挂到持久磁盘。发布前备份，迁移后校验，保留上一版可运行镜像和回滚说明。
- 部署单实例受邀试用环境，配置实际 secret、预算和允许来源。禁止静默使用 mock。
- 运行容器和云端用户流程、故障恢复、告警、备份恢复及成本限制验收。
- 更新 README、架构说明、质量记录和发布检查表，保留明确的已知限制。

验收标准：

- R10.1：干净环境实际构建并启动生产容器。UI、API、SSE、认证、真实模型和浏览器工具共同工作，health/readiness 均符合预期。
- R10.2：在受控云域名上完成 R8.1 的完整用户流程。容器重启后任务、结果、记忆和审批记录仍可查询。
- R10.3：模拟模型失败、来源超时、worker stale 后可以诊断和恢复，出现预期告警，运行预算生效。
- R10.4：数据库备份能恢复到独立实例，校验历史 run 与记忆。上一版镜像/数据库的回滚步骤经过演练。
- R10.5：所有原 Phase 的要求均在覆盖表中有当前证据。目标架构无未关闭 P1，所有剩余限制明确记录并不阻断原 AC。

证据：镜像 digest、CPU 架构、发布 SHA、真实部署 URL、容器健康记录、live run/eval、备份恢复与回滚记录。

手动验收：从另一台设备登录云端，创建任务、运行、反馈、查看 trace；重启服务后复查数据与下一次调度。

Docker 不可用、云平台未选定、没有真实 key 或 live 检查未执行时，保留未验证状态。不得以静态文件检查代替 R10。

## 发布前必须覆盖的原要求

| 原要求 | 整改与验证位置 |
| --- | --- |
| 旧产物清理、包边界、依赖完整 | R1、R3、R6 |
| SQLite/Drizzle schema、migration、append-only events、replay | R3 |
| Fastify API、schema、SSE、错误与脱敏 | R2、R3、R4、R7、R8 |
| 全部 Dashboard 页面及移动端 | R8 |
| cron、interval、manual、pause/resume、三种 overlap policy | R5 |
| mock、RSS、URL、browser 与完整内容流程 | R2、R3、R4 |
| 来源失败容忍、去重、排序、来源与结果证据 | R3、R4、R6 |
| memory、feedback、FTS、write guard、export/clear | R2、R6、R8 |
| 带证据的实践沉淀与后续使用 | R6、R9 |
| 核心 eval 数据集、DB report、失败追踪 | R9 |
| 真实 trace、cost、tokens、latency、error、budget | R4、R7 |
| heartbeat、monitoring 与故障恢复 | R7、R10 |
| 环境配置、secret、registry、allowlist、approval、audit | R1、R2、R7、R10 |
| Docker、health/readiness、CI、fresh clone、部署就绪 | R1、R9、R10 |

每次关闭原 Phase 时，把该 Phase 的每条原始 AC 展开到阶段证据里逐项核对。上表仅做导航，不替代逐条验收。

## 验收命令与证据管理

现有完整回归命令仍保留：

```bash
npm ci
npm run check
npm run build
npm run check:package-boundaries
npm run dashboard:build
npm run test
npm run eval
```

R1、R8、R9、R10 将补充干净环境、浏览器和容器验收入口。它们在本计划编写时尚未实现，不能记录为已经通过。

阶段摘要放在 `docs/evidence/`，记录实际命令、退出码、预期与观察结果。日志、截图、数据库和浏览器 trace 放在隔离的输出目录或 CI artifacts，并设置保留周期。真实 secret 不进入任何证据。

每批次独立提交。推送后核对远程 SHA。只有所有原 AC、R1 到 R10 和实际部署证据齐全，才把 0008/0009 移到 completed 并声明项目完成。

## 实施参考

以下资料用于确定实现和验收方法。具体版本以 lockfile 和实现时核对的 API 为准。

- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)：用于 lockfile 驱动的干净安装。
- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)：分开编译依赖和运行镜像。
- [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)：在每次请求和执行入口验证权限，默认拒绝。
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)：校验网络目的地址和重定向，并结合网络限制。
- [node-cron scheduling options](https://www.nodecron.com/scheduling-options.html)：核对时区和 overlap 行为，不能假设新版本 API 已存在于当前 lockfile。
- [Playwright assertions](https://playwright.dev/docs/test-assertions)：通过浏览器操作和结果断言验收用户流程。
- [OpenTelemetry trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)：校对 trace 标识、父子关系、时长和状态。
