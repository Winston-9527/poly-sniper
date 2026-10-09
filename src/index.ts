import "dotenv/config";
import { createApp } from "./app.js";
import { Sentinel } from "./sentinel/Sentinel.js";

/**
 * 入口。PIPELINE 选择运行哪条链路：
 *   sentinel（默认）：现有生产链路（异动 → 可疑钱包画像），保持切换前行为不变。
 *   ledger          ：P1 新链路（持续采集 + 持仓账本 + 行为报告）。
 * 未显式设置时默认 sentinel，避免重启就把生产行为换掉；新链路先用 npm run shadow 影子运行核对。
 */
async function main() {
    const which = (process.env.PIPELINE ?? 'sentinel').toLowerCase();
    console.log("==========================================");
    console.log(`   Poly-Sniper 启动（PIPELINE=${which}）`);
    console.log("==========================================");
    console.log(`启动时间: ${new Date().toLocaleString()}`);

    if (which === 'ledger') {
        const app = createApp();
        app.log(`影子模式: ${app.config.shadowMode ? '开（不向 Telegram 发消息）' : '关'}`);
        app.log(`数据库: ${app.config.dbPath}`);
        app.log(`推送限速: ${app.config.push.maxPerMinute}/分钟，日上限 ${app.config.push.maxPerDay} 条`);
        app.outbox.recover();
        app.bot.start();

        // 上线提示：只发一条，把限速与查询方式讲清楚（避免用户误以为「被刷屏」或「没生效」）
        if (!app.config.shadowMode && app.config.telegram.enabled) {
            app.bot.ensureSender();
            const watch = app.repos.watchlist(true).length;
            const text = [
                '<b>Poly-sniper 新链路已上线</b>',
                'P1：持续观察 + 持仓账本（新出现持仓 / 加仓 / 减仓 / 本地址退出）',
                `推送限速：${app.config.push.maxPerMinute}/分钟，日上限 ${app.config.push.maxPerDay} 条；超限并入当日摘要，次日汇总一条，不会丢消息`,
                `当前关注对象：${watch} 个；采集间隔 ${Number(process.env.CYCLE_INTERVAL_SECONDS ?? 300)} 秒`,
                '查询：/status 采集与缺口 ｜ /wallet 0x… 画像 ｜ /check 市场链接',
                '报告区分事实/推断/缺失；「未观察到」不等于「没有发生」。',
            ].join('\n');
            const r = await app.bot.send(text);
            app.log(`[startup] 上线提示：${r.ok ? 'id=' + r.messageId : '失败 ' + r.error}`);
        }

        const intervalMs = Number(process.env.CYCLE_INTERVAL_SECONDS ?? 300) * 1000;
        const backupEveryCycles = Number(process.env.BACKUP_EVERY_CYCLES ?? 96); // 约每 8 小时（5 分钟一轮）
        let running = false;
        let cycles = 0;
        const tick = async () => {
            if (running) { app.log('[cycle] 上一轮尚未结束，跳过本次'); return; }
            running = true;
            try {
                const rep = await app.pipeline.runCycle({});
                cycles++;
                app.log(`[cycle] 处理 ${rep.processed} 个对象，新增事件 ${rep.events}，入队 ${rep.queued}，记录未推送 ${rep.suppressed}，投递 ${JSON.stringify(rep.flush)}`);
                for (const w of rep.warnings.slice(0, 5)) app.log(`[cycle][warn] ${w}`);
                if (cycles % backupEveryCycles === 0) {
                    const file = app.db.backupTo(app.config.backupDir);
                    app.log(`[backup] ${file}`);
                }
            } catch (e) {
                app.log(`[cycle][error] ${(e as Error).stack ?? String(e)}`);
            } finally {
                running = false;
            }
        };
        await tick();
        setInterval(() => { void tick(); }, intervalMs);

        const shutdown = (sig: string) => {
            app.log(`收到 ${sig}，开始关闭：先停投递，再关数据库`);
            void app.bot.stop().finally(() => { app.close(); process.exit(0); });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        return;
    }

    // 默认：现有生产链路
    const sentinel = new Sentinel("https://clob.polymarket.com");
    await sentinel.start();
    console.log("\n[状态] 监控程序已就绪。");
    console.log("[提示] 正在监控所有活跃市场的价格异动 (5分钟内波动 > 5%)。");
    console.log("[提示] 异动警报将实时输出到终端。\n");
    setInterval(() => { }, 10000);
}

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

main().catch(err => {
    console.error("主程序运行出错:", err);
});
