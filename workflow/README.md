# workflow 代码入口

对外唯一命令保持不变：`node workflow/boss.js <命令>`。`boss.js` 现在只保留启动、命令注册和少量跨域编排；具体实现按业务边界放在独立模块中。

## 查问题时从哪里进入

| 问题类型 | 首要文件 |
| --- | --- |
| 命令不存在、帮助错误、启动失败 | `boss.js`、`command-help.js` |
| CDP 连接、标签、导航、等待 | `cdp.js` |
| 页面路由、控件解析、通用浏览器命令 | `browser.js`、`browser-cli.js` |
| 收藏、推荐、搜索、公司岗位与分页断点 | `discovery-commands.js` |
| JD 页面等待、聊天页就绪、失效跳转 | `page-flows.js` |
| 岗位归一化、筛选、去重、远程判断 | `job-domain.js` |
| 项目客户粗筛（v7，两单成交 JD 为回归基准）、信息完整度排序 | `project-scoring.js` |
| 批量写开场白、发送计划文件、逐条执行器、发送计数 | `dispatch.js` |
| JD 解析、哈希、审核完整性 | `jd-domain.js` |
| 开场白生成与发送资格 | `opener-service.js` |
| 首次发送、送达复核、回复、简历发送 | `outreach-commands.js` |
| 送达证据表达式与结果归一化 | `delivery-verification.js` |
| 会话分类与简历触发 | `conversation-domain.js` |
| 会话工作台聚合 | `conversation-workbench.js` |
| 台账加载、写锁、原子替换 | `ledger-store.js` |
| 熔断、额度、节流 | `safety.js` |
| 旧数据迁移和离线校验 | `maintenance.js` |
| 离线自检 | `self-test.js` |

## 依赖方向

```text
boss.js (CLI 组装与跨域编排)
├─ discovery-commands.js ── job-domain.js / page-flows.js
├─ outreach-commands.js ─── opener-service.js / delivery-verification.js
├─ browser-cli.js ───────── browser.js ── cdp.js
├─ conversation-workbench.js ── conversation-domain.js
├─ dispatch.js ──────────── opener-service.js / outreach-commands.js（延迟加载）/ safety.js
├─ maintenance.js / self-test.js
└─ safety.js / ledger-store.js / cli-args.js / daily-options.js
```

底层模块不得反向加载 `boss.js`。页面层不解释岗位业务，领域层不连接浏览器，台账存储层不判断岗位状态。新增命令时优先放入对应业务模块，只在 `boss.js` 命令表注册。

## 当前主入口保留内容

主入口仍保留 `preflight`、回复/互动同步、在线 JD 读取、岗位/会话工作台、队列选择和最终命令表。这些函数共同承担跨模块编排，继续拆分只有在形成新的清晰业务块时才有价值；不要为了文件更短引入工厂层或空壳包装。

手工回复正文边界检查（离线，不连接 BOSS）：`node workflow/conversation-reply-test.js`。
