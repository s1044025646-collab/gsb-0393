// 演示脚本：固定种子开局 -> 空白展开 -> 插旗+快速揭示；
// 再用固定测试盘演示错旗踩雷 与 只揭示安全格获胜。
import * as path from "node:path";
import * as fs from "node:fs";
import { Store, defaultDataDir } from "./store";
import { renderBoard } from "./render";
import { countAdjacentMines, neighborsOf } from "./engine";

const dbPath = path.join(defaultDataDir(), "demo.db");
fs.rmSync(dbPath, { force: true });
const store = new Store(dbPath);

function act(id: string, type: any, row: number, col: number, actionId: string) {
  const v = store.getGame(id).version;
  const { result } = store.applyAction(id, { actionId, type, row, col, expectedVersion: v });
  return result;
}

console.log("=== 演示 1：固定种子开局，首次点出空白区域 ===");
const g1 = store.createGame(9, 9, 10, "demo-seed-1");
console.log(`对局 ${g1.id}（9x9，10 雷，seed=demo-seed-1）`);
// 找一个首次点击能开出空白的位置：布雷后邻域无雷的安全格。
// 先试 (4,4)，若展开少于 5 格则换种子重开（演示确定性，只试固定几个候选）。
let game = g1;
let first: [number, number] = [4, 4];
for (const seed of ["demo-seed-1", "demo-seed-2", "demo-seed-3", "demo-seed-4"]) {
  const candidate = seed === "demo-seed-1" ? g1 : store.createGame(9, 9, 10, seed);
  const res = act(candidate.id, "reveal", 4, 4, `demo-first-${seed}`);
  if ((res.newlyRevealed ?? []).length >= 5) {
    game = candidate;
    break;
  }
}
console.log(renderBoard(store.getGame(game.id)));

console.log("\n=== 演示 2：插旗后快速揭示 ===");
{
  const state = store.getGame(game.id);
  // 找一个已揭示数字格，其邻域恰有一个隐藏格且该格是雷 -> 插旗后 chord。
  let done = false;
  for (const cell of state.revealed) {
    const r = Math.floor(cell / state.cols), c = cell % state.cols;
    const n = countAdjacentMines(cell, state.mines, state.rows, state.cols);
    if (n !== 1) continue;
    const hidden = neighborsOf(cell, state.rows, state.cols).filter(
      (x) => !state.revealed.has(x) && !state.flagged.has(x));
    const hiddenMines = hidden.filter((x) => state.mines.has(x));
    if (hidden.length >= 2 && hiddenMines.length === 1) {
      const mine = hiddenMines[0];
      act(game.id, "flag", Math.floor(mine / state.cols), mine % state.cols, "demo-flag-1");
      console.log(`在 (${Math.floor(mine / state.cols)},${mine % state.cols}) 插旗后，对 (${r},${c}) 快速揭示：`);
      act(game.id, "chord", r, c, "demo-chord-1");
      console.log(renderBoard(store.getGame(game.id)));
      done = true;
      break;
    }
  }
  if (!done) console.log("（本盘未找到合适的演示点，跳过）");
}

console.log("\n=== 演示 3：固定测试盘 —— 错旗后快速揭示踩雷 ===");
{
  // 3x3，雷在 0 号格（0,0）。(1,1) 的数字为 1；在 (0,1) 错插旗后对 (1,1) chord 会踩到 (0,0)。
  const g = store.createGame(3, 3, 1, "fixture", [0]);
  act(g.id, "reveal", 1, 1, "fx1-reveal");
  act(g.id, "flag", 0, 1, "fx1-flag"); // 错旗：(0,1) 不是雷
  const res = act(g.id, "chord", 1, 1, "fx1-chord"); // 旗数==1==提示数，揭开 (0,0) 雷
  console.log(`结果: hitMine=${res.hitMine} status=${res.status}`);
  console.log(renderBoard(store.getGame(g.id)));
}

console.log("\n=== 演示 4：固定测试盘 —— 只揭示全部安全格即获胜（无需插旗） ===");
{
  const g = store.createGame(3, 3, 1, "fixture", [0]);
  let n = 0;
  for (let i = 1; i < 9 && store.getGame(g.id).status !== "won"; i++) {
    act(g.id, "reveal", Math.floor(i / 3), i % 3, `fx2-reveal-${n++}`);
  }
  const st = store.getGame(g.id);
  console.log(`结果: status=${st.status}（雷格从未揭示也从未插旗）`);
  console.log(renderBoard(st));
}

console.log(`\n演示数据已写入 ${dbPath}`);
store.close();
