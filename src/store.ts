// SQLite 持久化：配置、首次布局、动作日志；首次布雷与揭示在同一事务内完成。
import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ActionInput, ActionResult, GameState, RuleError,
  applyAction, createGame, stateHash,
} from "./engine";

export interface ActionLogEntry {
  seq: number;
  actionId: string;
  type: string;
  row: number;
  col: number;
  expectedVersion: number;
  versionBefore: number;
  versionAfter: number;
  result: ActionResult;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        rows INTEGER NOT NULL,
        cols INTEGER NOT NULL,
        mine_count INTEGER NOT NULL,
        seed TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        generated INTEGER NOT NULL,
        fixture INTEGER NOT NULL,
        mines_json TEXT NOT NULL,
        revealed_json TEXT NOT NULL,
        flagged_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        game_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        action_id TEXT NOT NULL,
        type TEXT NOT NULL,
        row INTEGER NOT NULL,
        col INTEGER NOT NULL,
        expected_version INTEGER NOT NULL,
        version_before INTEGER NOT NULL,
        version_after INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (game_id, seq),
        UNIQUE (game_id, action_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private rowToState(row: any): GameState {
    return {
      id: row.id,
      rows: row.rows,
      cols: row.cols,
      mineCount: row.mine_count,
      seed: row.seed,
      status: row.status,
      version: row.version,
      generated: row.generated === 1,
      fixture: row.fixture === 1,
      mines: new Set(JSON.parse(row.mines_json) as number[]),
      revealed: new Set(JSON.parse(row.revealed_json) as number[]),
      flagged: new Set(JSON.parse(row.flagged_json) as number[]),
    };
  }

  getGame(id: string): GameState {
    const row = this.db.prepare("SELECT * FROM games WHERE id = ?").get(id);
    if (!row) throw new RuleError("NOT_FOUND", `对局不存在: ${id}`);
    return this.rowToState(row);
  }

  listGames(): { id: string; rows: number; cols: number; mineCount: number; status: string; version: number }[] {
    const rows = this.db.prepare("SELECT id, rows, cols, mine_count, status, version FROM games ORDER BY created_at").all() as any[];
    return rows.map((r) => ({ id: r.id, rows: r.rows, cols: r.cols, mineCount: r.mine_count, status: r.status, version: r.version }));
  }

  createGame(rows: number, cols: number, mineCount: number, seed: string, fixtureMines?: number[]): GameState {
    const id = crypto.randomUUID();
    const state = createGame(id, rows, cols, mineCount, seed, fixtureMines);
    this.persistNew(state);
    return state;
  }

  private persistNew(state: GameState): void {
    this.db.prepare(`
      INSERT INTO games (id, rows, cols, mine_count, seed, status, version, generated, fixture,
                         mines_json, revealed_json, flagged_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.id, state.rows, state.cols, state.mineCount, state.seed, state.status, state.version,
      state.generated ? 1 : 0, state.fixture ? 1 : 0,
      JSON.stringify([...state.mines]), JSON.stringify([...state.revealed]), JSON.stringify([...state.flagged]),
      new Date().toISOString(),
    );
  }

  private persistUpdate(state: GameState): void {
    this.db.prepare(`
      UPDATE games SET status = ?, version = ?, generated = ?, mines_json = ?, revealed_json = ?, flagged_json = ?
      WHERE id = ?
    `).run(
      state.status, state.version, state.generated ? 1 : 0,
      JSON.stringify([...state.mines].sort((a, b) => a - b)),
      JSON.stringify([...state.revealed].sort((a, b) => a - b)),
      JSON.stringify([...state.flagged].sort((a, b) => a - b)),
      state.id,
    );
  }

  /**
   * 应用动作：幂等 + 事务。
   * - actionId 已存在：直接返回已存结果，不消耗版本与随机数。
   * - 非法动作：抛 RuleError，事务回滚，棋盘不变。
   */
  applyAction(gameId: string, action: ActionInput): { result: ActionResult; replayed: boolean } {
    const existing = this.db.prepare("SELECT result_json FROM actions WHERE game_id = ? AND action_id = ?").get(gameId, action.actionId) as any;
    if (existing) {
      return { result: JSON.parse(existing.result_json), replayed: true };
    }
    // 确认对局存在（在事务外读，事务内会再读一次）
    this.getGame(gameId);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getGame(gameId);
      const result = applyAction(state, action);
      this.persistUpdate(state);
      const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM actions WHERE game_id = ?").get(gameId) as any;
      this.db.prepare(`
        INSERT INTO actions (game_id, seq, action_id, type, row, col, expected_version,
                             version_before, version_after, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        gameId, seqRow.seq, action.actionId, action.type, action.row, action.col, action.expectedVersion,
        result.versionBefore, result.versionAfter, JSON.stringify(result), new Date().toISOString(),
      );
      this.db.exec("COMMIT");
      return { result, replayed: false };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getLog(gameId: string): ActionLogEntry[] {
    this.getGame(gameId);
    const rows = this.db.prepare("SELECT * FROM actions WHERE game_id = ? ORDER BY seq").all(gameId) as any[];
    return rows.map((r) => ({
      seq: r.seq,
      actionId: r.action_id,
      type: r.type,
      row: r.row,
      col: r.col,
      expectedVersion: r.expected_version,
      versionBefore: r.version_before,
      versionAfter: r.version_after,
      result: JSON.parse(r.result_json),
      createdAt: r.created_at,
    }));
  }

  /** 重放校验：从初始配置重新执行日志中的全部动作，比对最终状态哈希。 */
  replay(gameId: string): { ok: boolean; expectedHash: string; actualHash: string; steps: number; message?: string } {
    const current = this.getGame(gameId);
    const log = this.getLog(gameId);
    const fresh = createGame(
      gameId, current.rows, current.cols, current.mineCount, current.seed,
      current.fixture ? [...current.mines] : undefined,
    );
    let state = fresh;
    for (const entry of log) {
      const action: ActionInput = {
        actionId: entry.actionId,
        type: entry.type as any,
        row: entry.row,
        col: entry.col,
        expectedVersion: entry.expectedVersion,
      };
      const result = applyAction(state, action);
      if (result.versionAfter !== entry.versionAfter) {
        return {
          ok: false, expectedHash: stateHash(current), actualHash: stateHash(state),
          steps: entry.seq + 1, message: `第 ${entry.seq} 步版本不一致`,
        };
      }
    }
    const expectedHash = stateHash(current);
    const actualHash = stateHash(state);
    return {
      ok: expectedHash === actualHash,
      expectedHash, actualHash, steps: log.length,
      message: expectedHash === actualHash ? "重放一致" : "重放结果与当前状态不一致",
    };
  }
}

export function defaultDataDir(): string {
  return path.join(process.cwd(), "data");
}
