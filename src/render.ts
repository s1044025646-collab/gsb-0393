// 字符棋盘渲染：仅依据公开可见状态。
import { publicView, GameState } from "./engine";

export function renderBoard(state: GameState): string {
  const view = publicView(state);
  const grid: string[][] = [];
  for (let r = 0; r < state.rows; r++) grid.push(new Array(state.cols).fill("."));
  for (const cell of view.cells) {
    if (cell.state === "flagged") grid[cell.row][cell.col] = "F";
    else if (cell.state === "revealed") {
      const n = cell.adjacentMines!;
      grid[cell.row][cell.col] = n === -1 ? "*" : n === 0 ? " " : String(n);
    }
  }
  const header = "   " + Array.from({ length: state.cols }, (_, c) => c).join(" ");
  const lines = grid.map((row, r) => `${String(r).padStart(2)} ` + row.map((c) => (c === " " ? "·" : c)).join(" "));
  return `${header}\n${lines.join("\n")}`;
}
