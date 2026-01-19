import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { ProxyAgent, setGlobalDispatcher } from "undici";

function sendJson(res: ServerResponse, status: number, payload: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function handleProfile(req: IncomingMessage, res: ServerResponse) {
    try {
        const payload = await parseBody(req);
        const { tokenId, conditionId, currentPrice } = payload || {};
        if (!tokenId) {
            sendJson(res, 400, { error: "缺少 tokenId" });
            return;
        }

        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxyUrl) {
            setGlobalDispatcher(new ProxyAgent(proxyUrl));
        }

        // @ts-ignore 使用编译输出模块
        const { Profiler } = await import("../dist/sentinel/Profiler.js");
        const profiler = new Profiler();
        const result = await profiler.analyzeMarket(tokenId, conditionId, currentPrice ?? 0.5);
        sendJson(res, 200, { results: result });
    } catch (error: any) {
        sendJson(res, 500, { error: error.message || "Profiler 调用失败" });
    }
}

export async function startProfilerService(port: number = 8793) {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (!req.url) {
            sendJson(res, 404, { error: "缺少路径" });
            return;
        }

        if (req.method === "POST" && req.url === "/profile") {
            await handleProfile(req, res);
            return;
        }

        sendJson(res, 404, { error: "未找到路径" });
    });

    await new Promise<void>(resolve => {
        server.listen(port, () => {
            console.log(`[Profiler] 服务已启动: http://127.0.0.1:${port}/profile`);
            resolve();
        });
    });

    return server;
}

if (process.env.PROFILER_AUTO_START === "true") {
    const port = process.env.PROFILER_PORT ? Number(process.env.PROFILER_PORT) : 8793;
    startProfilerService(port).catch(error => {
        console.error("[Profiler] 启动失败:", error);
        process.exit(1);
    });
}
