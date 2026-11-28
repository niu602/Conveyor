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
| `recorded` | 有 | 有（演练 A） | 有 | `m2-unknown-recorded.png` |
| `absent` | 有 | **部分**（演练 B，见 §6.2） | 部分 | 无 |
| `unknown` | 有（跑满 45s） | **未做** | 未做 | 无 |
| 90 秒 composition 时限 | — | 有（partner 层真实触发，见 §6.4） | 有 | 无 |

**未完成的原因是外部配额，不是设计或代码问题**：2026-11-28 02:5x 起该 key 对 `discovery-api.intern-ai.org.cn` 返回 `LLM HTTP 429 {"code":"quota_exceeded"}`，两次不同 `trace_id`（`fb962d6b…`、`984bde54…`）均如此，连"你的营业时间是几点"这种单跳问答也被拒。真模型链路在此之后无法继续，`absent` 面板截图与 `unknown` 两个注入演练因此挂起。代码侧三态由 55 项用例覆盖，全绿。

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

### 6.2 演练 B：`absent` —— 部分完成，并查出一个 transport 层真问题

以 `--drill reject-write`（处理前断连）跑了两轮，日志均逐字出现：

```
DRILL reject-write: closing the socket before handling; nothing recorded.
```

**但两轮磁盘上都各多出一单**：

| 轮次 | 落单 | 键 |
| --- | --- | --- |
| B-1 | `J-64babb88-bb7e-493c-a70f-114e7c53e104` | `dispatch:DEMO-1795833808034:Q-a59fbc2e-7397-4a65-8c06-3a6e9ed46c7d` |
| B-2 | `J-e4493ae7-6406-4b5f-bc17-b003aed2ff3f` | `dispatch:DEMO-1795834058207:Q-defe25f8-65fd-45aa-b290-1a533a5a1a51` |

排查结论（逐层排除，非猜测）：

- 开关只匹配 `req.method==="POST" && path==="/api/dispatch"`，**不会误伤 `/api/dispatch/check`**；
- `DispatchWindow.submit` 的 catch 分支只读不写，**无自动重试**；
- `DeskClient.send` 单次 fetch，**无重试循环**；
- 开关严格一次性（`armed=false` 取出即置）。

因此第二次 POST 只能来自**浏览器传输层**：**Chrome 会对"复用的 keep-alive 连接在收到任何响应字节前被重置"的 POST 透明重发**。一次性故障被第一次请求消耗掉，透明重发落在新连接上于是成交。

**这条对生产同样成立**：`reject-write` 这种"断连"注入不足以稳定制造 absent，真实世界里它也可能被浏览器重发掉。为此新增第三种注入：

```
--drill fail-write   处理前直接答 503，不落库
```

503 是真实状态码，浏览器不会重发；而 `DeskClient` 对 5xx 仍抛 `unknown`（4xx 才是 desk 自己的 refusal），因此调用方依旧"不知道有没有落单"，正好进只读核实路径。**absent 分支应改用 `fail-write` 复现**，`reject-write` 保留用于演示上述重发现象。

顺带取得的真实证据：B-1 中 absent 后重试通道被触发，**同键重发只产生一单**（磁盘该键唯一），即 §2.3 的回放语义在真浏览器里成立。

### 6.3 演练 C / D：`unknown` —— 未做

- C（断网注入，杀 8086 并保持 45 秒不可达，5 读全失败）
- D（窗口层 unknown）

均因 §0 的配额耗尽未执行。**窗口层 unknown 目前只有自动化用例覆盖**（跑满 45s、`waits` 断言）。

### 6.4 90 秒 composition 时限：行号与行为更正

- 位置是 **`pizza-site/runtime/engine.js:554`** `deadline: Date.now() + 90_000`（任务原文的 `:533` 是同步前旧行号）。
- `runner.js:65` `"the composition deadline was reached"`、`runner.js:78` `"the 90-second query deadline was reached"` 未变。
- **行为更正：时限只阻止"再发起下一次调用"，不中断已在飞的调用。** 演练 A 的远程调用实测 `90716ms`、其中 `confirm_dispatch 45646ms`，压在 90 秒线上仍正常返回结果。
- **真实触发已发生一次**（partner 调用层）：因确认弹窗耗时超预算，页面给出 `Dispatch to Conveyor Courier — No reply — the request was skipped at the deadline`。该次窗口未打开，故**它证明的是 partner 层的时限行为，不是窗口层 unknown**。两者在文档里分开记。

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

## 9. 待补

1. `absent` 面板截图（用 `fail-write` 复现）。
2. `unknown` 断网注入演练与截图（杀 8086 保持 45 秒不可达）。
3. 窗口层 unknown 的真浏览器证据。
4. unknown 分支的**对账页兜底**目前只指向跑腿站 jobs 页（`deskLink()`），真正的双方对账页待 M2-④。

以上 1–3 依赖模型配额恢复。