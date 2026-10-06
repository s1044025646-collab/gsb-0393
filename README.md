# 确定性扫雷后端（TypeScript + Node.js + SQLite）

纯后端实现：可复现的扫雷规则、动作验证、幂等日志与重放校验。只做 API 与 CLI，无网页、无自动解题、无多人竞技。Windows 本地直接运行，不依赖 Docker / WSL / 外部服务（SQLite 使用 Node.js 内置 `node:sqlite`，零原生依赖）。

## 环境要求

- Node.js >= 22.5（开发使用 Node 25 验证；`node:sqlite` 目前带 ExperimentalWarning，不影响功能）
- 仅开发依赖 TypeScript（`npm install` 自动安装）

## 快速开始

```powershell
npm install
npm run build    # 编译 TypeScript 到 dist/
npm test         # 构建并运行全部测试
npm start        # 启动 HTTP API（默认端口 0 = 自动选择空闲端口）
npm run demo     # 运行固定种子演示（写入 data/demo.db）
```

自定义端口与数据文件：

```powershell
node dist/src/server.js --port=8080 --db=data\my.db
```

数据目录默认为项目内 `data/`，首次运行自动创建。

## 规则说明

- 棋盘为至少 3x3 的矩形，坐标一律为从零开始的 `(row, col)`。
- 格子状态：隐藏 / 插旗 / 已揭示。
- 首次点击安全布雷：第一个有效揭示动作发生时才生成雷位，排除该格及其棋盘内相邻八格，再用确定性 PRNG（FNV-1a 种子哈希 + mulberry32 + Fisher-Yates）从剩余位置无重复取样。因此雷数上限为 `行数 x 列数 - 9`，超出在创建时拒绝。
- 创建、查询、插旗/取消插旗都不会触发布雷；点击已插旗格被拒绝且仍然不布雷。同一配置 + 种子 + 首次位置必然得到相同布局，与输入时刻、进程重启无关。
- 两种揭示语义：
  - `reveal`（普通揭示）：揭开单个安全格；若周围雷数为 0，用队列洪水扩展到相邻零格及其数字边界。不会揭示插旗格，不会跨雷区打开远处零区。点到雷立即判负。
  - `chord`（数字格快速揭示）：目标必须是已揭示的数字格，且其周围旗数等于提示数时才允许；随后对所有未插旗、未揭示的邻格执行与普通揭示相同的动作（含洪水展开）。旗放错时会踩雷——只要本次动作中有一颗雷被揭开，整个动作原子完成并立即判负，绝不因为“旗数看起来对”而假定安全。
- 胜负：揭示全部非雷格即获胜（不要求给雷插旗）；踩雷即失败。终局后所有动作返回 `GAME_OVER`。终局后的局面查询会附带全部雷位供查看。

## 布局隐私范围

- `GET /games/:id`（公开局面）只包含每格的可见状态（隐藏/插旗/已揭示及已揭示格的数字），不包含未揭示格的雷位与数字、种子、PRNG 内部状态。运行中的对局不泄露任何布局信息。
- `GET /games/:id/admin` 是独立的管理员演示/测试取证入口，返回完整雷位与种子，响应中带显式警告字段，与普通局面接口完全分离。请勿将其用于真实对局的玩家侧。
- 终局（胜/负）后，公开局面与动作结果会附带全部雷位（`mines` / `minesRevealed`），用于复盘展示。

## HTTP API

所有响应为 JSON。错误格式：`{ "error": { "code": "...", "message": "..." } }`。

- `POST /games` 创建对局：`{rows, cols, mineCount, seed, fixtureMines?}`
- `GET /games` 列出对局摘要
- `GET /games/:id` 公开局面（含 `version`，不泄露雷位）
- `GET /games/:id/admin` 管理员取证视图（含完整雷位，仅演示/测试）
- `POST /games/:id/actions` 执行动作：`{actionId, type, row, col, expectedVersion}`
- `GET /games/:id/log` 动作记录（含首次布局摘要、新揭示格、旗变化、结果）
- `GET /games/:id/replay` 从日志确定性重放并校验最终状态哈希

说明：

- `type` 取值为 `reveal | flag | unflag | chord`。
- 幂等：`actionId` 在对局内唯一。重复提交相同 `actionId` 直接返回首次结果（`idempotentReplay: true`），不消耗版本号与随机数。
- 乐观并发：`expectedVersion` 必须等于当前 `version`，否则 409。每个成功动作使版本 +1。
- 非法动作整体回滚：不改棋盘、不写日志、不消耗版本。
- 首次布雷与首次揭示在同一 SQLite 事务内完成；服务重启后可继续对局，结果与不中断执行一致。

### 错误码

- `INVALID_PARAM`（400）：尺寸/雷数/坐标/字段非法（如雷数超过 总格数-9）
- `NOT_FOUND`（404）：对局不存在
- `VERSION_CONFLICT`（409）：期望版本与当前版本不一致
- `GAME_OVER`（409）：对局已结束，拒绝后续动作
- `ILLEGAL_ACTION`（422）：违反规则（点旗格、重复插旗、快速揭示旗数不符等）

### 示例

```powershell
$g = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/games -ContentType 'application/json' -Body '{"rows":9,"cols":9,"mineCount":10,"seed":"hello"}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/games/$($g.id)/actions" -ContentType 'application/json' -Body '{"actionId":"a1","type":"reveal","row":4,"col":4,"expectedVersion":0}'
```

## CLI

CLI 与 API 共用同一规则核心，直接操作本地 SQLite 文件（默认 `data/minesweeper.db`，可用 `--db=` 指定）：

```powershell
npm run build
node dist/src/cli.js create --rows=9 --cols=9 --mines=10 --seed=demo
node dist/src/cli.js list
node dist/src/cli.js state <id>                     # 字符棋盘 + 公开信息
node dist/src/cli.js reveal <id> 4 4                # 自动取当前版本；--expect=N 可显式指定
node dist/src/cli.js flag <id> 0 6 --action-id=f1   # --action-id 指定幂等编号
node dist/src/cli.js unflag <id> 0 6
node dist/src/cli.js chord <id> 0 5
node dist/src/cli.js log <id>
node dist/src/cli.js replay <id>
node dist/src/cli.js admin <id>                     # 管理员取证视图（含雷位）
node dist/src/cli.js create --rows=3 --cols=3 --mines=1 --seed=fx --fixture="[0]"   # 固定布局夹具（测试用）
```

字符棋盘图例：`.` 隐藏，`F` 插旗，`·` 已揭示空白（数字 0），`1`-`8` 数字提示，`*` 被揭开的雷。行首/列首为从零开始的坐标。

## 确定性设计

- PRNG 只以用户提供的种子字符串为输入（FNV-1a → mulberry32），不混入时间、进程或平台状态。
- 雷位在首次有效揭示时生成并持久化，之后固定不变；日志记录首次布局摘要 `layoutDigest`。
- `replay` 从初始配置重放全部日志动作，比对最终状态哈希，可验证日志完整性与实现确定性。

## 测试

`npm test` 覆盖：边角首次点击安全区、最大合法雷数、零雷、同种子复现、重复请求幂等、版本冲突、插旗阻止展开、终局拒绝动作、独立邻域枚举核对全部数字、可达零格集合核对展开边界、日志重放、模拟重启后继续对局、固定夹具盘的错旗踩雷与胜利判定。

## 已知限制

- `node:sqlite` 在 Node 25 仍标记为 experimental（启动时有警告，功能稳定）；如需消除警告可换成 `better-sqlite3`。
- 单进程写 SQLite（WAL 模式），未做跨进程并发互斥；定位为本地单机后端。
- 固定布局夹具（`fixtureMines`）是测试/演示入口，创建后布局同样不可修改。
