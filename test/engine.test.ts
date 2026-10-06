import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  applyAction, countAdjacentMines, createGame, generateMines,
  neighborsOf, publicView, stateHash, GameState,
} from "../src/engine";
import { Store } from "../src/store";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ms-")), "test.db");
}

function act(state: GameState, type: any, row: number, col: number, expectedVersion?: number) {
  return applyAction(state, {
    actionId: `${type}-${row}-${col}-${state.version}`,
    type, row, col,
    expectedVersion: expectedVersion ?? state.version,
  });
}

// ---------- 布雷确定性 ----------

test("同种子同首次位置布局一致；不同种子一般不同", () => {
  const a = createGame("a", 9, 9, 10, "seed-x");
  const b = createGame("b", 9, 9, 10, "seed-x");
  generateMines(a, 40);
  generateMines(b, 40);
  assert.deepEqual([...a.mines].sort((x, y) => x - y), [...b.mines].sort((x, y) => x - y));
  const c = createGame("c", 9, 9, 10, "seed-y");
  generateMines(c, 40);
  assert.notDeepEqual([...c.mines].sort((x, y) => x - y), [...a.mines].sort((x, y) => x - y));
  assert.equal(a.mines.size, 10); // 无重复取样
});

test("首次点击排除自身与八邻域（含边角）", () => {
  for (const first of [0, 8, 72, 80, 40]) {
    const g = createGame("g", 9, 9, 10, "corner-test");
    generateMines(g, first);
    const excluded = new Set([first, ...neighborsOf(first, 9, 9)]);
    for (const m of g.mines) assert.ok(!excluded.has(m), `雷 ${m} 落在首点 ${first} 排除区`);
  }
});

test("最大合法雷数 = 总格数-9；超限拒绝", () => {
  const g = createGame("g", 3, 3, 0, "s"); // 3x3 只允许 0 雷
  assert.equal(g.mineCount, 0);
  assert.throws(() => createGame("g", 3, 3, 1, "s"));
  const g2 = createGame("g2", 4, 4, 7, "s"); // 16-9=7
  generateMines(g2, 0);
  assert.equal(g2.mines.size, 7);
  assert.throws(() => createGame("g3", 4, 4, 8, "s"));
});

test("零雷对局：首次点击展开全盘并直接获胜", () => {
  const g = createGame("g", 5, 5, 0, "zero");
  const res = act(g, "reveal", 2, 2);
  assert.equal(res.status, "won");
  assert.equal(g.revealed.size, 25);
});

// ---------- 数字与展开（独立邻域枚举核对） ----------

function bruteForceNumber(mines: Set<number>, i: number, rows: number, cols: number): number {
  const r = Math.floor(i / cols), c = i % cols;
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (dr === 0 && dc === 0) continue;
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && mines.has(nr * cols + nc)) n++;
  }
  return n;
}

test("所有格数字与独立邻域枚举一致", () => {
  const mines = new Set([0, 5, 11, 20, 34, 55, 70, 79, 42, 63]);
  const g = createGame("g", 9, 9, 10, "s", [...mines]);
  for (let i = 0; i < 81; i++) {
    assert.equal(countAdjacentMines(i, g.mines, 9, 9), bruteForceNumber(mines, i, 9, 9), `cell ${i}`);
  }
});

test("洪水展开边界 = 可达零格集合及其数字边界", () => {
  const rows = 6, cols = 6;
  const mines = new Set([0, 35]); // 两角落雷，中间大片零区
  const g = createGame("g", rows, cols, 2, "s", [...mines]);
  const res = act(g, "reveal", 3, 3);
  // 独立计算：从 (3,3) 出发经零格连通的零格集合 Z，展开集 = Z ∪ Z 的邻域（排除雷）
  const num = (i: number) => bruteForceNumber(mines, i, rows, cols);
  const zeroSet = new Set<number>();
  const stack = [3 * cols + 3];
  const seen = new Set(stack);
  while (stack.length) {
    const cur = stack.pop()!;
    if (num(cur) !== 0) continue;
    zeroSet.add(cur);
    for (const nb of neighborsOf(cur, rows, cols)) {
      if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  const expected = new Set(zeroSet);
  for (const z of zeroSet) for (const nb of neighborsOf(z, rows, cols)) {
    if (!mines.has(nb)) expected.add(nb);
  }
  assert.deepEqual(new Set(res.newlyRevealed), expected);
  assert.ok(![...res.newlyRevealed!].some((i) => mines.has(i)));
});

test("插旗格阻止展开穿过", () => {
  const g = createGame("g", 3, 3, 0, "s", []);
  act(g, "flag", 0, 0);
  const res = act(g, "reveal", 2, 2);
  assert.ok(!res.newlyRevealed!.includes(0));
  assert.ok(g.flagged.has(0));
});

// ---------- 快速揭示 ----------

test("快速揭示：旗数不符拒绝；旗数符合但旗错会踩雷判负", () => {
  const g = createGame("g", 3, 3, 1, "s", [0]);
  act(g, "reveal", 1, 1);
  assert.throws(() => act(g, "chord", 1, 1), (e: any) => e.code === "ILLEGAL_ACTION"); // 旗数 0 != 1
  act(g, "flag", 0, 1); // 错旗
  const res = act(g, "chord", 1, 1);
  assert.equal(res.hitMine, true);
  assert.equal(g.status, "lost");
});

test("快速揭示：正确插旗后揭开其余邻格", () => {
  const g = createGame("g", 3, 3, 1, "s", [0]);
  act(g, "reveal", 1, 1);
  act(g, "flag", 0, 0);
  const res = act(g, "chord", 1, 1);
  assert.equal(res.hitMine, undefined);
  assert.ok(!g.revealed.has(0)); // 旗格不动
  assert.equal(g.status, "won"); // 其余安全格全揭
});

// ---------- 胜负与终局 ----------

test("踩雷判负后所有动作被拒绝", () => {
  const g = createGame("g", 3, 3, 1, "s", [4]);
  act(g, "reveal", 0, 0);
  const res = act(g, "reveal", 1, 1);
  assert.equal(res.hitMine, true);
  assert.equal(g.status, "lost");
  assert.ok(res.minesRevealed!.includes(4));
  assert.throws(() => act(g, "reveal", 0, 1), (e: any) => e.code === "GAME_OVER");
  assert.throws(() => act(g, "flag", 0, 1), (e: any) => e.code === "GAME_OVER");
});

test("胜利不要求插旗；运行中公开视图不泄露雷位", () => {
  const g = createGame("g", 3, 3, 1, "s", [0]);
  for (let i = 1; i < 9 && g.status !== "won"; i++) act(g, "reveal", Math.floor(i / 3), i % 3);
  assert.equal(g.status, "won");
  assert.equal(g.flagged.size, 0);

  const g2 = createGame("g2", 9, 9, 10, "privacy");
  act(g2, "reveal", 4, 4);
  const view = publicView(g2);
  assert.equal((view as any).mines, undefined);
  assert.equal((view as any).seed, undefined);
  for (const cell of view.cells) {
    if (cell.state !== "revealed") assert.equal((cell as any).adjacentMines, undefined);
  }
});

// ---------- 动作校验 ----------

test("点击已插旗格拒绝且不触发布雷", () => {
  const g = createGame("g", 9, 9, 10, "s");
  act(g, "flag", 3, 3);
  assert.equal(g.generated, false);
  assert.throws(() => act(g, "reveal", 3, 3), (e: any) => e.code === "ILLEGAL_ACTION");
  assert.equal(g.generated, false); // 仍未布雷，未消耗随机数
  assert.equal(g.version, 1); // 非法动作不消耗版本
});

test("版本冲突与坐标/参数校验", () => {
  const g = createGame("g", 9, 9, 10, "s");
  assert.throws(() => act(g, "reveal", 0, 0, 5), (e: any) => e.code === "VERSION_CONFLICT");
  assert.throws(() => act(g, "reveal", -1, 0), (e: any) => e.code === "INVALID_PARAM");
  assert.throws(() => act(g, "reveal", 9, 0), (e: any) => e.code === "INVALID_PARAM");
  assert.equal(g.version, 0);
});

// ---------- 持久化：幂等 / 日志 / 重放 / 重启 ----------

test("重复 actionId 幂等：不消耗版本与随机数", () => {
  const store = new Store(tmpDb());
  const g = store.createGame(9, 9, 10, "idem");
  const a = { actionId: "act-1", type: "reveal" as const, row: 4, col: 4, expectedVersion: 0 };
  const r1 = store.applyAction(g.id, a);
  const r2 = store.applyAction(g.id, a);
  assert.equal(r2.replayed, true);
  assert.equal(store.getGame(g.id).version, 1);
  assert.deepEqual(r1.result, r2.result);
  store.close();
});

test("非法动作不写日志不改棋盘", () => {
  const store = new Store(tmpDb());
  const g = store.createGame(9, 9, 10, "bad");
  assert.throws(() => store.applyAction(g.id, {
    actionId: "x", type: "reveal", row: 4, col: 4, expectedVersion: 99,
  }), (e: any) => e.code === "VERSION_CONFLICT");
  assert.equal(store.getGame(g.id).version, 0);
  assert.equal(store.getLog(g.id).length, 0);
  store.close();
});

test("日志记录首次布局摘要，重放校验一致", () => {
  const store = new Store(tmpDb());
  const g = store.createGame(9, 9, 10, "replay-seed");
  store.applyAction(g.id, { actionId: "a1", type: "reveal", row: 4, col: 4, expectedVersion: 0 });
  store.applyAction(g.id, { actionId: "a2", type: "flag", row: 0, col: 0, expectedVersion: 1 });
  const log = store.getLog(g.id);
  assert.equal(log.length, 2);
  assert.ok(log[0].result.layoutDigest); // 首次布雷摘要
  assert.equal(log[0].result.generatedNow, true);
  assert.ok(!log[1].result.layoutDigest); // 后续动作不再布雷
  const replay = store.replay(g.id);
  assert.equal(replay.ok, true, replay.message ?? "");
  store.close();
});

test("重启后继续对局与不中断一致", () => {
  const db = tmpDb();
  const s1 = new Store(db);
  const g = s1.createGame(9, 9, 10, "restart");
  s1.applyAction(g.id, { actionId: "a1", type: "reveal", row: 4, col: 4, expectedVersion: 0 });
  const hashBefore = stateHash(s1.getGame(g.id));
  s1.close();

  const s2 = new Store(db); // 模拟进程重启
  const restored = s2.getGame(g.id);
  assert.equal(stateHash(restored), hashBefore);
  // 找一个未揭示的格子插旗
  let flagCell = -1;
  for (let i = 0; i < 81; i++) if (!restored.revealed.has(i)) { flagCell = i; break; }
  s2.applyAction(g.id, { actionId: "a2", type: "flag", row: Math.floor(flagCell / 9), col: flagCell % 9, expectedVersion: 1 });
  assert.equal(s2.replay(g.id).ok, true);
  s2.close();

  // 对照：不中断执行同样动作序列
  const s3 = new Store(tmpDb());
  const g3 = s3.createGame(9, 9, 10, "restart");
  s3.applyAction(g3.id, { actionId: "a1", type: "reveal", row: 4, col: 4, expectedVersion: 0 });
  s3.applyAction(g3.id, { actionId: "a2", type: "flag", row: Math.floor(flagCell / 9), col: flagCell % 9, expectedVersion: 1 });
  const a = s3.getGame(g3.id);
  const b = new Store(db).getGame(g.id);
  assert.deepEqual([...a.mines].sort(), [...b.mines].sort());
  assert.deepEqual([...a.revealed].sort(), [...b.revealed].sort());
  assert.deepEqual([...a.flagged].sort(), [...b.flagged].sort());
  s3.close();
});

test("同种子跨进程复现（两次独立建库布局一致）", () => {
  const layouts: number[][] = [];
  for (let i = 0; i < 2; i++) {
    const store = new Store(tmpDb());
    const g = store.createGame(9, 9, 10, "repro");
    store.applyAction(g.id, { actionId: "a1", type: "reveal", row: 2, col: 2, expectedVersion: 0 });
    layouts.push([...store.getGame(g.id).mines].sort((x, y) => x - y));
    store.close();
  }
  assert.deepEqual(layouts[0], layouts[1]);
});
