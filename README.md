# 确定性扫雷后端（TypeScript + Node.js + SQLite）

纯后端实现：可复现的布雷、连锁揭示、快速揭示、胜负判定、动作日志与重放验证。只做 API 与 CLI，无网页、无自动解题、无多人竞技。

## 运行要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，无需 Docker / WSL / 外部服务）
- 首次使用执行 `npm install`（仅安装 TypeScript 与类型定义）

## 命令

```powershell
npm run build    # 编译 TypeScript 到 dist/
npm test         # 构建并运行全部测试
npm start        # 启动 HTTP API（默认端口 0：自动选择空闲端口；PORT=8080 可指定）
npm run demo     # 固定种子演示：空白展开、插旗+快速揭示、错旗踩雷、全安全格获胜
npm run cli -- create 9 9 10 my-seed   # CLI 示例（数据存于项目内 data/ 目录）
```

数据目录默认为项目下 `data/minesweeper.db`，可用环境变量 `MINESWEEPER_DB` 覆盖。

## 确定性规则

- 创建对局只记录 `rows/cols/mines/seed`，**不生成雷位**。
- 首次有效揭示（reveal）时才布雷：排除首点及其棋盘内相邻八格，在剩余位置用公开算法无重复取样：
  种子字符串 → FNV-1a(32) 哈希 → splitmix32 伪随机流 → Fisher-Yates 部分洗牌（见 `src/rng.ts`）。
- 雷数上限为 `rows*cols-9`，保证任意首点（含边角）都能安全布雷。
- 同一配置 + 种子 + 首次位置必然得到同一布局；与输入时刻、进程重启无关。
- 创建、查询、插旗/取消旗不消耗布雷随机数；点击已插旗格被拒绝且仍未布雷。
- 首次布雷与首次揭示在同一个 SQLite 事务内完成，重启后继续对局与不中断一致。

## 两种揭示语义

- **reveal（揭示）**：打开一个未插旗隐藏格。若是雷则判负；否则显示真实周围雷数；
  数字为 0 时用 BFS 自动扩展到相邻零格及其边界数字格。已插旗格永不被动展开。
- **chord（快速揭示）**：只能用于已揭示的数字格，且周围旗数必须等于提示数，
  否则拒绝。满足条件时对所有未插旗邻格执行与 reveal 相同的展开逻辑。
  **旗放错时可能踩雷**——动作原子完成，一次快速揭示中只要打开任意雷格即判负。

胜负：打开全部非雷格即获胜（不要求插旗）；踩雷即判负，终局后所有动作被拒绝。
终局响应附带全部雷位供查看。

## 布局隐私范围

- `GET /games/:id`（公开局面）：每格仅返回 `hidden` / `flag` / 数字（已揭示）；
  终局后额外显示 `mine`。运行中**不泄露**未揭示格的雷位、数字或随机内部状态。
- `GET /games/:id/admin`（管理员/测试取证入口）：返回完整底层棋盘（雷位与全部数字），
  与公开接口明确分离，仅用于演示与测试核对。

## HTTP API

坐标一律为从零开始的 `row`/`col`。错误返回 `{"error": 错误码, "message": 描述}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/games` | 创建对局 `{rows, cols, mines, seed}` → `{id, version}` |
| GET | `/games/:id` | 公开局面（含 `version`、`status`、`cells`） |
| GET | `/games/:id/admin` | 管理员取证视图（完整棋盘） |
| POST | `/games/:id/actions` | 执行动作（见下） |
| GET | `/games/:id/log` | 动作日志（动作、首次布局摘要、新揭示格、旗变化、结果） |
| POST | `/games/:id/replay` | 从配置与日志重放并校验最终状态摘要 |

动作请求体：

```json
{"actionId": "唯一幂等编号", "expectedVersion": 0, "type": "reveal|flag|unflag|chord", "row": 3, "col": 4}
```

- `expectedVersion` 与当前版本不一致 → `VERSION_CONFLICT`，棋盘不变。
- 同一 `actionId` 重复提交同一动作 → 直接返回首次结果，不重复消耗版本或随机数；
  同一 `actionId` 提交不同动作 → `ACTION_ID_CONFLICT`。
- 非法动作（越界、点旗格、重复插旗、终局后操作等）不改变棋盘。

错误码：`INVALID_PARAMS`(400)、`GAME_NOT_FOUND`(404)、`VERSION_CONFLICT` / `GAME_OVER` /
`CELL_FLAGGED` / `CELL_REVEALED` / `CHORD_NOT_ALLOWED` / `INVALID_ACTION` / `ACTION_ID_CONFLICT`(409)。

## CLI

```powershell
node dist/src/cli.js create <rows> <cols> <mines> <seed>
node dist/src/cli.js state <id>                          # 字符棋盘：. 隐藏  F 旗  * 雷  空格=0
node dist/src/cli.js reveal|chord|flag|unflag <id> <row> <col> <expectedVersion> <actionId>
node dist/src/cli.js log <id>
node dist/src/cli.js replay <id>
node dist/src/cli.js admin <id>                          # 取证视图
```

## 测试覆盖（`test/engine.test.ts`，14 例）

边角首点安全、最大合法雷数、零雷、数字独立邻域枚举核对、展开边界与可达零格集合核对、
插旗阻止展开、点旗格不触发布雷、创建/查询/插旗不耗随机数、重复请求幂等、版本冲突、
终局动作拒绝、错旗 chord 踩雷、旗数不足拒绝、只揭示安全格获胜、公开视图隐私、
日志重放验证、重启续局、同种子复现。

## 已知限制

- 使用 Node 内置 `node:sqlite`（当前为实验性 API，启动时有 ExperimentalWarning，不影响功能）。
- 单进程本地服务，无鉴权；管理员取证接口仅靠路径区分，生产部署需自行加访问控制。
- 棋盘上限 100000 格，防止资源滥用。
