import { sample } from "./rng";

export type GameStatus = "playing" | "won" | "lost";

export interface Config {
  rows: number;
  cols: number;
  mines: number;
  seed: string;
}

export interface Layout {
  mines: Set<number>;   // 雷格线性下标
  numbers: number[];    // 每格周围雷数（雷格为 -1）
}

export interface BoardState {
  revealed: Set<number>;
  flagged: Set<number>;
}

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function idx(row: number, col: number, cols: number): number {
  return row * cols + col;
}

export function neighborsOf(i: number, rows: number, cols: number): number[] {
  const r = Math.floor(i / cols);
  const c = i % cols;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
    }
  }
  return out;
}

export function validateConfig(cfg: Config): void {
  if (!Number.isInteger(cfg.rows) || !Number.isInteger(cfg.cols) || cfg.rows < 3 || cfg.cols < 3) {
    throw new GameError("INVALID_PARAMS", "棋盘至少为 3x3 的矩形");
  }
  if (cfg.rows * cfg.cols > 100000) {
    throw new GameError("INVALID_PARAMS", "棋盘过大");
  }
  if (!Number.isInteger(cfg.mines) || cfg.mines < 0) {
    throw new GameError("INVALID_PARAMS", "雷数必须是非负整数");
  }
  if (cfg.mines > cfg.rows * cfg.cols - 9) {
    throw new GameError("INVALID_PARAMS", "雷数不能超过总格数减 9（保证任意首点安全）");
  }
  if (typeof cfg.seed !== "string" || cfg.seed.length === 0 || cfg.seed.length > 256) {
    throw new GameError("INVALID_PARAMS", "种子必须是非空字符串（<=256 字符）");
  }
}

// 首次有效揭示时生成布局：排除首点及其棋盘内相邻八格。
export function generateLayout(cfg: Config, firstRow: number, firstCol: number): Layout {
  const total = cfg.rows * cfg.cols;
  const first = idx(firstRow, firstCol, cfg.cols);
  const excluded = new Set<number>([first, ...neighborsOf(first, cfg.rows, cfg.cols)]);
  const candidates: number[] = [];
  for (let i = 0; i < total; i++) if (!excluded.has(i)) candidates.push(i);
  if (cfg.mines > candidates.length) {
    throw new GameError("INVALID_PARAMS", "雷数超过可布雷位置数");
  }
  // 在候选下标空间取样，再映射回棋盘下标
  const picked = sample(cfg.seed, candidates.length, cfg.mines);
  const mines = new Set<number>(picked.map((p) => candidates[p]));
  const numbers = new Array<number>(total).fill(0);
  for (let i = 0; i < total; i++) {
    if (mines.has(i)) { numbers[i] = -1; continue; }
    let n = 0;
    for (const nb of neighborsOf(i, cfg.rows, cfg.cols)) if (mines.has(nb)) n++;
    numbers[i] = n;
  }
  return { mines, numbers };
}

// 空白展开：BFS，仅从零格扩展；边界数字被揭示但不继续扩展；不揭示旗格。
export function expandReveal(cfg: Config, layout: Layout, state: BoardState, start: number): number[] {
  const newly: number[] = [];
  if (state.revealed.has(start) || state.flagged.has(start)) return newly;
  const queue: number[] = [start];
  const seen = new Set<number>([start]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (state.revealed.has(cur) || state.flagged.has(cur)) continue;
    newly.push(cur);
    state.revealed.add(cur);
    if (layout.numbers[cur] === 0) {
      for (const nb of neighborsOf(cur, cfg.rows, cfg.cols)) {
        if (!seen.has(nb) && !state.revealed.has(nb) && !state.flagged.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
  }
  return newly;
}

export function checkWin(cfg: Config, state: BoardState): boolean {
  return state.revealed.size === cfg.rows * cfg.cols - cfg.mines;
}
