import "dotenv/config";
import { Sentinel } from "./sentinel/Sentinel.js";

async function main() {
    console.log("==========================================");
    console.log("   Poly-Sniper 全市场实时监控启动中...    ");
    console.log("==========================================");
    console.log(`启动时间: ${new Date().toLocaleString()}`);

    // 不传入特定的 Token ID，Sentinel 将监控所有从 Gamma 加载的市场
    const sentinel = new Sentinel("https://clob.polymarket.com");
    await sentinel.start();

    console.log("\n[状态] 监控程序已就绪。");
    console.log("[提示] 正在监控所有活跃市场的价格异动 (5分钟内波动 > 5%)。");
    console.log("[提示] 异动警报将实时输出到终端。\n");

    // 保持进程运行
    setInterval(() => { }, 10000);
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

main().catch(err => {
    console.error("主程序运行出错:", err);
});
