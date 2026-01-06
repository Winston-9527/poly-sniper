import { Profiler } from './sentinel/Profiler.js';
import { TelegramMessenger } from './sentinel/TelegramMessenger.js';
import { GammaClient } from './sentinel/GammaClient.js';
import { ChainAnalyzer } from './sentinel/ChainAnalyzer.js';
import { MarketMetadata } from './sentinel/types.js';
import * as dotenv from 'dotenv';
import process from 'process';

dotenv.config();

const infinexTokenId = "42079267139386211679273548973406303782468617746460421235349529889689144466923";
const khameneiTokenId = "101434403359553929764780234916919166959889590658679054429843672204390513588056";

console.log("Checking Telegram config...");
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("⚠️ Missing TELEGRAM_BOT_TOKEN in .env. Messages might fail.");
}

const rpcUrl = process.env.RPC_URL || "https://polygon-rpc.com";
console.log(`Using RPC: ${rpcUrl}`);

const analyzer = new ChainAnalyzer(rpcUrl);
const profiler = new Profiler(new GammaClient(), analyzer);
const messenger = new TelegramMessenger();

async function run() {
    console.log("Starting analysis of real markets...");

    // 1. Analyze Infinex
    console.log("\n------------------------------------------------");
    console.log("Analyzing Market: Infinex Public Sale (> $3M)");
    const infinexConditionId = "0x99180dac9fee0c5077b09aa47d0cfd44afb1a8f20fa81d8b02d67e7b08c88b66";
    const infinexPrice = 0.945;
    console.log("Token ID:", infinexTokenId);
    try {
        const results1 = await profiler.analyzeMarket(infinexTokenId, infinexConditionId, infinexPrice);
        console.log(`✅ Analysis Complete. Found ${results1.length} high-risk wallets.`);

        results1.forEach((r) => {
            console.log(`- Wallet: ${r.address} | Score: ${r.totalScore}`);
            console.log(`  Breakdown: Freshness(${r.breakdown.freshness}), Focus(${r.breakdown.focus}), Pos(${r.breakdown.position}), Corr(${r.breakdown.correlation}), Cap(${r.breakdown.capital})`);
            console.log(`  Details: ${r.details.join(", ")}`);
        });

        if (results1.length > 0) {
            console.log("Sending report to Telegram...");
            const meta1: MarketMetadata = {
                marketId: "1100370",
                category: "Crypto",
                title: "Over $3M committed to the Infinex public sale?",
                conditionId: infinexConditionId,
                liquidity: 61519
            };
            await messenger.sendProfilerReport(meta1, results1);
        }
    } catch (err: any) {
        console.error("Error analyzing Infinex:", err.message || err);
    }

    // 2. Analyze Khamenei Out
    console.log("\n------------------------------------------------");
    console.log("Analyzing Market: Khamenei Out (Jan 31)");
    const khameneiTokenId = "101434403359553929764780234916919166959889590658679054429843672204390513588056";
    const khameneiConditionId = "0xa8b744720006da3c08b4dc8a61a5ce930542f550fcf8d27380ae898de636799d";
    const khameneiPrice = 0.095; // From JSON

    try {
        const results2 = await profiler.analyzeMarket(khameneiTokenId, khameneiConditionId, khameneiPrice);
        console.log(`✅ Analysis Complete. Found ${results2.length} high-risk wallets.`);

        results2.forEach((r) => {
            console.log(`- Wallet: ${r.address} | Score: ${r.totalScore}`);
            console.log(`  Breakdown: Freshness(${r.breakdown.freshness}), Focus(${r.breakdown.focus}), Pos(${r.breakdown.position}), Corr(${r.breakdown.correlation}), Cap(${r.breakdown.capital})`);
            console.log(`  Details: ${r.details.join(", ")}`);
        });

        if (results2.length > 0) {
            console.log("Sending report to Telegram...");
            const meta2: MarketMetadata = {
                marketId: "1106713",
                category: "Geopolitics",
                title: "Khamenei out as Supreme Leader of Iran by January 31?",
                conditionId: khameneiConditionId,
                liquidity: 272254
            };
            await messenger.sendProfilerReport(meta2, results2);
        }
    } catch (err: any) {
        console.error("Error analyzing Khamenei:", err.message || err);
    }
}

run();
