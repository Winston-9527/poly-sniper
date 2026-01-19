const http = require("node:http");
const { Profiler } = require("../../../dist/sentinel/Profiler.js");

function sendJson(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
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

async function handleProfile(req, res) {
    try {
        const payload = await parseBody(req);
        const { tokenId, conditionId, currentPrice } = payload || {};
        if (!tokenId) {
            sendJson(res, 400, { error: "缺少 tokenId" });
            return;
        }

        const profiler = new Profiler();
        const result = await profiler.analyzeMarket(tokenId, conditionId, currentPrice ?? 0.5);
        sendJson(res, 200, { results: result });
    } catch (error) {
        sendJson(res, 500, { error: error.message || "Profiler 调用失败" });
    }
}

function startProfilerService(port = 8793) {
    const server = http.createServer(async (req, res) => {
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

    return new Promise(resolve => {
        server.listen(port, () => {
            console.log(`[Profiler] 服务已启动: http://127.0.0.1:${port}/profile`);
            resolve(server);
        });
    });
}

module.exports = { startProfilerService };

if (process.env.PROFILER_AUTO_START === "true") {
    const port = process.env.PROFILER_PORT ? Number(process.env.PROFILER_PORT) : 8793;
    startProfilerService(port).catch(error => {
        console.error("[Profiler] 启动失败:", error);
        process.exit(1);
    });
}
