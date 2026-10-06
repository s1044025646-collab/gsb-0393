import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BoardState, Config, GameError, GameStatus, Layout,
  checkWin, expandReveal, generateLayout, idx, neighborsOf, validateConfig,
} from "./engine";

export interface ActionInput {
  actionId: string;
  expectedVersion: number;
  type: "reveal" | "flag" | "unflag" | "chord";
  row: number;
  col: number;
}

export interface ActionResult {
  version: number;
  status: GameStatus;
  revealed: number[];   // 本次新揭示的线性下标
  flagChanged: number[]; // 本次旗变化下标
  layoutDigest?: string; // 首次布雷时的布局摘要
  mines?: number[];      // 终局时返回全部雷位
}

interface GameRow {
  id: string;
  rows: number; cols: number; mines: number; seed: string;
  status: GameStatus; version: number;
  first_row: number | null; first_col: number | null;
  layout_json: string | null;
  revealed_json: string; flagged_json: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  rows INTEGER NOT NULL, cols INTEGER NOT NULL,
  mines INTEGER NOT NULL, seed TEXT NOT NULL,
  status TEXT NOT NULL, version INTEGER NOT NULL,
  first_row INTEGER, first_col INTEGER,
  layout_json TEXT, revealed_json TEXT NOT NULL, flagged_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  game_id TEXT NOT NULL, seq INTEGER NOT NULL,
  action_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL,
  version_after INTEGER NOT NULL,
  PRIMARY KEY (game_id, seq),
  UNIQUE (game_id, action_id)
);`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  createGame(cfg: Config): { id: string; version: number } {
    validateConfig(cfg);
    const id = createHash("sha256")
      .update(`${cfg.rows}x${cfg.cols}:${cfg.mines}:${cfg.seed}:${Date.now()}:${Math.random()}`)
      .digest("hex").slice(0, 16);
    this.db.prepare(
      `INSERT INTO games (id,rows,cols,mines,seed,status,version,first_row,first_col,layout_json,revealed_json,flagged_json,created_at)
       VALUES (?,?,?,?,?,'playing',0,NULL,NULL,NULL,'[]','[]',?)`
    ).run(id, cfg.rows, cfg.cols, cfg.mines, cfg.seed, new Date().toISOString());
    return { id, version: 0 };
  }

  private load(id: string): GameRow {
    const row = this.db.prepare("SELECT * FROM games WHERE id=?").get(id) as GameRow | undefined;
    if (!row) throw new GameError("GAME_NOT_FOUND", `对局不存在: ${id}`);
    return row;
  }

  private parseLayout(row: GameRow): Layout | null {
    if (!row.layout_json) return null;
    const raw = JSON.parse(row.layout_json) as { mines: number[]; numbers: number[] };
    return { mines: new Set(raw.mines), numbers: raw.numbers };
  }

  private parseState(row: GameRow): BoardState {
    return {
      revealed: new Set(JSON.parse(row.revealed_json) as number[]),
      flagged: new Set(JSON.parse(row.flagged_json) as number[]),
    };
  }

  configOf(id: string): Config {
    const r = this.load(id);
    return { rows: r.rows, cols: r.cols, mines: r.mines, seed: r.seed };
  }

  // 公开局面：不含任何未揭示格的雷/数字信息
  publicView(id: string) {
    const r = this.load(id);
    const state = this.parseState(r);
    const layout = this.parseLayout(r);
    const cells: ("hidden" | "flag" | number | "mine")[] = [];
    const total = r.rows * r.cols;
    for (let i = 0; i < total; i++) {
      if (state.revealed.has(i)) cells.push(layout && layout.mines.has(i) ? "mine" : layout ? layout.numbers[i] : "hidden");
      else if (state.flagged.has(i)) cells.push("flag");
      else if (r.status !== "playing" && layout && layout.mines.has(i)) cells.push("mine");
      else cells.push("hidden");
    }
    return {
      id: r.id, rows: r.rows, cols: r.cols, mines: r.mines,
      status: r.status, version: r.version,
      generated: layout !== null,
      cells,
    };
  }

  // 管理员/测试取证入口：返回完整底层棋盘，与普通接口明确分离
  adminView(id: string) {
    const r = this.load(id);
    const layout = this.parseLayout(r);
    return {
      id: r.id,
      config: this.configOf(id),
      status: r.status, version: r.version,
      firstPos: r.first_row === null ? null : { row: r.first_row, col: r.first_col },
      layout: layout ? { mines: [...layout.mines].sort((a, b) => a - b), numbers: layout.numbers } : null,
      revealed: JSON.parse(r.revealed_json), flagged: JSON.parse(r.flagged_json),
    };
  }

  applyAction(id: string, action: ActionInput): ActionResult {
    if (typeof action.actionId !== "string" || !action.actionId) {
      throw new GameError("INVALID_PARAMS", "actionId 必须是非空字符串");
    }
    if (!Number.isInteger(action.expectedVersion) || action.expectedVersion < 0) {
      throw new GameError("INVALID_PARAMS", "expectedVersion 必须是非负整数");
    }
    const payload = JSON.stringify({
      type: action.type, row: action.row, col: action.col,
    });

    // 幂等：同一 actionId 重放同一动作直接返回原结果，不消耗版本
    const dup = this.db.prepare("SELECT payload, result FROM actions WHERE game_id=? AND action_id=?")
      .get(id, action.actionId) as { payload: string; result: string } | undefined;
    if (dup) {
      if (dup.payload !== payload) {
        throw new GameError("ACTION_ID_CONFLICT", "actionId 已被不同动作占用");
      }
      return JSON.parse(dup.result) as ActionResult;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.load(id);
      if (action.expectedVersion !== row.version) {
        throw new GameError("VERSION_CONFLICT",
          `版本冲突：期望 ${action.expectedVersion}，当前 ${row.version}`);
      }
      if (row.status !== "playing") {
        throw new GameError("GAME_OVER", `对局已结束（${row.status}），拒绝后续动作`);
      }
      const cfg: Config = { rows: row.rows, cols: row.cols, mines: row.mines, seed: row.seed };
      if (!Number.isInteger(action.row) || !Number.isInteger(action.col) ||
          action.row < 0 || action.row >= row.rows || action.col < 0 || action.col >= row.cols) {
        throw new GameError("INVALID_PARAMS", "坐标越界");
      }
      const cell = idx(action.row, action.col, row.cols);
      const state = this.parseState(row);
      let layout = this.parseLayout(row);
      const result: ActionResult = {
        version: row.version + 1, status: "playing", revealed: [], flagChanged: [],
      };
      let firstRow = row.first_row, firstCol = row.first_col;

      const ensureLayout = () => {
        if (!layout) {
          // 首次布雷与首次揭示在同一事务内完成
          layout = generateLayout(cfg, action.row, action.col);
          firstRow = action.row; firstCol = action.col;
          result.layoutDigest = createHash("sha256")
            .update(JSON.stringify([...layout.mines].sort((a, b) => a - b))).digest("hex");
        }
      };

      switch (action.type) {
        case "flag":
          if (state.revealed.has(cell)) throw new GameError("CELL_REVEALED", "已揭示格不能插旗");
          if (state.flagged.has(cell)) throw new GameError("INVALID_ACTION", "该格已插旗");
          state.flagged.add(cell);
          result.flagChanged.push(cell);
          break;
        case "unflag":
          if (!state.flagged.has(cell)) throw new GameError("INVALID_ACTION", "该格未插旗");
          state.flagged.delete(cell);
          result.flagChanged.push(cell);
          break;
        case "reveal": {
          if (state.flagged.has(cell)) throw new GameError("CELL_FLAGGED", "已插旗格不能揭示");
          if (state.revealed.has(cell)) throw new GameError("CELL_REVEALED", "该格已揭示");
          ensureLayout();
          if (layout!.mines.has(cell)) {
            state.revealed.add(cell);
            result.revealed.push(cell);
            result.status = "lost";
          } else {
            result.revealed = expandReveal(cfg, layout!, state, cell);
            if (checkWin(cfg, state)) result.status = "won";
          }
          break;
        }
        case "chord": {
          if (!layout || !state.revealed.has(cell)) {
            throw new GameError("CHORD_NOT_ALLOWED", "快速揭示只能用于已揭示的数字格");
          }
          const num = layout.numbers[cell];
          if (num <= 0) throw new GameError("CHORD_NOT_ALLOWED", "空白格不能快速揭示");
          const nbs = neighborsOf(cell, row.rows, row.cols);
          const flagCount = nbs.filter((n) => state.flagged.has(n)).length;
          if (flagCount !== num) {
            throw new GameError("CHORD_NOT_ALLOWED", `周围旗数 ${flagCount} 不等于提示数 ${num}`);
          }
          let hitMine = false;
          for (const nb of nbs) {
            if (state.flagged.has(nb) || state.revealed.has(nb)) continue;
            if (layout.mines.has(nb)) {
              // 旗放错也可能踩雷：原子完成，踩到即判负
              state.revealed.add(nb);
              result.revealed.push(nb);
              hitMine = true;
            } else {
              result.revealed.push(...expandReveal(cfg, layout, state, nb));
            }
          }
          if (hitMine) result.status = "lost";
          else if (checkWin(cfg, state)) result.status = "won";
          break;
        }
        default:
          throw new GameError("INVALID_ACTION", `未知动作类型: ${(action as { type: string }).type}`);
      }

      const status: GameStatus = result.status;
      if (status !== "playing" && layout) {
        result.mines = [...layout.mines].sort((a, b) => a - b);
      }
      const seq = (this.db.prepare("SELECT COUNT(*) AS c FROM actions WHERE game_id=?").get(id) as { c: number }).c;
      this.db.prepare(
        `UPDATE games SET status=?, version=?, first_row=?, first_col=?, layout_json=?, revealed_json=?, flagged_json=? WHERE id=?`
      ).run(
        status, result.version, firstRow, firstCol,
        layout ? JSON.stringify({ mines: [...layout.mines], numbers: layout.numbers }) : row.layout_json,
        JSON.stringify([...state.revealed]), JSON.stringify([...state.flagged]), id,
      );
      this.db.prepare(
        `INSERT INTO actions (game_id,seq,action_id,payload,result,version_after) VALUES (?,?,?,?,?,?)`
      ).run(id, seq, action.actionId, payload, JSON.stringify(result), result.version);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  actionLog(id: string) {
    this.load(id);
    return this.db.prepare("SELECT seq, action_id AS actionId, payload, result, version_after AS versionAfter FROM actions WHERE game_id=? ORDER BY seq")
      .all(id) as { seq: number; actionId: string; payload: string; result: string; versionAfter: number }[];
  }

  // 重放验证：从配置与日志重新执行全部动作，核对最终状态摘要
  replay(id: string): { ok: boolean; steps: number; finalDigest: string; storedDigest: string } {
    const row = this.load(id);
    const log = this.actionLog(id);
    const cfg: Config = { rows: row.rows, cols: row.cols, mines: row.mines, seed: row.seed };
    let layout: Layout | null = null;
    const state: BoardState = { revealed: new Set(), flagged: new Set() };
    let status: GameStatus = "playing";
    for (const entry of log) {
      const a = JSON.parse(entry.payload) as { type: string; row: number; col: number };
      const cell = idx(a.row, a.col, cfg.cols);
      if (a.type === "flag") state.flagged.add(cell);
      else if (a.type === "unflag") state.flagged.delete(cell);
      else if (a.type === "reveal" || a.type === "chord") {
        if (!layout) layout = generateLayout(cfg, a.row, a.col);
        if (a.type === "reveal") {
          if (layout.mines.has(cell)) { state.revealed.add(cell); status = "lost"; }
          else { expandReveal(cfg, layout, state, cell); if (checkWin(cfg, state)) status = "won"; }
        } else {
          let hit = false;
          for (const nb of neighborsOf(cell, cfg.rows, cfg.cols)) {
            if (state.flagged.has(nb) || state.revealed.has(nb)) continue;
            if (layout.mines.has(nb)) { state.revealed.add(nb); hit = true; }
            else expandReveal(cfg, layout, state, nb);
          }
          if (hit) status = "lost";
          else if (checkWin(cfg, state)) status = "won";
        }
      }
    }
    const digestOf = (s: GameStatus, st: BoardState) =>
      createHash("sha256").update(JSON.stringify({
        status: s,
        revealed: [...st.revealed].sort((a, b) => a - b),
        flagged: [...st.flagged].sort((a, b) => a - b),
      })).digest("hex");
    const stored = this.parseState(row);
    const finalDigest = digestOf(status, state);
    const storedDigest = digestOf(row.status, stored);
    return { ok: finalDigest === storedDigest, steps: log.length, finalDigest, storedDigest };
  }
}

export function defaultDbPath(): string {
  return process.env.MINESWEEPER_DB ?? path.join(process.cwd(), "data", "minesweeper.db");
}

