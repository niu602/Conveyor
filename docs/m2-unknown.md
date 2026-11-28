# M2-② 收尾：工具项持久化、幂等键定稿、unknown 三态

日期：2026-11-28（北京时间）
模型：`deepseek-v4.1-flash-1017` @ `https://discovery-api.intern-ai.org.cn/v1`（BYOK 自定义 provider）
站点：披萨站 `http://127.0.0.1:8084` → 跑腿站 `http://localhost:8085`，接单口 `http://127.0.0.1:8086`
提交：`022a61e`（A4/A2/A1 代码与测试）+ 本次收尾提交（`--drill` 开关、演练截图、本文档）

本块把 unknown 从"读一次就下结论"升到行业三态：**recorded / absent / unknown 三者分开**，终态确认前不重新露出提交入口。

---

## 0. 覆盖度：每个分支证到了哪一层

| 分支 | 自动化用例 | 真浏览器 + 真接单口 + 真故障 | 真模型端到端 | 截图 |
| --- | --- | --- | --- | --- |
| `recorded` | 有 | 有（演练 A，套 A） | 有 | `m2-unknown-recorded.png` |
| `absent` | 有 | 有（演练 B，套 B / glm-4-plus） | 有 | `m2-unknown-absent.png` |
| `unknown` | 有（跑满 45s） | 有（演练 C，套 B / glm-4-plus） | 有 | `m2-unknown-unknown.png`、`m2-unknown-confirming.png` |
| 90 秒 composition 时限 | — | 有（partner 层，套 B / GLM-4.7-Flash） | 有 | `m2-unknown-deadline.png` |

**四个分支全部留证完毕。** 过程曲折，两段外部障碍与一次选型弯路都记在下面，不掩盖：

1. 2026-11-28 上午，intern-ai 的 key 返回 `LLM HTTP 429 {"code":"quota_exceeded"}`，两次不同 `trace_id`（`fb962d6b…`、`984bde54…`）均如此，连单跳问答也被拒。
2. 改用套 B（本地反代 → 智谱，见 §9）绕过配额。GLM-4.7-Flash 偶发 `1305` 限流且响应长尾极大，整轮跨站调用难以凑齐；换非思考档后又踩到"模型跟不上两跳协议"的坑（§9.3）。最终 **`glm-4-plus`** 稳定跑通，B/C 一轮成。

代码侧三态由 55 项用例覆盖，全绿；演练后磁盘 jobs 数不变，B/C 均未落单。

---

## 1. 三态契约（以代码为准）

文件：`courier-site/bridge/dispatch-window.js`

写失败后**永不重发写**，只按同一个键读回：

```js
try {
  done = await state.desk.dispatch({ ...state.request, idempotencyKey: key }, details);
} catch {
  await DispatchWindow.confirm(state, box, details, key);   // 只读核实
  return;
}
```

`confirmOutcome()` 的三种收尾严格分开：

| 读回结果 | 判定条件 | UI | 是否再露出提交入口 |
| --- | --- | --- | --- |
| `recorded` | `answer.recorded === true` | 展示收据，`settledBy:"read"`、`replayed:true` | 否（已成交） |
| `absent` | `answer.recorded === false` **连续两次** | "Nothing was recorded" | **是**，且仅当报价未过期；按钮文案改为 "Send this parcel again"，键不变 |
| `unknown` | 读失败 / `ok!==true` / `recorded` 不是布尔 / 45 秒预算耗尽 | "We could not confirm it" + 跑腿站 jobs 页链接 | **否** |

两条防御性判定值得单列：

- `typeof answer.recorded !== "boolean"` → 判 `unknown`，**不猜 absent**。body 没说清是否落单时猜"没落单"会诱发第二次发送。
- 读接口返回 refusal（`ok!==true`）→ 判 `unknown`，因为那是"这次读没settle"，不是"关于这单的答案"。

`absent` 且报价已过期 → 关窗并返回 `ok:false`，提示重新询价，不给重试。

---

## 2. 幂等键定稿

### 2.1 一处必须更正的前提

任务原文写"**金额移出键**"。实测 `git grep 'dispatch:' f0313f6` 全仓只有一处键构造：

```js
static keyFor(quoteId) { return `dispatch:${quoteId}`; }
```

**金额从来就不在键里**。本次真实变更是把 `pizzaOrderRef` 加进键：

```js
static keyFor(quoteId, pizzaOrderRef) {
  const ref = String(pizzaOrderRef || "").trim();
  return ref ? `dispatch:${ref}:${quoteId}` : `dispatch:${quoteId}`;
}
```

无订单号时退回 quote-only（非披萨伙伴寄件的情形）。键**站点侧确定性派生**：调用方不必存键也能重新算出来，重试自然指向同一笔交易。

### 2.2 金额改为同键参数比对

`CourierDesk.requestDigest(args)`：

```
[quoteId, pizzaOrderRef, dropZone, parcelSize, itemCount, expectedFeeCents ?? feeCents].join("|")
```

- 幂等行落 `requestDigest`；回放时比对 `existing.requestDigest || requestDigest(existing)`（老数据回退重算）。
- 不一致 → `{ok:false, code:"idempotency_conflict", field:"idempotencyKey", jobId, recordedFeeCents, reason}`，HTTP **409**，窗口走 `finishConflict` 终态，**不静默出第二单**。
- D1 侧：`schema.sql` 的 jobs 加 `request_digest TEXT NOT NULL DEFAULT ''`，`d1-store.js` INSERT 补第 4 位占位符（共 18 个），`jobOf` 带出 `requestDigest`。

**digest 故意不含收件人姓名/电话/地址**：改正一个电话号不该被当成另一笔交易。这是取舍，与支付宝的口径有分歧，见 §4.3。

### 2.3 重试窗口口径

TTL（报价 15 分钟）**只约束"新开一次尝试"**——即 absent 之后是否再露出发送入口；**不约束已落单 job 的同键回放**，回放永远返回首单。否则一条过期报价会把已成交的单变成"可以再发一次"，诱发重复。

---

## 3. 轮询节奏

```js
static POLL_DELAYS = [5000, 10000, 15000, 15000];
static ABSENT_READS = 2;
```

读发生在 t=0 / 5 / 15 / 30 / 45 秒，**共 5 读、45 秒预算**。`recorded` 立即停；`absent` 需连续两次（中间任何一次非 absent 都会把计数清零）；预算耗尽 → `unknown`。

`state.wait` 可注入，测试里记录延迟而不真睡，因此"跑满 45 秒"用例断言的是 `waits=[5000,10000,15000,15000]`。

---

## 4. 行业对标（三条断言均已逐字核实，出处按实际篇名挂）

### 4.1 微信支付：终态确认后才恢复入口

《接入易错点_小程序支付》原文：

> 支付返回后前端须调用商户查单接口确认订单状态，**只有拿到明确的成功或失败终态后才恢复按钮**或引导再次支付

同篇"典型反例"逐字列出：**"支付结果尚未确认就重新露出付款入口"**。这正是 A1 的硬约束。
来源：https://pay.weixin.qq.com/doc/v3/partner/4054257720

同篇还背书了 §2.3 的 TTL 口径：

> 对仍未支付的订单再次发起支付时**复用原商户订单号**与有效期内（如 15 分钟）的支付参数，超过有效期整单取消后再重建
> 服务端以业务订单为幂等粒度做防重复提交……**重复请求直接返回原支付参数，不再调用下单接口**

### 4.2 5 秒 / 10 秒 / 45 秒的真实出处是《付款码支付 V2》，不是《接入易错点》

> 当返回结果为"系统错误"时，商户系统**等待 5 秒**后调用【查询订单 API】……当返回结果为"USERPAYING"时，商户系统可设置间隔时间（**建议 10 秒**）重新查询支付结果，直到支付成功或**超时（建议 45 秒）**

来源：https://pay.weixin.qq.com/doc/v2/partner/4011941293
本项目的 `[5000,10000,15000,15000]` 是这个建议的一种实现（首读提前到 t=0，总预算仍是 45 秒）。

### 4.3 支付宝：Alipay+ 条码支付《最佳实践》"确保交易为终态"

> 当面付交易存在一个中间状态 `WAIT_BUYER_PAY`，和三个最终状态 `TRADE_SUCCESS`、`TRADE_FINISHED`、`TRADE_CLOSED`。**商户必须确保每笔交易都达到终态**

**它的节奏与微信不同**，必须分开写：交易创建 **5 秒后**开始查、**每 3–5 秒**一次、超时**如 60 秒**；且"若查询结果一直是 `WAIT_BUYER_PAY`，**必须调用撤销接口**将交易强制取消"。

同篇"幂等"段与 A2 语义同构：

> 商户交易号相同的交易视为同一笔交易……之后检查其它信息，**包括买家信息，交易金额等。若请求内其它信息同支付宝内部信息不一致，则会报错**。否则，支付宝返回该笔交易的真实状态。

来源：https://docs.alipayplus.com/alipayplus/alipayplus/barcode_cn/practice

**本项目与之的明写分歧**：支付宝连"买家信息"一起比对，本项目 digest 排除收件人姓名/电话/地址。理由是改联系方式不构成另一笔交易；Stripe 亦建议键与比对材料避开个人标识。

## 4.4 Stripe：键的派生方式与窗口

- 键保留 **"at least 24 hours"**，之后可能被清除；清除后复用会执行新请求。
- **"The idempotency layer compares incoming parameters to those of the original request and errors if they're not the same"**；错误类型 `idempotency_error`。
- 回放标识 `Idempotent-Replayed: true` —— 对应本项目的 `replayed:true`。
- **键派生方式直接背书本项目做法**："Derive the key from a user-attached object, like the ID of a shopping cart. This provides a relatively straightforward way to protect against double submissions."
- "Avoid using sensitive data (for example, email addresses or personal identifiers) as idempotency keys."
- 窗口外仍不明 → **"don't retry with either the old key or a new one"**，改为检索对象、用 webhook 对账 —— 对应本项目 unknown 分支指向 jobs 页 + 后续对账页兜底。

来源：https://docs.stripe.com/api/idempotent_requests 、https://stripe.com/docs/error-low-level

---

## 5. 对任务原文的四处偏离备案

1. **轮询走 `outcome(key)`，不是 `lookup_job`**。`site-actions.js` 的 `lookup_job` 把 `jobId` 列为必填，而 unknown 时手上只有键、没有单号，只能走 by-key 的 `/api/dispatch/outcome`。
2. **`absent` 需连续两读**（`ABSENT_READS=2`）。紧随丢失响应的一次读可能撞上仍在落地的写；"Nothing was recorded" 是对访客的断言，不能靠一次竞态读就下。
3. **TTL 只约束新尝试，不约束已落单回放**（§2.3），有微信原文背书。
4. **digest 排除收件人 PII**，与支付宝口径分歧（§4.3）。

### 5.1 一处不能过度对标的辨析：absent ≠ 中间态

微信说 `NOTPAY` 不得直接判失败、要先关单；支付宝说持续 `WAIT_BUYER_PAY` 必须撤销。**那两种都是"行已存在但处于中间态"**。

本项目接单口的写是**单行原子插入**，`absent` 的含义是"这个键下根本没有这行"，更接近 `TRADE_NOT_EXIST`，因此**不需要关单或撤销动作**。把 absent 直接类比成 NOTPAY/WAIT_BUYER_PAY 会得出错误的"必须补撤销接口"结论。

---

## 6. 演练证据

### 6.1 演练 A：`recorded`（真模型 + 真浏览器 + 真丢响应）—— 完成

接单口以 `--drill drop-response` 启动，日志逐字：

```
DRILL drop-response: desk answered 201, closing the socket without sending it.
```

即 **201 已生成、job 已落盘并 flush，响应被真实丢弃**。结果：

- 落单 `J-fca4dbd6-b3c8-41ae-9c24-970ef6a026e4`
- 键 `dispatch:DEMO-1795792674045:Q-955075f7-8400-4560-ae4d-cb34cc785006`（新格式生效）
- 磁盘上该键**恰一单**，无重复
- 披萨聊天最终仍拿到该单号 + $4.50 + assigned

截图：`m2-unknown-recorded.png`。

一处 runtime 限制：导出的 trace 只保留 `resultPreview`（约 200 字符），`settledBy` 字段被截断，故该字段无法从 trace 取证；上述链路以接单口日志 + 磁盘单数 + 聊天结果三方互证。

### 6.2 演练 B：`absent` —— 完成（套 B / glm-4-plus）

接单口以 `--drill fail-write` 启动，写窗口提交后日志逐字：

```
Drill armed: fail-write (one shot, on the next POST /api/dispatch)
DRILL fail-write: answered 503 before handling; nothing recorded.
```

窗口随后按同一个键读回两次，落到 absent 面板（`m2-unknown-absent.png`），文案逐字：

> **Nothing was recorded**
> The first send's answer was lost, so we checked the desk twice by the same reference: no job was recorded for it. Nothing was accepted and nothing was sent twice.
> The quote still holds, so you can send it again with the same reference. If the first send did reach the desk after all, you will get that same job back, not a second one.

原 form 被重新挂回、按钮文案变为 **"Send this parcel again"**、窗口不 resolve。**磁盘 jobs 数演练前后不变**，证明 503 那次确实没落库。

#### 6.2.1 前史：`reject-write` 为什么不可靠（保留为反面证据）

先前用 `--drill reject-write`（处理前断连）跑了两轮，日志均出现 `closing the socket before handling; nothing recorded.`，**但两轮磁盘上各多出一单**：

| 轮次 | 落单 | 键 |
| --- | --- | --- |
| B-1 | `J-64babb88-bb7e-493c-a70f-114e7c53e104` | `dispatch:DEMO-1795833808034:Q-a59fbc2e-7397-4a65-8c06-3a6e9ed46c7d` |
| B-2 | `J-e4493ae7-6406-4b5f-bc17-b003aed2ff3f` | `dispatch:DEMO-1795834058207:Q-defe25f8-65fd-45aa-b290-1a533a5a1a51` |

逐层排除（开关只匹配 POST `/api/dispatch`、窗口 catch 只读、`DeskClient.send` 单次 fetch、开关严格一次性）后，只剩传输层：**Chrome 会对"复用的 keep-alive 连接在收到任何响应字节前被重置"的 POST 透明重发**，一次性故障被第一次请求消耗，重发落在新连接上成交。

这条对生产同样成立，故新增 `fail-write`（真实 503，浏览器不重发，`DeskClient` 对 5xx 仍抛 `unknown`）。`reject-write` 保留用于演示重发现象本身。B-1 顺带证明：absent 后同键重发在真浏览器里只产生一单。

### 6.3 演练 C：`unknown` —— 完成（套 B / glm-4-plus）

**在写窗口已经打开、收件信息已填好之后**杀掉 8086（实测 `/api/health` 不可达），再点 "Send this parcel"。写失败 → 只读核实 → 5 读全失败 → 45 秒预算耗尽。

中途态（`m2-unknown-confirming.png`）逐字：

> **Confirming with the desk**
> Your answer was lost on the way back. We are checking whether the run was recorded, using the same reference. Nothing is being sent again.
> Check 3 of 5. Please keep this window open.

终态（`m2-unknown-unknown.png`）逐字：

> **We could not confirm it**
> The first send's answer was lost, and checking the desk for 45 seconds did not settle whether the job was accepted. Nothing was sent twice, and this window will not offer another send while that is unknown.
> Check it on our own jobs page, where every run on the desk is listed:
> *Conveyor Courier — jobs on the desk*

**不再提供发送入口**，只给对账入口。磁盘 jobs 数不变。

两处必须写清的演练约束：

- **反代与接单口同进程同端口**，杀 8086 会连反代一起杀。所以 C 只能在窗口打开后再杀——窗口层的 5 次读回不需要模型，这样才成立。
- **留证手法备案**：unknown 面板渲染后立即 `state.resolve(...)`，runtime 随即关闭弹窗，前两次尝试都因此没截到。第三次在提交前置 `window.opener = null`，**只切断回报通道**，让已渲染的面板留在屏上。面板本身由真实代码路径产生（`finishUnknown` 先 `box.replaceChildren(notice)` 再 resolve），三态判定逻辑一行未改。这是拍照用的固定手法，不是伪造状态。

### 6.4 90 秒 composition 时限：行号与行为更正

- 位置是 **`pizza-site/runtime/engine.js:554`** `deadline: Date.now() + 90_000`（任务原文的 `:533` 是同步前旧行号）。
- `runner.js:65` `"the composition deadline was reached"`、`runner.js:78` `"the 90-second query deadline was reached"` 未变。
- **行为更正：时限只阻止"再发起下一次调用"，不中断已在飞的调用。** 演练 A 的远程调用实测 `90716ms`、其中 `confirm_dispatch 45646ms`，压在 90 秒线上仍正常返回结果。
- **真实触发已发生一次**（partner 调用层）：因确认弹窗耗时超预算，页面给出 `Dispatch to Conveyor Courier — No reply — the request was skipped at the deadline`。该次窗口未打开，故**它证明的是 partner 层的时限行为，不是窗口层 unknown**。两者在文档里分开记。

**套 B 上又复现一次，证据更完整**（`m2-unknown-deadline.png`，路由：本地反代 → GLM-4.7-Flash）。执行日志逐字：

```
AGENT   little_oven_assistant @ 127.0.0.1:8084 · 181564ms
LLM     GLM-4.7-Flash via 127.0.0.1:8086 · 111803ms
TOOL    · 41432ms
COMPOSITION_LIMIT
RESULT  courier_dispatch  Skipped Conveyor Courier: the composition deadline was reached.
LLM     GLM-4.7-Flash via 127.0.0.1:8086 · 16842ms
AGENT_RESULT
```

这一次同时钉死了时限的两条行为：

1. **不中断在飞**：那次模型调用跑了 **111803ms**，远超 90 秒，仍正常返回（比 §6.1 的 90716ms 更极端）。
2. **只阻止再发起**：其后对 Conveyor Courier 的 partner 调用被 `COMPOSITION_LIMIT` 跳过，返回 `Skipped … the composition deadline was reached`，而整轮**没有中止**——后面还照常发了一次 16842ms 的模型调用并产出 `AGENT_RESULT`。

诱因是 consent 卡停留超过预算（GLM 单次响应本就慢），与演练 A 的成因一致。

---

## 7. FileStore 的非计划实测

本轮开发环境**六次**随会话掉线导致 8084/8085/8086 全停。每次重启后 `.local/desk.json` 中的既有单**全部还在**（本轮从 2 单累积到 4 单，跨多次进程重启与强杀）。

这是 A4 持久化的**非计划真实验证**：掉线丢单被文件持久化根治。计划内验证是 `tests/restart.test.mjs`（真 spawn → SIGKILL → 重启 → 读回，实测 322ms 通过）。

数据文件落 `courier-site/.local/desk.json`，`.gitignore` 的 `.local/` 已覆盖（`git check-ignore -v` 实测 exit 0）；写入为 `.tmp` + rename 原子替换，防强杀截断。seed 与演示数据一律假人假地址。

---

## 8. 复现命令与当前统计

```
cd D:\Conveyor\courier-site && node --test "tests/*.test.mjs"     # 55 tests / 55 pass / 0 fail / 0 skip
cd D:\Conveyor\pizza-site   && node --test "tests/*.test.mjs"     # 39 tests / 39 pass / 0 fail / 0 skip
node D:\OpenAgenticWeb\skills\agentify-website\scripts\build_network.mjs <site>\<network>.hocon --manifest <site>\agent-manifest.json --check
```

两站 build --check 均 **0 warning / 0 error**，生成物 up to date。

演练开关（开发专用，Worker 无此 flag）：

```
node courier-site/worker/local-server.mjs --port 8086 --drill drop-response   # recorded 分支
node courier-site/worker/local-server.mjs --port 8086 --drill fail-write      # absent 分支（推荐）
node courier-site/worker/local-server.mjs --port 8086 --drill reject-write    # 演示浏览器透明重发
```

---

## 9. 双路由：本地 LLM 反代（套 B）

intern-ai 的 key 配额耗尽后新增的第二条路由，与套 A 并存，**零 manifest 改动、零 runtime 接触**，只在 ⚙ AI model settings 三字段切换。

| | 套 A | 套 B |
| --- | --- | --- |
| baseUrl | `https://discovery-api.intern-ai.org.cn/v1` | `http://127.0.0.1:8086/llm-proxy` |
| model | `deepseek-v4.1-flash-1017` | `GLM-4.7-Flash` |
| key | 访客 BYOK，直连 provider | 占位 `env`（反代持密钥）或访客自有智谱 key（透传） |
| 状态 | 配额耗尽（429 quota_exceeded） | 可用 |

### 9.1 为什么必须反代

浏览器直连 `open.bigmodel.cn` 栽在**预检**：OPTIONS 返回 405 / 无 `Access-Control-Allow-Origin`，请求根本发不出去。tokenhub 同样。反代自己答预检再转发。

`courier-site/worker/llm-proxy.mjs` 是**独立 dev-only 模块**，`local-server.mjs` 命中 `/llm-proxy` 前缀即进它、**不进 desk 的 `handle()`**；Worker 没有这条路由，M4 抽取不受污染。它同时是官方 `publisher_funded`「自建持密钥代理」的本地等价物，M3 原位升级为独立 Worker + `wrangler secret`。

CORS **单独写、不复用 desk 白名单**：desk 只放行 `Content-Type`，而带 Bearer 头必触发预检，所以这里 `Access-Control-Allow-Headers` 必须含 `Authorization, Content-Type`。ACAO 回显白名单 origin（8084/8085 的 127.0.0.1 与 localhost 四个），非白名单不回 ACAO。实测预检 **204**，四个头齐全。

密钥纪律与 M2-③ 私钥一致：从启动环境变量读，`.env` 进 git-ignore（`git check-ignore` 实测命中 `.gitignore:5`），提交 `.env.example` 占位（`!.env.example` 反排除）。日志只记 `key: server` / `key: visitor`，不记 key 值。

**流式直通不缓冲**：runtime 恒发 `stream:true` 并增量读 SSE，缓冲会卡住 UI。上游 `Accept-Encoding: identity`，避免压缩后再拼装。

### 9.2 两处实现层决定（自主追加，需备案）

1. **串行队列**：同一时刻只允许一个上游调用在飞。
2. **最小间隔 8 秒**：两次上游调用之间强制留白。

两者都**不改请求内容、不重试**——被拒就原样把 429 交回页面，符合「勿加自动重试」的约束。加它们的原因是下面这组实测。

### 9.3 智谱 1305 的实测结论（三次对照，推翻两个直觉）

`{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}`，HTTP 429。

| 假设 | 实验 | 结论 |
| --- | --- | --- |
| 并发超限 | 加队列前日志出现 143ms 内两发、双双被拒；加队列后两发已错开 | **部分成立**，但错开后仍会被拒，不是唯一原因 |
| 请求体积超限 | 858B 成功、1968B 失败、3818B 成功、6038B 成功；真实浏览器请求 11–18KB 大量成功 | **推翻**，与体积无关 |
| 连发过密 | 加 8 秒最小间隔后**连续 6 次调用全 200**（含 11–18KB 大请求） | **成立**，是主要诱因 |

但节流后仍偶发 429，**不是 100% 可靠**。原始日志：`raw-m2-route-b-proxy.txt`。

**另一个必须记住的副作用**：GLM-4.7-Flash 是思考模型，单次响应实测 1547ms ~ **111803ms** 不等。慢的那头会自己把 90 秒 composition 预算吃穿——§6.4 的 D 分支正是这么复现的。做窗口层演练时要把这个延迟算进预算。

### 9.4 套 B 首链路已验证

`m2-route-b-first-link.png`：真浏览器里问答成功，执行日志逐字 `LLM GLM-4.7-Flash via 127.0.0.1:8086 · key: local BYOK (not shown)`。预检 204 + POST 200 + SSE 直通 + 上游真实 `model:"glm-4.7-flash"` 均已单独实测。

### 9.5 模型选型：非思考档不是"换个名字"那么简单

为压掉长尾延迟换非思考档，四层快检（基础 / SSE / tools 流式 / 预检）逐个过，但**快检过 ≠ 能跑两跳协议**：

| 模型 | 单次延迟 | reasoning_content | tools | 真实两跳表现 |
| --- | --- | --- | --- | --- |
| `GLM-4.7-Flash` | 1547ms ~ 111803ms | 有 | 正常 | 协议正确，但长尾自己吃穿 90 秒预算；偶发 1305 |
| `glm-4.5-flash` | 5936ms | 有 | — | 仍是思考档，不满足换档目标 |
| `glm-4-flash` | 962ms | 无 | 正常 | **不合格**：只发一次 LLM 调用就道歉，根本不发 tool call |
| `glm-4-air` | 1210ms | 无 | 正常 | **不合格**：一次误选 `lookup_job`；一次连 partner 调用都没发就宣称"已成功派单" |
| `glm-4.5-air` | 1757ms | 有 | 正常 | 思考档，未采用 |
| **`glm-4-plus`** | **969ms** | **无** | **正常** | **合格**：quote → authorize → confirm_dispatch → 写窗口，B/C 一轮成 |

结论：**四层快检只验通道兼容，验不出多跳工具编排能力**。选型必须再加一条"真跑一轮跨站"才算过。`glm-4-plus` 是非思考旗舰档，既快又跟得上协议，B/C 与后续屏录都用它。

**各演练所用模型**（不混写）：

- 演练 A（recorded）：套 A，`deepseek-v4.1-flash-1017` 直连。
- 演练 B（absent）、C（unknown）：套 B，本地反代 → **`glm-4-plus`**。
- D（90 秒时限）：套 B，本地反代 → **`GLM-4.7-Flash`**。**故意保留慢模型原样不重做**——"在飞 111803ms 仍返回"这条证据本来就需要长尾才成立。
- 套 A 恢复后补录 BYOK 直连素材，视频主线仍用套 A 版。

### 9.6 两条实操教训

- **切模型设置会清空演示订单**。`#ns-apply` 之后 `latestOrder` 没了，`authorize_delivery` 正确地拒绝 "Place the order first"。顺序必须是：先配模型 → 再下单 → 再询价授权。
- **不要在回合在飞时重启 8086**。有一次这么干，partner 调用被打断，日志留下 `TOOL · 65748ms` + `COMPOSITION_LIMIT`。重启只在回合之间做。

---

## 10. 待补

1. unknown 分支的**对账页兜底**目前只指向跑腿站 jobs 页（`deskLink()`），真正的双方对账页待 M2-④。
2. 12-8 验收的四段原始屏录（consent 卡 / 写窗口确认 / 收据验签 / 掐网 unknown），走套 B + `glm-4-plus`。
3. 套 A 恢复后直连重验一遍，补录 BYOK 叙事素材。

三态演练本身已全部留证，无遗留分支。