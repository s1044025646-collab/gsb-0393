// 纯规则引擎：不依赖数据库与网络，所有函数确定性。
import { sampleDeterministic } from "./rng";

export type GameStatus = "ready" | "playing" | "won" | "lost";

export interface GameState {
  id: string;
  rows: number;
  cols: number;
  mineCount: number;
  seed: string;
  status: GameStatus;
  version: number;
  generated: boolean;
  mines: Set<number>; // 生成前为空集合
  revealed: Set<number>;
  flagged: Set<number>;
  fixture: boolean;
}

export type ActionType = "reveal" | "flag" | "unflag" | "chord";

export interface ActionInput {
  actionId: string;
  type: ActionType;
  row: number;
  col: number;
  expectedVersion: number;
}

export interface ActionResult {
  ok: boolean;
  errorCode?: string;
  message?: string;
  versionBefore: number;
  versionAfter: number;
  status: GameStatus;
  generatedNow?: boolean;
  layoutDigest?: string; // 首次布雷时的布局摘要（雷位排序列表的哈希）
  newlyRevealed?: number[]; // 一维下标列表
  flagChanged?: { cell: number; flagged: boolean };
  hitMine?: boolean;
  minesRevealed?: number[]; // 终局时附带的全部雷位
}

export class RuleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const idx = (row: number, col: number, cols: number) => row * cols + col;
export const rowOf = (i: number, cols: number) => Math.floor(i / cols);
export const colOf = (i: number, cols: number) => i % cols;

export function neighborsOf(i: number, rows: number, cols: number): number[] {
  const r = rowOf(i, cols);
  const c = colOf(i, cols);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
    }
  }
  return out;
}

export function countAdjacentMines(i: number, mines: Set<number>, rows: number, cols: number): number {
  let n = 0;
  for (const nb of neighborsOf(i, rows, cols)) if (mines.has(nb)) n++;
  return n;
}

export function validateConfig(rows: number, cols: number, mineCount: number): void {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 3 || cols < 3) {
    throw new RuleError("INVALID_PARAM", "棋盘至少为 3x3，行列必须为整数");
  }
  if (!Number.isInteger(mineCount) || mineCount < 0) {
    throw new RuleError("INVALID_PARAM", "雷数必须为非负整数");
  }
  if (mineCount > rows * cols - 9) {
    throw new RuleError("INVALID_PARAM", `雷数不能超过 总格数-9（${rows * cols - 9}），否则无法保证首次点击安全`);
  }
}

export function createGame(id: string, rows: number, cols: number, mineCount: number, seed: string, fixtureMines?: number[]): GameState {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new RuleError("INVALID_PARAM", "seed 必须为非空字符串");
  }
  const total = rows * cols;
  if (fixtureMines !== undefined) {
    // 夹具盘无需保证首次安全区，仅要求基本合法
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 3 || cols < 3) {
      throw new RuleError("INVALID_PARAM", "棋盘至少为 3x3");
    }
    if (!Number.isInteger(mineCount) || mineCount < 0 || mineCount >= total) {
      throw new RuleError("INVALID_PARAM", "fixture 雷数必须满足 0 <= 雷数 < 总格数");
    }
  } else {
    validateConfig(rows, cols, mineCount);
  }
  const state: GameState = {
    id, rows, cols, mineCount, seed,
    status: "ready", version: 0, generated: false,
    mines: new Set(), revealed: new Set(), flagged: new Set(),
    fixture: false,
  };
  if (fixtureMines !== undefined) {
    // 受控测试夹具：创建时即固定布局，跳过首次布雷。
    const set = new Set(fixtureMines);
    if (set.size !== fixtureMines.length) throw new RuleError("INVALID_PARAM", "fixtureMines 存在重复");
    if (set.size !== mineCount) throw new RuleError("INVALID_PARAM", "fixtureMines 数量必须等于雷数");
    for (const m of set) {
      if (!Number.isInteger(m) || m < 0 || m >= total) throw new RuleError("INVALID_PARAM", "fixtureMines 越界");
    }
    state.mines = set;
    state.generated = true;
    state.fixture = true;
  }
  return state;
}

/** 首次布雷：排除首点格及其棋盘内八邻域，用种子确定性取样。 */
export function generateMines(state: GameState, first: number): void {
  const excluded = new Set<number>([first, ...neighborsOf(first, state.rows, state.cols)]);
  const candidates: number[] = [];
  const total = state.rows * state.cols;
  for (let i = 0; i < total; i++) if (!excluded.has(i)) candidates.push(i);
  if (state.mineCount > candidates.length) {
    throw new RuleError("INVALID_PARAM", "候选格不足，无法布雷"); // 配置校验已保证不会发生
  }
  state.mines = new Set(sampleDeterministic(candidates, state.mineCount, state.seed));
  state.generated = true;
}

export function layoutDigest(mines: Set<number>): string {
  const sorted = [...mines].sort((a, b) => a - b).join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < sorted.length; i++) {
    h ^= sorted.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 从 start 做洪水展开；返回新揭示格（不含已揭示）。不触及插旗格。 */
export function floodReveal(state: GameState, start: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (state.revealed.has(cur) || state.flagged.has(cur)) continue;
    if (state.mines.has(cur)) continue; // 洪水展开永不揭雷
    state.revealed.add(cur);
    out.push(cur);
    if (countAdjacentMines(cur, state.mines, state.rows, state.cols) === 0) {
      for (const nb of neighborsOf(cur, state.rows, state.cols)) {
        if (!seen.has(nb) && !state.revealed.has(nb) && !state.flagged.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
  }
  return out.sort((a, b) => a - b);
}

function checkWin(state: GameState): void {
  if (state.revealed.size === state.rows * state.cols - state.mineCount) {
    state.status = "won";
  }
}

function assertInBoard(state: GameState, row: number, col: number): number {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= state.rows || col < 0 || col >= state.cols) {
    throw new RuleError("INVALID_PARAM", "坐标越界或不是整数");
  }
  return idx(row, col, state.cols);
}

function assertActive(state: GameState): void {
  if (state.status === "won" || state.status === "lost") {
    throw new RuleError("GAME_OVER", `对局已结束（${state.status}），拒绝后续动作`);
  }
}

/**
 * 应用一个动作（纯函数式地原地修改传入 state；调用方负责事务与持久化）。
 * 非法动作抛 RuleError，state 不被修改（调用方应回滚）。
 */
export function applyAction(state: GameState, action: ActionInput): ActionResult {
  const versionBefore = state.version;
  if (action.expectedVersion !== state.version) {
    throw new RuleError("VERSION_CONFLICT", `期望版本 ${action.expectedVersion} 与当前版本 ${state.version} 不一致`);
  }
  assertActive(state);
  const cell = assertInBoard(state, action.row, action.col);
  const result: ActionResult = {
    ok: true, versionBefore, versionAfter: state.version, status: state.status,
  };

  switch (action.type) {
    case "flag": {
      if (state.revealed.has(cell)) throw new RuleError("ILLEGAL_ACTION", "已揭示格不能插旗");
      if (state.flagged.has(cell)) throw new RuleError("ILLEGAL_ACTION", "该格已插旗");
      state.flagged.add(cell);
      if (state.status === "ready") state.status = "playing";
      result.flagChanged = { cell, flagged: true };
      break;
    }
    case "unflag": {
      if (!state.flagged.has(cell)) throw new RuleError("ILLEGAL_ACTION", "该格未插旗");
      state.flagged.delete(cell);
      result.flagChanged = { cell, flagged: false };
      break;
    }
    case "reveal": {
      if (state.flagged.has(cell)) throw new RuleError("ILLEGAL_ACTION", "已插旗格不能揭示");
      if (state.revealed.has(cell)) throw new RuleError("ILLEGAL_ACTION", "该格已揭示");
      if (!state.generated) {
        generateMines(state, cell);
        result.generatedNow = true;
        result.layoutDigest = layoutDigest(state.mines);
      }
      if (state.status === "ready") state.status = "playing";
      if (state.mines.has(cell)) {
        state.revealed.add(cell);
        state.status = "lost";
        result.hitMine = true;
        result.newlyRevealed = [cell];
        result.minesRevealed = [...state.mines].sort((a, b) => a - b);
      } else {
        result.newlyRevealed = floodReveal(state, cell);
        checkWin(state);
        if (state.status === "won") result.minesRevealed = [...state.mines].sort((a, b) => a - b);
      }
      break;
    }
    case "chord": {
      // 快速揭示：仅对已揭示数字格，且周围旗数等于提示数时允许。
      if (!state.generated || !state.revealed.has(cell)) {
        throw new RuleError("ILLEGAL_ACTION", "快速揭示要求目标为已揭示的数字格");
      }
      const number = countAdjacentMines(cell, state.mines, state.rows, state.cols);
      const nbs = neighborsOf(cell, state.rows, state.cols);
      const flagCount = nbs.filter((n) => state.flagged.has(n)).length;
      if (flagCount !== number) {
        throw new RuleError("ILLEGAL_ACTION", `周围旗数 ${flagCount} 不等于提示数 ${number}`);
      }
      const targets = nbs.filter((n) => !state.flagged.has(n) && !state.revealed.has(n));
      if (targets.length === 0) throw new RuleError("ILLEGAL_ACTION", "没有可揭示的邻格");
      const newly = new Set<number>();
      let hit = false;
      for (const t of targets) {
        if (state.mines.has(t)) {
          state.revealed.add(t);
          newly.add(t);
          hit = true; // 原子：继续把本次动作记录完，但判负
        } else {
          for (const r of floodReveal(state, t)) newly.add(r);
        }
      }
      result.newlyRevealed = [...newly].sort((a, b) => a - b);
      if (hit) {
        state.status = "lost";
        result.hitMine = true;
        result.minesRevealed = [...state.mines].sort((a, b) => a - b);
      } else {
        checkWin(state);
        if (state.status === "won") result.minesRevealed = [...state.mines].sort((a, b) => a - b);
      }
      break;
    }
    default:
      throw new RuleError("INVALID_PARAM", `未知动作类型: ${action.type}`);
  }

  state.version += 1;
  result.versionAfter = state.version;
  result.status = state.status;
  return result;
}

/** 公开局面：只含可见信息，不泄露未揭示格的雷位与数字。 */
export function publicView(state: GameState) {
  const cells: { row: number; col: number; state: "hidden" | "flagged" | "revealed"; adjacentMines?: number }[] = [];
  for (let i = 0; i < state.rows * state.cols; i++) {
    const row = rowOf(i, state.cols);
    const col = colOf(i, state.cols);
    if (state.revealed.has(i)) {
      cells.push({
        row, col, state: "revealed",
        adjacentMines: state.mines.has(i) ? -1 : countAdjacentMines(i, state.mines, state.rows, state.cols),
      });
    } else if (state.flagged.has(i)) {
      cells.push({ row, col, state: "flagged" });
    } else {
      cells.push({ row, col, state: "hidden" });
    }
  }
  return {
    id: state.id,
    rows: state.rows,
    cols: state.cols,
    mineCount: state.mineCount,
    status: state.status,
    version: state.version,
    generated: state.generated,
    revealedCount: state.revealed.size,
    flagCount: state.flagged.size,
    cells,
    ...(state.status === "won" || state.status === "lost"
      ? { mines: [...state.mines].sort((a, b) => a - b) }
      : {}),
  };
}

/** 状态哈希：用于重放校验与重启一致性核对。 */
export function stateHash(state: GameState): string {
  const canon = JSON.stringify({
    r: state.rows, c: state.cols, m: state.mineCount, s: state.seed,
    st: state.status, v: state.version, g: state.generated,
    mines: [...state.mines].sort((a, b) => a - b),
    rev: [...state.revealed].sort((a, b) => a - b),
    flg: [...state.flagged].sort((a, b) => a - b),
  });
  let h1 = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h1 ^= canon.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0");
}
