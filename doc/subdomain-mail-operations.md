# 子域名邮箱部署与验证

实现依据为 [已确认设计](subdomain-mail-design.md)。本次只修改和本地验证代码，未部署、未修改 Cloudflare/DNS、未向真实地址发送测试邮件。

## 本地检查

在 `mail-worker` 目录执行：

```powershell
npm ci
npm test
npm run check
npm run subdomain:name -- example.com
npm run subdomain:name -- example.com shop
```

`npm test` 现在运行 Vitest，不再使用原来的部署命令。测试用隔离 D1/KV 和本地 Workers runtime，直接调用真实迁移、HTTP API、邮件事件与站内投递代码。`npm run check` 只打包检查（`--dry-run`），使用无远程资源 ID、无构建钩子的 `wrangler-check.toml`，不会发布。两个名称命令只输出名称，不检测或配置 DNS；随机标签为 10 位小写字母数字，自定义标签为 1–63 位小写字母、数字及内部连字符。

测试覆盖 100 个地址、101 整批拒绝、非法前缀与大小写冲突、请求重放/冲突/过期、并发配额、中断与提交后响应丢失、过期处理租约接管、旧创建入口配额竞态、严格收信、停用/恢复、删除占用、游标查询、现有页面读取、普通邮箱创建与发信及邮件清理。测试结果只能证明本地行为，不证明公网投递或长期容量。

当前仓库的 Vitest Workers 测试池只支持到 `2025-03-10`，测试时会提示从项目配置的 `2025-06-04` 回退；本地行为测试使用该运行时，Wrangler 打包使用项目配置日期。初始化测试中旧迁移还会报告跳过不存在的 `auto_refresh_time`，这是旧初始化流程的已捕获提示。本功能迁移遇到异常会直接失败，不会吞掉错误。上述限制需要结合后面的测试部署与真实投递验证确认。

## 配置

在实际部署使用的 Wrangler 配置 `[vars]` 中维护独立列表。使用 GitHub Actions 时应修改 `wrangler-action.toml`，手动发布通常使用 `wrangler.toml`；其他测试配置也需要分别维护，不能只改未被部署的文件：

```toml
domain = ["example.com"] # 保留现有普通注册/创建域名
subdomain_base = "example.com"
subdomain_domains = ["shop.example.com", "a1b2c3d4e5.example.com"]
```

基础域名固定，列表只允许其单层子域；全部使用小写，不写 `@`、协议、端口或末尾点。缺省空列表表示不启用新子域。示例地址必须替换成自己的已验证地址，不能直接当作可收信域名。

不要把子域放进 `domain`；接口也会过滤公开域名选项并阻止普通注册/创建。普通用户的角色授权按完整子域匹配，`example.com` 不代表 `shop.example.com`。沿用现有角色语义：`availDomain` 为空表示不限制域名，非空时必须包含完整子域；管理员自身免角色域名和数量限制，代普通用户创建不豁免。新 API 仍要求 `addEmail`、`manyEmail` 开启，遵守 `minEmailPrefix` 和 `emailPrefixFilter`，不要求浏览器人机验证。

现有角色编辑页会丢弃普通域名列表之外的选项，本版没有新增角色管理页面。可通过现有 `/api/role/set` 管理接口保存 `availDomain` 数组（使用管理员浏览器登录令牌，按原契约同时保留角色名称、权限等字段），或由管理员在 D1 的目标角色 `role.avail_domain` 中加入完整子域（逗号分隔，保留原有授权）。不要为角色选择器方便而把子域加入公开 `domain`。通过脚本设置后，避免在旧角色编辑页改动域名选择导致该值被移除。

不要把已有普通邮箱使用的域名直接改为本功能子域：本功能不会转换旧邮箱，整域启用严格收信后，只有本 API 创建的地址可收信。

## 由管理员执行的部署顺序

以下均为部署说明，本次没有执行其中的远程操作。

1. 按原项目流程准备 Worker、D1、KV、静态资源及所需附件存储，备份生产数据库。测试/探针部署必须使用独立 D1、KV 与管理员身份，避免测试数据进入生产。
2. 对已有数据库，先检查 `PRAGMA table_info(account)` 是否已有 `mailbox_kind`。在 `mail-worker` 运行 `npm run subdomain:migration` 生成 `.wrangler/subdomain-migration.sql`。若该列已存在，使用 `npm run subdomain:migration -- --existing-column`。命令只生成文件，不修改数据库。
3. 在发布新 Worker 前，由管理员将生成的 SQL 应用到对应的已有数据库。先在本地或测试数据库演练，再使用实际数据库名称/配置执行 `wrangler d1 execute <数据库名称> --remote --config <部署配置> --file .wrangler/subdomain-migration.sql`。此 SQL 仅添加本功能结构；不要删表、删索引或用空库覆盖生产。若中断，重新检查列，按第 2 步选择参数重跑；表、索引及触发器使用 `IF NOT EXISTS`。
4. 新数据库先保持子域列表为空，按原项目流程部署并访问 `/api/init/<jwt_secret>` 完整初始化；完整初始化已包含本功能迁移。已有数据库应用第 3 步迁移后，再按原项目流程部署新版 Worker。不能让新版正常流量先于迁移，否则缺少列/表会导致请求失败。
5. 完成下一节的真实探针收信验证后，才把子域加入生产 `subdomain_domains` 并由管理员发布配置。每次新增子域后调用 `/api/init/<jwt_secret>/subdomain`，确认返回 `success`；它检查/补齐本功能结构、持久化整个子域的管理标记，并刷新设置，不重跑旧迁移。初始化密钥沿用项目已有机制，不要将它提交到脚本或公开日志。
6. 生产先创建一个探针地址再进行一次外部收信回归，确认目标 `accountId` 与用户归属后，运行正式批量脚本。

新增结构包括 `account.mailbox_kind`、`managed_subdomain`、`mailbox_reservation`、`mailbox_request`、`mailbox_request_item` 和对应索引/触发器。已有普通邮箱保持 `mailbox_kind=0`。占用表独立于邮箱和用户，物理删除不会级联清除占用；批次结果超过 24 小时由现有小时定时任务清理，地址占用不清理。

子域移出列表后，新建和收信停止，历史记录仍可查询。不要删除 `managed_subdomain` 或 `mailbox_reservation` 作为停用手段。若需要回退版本，应使用保留严格校验的修复版本；旧 Worker 不认识管理标记，直接回滚到旧收信代码会重新启用宽松回退。退回旧代码前必须先在 Cloudflare 停止这些子域向它路由邮件。

## 真实 Cloudflare 收信验收（尚未完成）

分别选择一个随机命名子域和一个自定义命名子域执行完整流程：

1. 用辅助命令生成名称。在 Cloudflare 为该完整子域启用 Email Routing，并按平台提示配置 DNS；配置将该子域邮件交给探针 Worker 的路由。参考 [Cloudflare 子域配置](https://developers.cloudflare.com/email-service/configuration/subdomains/) 和 [路由配置](https://developers.cloudflare.com/email-service/get-started/route-emails/)。本项目不会调用 Cloudflare API 自动创建 DNS 或路由。
2. 只在隔离探针部署把该子域加入列表，运行初始化/子域初始化。在探针环境通过批量 API **先创建** `probe@该子域`，记录 `accountId`。这一步是验证前的临时配置，不等于生产可用子域认证。
3. 从 Gmail、Outlook 或其他真正的外部邮箱发送一封带唯一主题和正文的邮件到该完整地址。记录发送时间、Message-ID、Cloudflare 邮件事件结果；通过 `emails?accountId=...` 和现有页面确认邮件内容、收件地址与归属一致。必要时再测试普通附件。
4. 发送到未创建的 `unknown@该子域` 和 `probe+tag@该子域`：检查 Cloudflare 事件/发件方退信确认拒收，并确认数据库/页面未出现这些新邮件。全局 `noRecipient=0`（允许无主收件）时仍须拒收；如果确实创建 `probe+tag`，则该完整地址应能收到邮件。
5. 停用 `probe`，重发外部邮件并从站内普通邮箱发送，均应拒收；旧邮件仍能查到。恢复后再次外部发信，应可收到。再撤销用户完整子域权限或禁用用户，确认拒收。
6. 在探针部署移出该子域并发布配置：已创建和未创建地址均拒收，旧邮件仍可读；不能回退到无主邮件或 `+tag` 收信。再测试物理删除地址或其用户，尝试重新创建同一地址，应返回 `ADDRESS_UNAVAILABLE`。
7. 保存两类子域的以上实际证据，才将它们加入生产列表。DNS 查询成功、API 创建成功、本地 `email` 事件测试通过都不能代替第 3 步。

尚未验证真实 Cloudflare 投递延迟、平台配额、长期存量/每日容量。没有新增每日限额。批量实现用有序计划行的数据库触发器执行逐项校验，整个创建过程只有固定数量的 D1 调用；数据库串行处理事务，配额检查和账户创建不会被并发批次分开。D1 事务和平台限制参见 [batch 事务说明](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) 与 [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。生产仍应观察 D1 处理时长、队列、存储及 Worker CPU；本地测试不构成容量保证。

## API 调用

对外 URL 需要项目既有的 `/api` 前缀，例如 `/api/public/subdomainMailbox/batchCreate`。所有新接口都使用现有管理员 Public API 令牌，直接放在 `Authorization`，不要加 `Bearer `。通过现有 `/api/public/genToken` 获取/轮换令牌；不要把令牌写入版本库。成功沿用 `{code:200,message:"success",data:...}`。请求错误使用相应 HTTP 状态和 JSON `code`；逐项失败的批次整体仍是 200。

PowerShell 示例（`MAIL_API_URL`、`MAIL_API_TOKEN` 由本机环境设置）：

```powershell
$mailHeaders = @{ Authorization = $env:MAIL_API_TOKEN }
$mailBody = @{
  requestId = "websites-20260914-001"
  domain = "shop.example.com"
  prefixes = @("github", "shopping", "alice+tag")
  # userId = 42 # 只能填写真实已有用户；省略时归管理员本人
} | ConvertTo-Json
$mailResult = Invoke-RestMethod -Method Post `
  -Uri "$env:MAIL_API_URL/api/public/subdomainMailbox/batchCreate" `
  -Headers $mailHeaders -ContentType "application/json" -Body $mailBody
$mailResult.data
```

随机模式用 `count=1..100` 替换 `prefixes`，每次固定使用所选子域，不随机挑选子域或添加 DNS。自定义前缀统一小写判重，合法的 `_`、`%`、`+` 等字符按现有邮箱格式允许；不会对已占用的自定义名称改名。随机前缀默认 12 位，至少达到 `minEmailPrefix`，按禁用词过滤，有限次尝试失败返回 `GENERATION_FAILED`。

| 方法与路径（均在 `/api/public/subdomainMailbox` 下） | 参数与结果 |
| --- | --- |
| `POST /batchCreate` | `requestId` 必填，1–128 字符；`domain` 必填；`count` 或 `prefixes` 二选一；可选 `userId`。返回 `created`、`failed`、输入顺序 `items` |
| `GET /list` | 可选 `userId`（默认管理员）、`domain`、`status=active/disabled`、`cursor`、`size`（默认 20，最多 100）；返回 `{items,nextCursor}` |
| `POST /disable` | JSON `{accountId:123}`，重复操作成功；不删邮件、不释放配额 |
| `POST /enable` | JSON `{accountId:123}`，重复操作成功；要求用户有效、域名启用及权限仍在，不修改归属 |
| `GET /emails` | `accountId` 必填，`cursor`、`size` 可选（默认 20，最多 50）；返回 `{items,nextCursor}`；只查该账户/用户的未删除收件，停用不影响查询 |

首次查询省略 `cursor`，后续原样传入返回的非空 `nextCursor`，其为空即结束。按递增 `accountId`/`emailId` 排序，不受置顶顺序影响。查询不使用邮箱字符串 `LIKE`。旧 `/public/addUser`、`/public/emailList` 语义保留；旧页面可直接列出并读取这些归属于现有用户的邮箱，无需新增登录用户。

常见请求错误：`INVALID_MODE`、`INVALID_COUNT`、`INVALID_REQUEST_ID`、`INVALID_USER`、`DOMAIN_UNAVAILABLE`、`DOMAIN_PERMISSION_DENIED`、`ADD_EMAIL_DISABLED`、`REQUEST_CONFLICT`。逐项错误包括 `INVALID_PREFIX`、`PREFIX_BLOCKED`、`ADDRESS_UNAVAILABLE`、`QUOTA_EXCEEDED`、`GENERATION_FAILED`。本功能发件人明确返回 `SUBDOMAIN_RECEIVE_ONLY`；不能用其他类型的账户调用本功能状态/邮件接口。

同一管理员身份、同一 `requestId`、相同规范化参数，首次受理后的 24 小时内返回原逐项结果，包括失败项。省略 `userId` 与显式填当前管理员 ID 等价；域名首尾空白、域名/前缀大小写规范化后比较。修改参数返回 409。令牌轮换不改变管理员数据库身份。

如果返回 HTTP/JSON 202、`data.status="processing"`，按 `Retry-After`/`data.retryAfter` 等待（当前 60 秒）再用**同一请求和参数**重试。请求在创建事务前中断时，租约到期可接管；旧处理者的随机 owner 标记失效，不能重复创建。账户、永久占用和全部逐项结果在同一个 D1 事务提交，提交后丢失 HTTP 响应可直接重放；预期的逐项失败不会撤销成功项，意外数据库异常则回滚该次未提交事务。

脚本应持久保存请求 ID、参数和结果。只重做失败项须用新的请求 ID。超过 24 小时，原 ID 可能创建新批次，应先查询现有地址再决定。停用地址长期保留，邮件仍遵循原有 `autoCleanDays`（默认 0 为关闭）；`autoCleanExclude` 按用户主邮箱豁免其全部地址。
