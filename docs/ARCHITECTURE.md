# 架构

## 设计原则

**模型只做判断，确定性的事全由脚手架兜底。** 具体到这个项目：

- 模型做的：读 JD 给出三项审核结论；按事实卡写开场白。
- 脚手架做的：决定能不能读、能不能发、发几条、间隔多久；验证开场白是否越界；记住发过谁；出事就停。

判断的边界画在"能不能被确定性地检查"上。能写成正则或计数的，就写成正则或计数，不留给模型。

## 分层

```
boss.js            CLI 组装、命令表、ONLINE_COMMANDS 集合（在线命令前置锁检查）
├─ safety.js       预算/锁/节流。所有在线动作调用 reserveAction() 才能继续
├─ ledger-store.js 台账读写：写锁文件 + 临时文件原子替换 + updatedAt 乐观并发
├─ reins-config.js 个人化配置唯一入口，真实文件 > example 回退
├─ job-domain.js   岗位归一化、预筛、去重（encryptBossId 为主键）、远程判断
├─ jd-domain.js    JD 解析、哈希、审核完整性、队列拒绝原因
├─ project-scoring.js 离线粗筛 v7：交付物 + 合作依据 + 无到岗
├─ opener-service.js 门禁 + 提示词 + 本机模型调用 + 拒绝回喂重写
├─ dispatch.js     批量生成 / 计划文件 / 执行器 / 发送计数
├─ outreach-commands.js 单条发送、送达核验、审核、公司登记
├─ discovery-commands.js 搜索、推荐流、收藏，一条命令只推进一页
├─ page-flows.js   JD 页等待、聊天页就绪、失效跳转
├─ browser.js / browser-cli.js 语义快照、页面能力矩阵、通用浏览器命令（含危险动作拦截）
├─ cdp.js          裸 CDP：Node 原生 WebSocket + HTTP /json + Runtime.evaluate
└─ self-test.js    离线回归
```

底层模块不得反向加载 `boss.js`。页面层不解释岗位业务，领域层不连接浏览器，台账层不判断岗位状态。

## 关键机制

### 三层闸门（safety.js）

`reserveAction(kind, detail, file, alsoCount)` 在每个在线动作前执行：

1. 24 小时滚动窗口内该类动作是否触到平台硬顶 → 触到就写熔断锁并抛安全异常
2. 是否用完作业额度 → 用完就拒绝
3. 10 分钟窗口内是否超突发上限 → 超了就拒绝
4. 距上次任何动作是否满最小间隔 → 不满就随机等待（间隔到间隔的 1.5 倍）
5. 通过后把事件追加到 `data/budget.<端口>.json`

发送会连带计一次岗位详情，因为发送前要加载 JD 页，平台那边照样算。多账号按 CDP 端口分文件，互不占额度。

### 熔断锁（safety.js）

`data/lock.<端口>.json`。写锁的触发：安全验证页、403、`code=32/36/37`、账户异常、连续空白 JD、触到硬顶、preflight 发现异常页。

`ONLINE_COMMANDS` 集合里的命令在进入前先 `assertNotLocked()`；离线命令（`jd`、`list`、`preflight`、`self-test`）不受锁影响，所以锁定期间仍能审核和写材料。风控级锁（正则 `SEVERE_LOCK_RE`）当天拒绝解锁，最早满 24 小时且跨自然日。

### 台账并发（ledger-store.js）

单文件 JSON。写入流程：拿写锁文件（`wx` 独占创建，5 分钟过期自动清理）→ 比较 `updatedAt` 与加载时快照，不一致就拒绝写入 → 写临时文件 → `rename` 原子替换。这样两条命令同时跑不会互相覆盖，`dispatch` 每条发完重新加载也不会读到半截文件。

### 事实门禁（opener-service.js）

顺序：`validateOpener`（链接白名单、长度粗检、未确认经历、AI 感）→ `assertOpenerFits`（远程/结算问句）→ `openerLengthReason`（120–200）→ `factAnchorReason`（未确认技术名、禁写数字、事实锚点、通用问句）→ `openerRepetitionReason`（同日问句/开头/锚点限频）。

所有具体的词表来自 `reins.config.json`，代码里没有任何项目名。锚点限频按「当日总数 ÷ 项目数」动态算，下限 5，避免一天发 100 条时固定额度卡死。

生成走 `generateOpener`：提示词只喂事实卡命中那一行的项目细节（不是整份事实文件，小模型拿到整份会挑最顺手的数字），被拒一次把原因喂回去重写一次。

### 计划与执行（dispatch.js）

- `ai-opener --batch`：遍历"审核通过但无当前开场白"队列，逐条生成、逐条 `saveLedger`。当天失败过的默认跳过。末尾打印拒绝原因直方图。
- `send-plan`：遍历"材料就绪"队列，每条重过 `planRejectReason`（等价于 `ai-send --use-saved` 的全部门禁），写入 `{jobId, jdHash, openerHash, bossId, status:'pending'}`。条数按 24 小时剩余发送额度截断。
- `dispatch`：逐条 `assertNotLocked` → 重新加载台账 → `recheckItem`（JD 哈希、开场白哈希、门禁）→ 等突发窗口 → `sendWithAutomaticVerification` → 按台账里的 `outreach.status` 记录结果 → 每条写回计划文件。停机条件：锁被写入、错误信息匹配 `HALT_RE`（额度/突发/硬顶/安全验证/CDP 不可达）、连续失败 ≥3。重跑同一文件只处理 `pending` 项。

### 送达核验（delivery-verification.js / outreach-commands.js）

发送成功的定义是三件事同时成立：输入框清空、完整消息属于本人气泡、该气泡显示"送达/已读"。缺一记 `delivery_unverified`，自动走一次 `verify-delivery` 打开精确会话复核，仍不确认就停在 `unverified`，永不重发。

### 去重（job-domain.js）

一个招聘者全局只发一次。主键是 BOSS 的 `encryptBossId`，岗位 ID、公司名、显示名只做辅助。会话去重读虚拟列表完整数据源而不是当前屏幕渲染的几十条（早期重复招呼的根因）。

### 回归（self-test.js）

- 两份真实成交的 JD（已脱敏）作为筛选规则的回归基线：任何一版 `project-scoring` 把它们判成不可发送，测试就失败。
- 门禁回归：套话、顿号串、分号、禁写数字、未确认技术名、通用问句、同日重复、长度。
- 计划/执行器：JD 哈希变化、开场白被改、额度截断、跳过记录不计入发送数。
- 安全：安全页正则的误报回归（BOSS 静默通过安全复核后仍把参数留在 URL 上）、锁文件、风控级锁当天拒解。
- 启动脚本编码：BAT 保持 ASCII + CRLF，PS1 带 UTF-8 BOM。

## 浏览器层

Playwright 的 `connect_over_cdp` 在 BOSS 会被反自动化弹成 about:blank，所以用裸 CDP：Node 原生 WebSocket 连 `/json` 列出的目标，全部操作走 `Runtime.evaluate`，导航用 `location.href`。

浏览器是复制了默认 profile 的独立 user-data-dir 加 `--remote-debugging-port`，默认起在一个独立 Windows 桌面对象上：窗口真实存在、可渲染可截图，但不画在主桌面、不占任务栏、不抢焦点。代价是只能经 CDP 操作，`MainWindowHandle` 恒为 0。

页面就绪用语义快照判断：岗位卡片、JD 正文、聊天输入框这些业务元素真实出现才算就绪，`document.readyState` 不算。`browser-click` 等通用命令对"发送/保存/提交/删除"类按钮强制 `--allow-action`，先 `--dry-run` 返回真实目标。

## 上下文纪律

这套东西是给会被压缩上下文的模型用的，所以：

- 每个 JD 只读一遍，判完就丢；复看用离线 `jd <id>`，不重新联网
- `preflight` 一条命令给出全部状态，不要四条命令热身
- 队列命令默认压缩输出，`--limit/--grep/--queue` 把筛选留在命令里
- 台账文件禁止直接读
