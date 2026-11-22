# M1 验收记录 — 一根针

日期：2026-11-22（M1 计划窗口 11-25 ~ 11-29，提前完成）
仓库：`D:\Conveyor` · 官方只读副本：`D:\OpenAgenticWeb` @ `f154be8f`

M1 的目标只有一句话：**在真浏览器里跑通一笔跨站交易**，披萨站的访客同意运费后，跑腿站在
自己的窗口里收下这一单，姓名电话地址不经过任何 agent。这份文档记录它是否真的做到了。

---

## 1. 拓扑

| 站点 | 打开地址 | 网络名 | 角色 |
| --- | --- | --- | --- |
| 披萨站 | `http://127.0.0.1:8084` | `little_oven_pizza` | 调用方 |
| 跑腿站 | `http://localhost:8085` | `courier_dispatch` | 被调方 |
| 跑腿接单口 | `http://127.0.0.1:8086` | — | Worker（本地 Node 入口，内存 store） |

两站刻意用不同主机名。loopback 上 runtime 会把 BYOK key 写进按主机名生效的 cookie，
同主机名的 partner 会连同请求拿到那把 key。

---

## 2. 构建

| 站点 | 命令 | 结果 |
| --- | --- | --- |
| 跑腿站 | `build_network.mjs courier_dispatch.hocon --manifest agent-manifest.json` | **exit 0，0 error，0 warning** |
| 披萨站 | 同上（`little_oven_pizza`） | **exit 0，0 error，1 warning** |

跑腿站 front agent 指令 3808 字符（runtime 另加 1612 CRUSE 上下文）。
披萨站 4740 字符。

披萨站那条 warning 是上游 bug，不是本站问题：

```
WARNING: partner_rules differs from templates/network.hocon.
```

根因是 `build_network.mjs` 对站点 HOCON 做了 `\r\n → \n` 归一化、对模板没有做，
Windows checkout（`core.autocrlf=true`）下必然不一致。已提交
[issue #70](https://github.com/cognizant-ai-labs/agentic-web/issues/70)，
详见 `docs/upstream-issues.md` 与 `docs/m0-baseline.md` §1。

跑腿站不调用任何 partner，因此没有 `partner_rules`，天然不触发这条 warning。

原始输出：`docs/raw-m1-build-courier.txt`、`docs/raw-m1-build-pizza.txt`。

---

## 3. 测试

| 套件 | 结果 |
| --- | --- |
| `pizza-site/tests/*.test.mjs` | **31 tests / 31 pass / 0 fail** |
| `courier-site/tests/*.test.mjs` | **30 tests / 30 pass / 0 fail** |

跑腿站 30 项 = 页面与网络 20 项 + 接单口 10 项。

披萨站为接第三个 partner 改了一处测试：`PARTNERS` 表增加 `courier_dispatch`，
并把「指令里必须写 `ask <name> what it offers and how to book`」改成每个 partner 自带
`ask` 短语——跑腿站共享的是写，它的 How to work 行说的是「先报价、同意后再派单」，
不是「问它有什么、怎么订」。这是契约差异，不是放宽断言。

跑腿站测试覆盖（`tests/agentified.test.mjs`）：

- 网络通过 runtime 校验；grounding 规则未被删改；**不调用 partner 因此不得带 partner_rules**；
  peer policy 保持 closed；首句点明「parcel runs」（caller 只能学到这一句）。
- `agentTools` 每个名字要么页面注册为 local-only，要么只由 bridge 共享；
  页面**不得**注册 `confirm_dispatch`（否则它会在本页无弹窗执行）。
- 单次模型调用的系统提示 + 工具定义在 16000 字符预算内。
- 读动作返回完整费率表、规则、今日日期与每条页面事实及其 href；**不改页面、不移焦点**；
  返回的是副本，改它不影响页面。
- 7 组报价逐一对手算金额：harbor/small/1 与 /2 = $3.00；north/medium/2 = $6.50、
  /3 = $7.00、/6 = $8.50；old_town/large/3 = $10.50、/12 = $15.00。
  报价有效期恰为 15 分钟。每组都比对整页快照。
- 拒单：outside 区域、small 装 5 件、medium 装 7 件；itemCount 0 被 schema 挡在站点之外，
  同时站点自身规则也拒（页面表单没有 schema）。
- 查单：读得到事件、拒未知单号、**拒真实单号的前缀**（近似匹配不得命中）。
- 取消对话框：措辞、每条详情与手算金额一致、只有 confirm 按钮确认、decline 与 Esc 都不确认；
  对话框本身不执行动作。
- 三种拒绝各自不开对话框：未知单号、已 picked_up、expectedStatus 过期。
- 批准后的取消与页面自己的取消表单落同样的记录；只有状态与事件增加，费用件数不变。
- 过期 expectedStatus（更新与更旧）由操作本身返回 ok:false 且不改任何东西。
- 无确认回调时不可逆工具根本不提供；从「本可成功」的状态 decline，记录逐字段不变。
- bridge 只共享 4 个动作、callerOrigins 精确到披萨站、写在窗口内确认、
  **入参不含 customerName/phone/address/email/note**，且**不共享 cancel_job**。
- 用一条姓名电话地址备注全填的真实记录，扫描所有读结果 / 拒单 / 对话框，
  连每个长词都不出现；同时确认 store 里确实存着它们。
- partner 同名动作走 runtime 对话框；捆绑表单什么都不跑；
  consent 卡等待时取焦点、答完还给聊天；访客在页面表单里打字时不抢焦点。

接单口测试（`tests/worker.test.mjs`）：

- CORS 白名单只有两个 origin，各自回自己的 origin（**从不回 `*`**）；
  陌生 origin 403 且无 CORS 头；OPTIONS 预检同样判定。
- 报价 $7.00 / 22 min / 15 分钟有效期。
- **同一幂等键三次调用（第三次故意换姓名地址）→ 同一 jobId，store 里只有 1 单，
  且首位访客的姓名未被覆盖**；不同键才是新的一单。
- 两个写入者并发同键 → 同一 jobId，只有一个拿到 201。
- `/api/dispatch/check` 只读：正确报价 200；错金额 409 `quote_changed` 并回 currentFeeCents；
  包裹不符 409 `quote_mismatch`；未知报价 422；过期 410。**全过程 store 无单**。
- 派单拒绝矩阵：错金额 / 包裹不符 / 未知报价 / 空键 / 电话不足位 / 空姓名 / 空地址 / 过期，
  状态码与 code 逐一核对，且不留残单。
- 收据、查单、列表三处公开输出都不含姓名电话地址备注；store 里存的是 trim 后的值。
- 状态只能前进一步；picked_up 后不可取消；过期 expectedStatus 409；未知单号 404。
- **D1Store 用带 UNIQUE 语义的 D1 替身实测**：同键第二次 putJob 回到第一单，
  第二个 jobId 根本不存在。

原始输出：`docs/raw-m1-test-pizza.txt`、`docs/raw-m1-test-courier.txt`。

---

## 4. 连通检查（官方要求的三次）

官方 SKILL.md 第 7 步要求：对每个 partner 用 `--origin` 跑一次，再对本站自己的网络 URL
不带 `--origin` 跑一次。披萨站调用跑腿站，跑腿站不调用任何 partner，因此共三次：

```
node check_partner.mjs http://localhost:8085/courier_dispatch --origin http://127.0.0.1:8084
node check_partner.mjs http://localhost:8085/courier_dispatch
node check_partner.mjs http://127.0.0.1:8084/little_oven_pizza
```

三次均 **OK / exit 0**，七个公开文件全部 200，bridge 模块被正确识别。
原始输出：`docs/raw-m1-check-courier.txt`、`docs/raw-m1-check-courier-callers.txt`、
`docs/raw-m1-check-pizza-callers.txt`。

---

## 5. 真浏览器闭环（M1 的命门）

Chrome，无 LLM key。用官方 `references/bundle_and_hosting.md` 的「Check without a key」
思路，在披萨站页面主世界注入脚本，直接驱动 runtime 的 action registry —— 走的是与模型
调用完全相同的跨域 bridge 通路，只是把「模型决定调用」换成「脚本决定调用」。

> 注：`bu.js()` 运行在隔离世界，读不到 `window.__nsweb`。改为向页面注入 `<script>`
> 在主世界执行，结果写回隐藏 DOM 节点再读出。

### 5.1 跨域拿到共享动作

披萨站页面 `registerRemoteActions` 加载跑腿站 bridge 后，目录恰为：

| 动作 | effect | availability |
| --- | --- | --- |
| `get_dispatch_state` | read | bridge |
| `request_quote` | read | bridge |
| `lookup_job` | read | bridge |
| `confirm_dispatch` | irreversible | bridge |

`cancel_job` **不在其中**——被调方的取消留在自己页面。

### 5.2 跨站只读

`get_dispatch_state` 在跑腿站隐藏 frame 里 `fetch` 自己的 HTML 并用 DOMParser 解析，
返回的是**真实页面文案**（不是测试替身）：

- zones：`harbor:$3.00 / north:$4.50 / old_town:$5.50 / outside:$0.00`
- cancellation / service / contact 三条原文，phone = `tel:555-0170`

这正是官方要求「只能在浏览器里验」的那一项。

`request_quote`（north / medium / 3）→ `Q-308358ee…`，**$7.00 / 22 min**，
basis 拆得出 450 + 200 + 50。报价来自 8086 的真实接单口。

### 5.3 跨站写：在跑腿站自己的窗口确认

触发 `confirm_dispatch` 后，披萨站聊天里出现 runtime 的提示卡：

> **Conveyor Courier Assistant** will open its own window, so you can check and finish this there.
> Opens on `localhost:8085`
> [Open Conveyor Courier Assistant] [Cancel]

点 Open → 新窗口 URL 为 **`http://localhost:8085/bridge/action-bridge.html`**，
即被调方自己的 origin。窗口内容：

- 抬头写明「The assistant on **127.0.0.1:8084** asked us to run this delivery for you.
  Type your details here, not in the chat.」
- North town / Medium box / 3 items / **$7.00** / 22 min / 报价有效期 / 包裹摘要 / 对方单号
- 四个输入框：收件人、电话、地址、备注

**先验拒绝**：电话填 `555` → 点 Send → 窗口内 phone 字段下出现
「Give a phone number with 7 to 15 digits.」，其余字段无错，**未落单**。
这是跑腿站自己的规则在自己窗口里生效。

**再验成交**：电话改 `+1 (555) 010-2233`，姓名 `  Sam Lee  `，地址 `  12 Harbor Rd, North town  `，
备注 `Ring twice` → Send → 窗口关闭，披萨站拿到回执：

```json
{"status":"succeeded","result":{"ok":true,
 "jobId":"J-fbf2be73-9539-42c4-a923-fd9d0af08e34","status":"assigned",
 "dropZone":"north","parcelSize":"medium","itemCount":3,
 "feeCents":700,"feeText":"$7.00","etaMinutes":22,"replayed":false}}
```

**回执里没有姓名、电话、地址、备注。**

### 5.4 反向只读

披萨站调 `lookup_job` → 同一单，status assigned，events 有一条 assigned，
同样不含任何个人字段。

### 5.5 幂等重放（真浏览器）

用**同一张报价**再次 `confirm_dispatch`，窗口里故意填**不同的人**
（`Someone Else Entirely` / `555-0199` / `9 Other Road`）→ 回执：

```json
{"ok":true,"jobId":"J-fbf2be73-9539-42c4-a923-fd9d0af08e34","replayed":true}
```**同一单**。接单口列表仍只有 2 单（真实单 + demo 单）。

### 5.6 拒绝路径（真浏览器）

新报价 old_town / large / 5 → **$11.50 / 31 min** → 开窗 → 点 **Keep it with them** → 回执：

```json
{"ok":false,"reason":"The visitor declined in the courier's own window. No job was accepted."}
```

接单口列表仍为 2 单，**没有残单**。

### 5.7 隐私扫描（服务端）

对 `GET /api/jobs/:id` 与 `GET /api/jobs` 的完整 JSON 扫描
`Sam Lee` / `010-2233` / `12 Harbor Rd` / `Ring twice` —— **四项全部 clean**。

### 5.8 跑腿站独立可用

不依赖 assistant，页面自己的表单全部实测：

- 报价 old_town / large / 12 → **$15.00 / 31 min**（与手算 550+450+500 一致）
- Refresh the desk → 列出跨站落的那一单与 demo 单
- 查 `J-DEMO-1` → assigned / $3.00
- 取消表单填过期状态 `delivered` → 页面报
  「That job is now assigned, not delivered. Read it again before cancelling.」
- 改回 `assigned` → 取消成功，列表变 cancelled，**旧错误提示被清掉**

### 5.9 站点自己的确认对话框（真浏览器）

用 `engine.onActionConfirm` 打开 `cancel_job` 的对话框，实际渲染出：

> **Cancel this job?**
> We will cancel this job on the desk. Nothing is charged, but the run stops and a new one would need a new dispatch.
> Job / Status / Delivery zone / Fee / Undoing it —— 五条详情取自接单口真实数据
> [Cancel the job] [Keep the job]

点 Keep the job → 返回 `false`，未改动。

截图：`docs/m1-courier-page.png`、`docs/m1-pizza-chat.png`。

---

## 6. 验收汇总

| 验收项 | 判定 |
| --- | --- |
| 两站 build 零 error | ✅ |
| 两站 build 零 warning | 跑腿站 ✅；披萨站 1 条上游 CRLF 假阳性（issue #70），已注明 |
| 两站 node --test 全绿 | ✅ 31 + 30 |
| check_partner 官方三次 | ✅ 三次 OK |
| bridge 只读跨站可用 | ✅ 含 DOMParser 页面事实 |
| **bridge 写在被调方自己窗口确认** | ✅ `localhost:8085/bridge/action-bridge.html` |
| **PII 不进 agent、不进回执** | ✅ 浏览器与服务端双重扫描 |
| **幂等：同键同单，重放不覆盖** | ✅ 单测 + 并发测 + D1 替身 + 真浏览器 |
| 拒绝路径无残单 | ✅ 窗口内校验拒绝 / 访客取消 两种 |
| 被调方页面独立可用 | ✅ |
| 单向流向（反向只读 job） | ✅ 不共享 cancel_job |

**M1 达成。**

---

## 7. 与施工清单的差异（以本文件与代码为准）

`docs/m1-construction.md` 是开工前写的，实现中有四处收敛：

1. bridge 只读报价的名字由 `get_quote` 改为 **`request_quote`**，与页面动作同名。
   官方 `templates/bridge/bridge-actions.js` 明确要求「give it the name of the page's own
   action, so the network's instructions fit both」。
2. bridge 另共享 **`get_dispatch_state`** 与 **`lookup_job`**：前者让调用方学到 zone/size
   枚举与规则，后者是文档里说的「反向只读 job_status」。
3. 接单口增加 **`POST /api/dispatch/check`**：写窗口在出表单前必须先跑站点自己的只读检查，
   没有这个端点就只能把规则复制一份到窗口里。
4. 新增 **`demo-job.js`** 与 `J-DEMO-1`：sample_queries 里有两条问 job 编号，
   官方要求这类查询必须指向站点文档里写明的 demo 记录。

另外两处结构决定：

- 新增 `desk-client.js`，页面 / bridge / 写窗口共用一个接单口客户端，避免三份 fetch 逻辑。
- 页面的 `request_quote` 与 `lookup_job` **只更新数据不渲染**，渲染留在页面自己的
  handler 里。官方 `site_actions.md` 规定「只替换结果面板的动作也算 write」，
  而这两个必须是 read（partner 报价不该弹窗）。

---

## 8. 尚未做的事

- **未用真实 LLM key 跑过一遍自然语言对话。** 上面所有闭环走的是 runtime 的真实通路，
  但「模型是否遵守 partner_rules」只有真 key 才能验（官方 linking.md 明说）。
  待 Otari 免费额度确认后补。
- D1 `database_id` 仍是占位符，M3 部署时填。M1 用本地 Node 入口，规则与 D1 完全同形，
  且 D1Store 的幂等已用替身实测。
- 未部署到 Cloudflare Pages / Workers。
