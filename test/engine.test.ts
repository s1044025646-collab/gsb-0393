import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateLayout, neighborsOf, idx, GameError } from "../src/engine";
import { Store, ActionInput } from "../src/store";

const mem = () => new Store(":memory:");
let n = 0;
const aid = () => `t-${++n}`;

function act(store: Store, id: string, type: ActionInput["type"], row: number, col: number, ver: number) {
  return store.applyAction(id, { type, row, col, expectedVersion: ver, actionId: aid() });
}

test("参数校验：尺寸与雷数上限", () => {
  const s = mem();
  assert.throws(() => s.createGame({ rows: 2, cols: 3, mines: 0, seed: "x" }), /INVALID_PARAMS|至少/);
  assert.throws(() => s.createGame({ rows: 3, cols: 3, mines: 1, seed: "x" }), /雷数/); // 9-9=0
  assert.throws(() => s.createGame({ rows: 3, cols: 3, mines: -1, seed: "x" }));
  const ok = s.createGame({ rows: 3, cols: 3, mines: 0, seed: "x" });
  assert.equal(ok.version, 0);
});

test("同种子同首点布局一致，且首点八邻域无雷（含边角）", () => {
  for (const [r, c] of [[0, 0], [0, 8], [8, 0], [8, 8], [4, 4]]) {
    const cfg = { rows: 9, cols: 9, mines: 10, seed: "corner" };
    const a = generateLayout(cfg, r, c);
    const b = generateLayout(cfg, r, c);
    assert.deepEqual([...a.mines].sort(), [...b.mines].sort());
    const first = idx(r, c, 9);
    for (const cell of [first, ...neighborsOf(first, 9, 9)]) {
      assert.equal(a.mines.has(cell), false, `首点邻域含雷 at ${cell}`);
    }
  }
});

test("最大合法雷数与零雷", () => {
  const cfg = { rows: 3, cols: 4, mines: 3, seed: "max" }; // 12-9=3
  const layout = generateLayout(cfg, 0, 0);
  assert.equal(layout.mines.size, 3);
  const zero = generateLayout({ rows: 5, cols: 5, mines: 0, seed: "zero" }, 2, 2);
  assert.equal(zero.mines.size, 0);
  // 零雷：首点直接全盘展开获胜
  const s = mem();
  const { id } = s.createGame({ rows: 5, cols: 5, mines: 0, seed: "zero" });
  const r = act(s, id, "reveal", 2, 2, 0);
  assert.equal(r.status, "won");
  assert.equal(r.revealed.length, 25);
});

test("数字与独立邻域枚举一致", () => {
  const cfg = { rows: 10, cols: 10, mines: 20, seed: "numbers" };
  const layout = generateLayout(cfg, 3, 3);
  for (let i = 0; i < 100; i++) {
    if (layout.mines.has(i)) { assert.equal(layout.numbers[i], -1); continue; }
    let count = 0;
    const r = Math.floor(i / 10), c = i % 10;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nr = r + dr, nc = c + dc;
      if (dr === 0 && dc === 0) continue;
      if (nr < 0 || nr >= 10 || nc < 0 || nc >= 10) continue;
      if (layout.mines.has(nr * 10 + nc)) count++;
    }
    assert.equal(layout.numbers[i], count);
  }
});

test("展开边界等于可达零格集合闭包", () => {
  const cfg = { rows: 9, cols: 9, mines: 10, seed: "expand" };
  // 找一个首点为 0 的位置
  let first = 0;
  for (let i = 0; i < 81; i++) {
    const l = generateLayout(cfg, Math.floor(i / 9), i % 9);
    if (l.numbers[i] === 0) { first = i; break; }
  }
  const layout = generateLayout(cfg, Math.floor(first / 9), first % 9);
  const s = mem();
  const { id } = s.createGame(cfg);
  const r = act(s, id, "reveal", Math.floor(first / 9), first % 9, 0);
  // 独立计算：从零格 BFS，边界数字属于集合但不扩展
  const expected = new Set<number>();
  const q = [first];
  while (q.length) {
    const cur = q.pop()!;
    if (expected.has(cur)) continue;
    expected.add(cur);
    if (layout.numbers[cur] === 0) {
      for (const nb of neighborsOf(cur, 9, 9)) if (!layout.mines.has(nb)) q.push(nb);
    }
  }
  assert.deepEqual([...r.revealed].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  for (const cell of r.revealed) assert.equal(layout.mines.has(cell), false);
});

test("插旗阻止展开，旗格不被揭示", () => {
  const cfg = { rows: 9, cols: 9, mines: 10, seed: "expand" };
  let first = 0;
  for (let i = 0; i < 81; i++) {
    const l = generateLayout(cfg, Math.floor(i / 9), i % 9);
    if (l.numbers[i] === 0) { first = i; break; }
  }
  const layout = generateLayout(cfg, Math.floor(first / 9), first % 9);
  // 找一个会被展开到的安全格，先插旗
  const s1 = mem();
  const g1 = s1.createGame(cfg);
  const full = act(s1, g1.id, "reveal", Math.floor(first / 9), first % 9, 0);
  const target = full.revealed.find((x) => x !== first)!;

  const s2 = mem();
  const g2 = s2.createGame(cfg);
  act(s2, g2.id, "flag", Math.floor(target / 9), target % 9, 0);
  const partial = act(s2, g2.id, "reveal", Math.floor(first / 9), first % 9, 1);
  assert.equal(partial.revealed.includes(target), false);
  assert.ok(partial.revealed.length < full.revealed.length);
  // 点击已插旗格拒绝且未布雷（新局）
  const s3 = mem();
  const g3 = s3.createGame(cfg);
  act(s3, g3.id, "flag", 5, 5, 0);
  assert.throws(() => act(s3, g3.id, "reveal", 5, 5, 1), (e: GameError) => e.code === "CELL_FLAGGED");
  assert.equal(s3.publicView(g3.id).generated, false);
});

test("创建/查询/插旗不消耗布雷随机数", () => {
  const cfg = { rows: 9, cols: 9, mines: 10, seed: "rng-consume" };
  const s = mem();
  const a = s.createGame(cfg);
  s.publicView(a.id);
  act(s, a.id, "flag", 0, 0, 0);
  act(s, a.id, "unflag", 0, 0, 1);
  act(s, a.id, "reveal", 4, 4, 2);
  const b = s.createGame(cfg);
  act(s, b.id, "reveal", 4, 4, 0);
  assert.deepEqual(s.adminView(a.id).layout, s.adminView(b.id).layout);
});

test("重复动作幂等，不消耗版本", () => {
  const s = mem();
  const { id } = s.createGame({ rows: 9, cols: 9, mines: 10, seed: "idem" });
  const a: ActionInput = { type: "reveal", row: 4, col: 4, expectedVersion: 0, actionId: "same-id" };
  const r1 = s.applyAction(id, a);
  const r2 = s.applyAction(id, a);
  assert.deepEqual(r2, r1);
  assert.equal(s.publicView(id).version, r1.version);
  // 同一 actionId 不同动作 -> 冲突
  assert.throws(
    () => s.applyAction(id, { type: "reveal", row: 1, col: 1, expectedVersion: 1, actionId: "same-id" }),
    (e: GameError) => e.code === "ACTION_ID_CONFLICT",
  );
});

test("版本冲突与非法动作不改变棋盘", () => {
  const s = mem();
  const { id } = s.createGame({ rows: 9, cols: 9, mines: 10, seed: "ver" });
  assert.throws(() => act(s, id, "reveal", 4, 4, 5), (e: GameError) => e.code === "VERSION_CONFLICT");
  assert.throws(() => act(s, id, "reveal", 99, 0, 0), (e: GameError) => e.code === "INVALID_PARAMS");
  const v = s.publicView(id);
  assert.equal(v.version, 0);
  assert.equal(v.generated, false);
});

test("终局后动作拒绝；踩雷判负返回雷位", () => {
  const cfg = { rows: 5, cols: 5, mines: 3, seed: "lose" };
  const layout = generateLayout(cfg, 0, 0);
  const mine = [...layout.mines][0];
  const s = mem();
  const { id } = s.createGame(cfg);
  act(s, id, "reveal", 0, 0, 0);
  const r = act(s, id, "reveal", Math.floor(mine / 5), mine % 5, 1);
  assert.equal(r.status, "lost");
  assert.ok(r.mines && r.mines.length === 3);
  assert.throws(() => act(s, id, "flag", 0, 0, 2), (e: GameError) => e.code === "GAME_OVER");
});

test("错旗快速揭示踩雷；旗数不等拒绝", () => {
  const cfg = { rows: 5, cols: 5, mines: 3, seed: "fixture-loss" };
  const layout = generateLayout(cfg, 0, 0);
  const s = mem();
  const { id } = s.createGame(cfg);
  let ver = act(s, id, "reveal", 0, 0, 0).version;
  const view = s.publicView(id);
  let tested = false;
  for (let i = 0; i < 25 && !tested; i++) {
    if (typeof view.cells[i] !== "number" || (view.cells[i] as number) <= 0) continue;
    const num = view.cells[i] as number;
    const nbs = neighborsOf(i, 5, 5).filter((x) => view.cells[x] === "hidden");
    const mineNbs = nbs.filter((x) => layout.mines.has(x));
    const safeNbs = nbs.filter((x) => !layout.mines.has(x));
    if (mineNbs.length !== num || safeNbs.length === 0) continue;
    // 旗数不足时 chord 拒绝
    assert.throws(() => act(s, id, "chord", Math.floor(i / 5), i % 5, ver),
      (e: GameError) => e.code === "CHORD_NOT_ALLOWED");
    for (const m of mineNbs.slice(0, num - 1)) ver = act(s, id, "flag", Math.floor(m / 5), m % 5, ver).version;
    ver = act(s, id, "flag", Math.floor(safeNbs[0] / 5), safeNbs[0] % 5, ver).version;
    const r = act(s, id, "chord", Math.floor(i / 5), i % 5, ver);
    assert.equal(r.status, "lost");
    tested = true;
  }
  assert.ok(tested, "未找到可测试的数字格");
});

test("只揭示全部安全格即获胜", () => {
  const cfg = { rows: 4, cols: 4, mines: 3, seed: "fixture-win" };
  const layout = generateLayout(cfg, 0, 0);
  const s = mem();
  const { id } = s.createGame(cfg);
  let ver = act(s, id, "reveal", 0, 0, 0).version;
  let status = "playing";
  for (let i = 0; i < 16 && status === "playing"; i++) {
    if (layout.mines.has(i)) continue;
    if (s.publicView(id).cells[i] !== "hidden") continue;
    const r = act(s, id, "reveal", Math.floor(i / 4), i % 4, ver);
    ver = r.version; status = r.status;
  }
  assert.equal(status, "won");
});

test("公开视图不泄露雷位，管理员视图独立", () => {
  const s = mem();
  const { id } = s.createGame({ rows: 5, cols: 5, mines: 3, seed: "privacy" });
  act(s, id, "reveal", 0, 0, 0);
  const pub = s.publicView(id);
  for (const c of pub.cells) assert.notEqual(c, "mine");
  assert.equal("layout" in pub, false);
  const admin = s.adminView(id);
  assert.ok(admin.layout && admin.layout.mines.length === 3);
});

test("日志重放验证、重启后继续、同种子复现", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
  const db = path.join(dir, "g.db");
  const cfg = { rows: 9, cols: 9, mines: 10, seed: "restart" };
  let id: string;
  {
    const s = new Store(db);
    id = s.createGame(cfg).id;
    act(s, id, "reveal", 4, 4, 0);
    act(s, id, "flag", 0, 0, 1);
    s.close();
  }
  const s2 = new Store(db);
  const before = s2.publicView(id);
  assert.equal(before.version, 2);
  const r = act(s2, id, "unflag", 0, 0, 2);
  assert.equal(r.version, 3);
  const rp = s2.replay(id);
  assert.ok(rp.ok, "重放验证失败");
  assert.equal(rp.steps, 3);
  // 同种子全新进程级复现
  const s3 = mem();
  const g2 = s3.createGame(cfg);
  act(s3, g2.id, "reveal", 4, 4, 0);
  assert.deepEqual(s3.adminView(g2.id).layout!.mines, s2.adminView(id).layout!.mines);
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
