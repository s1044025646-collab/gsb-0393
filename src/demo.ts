import { generateLayout, idx, neighborsOf } from "./engine";
import { Store } from "./store";
import { renderBoard } from "./cli";

const store = new Store(":memory:");
let n = 0;
const aid = () => `demo-${++n}`;

function show(title: string, id: string): void {
  const v = store.publicView(id);
  console.log(`\n== ${title} == 状态=${v.status} 版本=${v.version}`);
  console.log(renderBoard(v));
}

// 场景一：固定种子开局，首点出空白区域，插旗后快速揭示
{
  const cfg = { rows: 9, cols: 9, mines: 10, seed: "demo-seed-1" };
  const { id } = store.createGame(cfg);
  let ver = 0;
  // 找一个首点能开出空白（数字 0）的位置
  let first = { r: 0, c: 0 };
  outer: for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const layout = generateLayout(cfg, r, c);
    if (layout.numbers[idx(r, c, 9)] === 0) { first = { r, c }; break outer; }
  }
  let r = store.applyAction(id, { type: "reveal", row: first.r, col: first.c, expectedVersion: ver, actionId: aid() });
  ver = r.version;
  show(`场景1: 固定种子首点 (${first.r},${first.c}) 展开空白`, id);

  // 在已揭示数字旁找一颗确定雷插旗，然后快速揭示
  const layout = generateLayout(cfg, first.r, first.c);
  const view = store.publicView(id);
  let done = false;
  for (let i = 0; i < view.cells.length && !done; i++) {
    if (typeof view.cells[i] !== "number" || (view.cells[i] as number) <= 0) continue;
    const rr = Math.floor(i / 9), cc = i % 9;
    const nbs = neighborsOf(i, 9, 9);
    const hidden = nbs.filter((x) => !store.publicView(id).cells[x] || view.cells[x] === "hidden");
    const mineNbs = hidden.filter((x) => layout.mines.has(x));
    if (mineNbs.length > 0 && hidden.length > mineNbs.length) {
      const m = mineNbs[0];
      r = store.applyAction(id, { type: "flag", row: Math.floor(m / 9), col: m % 9, expectedVersion: ver, actionId: aid() });
      ver = r.version;
      show(`场景1: 在 (${Math.floor(m / 9)},${m % 9}) 插旗`, id);
      r = store.applyAction(id, { type: "chord", row: rr, col: cc, expectedVersion: ver, actionId: aid() });
      ver = r.version;
      show(`场景1: 数字格 (${rr},${cc}) 快速揭示`, id);
      done = true;
    }
  }
  const rp = store.replay(id);
  console.log(`场景1 重放验证: ${rp.ok ? "通过" : "失败"}（${rp.steps} 步）`);
}

// 场景二：固定测试盘——错旗踩雷
{
  const cfg = { rows: 5, cols: 5, mines: 3, seed: "fixture-loss" };
  const { id } = store.createGame(cfg);
  let ver = 0;
  const layout = generateLayout(cfg, 0, 0);
  let r = store.applyAction(id, { type: "reveal", row: 0, col: 0, expectedVersion: ver, actionId: aid() });
  ver = r.version;
  // 找一个已揭示数字格，其隐藏邻格中有一颗雷和一个安全格；把旗插到安全格上（错旗），再 chord 踩雷
  const view = store.publicView(id);
  for (let i = 0; i < view.cells.length; i++) {
    if (typeof view.cells[i] !== "number" || (view.cells[i] as number) <= 0) continue;
    const num = view.cells[i] as number;
    const nbs = neighborsOf(i, 5, 5).filter((x) => view.cells[x] === "hidden");
    const mineNbs = nbs.filter((x) => layout.mines.has(x));
    const safeNbs = nbs.filter((x) => !layout.mines.has(x));
    if (mineNbs.length === num && safeNbs.length > 0) {
      // 先给真雷插旗，再把一面旗插到安全格上凑数（错旗）
      for (const m of mineNbs.slice(0, num - 1)) {
        r = store.applyAction(id, { type: "flag", row: Math.floor(m / 5), col: m % 5, expectedVersion: ver, actionId: aid() });
        ver = r.version;
      }
      const wrong = safeNbs[0];
      r = store.applyAction(id, { type: "flag", row: Math.floor(wrong / 5), col: wrong % 5, expectedVersion: ver, actionId: aid() });
      ver = r.version;
      const rr = Math.floor(i / 5), cc = i % 5;
      r = store.applyAction(id, { type: "chord", row: rr, col: cc, expectedVersion: ver, actionId: aid() });
      show(`场景2: 错旗后快速揭示 (${rr},${cc}) 踩雷判负`, id);
      break;
    }
  }
}

// 场景三：固定测试盘——只揭示所有安全格获胜（无需全部插旗）
{
  const cfg = { rows: 4, cols: 4, mines: 3, seed: "fixture-win" };
  const { id } = store.createGame(cfg);
  let ver = 0;
  const layout = generateLayout(cfg, 0, 0);
  let r = store.applyAction(id, { type: "reveal", row: 0, col: 0, expectedVersion: ver, actionId: aid() });
  ver = r.version;
  for (let i = 0; i < 16 && r.status === "playing"; i++) {
    if (layout.mines.has(i)) continue;
    if (store.publicView(id).cells[i] !== "hidden") continue;
    r = store.applyAction(id, { type: "reveal", row: Math.floor(i / 4), col: i % 4, expectedVersion: ver, actionId: aid() });
    ver = r.version;
  }
  show("场景3: 揭示全部安全格获胜（未插任何旗）", id);
}

store.close();
