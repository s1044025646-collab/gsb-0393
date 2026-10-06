// CLI：直接操作本地 SQLite（与 API 共用同一规则核心）。
// 用法示例：
//   node dist/src/cli.js create --rows=9 --cols=9 --mines=10 --seed=demo
//   node dist/src/cli.js state <id>
//   node dist/src/cli.js reveal <id> <row> <col> [--expect=N] [--action-id=xxx]
//   node dist/src/cli.js flag|unflag|chord <id> <row> <col> ...
//   node dist/src/cli.js log <id> | replay <id> | list | admin <id>
import * as path from "node:path";
import * as crypto from "node:crypto";
import { publicView } from "./engine";
import { renderBoard } from "./render";
import { Store, defaultDataDir } from "./store";

function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      opts[k] = v ?? "true";
    } else positional.push(a);
  }
  return { positional, opts };
}

function main(): void {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const dbPath = opts.db ?? path.join(defaultDataDir(), "minesweeper.db");
  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case "create": {
        const rows = Number(opts.rows), cols = Number(opts.cols), mines = Number(opts.mines);
        const seed = String(opts.seed ?? "default");
        const fixture = opts.fixture ? (JSON.parse(opts.fixture) as number[]) : undefined;
        const state = store.createGame(rows, cols, mines, seed, fixture);
        console.log(`已创建对局 ${state.id}`);
        console.log(renderBoard(state));
        break;
      }
      case "list": {
        console.log(JSON.stringify(store.listGames(), null, 2));
        break;
      }
      case "state": {
        const state = store.getGame(positional[1]);
        console.log(renderBoard(state));
        console.log(JSON.stringify({ ...publicView(state), cells: undefined }, null, 2));
        break;
      }
      case "admin": {
        const state = store.getGame(positional[1]);
        console.log("【管理员取证视图：含完整雷位，仅供演示/测试】");
        console.log(JSON.stringify({ mines: [...state.mines].sort((a, b) => a - b), seed: state.seed }, null, 2));
        break;
      }
      case "reveal": case "flag": case "unflag": case "chord": {
        const id = positional[1];
        const row = Number(positional[2]);
        const col = Number(positional[3]);
        const current = store.getGame(id);
        const expectedVersion = opts.expect !== undefined ? Number(opts.expect) : current.version;
        const actionId = opts["action-id"] ?? crypto.randomUUID();
        const { result, replayed } = store.applyAction(id, {
          actionId, type: cmd, row, col, expectedVersion,
        });
        console.log(JSON.stringify({ ...result, idempotentReplay: replayed }, null, 2));
        console.log(renderBoard(store.getGame(id)));
        break;
      }
      case "log": {
        console.log(JSON.stringify(store.getLog(positional[1]), null, 2));
        break;
      }
      case "replay": {
        console.log(JSON.stringify(store.replay(positional[1]), null, 2));
        break;
      }
      default:
        console.error("未知命令。可用: create|list|state|admin|reveal|flag|unflag|chord|log|replay");
        process.exitCode = 1;
    }
  } catch (err: any) {
    if (err && err.code) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exitCode = 2;
    } else throw err;
  } finally {
    store.close();
  }
}

main();
