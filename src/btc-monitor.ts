import "dotenv/config";
import { Sentinel } from "./sentinel/Sentinel.js";

/**
 * 专门用于监控 BTC 1h 市场的脚本
 * 提供更详细的运行状态输出
 */
async function monitorBTC() {
    console.log("==========================================");
    console.log("   Poly-Sniper BTC 1h 实时监控启动中...   ");
    console.log("==========================================");
    console.log(`启动时间: ${new Date().toLocaleString()}`);

    // 用户提供的 BTC 1h 市场 Token IDs (Bitcoin Up or Down - January 4, 9AM ET)
    const btcTokenIds = [
        "73829308253333264326021068397047275839298475448638554873034094347827528446488", // Bitcoin Up or Down - January 4, 9AM ET (Up)
        "21256445280740396904577575297021969529540441028146881963935461215730984921172", // Bitcoin Up or Down - January 4, 9AM ET (Down)
    ];

    console.log(`监控目标: Bitcoin Up or Down - January 4, 9AM ET`);
    console.log(`Token IDs: \n - ${btcTokenIds.join('\n - ')}`);

    // 初始化 Sentinel，设置 5% 的波动阈值，5分钟窗口
    const sentinel = new Sentinel("https://clob.polymarket.com", btcTokenIds);

    await sentinel.start();

    console.log("\n[状态] 脚本正在运行。");
    console.log("[提示] 如果 5 分钟内价格波动超过 5%，你将在这里看到警报。");
    console.log("[提示] 每处理 100 条消息会输出一次系统存活日志。\n");

    // 保持进程运行并定期输出心跳
    setInterval(() => {
        // 这里可以添加一些额外的状态检查逻辑
    }, 10000);
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

monitorBTC().catch(err => {
    console.error("监控程序运行出错:", err);
});
