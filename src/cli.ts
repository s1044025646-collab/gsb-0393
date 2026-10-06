import { Store, defaultDbPath } from "./store";

export function renderBoard(view: { rows: number; cols: number; cells: unknown[] }): string {
  const lines: string[] = [];
  const header = "   " + Array.from({ length: view.cols }, (_, c) => c % 10).join(" ");
  lines.push(header);
  for (let r = 0; r < view.rows; r++) {
    const rowCells: string[] = [];
    for (let c = 0; c < view.cols; c++) {
      const v = view.cells[r * view.cols + c];
      rowCells.push(v === "hidden" ? "." : v === "flag" ? "F" : v === "mine" ? "*" : v === 0 ? " " : String(v));
    }
    lines.push(String(r).padStart(2) + " " + rowCells.join(" "));
  }
  return lines.join("\n");
}

function usage(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
  create <rows> <cols> <mines> <seed>   创建对局
  state <id>                            查看公开局面（字符棋盘）
  admin <id>                            管理员取证视图（完整棋盘）
  reveal <id> <row> <col> <ver> <aid>   揭示
  chord  <id> <row> <col> <ver> <aid>   数字格快速揭示
  flag   <id> <row> <col> <ver> <aid>   插旗
  unflag <id> <row> <col> <ver> <aid>   取消旗
  log <id>                              动作记录
  replay <id>                           重放验证`);
}

export function runCli(argv: string[], store: Store): void {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "create": {
        const [rows, cols, mines, seed] = args;
        const out = store.createGame({ rows: +rows, cols: +cols, mines: +mines, seed });
        console.log(`已创建对局 ${out.id}（版本 ${out.version}）`);
        break;
      }
      case "state": {
        const v = store.publicView(args[0]);
        console.log(`对局 ${v.id} 状态=${v.status} 版本=${v.version} 已布雷=${v.generated}`);
        console.log(renderBoard(v));
        break;
      }
      case "admin":
        console.log(JSON.stringify(store.adminView(args[0]), null, 2));
        break;
      case "reveal": case "chord": case "flag": case "unflag": {
        const [id, row, col, ver, aid] = args;
        const r = store.applyAction(id, {
          type: cmd, row: +row, col: +col, expectedVersion: +ver, actionId: aid,
        });
        console.log(`结果: 状态=${r.status} 版本=${r.version} 新揭示=${r.revealed.length} 旗变化=${r.flagChanged.length}`);
        if (r.mines) console.log(`雷位: ${r.mines.join(",")}`);
        console.log(renderBoard(store.publicView(id)));
        break;
      }
      case "log":
        for (const e of store.actionLog(args[0])) {
          console.log(`#${e.seq} v${e.versionAfter} ${e.actionId} ${e.payload} -> ${e.result}`);
        }
        break;
      case "replay": {
        const r = store.replay(args[0]);
        console.log(r.ok ? `重放验证通过（${r.steps} 步）` : `重放验证失败！\n${r.finalDigest}\n${r.storedDigest}`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      default:
        usage();
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error(`错误 [${err.code ?? "INTERNAL"}] ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  const store = new Store(defaultDbPath());
  runCli(process.argv.slice(2), store);
  store.close();
}
