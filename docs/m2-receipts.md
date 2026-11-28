# M2-③④ 签名收据与双方对账页

段 2 施工记录。代码为准，本文件只记设计与实测；三态契约见 `m2-unknown.md`。
提交：`c2f5a94`（③）、`9ad7d87`（④）、`7da28cb`（usage log）。

---

## 1. 签的是什么，以及为什么不签别的

`courier-site/receipt-crypto.js` 的 `SIGNED_FIELDS` 固定顺序、固定集合：

```
jobId, pizzaOrderRef, dropZone, parcelSize, itemCount, feeCents, etaMinutes, createdAt
```

算法 **ECDSA P-256 + SHA-256**（`RECEIPT_ALG = "ECDSA-P256-SHA256"`）。

**签的是 booking facts，不是配送状态。** 三条排除各有理由：

| 排除项 | 理由 |
| --- | --- |
| `status` / `updatedAt` | 会变。收据在包裹送达后仍必须验得过，否则"签了"等于"只在 assigned 那一刻有效" |
| 收件人姓名 / 电话 / 地址 / 备注 | PII。既不签，也不进收据，页面根本不取 |
| `itemSummary` | 调用方自由文本，不是 desk 定价依据；签它等于为别人的措辞背书 |

三个数值字段（`itemCount` / `feeCents` / `etaMinutes`）在规范化时强制 `Number()`，
所以 `450` 与 `"450"` 是同一事实——线上 JSON 与页面读回不会因类型漂移而验不过。
**改 `SIGNED_FIELDS` 的顺序会让已签收据全部验不过**，改动前必须明白这一点。

签名**落库一次**（`dispatch` 在 `putJob` 之前签），同键回放返回同一签名，不重签。

---

## 2. kid 与换钥不断代

`kidOf(publicJwk)`：把公钥规范化成 `{kty, crv, x, y}` 四元、`JSON.stringify`、SHA-256、base64url、
取前 16 位小写字母数字。**kid 由公钥自身派生**，不是人填的，所以换钥必然换 kid，不会撞号。

只保留这四个成员是为了 kid 稳定：不同 runtime 导出的 JWK 可能带 `ext` / `key_ops` / `alg`，
若把它们算进去，同一把钥在 Worker 与 Node 里会得到两个 kid。已有用例锁死这一点。

**换钥流程**：新私钥进 `RECEIPT_PRIVATE_KEY`，旧公钥追加进 `RECEIPT_RETIRED_PUBLIC_KEYS`（JSON 数组）。
`/api/pubkey` 同时发布两代，active 在前。对账页**按每张收据自己的 kid 选公钥**，不是"用最新那把"。
已有用例证明：旧收据用旧 kid 验过、新收据用新 kid 验过、**旧钥验新收据必须 false**。

---

## 3. 私钥方案 b（计划书 §3 定案，未偏离）

- 本地从环境变量读：`courier-site/worker/receipt-signer.mjs` 的 `signerFromEnv(env)`。
- `.env` 被 `.gitignore:5` 命中；`.env.example` 只放占位与生成命令。
- M3 时同一个值改由 `wrangler secret` 提供，**`worker/index.js` 的读法不变**（`signerFromEnv(env)`），
  这是"原位替换"的落点。
- 解析失败只 log 原因、不回显值，返回 `null`：**desk 继续接单，只是收据不签名**，不因配置问题停业。
- 页面本地 desk 没有 signer（构造函数第 4 参为空）→ 收据不签名。**私钥永不进浏览器。**
- 测试全部用 `generateKeyPair()` 现生成的假钥对，不读 `.env`。

**实测**：全部 209 个已跟踪文件逐个扫描，`ZHIPU_API_KEY` 值与收据私钥的 `d` 字段**均无出现**。

---

## 4. `/api/pubkey` 的 CORS 例外（本段新做的实现决定）

现有规则是「业务端点从不发 `*`，只回显白名单 origin」。`/api/pubkey` **单独发 `*`**，理由：
公钥没有秘密，任何人都该能验签，验签不该要求先成为客户。

- 该端点只接 GET / OPTIONS，其余 405。
- 无 signer 时返回 `keys: []`，不是报错。
- **业务端点不受影响**：已有用例证明带着 signer 时，陌生 origin 打 `/api/quote` 仍是 403 且无 CORS 头。
- `ALLOWED_ORIGINS` 已加 **M3 TODO**：上线前必须换成 Pages 生产域名，漏换 = 线上写链路断。
  公钥端点不在这张名单里，不受该 TODO 影响。

---

## 5. 对账页：四种判定，不合并成"过 / 不过"

`receipt-ledger.js` 的 `VERDICTS`：

| 判定 | 页面文案 | 含义 |
| --- | --- | --- |
| `verified` | Verified | 签名覆盖这一行的工单、包裹与金额 |
| `changed` | Does not match | 有签名但对不上，**这一行不可信** |
| `no-key` | Key not published | 收据指名的 key 不在 desk 发布列表里 |
| `unsigned` | Not signed | 根本没有签名，是 desk 持有签名钥之前开的单 |

两条硬约束：

1. **读不到 desk 或读不到公钥通道 → 报 error，不出任何判定。** 网络故障绝不能伪装成"收据被篡改"。
2. **历史未签名单据显示"未签名"，不显示"失败"。** 段 2 之前落库的 4 张单就是这种情况，如实标注。

**验签故意不做成 `website_*` action**：模型不能宣称"已验签"。页面自己算，算完自己显示。

每行展示：工单号 / 订单参考 / 金额 / 落库时间 / kid / 签名判定。
每行 verified 带一个 **「Test a changed amount」**：在**本地副本**上加一分钱重验，
文案明写「Local check, nothing sent」，不发任何请求、不改任何行。这是让访客看见
"签名真的绑住了金额"而不只是"存在一个签名"的最便宜办法。已有用例锁死它不调 desk、不改原行。

unknown 分支的写窗口现在同时给 jobs 页链接和 `#receipts` 链接：既能找到单，也能验这张单。

---

## 6. 两站怎么共用同一份验签代码

**先否掉的方案**：披萨页跨 origin `import` 跑腿站的模块。
官方 `serve_site.mjs` 只对**公开 bundle 文件**（manifest / network / links / mcp / .well-known）发 `*`，
页面模块不在其中，跨站 import 会被 CORS 挡死。改官方脚本是禁止项。

**落地方案**：两站各存一份，`sync-shared.mjs` 复制，**测试逐字节比对**。
四个共享文件：`receipt-crypto.js`、`receipt-ledger.js`、`receipt-page.js`、`receipt-ledger.css`。
canonical 在 courier-site。`node sync-shared.mjs --check` 漂移即 exit 1。

这样两站各自自包含，M3 可以各自独立部署到两个 Pages 项目。
披萨站测试**反过来 import 跑腿站的 signer**，验它签出来的东西——两边必须对得上，这才是重点。

---

## 7. 实测证据

| 项 | 结果 | 出处 |
| --- | --- | --- |
| 跑腿站测试 | **75 / 75** | 独立重跑两次一致 |
| 披萨站测试 | **42 / 42** | 独立重跑两次一致 |
| 段 2 前基线 | **94 项（55 + 39）零回归** | 新增 23 项：③ 12 + ④ 11 |
| 官方 build --check | 两站均 `OK: these files are up to date` | 生成物未被手改 |
| 真实签名派单 | 201，kid `e9tenikxahzfu45m`，公开公钥验签 **true** | `raw-m2-receipt-sign.txt` |
| 改金额 4500 | 验签 **false** | 同上 |
| 收据内 PII | `[]`（四个字段全不在） | 同上 |
| 同键回放 | 200，`replayed: true`，**签名逐字相同** | 同上 |
| 重启后存活 | 两张签名收据重启后仍 **verified** | `raw-m2-receipt-restart.txt` |
| 磁盘落库 | jobs=6，2 张带 kid + 86 字符签名，4 张空 | `.local/desk.json` 实读 |
| 跑腿页真浏览器 | `2 verified of 6 · 4 not signed · 0 not matching · 0 with an unpublished key` | `m2-receipts-courier.png` |
| 披萨页真浏览器 | 同上，跨 origin 拉公钥成功 | `m2-receipts-pizza.png` |
| 一分钱 what-if | 「Local check, nothing sent: with one cent added, this signature does not match.」原行仍 verified | 同上（截图内可见） |
| 密钥泄漏扫描 | 209 个已跟踪文件，**clean** | 本段实测 |

**已知无害噪声（如实披露）**：披萨页控制台有 1 条 404 ——
`GET http://127.0.0.1:8086/agent-manifest.json`，来自 runtime 的 `fetchManifest(originUrl)` 探测，
**不是段 2 代码发出**（本段只发 `/api/pubkey` 与 `/api/jobs`，两条均 200）。
desk 没有 manifest 是设计如此，该 404 不影响任何功能，未做处理。

---

## 8. 尚未做的（留给 12-8 验收）

- `docs/m2-acceptance.md` 未写。
- 四段原始屏录未录：consent 卡 / 写窗口确认 / 收据验签 / 掐网 unknown。
  走**套 B + glm-4-plus**，**不用 `window.opener=null`**（该手法只用于静态截图）。
  收据验签段**不烧额度**，可任意重录。
- 顶层 README 未随 M2 更新。
- M3 预备（12-1 起并行）：wrangler 登录 dry-run、Pages 空壳、D1 建表 dry-run。
  其中 **CORS 生产域名替换点已标 TODO**（`worker/index.js` 的 `ALLOWED_ORIGINS`），
  另需同步 `desk-client.js` 的 `LOCAL_BASE` 与 `receipt-ledger.js` 的 `LEDGER_DESK_BASE`（后者已带 TODO）。
- 套 A（intern-ai）仍 429，恢复后补录 BYOK 直连素材，视频主线用套 A 版。