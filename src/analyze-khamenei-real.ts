import { GammaClient } from './sentinel/GammaClient.js';
import { ChainAnalyzer } from './sentinel/ChainAnalyzer.js';
import { Scorer } from './sentinel/Scorer.js';
import { Profiler } from './sentinel/Profiler.js';
import { TelegramMessenger } from './sentinel/TelegramMessenger.js';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

async function main() {
    console.log("Starting Real Wallet Analysis for 'Khamenei out as Supreme Leader'...");

    // Setup Proxy
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    if (proxyUrl) {
        console.log(`Detected proxy: ${proxyUrl}, configuring global dispatcher...`);
        const dispatcher = new ProxyAgent(proxyUrl);
        setGlobalDispatcher(dispatcher);
    }

    // 1. Initialize Components
    const gamma = new GammaClient();
    // Use public RPC if env not set, or rely on default
    const analyzer = new ChainAnalyzer(process.env.POLYGON_RPC_URL);
    const scorer = new Scorer();
    const profiler = new Profiler(gamma, analyzer, scorer);

    // Initialize Messenger (will warn if no token, which is fine)
    const messenger = new TelegramMessenger();

    // 2. Target Market Details
    const targetTokenId = "101434403359553929764780234916919166959889590658679054429843672204390513588056";
    const conditionId = "0xa8b744720006da3c08b4dc8a61a5ce930542f550fcf8d27380ae898de636799d";
    const metadata = {
        title: "Khamenei out as Supreme Leader of Iran by January 31?",
        marketId: targetTokenId,
        conditionId: conditionId,
        slug: "khamenei-out-as-supreme-leader-of-iran-by-january-31",
        outcome: "Yes",
        category: "Geopolitics"
    };

    // 3. Run Analysis
    console.log(`Analyzing market: ${metadata.title}`);
    console.log(`Token ID: ${targetTokenId}`);
    console.log(`Condition ID: ${conditionId}`);

    try {
        // Pass conditionId to bypass Gamma lookup if needed, though GammaClient should handle it now
        // Price is approx 0.105
        const suspiciousWallets = await profiler.analyzeMarket(targetTokenId, conditionId, 0.105);

        console.log(`\nAnalysis Complete. Found ${suspiciousWallets.length} suspicious wallets.`);

        if (suspiciousWallets.length > 0) {
            console.log("\n--- [SIMULATED TELEGRAM REPORT] ---");

            // Manually format the report as TelegramMessenger would (or close to it)
            let message = `🕵️‍♂️ **内幕钱包画像分析**\n\n`;
            message += `资产: ${metadata.title}\n`;
            message += `共发现 ${suspiciousWallets.length} 个高疑地址：\n\n`;

            suspiciousWallets.slice(0, 10).forEach((wallet, index) => {
                const profile = wallet.profile;
                message += `${index + 1}. [${profile.address.substring(0, 6)}...${profile.address.substring(38)}](https://polygonscan.com/address/${profile.address})\n`;
                message += `   • 评分: ${wallet.totalScore}\n`;
                message += `   • 持仓: $${wallet.positionValue.toFixed(2)}\n`;
                message += `   • 余额: $${profile.usdcBalance.toFixed(2)}\n`;
                message += `   • 账号: ${profile.isNew ? "新号" : "老号"} (Tx: ${profile.transactionCount})\n`;
                message += `   • 特征: ${wallet.details.join(", ")}\n\n`;
            });

            if (suspiciousWallets.length > 10) {
                message += `...以及其他 ${suspiciousWallets.length - 10} 个地址\n`;
            }

            console.log(message);
            console.log("-----------------------------------");

            // Try to send real message if configured
            if ((messenger as any).bot) {
                console.log("Attempting to send to real Telegram...");
                await messenger.sendProfilerReport(metadata, suspiciousWallets);
            } else {
                console.log("Telegram credentials not found. Skipping real send.");
            }

        } else {
            console.log("No suspicious wallets found matching the criteria.");
        }

    } catch (error) {
        console.error("Analysis failed:", error);
    }
}

main().catch(console.error);
