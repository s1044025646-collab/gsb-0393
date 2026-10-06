import * as http from "node:http";
import { AddressInfo } from "node:net";
import { GameError } from "./engine";
import { ActionInput, Store, defaultDbPath } from "./store";

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new GameError("INVALID_PARAMS", "请求体不是合法 JSON"); }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/games") {
        const b = (await readBody(req)) as Record<string, unknown>;
        const out = store.createGame({
          rows: Number(b.rows), cols: Number(b.cols),
          mines: Number(b.mines), seed: String(b.seed ?? ""),
        });
        return send(res, 201, out);
      }
      if (parts[0] === "games" && parts.length >= 2) {
        const id = parts[1];
        if (method === "GET" && parts.length === 2) return send(res, 200, store.publicView(id));
        if (method === "GET" && parts[2] === "admin") return send(res, 200, store.adminView(id));
        if (method === "GET" && parts[2] === "log") return send(res, 200, store.actionLog(id));
        if (method === "POST" && parts[2] === "replay") return send(res, 200, store.replay(id));
        if (method === "POST" && parts[2] === "actions") {
          const b = (await readBody(req)) as ActionInput;
          return send(res, 200, store.applyAction(id, b));
        }
      }
      return send(res, 404, { error: "NOT_FOUND", message: "未知路由" });
    } catch (e) {
      if (e instanceof GameError) {
        const code = e.code === "GAME_NOT_FOUND" ? 404
          : e.code === "INVALID_PARAMS" ? 400 : 409;
        return send(res, code, { error: e.code, message: e.message });
      }
      return send(res, 500, { error: "INTERNAL", message: String(e) });
    }
  });
}

if (require.main === module) {
  const store = new Store(defaultDbPath());
  const server = createServer(store);
  // 默认端口 0：由系统分配空闲端口；可用 PORT 环境变量指定
  const port = Number(process.env.PORT ?? 0);
  server.listen(port, () => {
    const addr = server.address() as AddressInfo;
    console.log(`扫雷 API 已启动: http://127.0.0.1:${addr.port}`);
  });
}
