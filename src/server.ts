// HTTP API：仅规则/动作/回放，无网页。
import * as http from "node:http";
import * as path from "node:path";
import { RuleError, publicView } from "./engine";
import { Store, defaultDataDir } from "./store";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof RuleError) {
    const status =
      err.code === "NOT_FOUND" ? 404 :
      err.code === "VERSION_CONFLICT" ? 409 :
      err.code === "GAME_OVER" ? 409 :
      err.code === "ILLEGAL_ACTION" ? 422 : 400;
    sendJson(res, status, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuleError("INVALID_PARAM", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && parts.length === 0) {
        return sendJson(res, 200, { name: "minesweeper-backend", endpoints: [
          "POST /games {rows,cols,mineCount,seed,fixtureMines?}",
          "GET /games",
          "GET /games/:id            公开局面（不泄露雷位）",
          "GET /games/:id/admin      管理员取证视图（含完整雷位，仅演示/测试）",
          "POST /games/:id/actions   {actionId,type,row,col,expectedVersion}",
          "GET /games/:id/log        动作记录",
          "GET /games/:id/replay     重放校验",
        ] });
      }

      if (parts[0] === "games" && parts.length === 1 && method === "POST") {
        const body = await readBody(req);
        const state = store.createGame(body.rows, body.cols, body.mineCount, body.seed, body.fixtureMines);
        return sendJson(res, 201, publicView(state));
      }
      if (parts[0] === "games" && parts.length === 1 && method === "GET") {
        return sendJson(res, 200, { games: store.listGames() });
      }
      if (parts[0] === "games" && parts.length === 2 && method === "GET") {
        return sendJson(res, 200, publicView(store.getGame(parts[1])));
      }
      if (parts[0] === "games" && parts[2] === "admin" && method === "GET") {
        const state = store.getGame(parts[1]);
        return sendJson(res, 200, {
          warning: "管理员取证视图：包含完整雷位，仅供演示/测试，不属于普通局面接口",
          ...publicView(state),
          mines: [...state.mines].sort((a, b) => a - b),
          seed: state.seed,
          fixture: state.fixture,
        });
      }
      if (parts[0] === "games" && parts[2] === "actions" && method === "POST") {
        const body = await readBody(req);
        for (const k of ["actionId", "type", "row", "col", "expectedVersion"]) {
          if (body[k] === undefined) throw new RuleError("INVALID_PARAM", `缺少字段: ${k}`);
        }
        const { result, replayed } = store.applyAction(parts[1], {
          actionId: String(body.actionId),
          type: body.type,
          row: body.row,
          col: body.col,
          expectedVersion: body.expectedVersion,
        });
        return sendJson(res, 200, { ...result, idempotentReplay: replayed, state: publicView(store.getGame(parts[1])) });
      }
      if (parts[0] === "games" && parts[2] === "log" && method === "GET") {
        return sendJson(res, 200, { log: store.getLog(parts[1]) });
      }
      if (parts[0] === "games" && parts[2] === "replay" && method === "GET") {
        return sendJson(res, 200, store.replay(parts[1]));
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function startServer(dbPath: string, port: number): Promise<{ server: http.Server; port: number }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({ server, port: addr.port });
    });
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const dbArg = args.find((a) => a.startsWith("--db="));
  const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 0); // 默认 0 = 空闲端口
  const dbPath = dbArg ? dbArg.split("=")[1] : path.join(defaultDataDir(), "minesweeper.db");
  startServer(dbPath, port).then(({ port }) => {
    console.log(`扫雷后端已启动: http://127.0.0.1:${port}  数据文件: ${dbPath}`);
  });
}
