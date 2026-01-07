"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Scorer = void 0;
var Scorer = /** @class */ (function () {
    function Scorer() {
    }
    /**
     * 对钱包进行打分 (基于 Optimize Scoring 规范)
     * @param profile 钱包画像
     * @param positionValue 该市场的持仓价值 (USD)
     * @param isCorrelated 是否与其他高分钱包有关联 (同源资金)
     */
    Scorer.prototype.score = function (profile, positionValue, isCorrelated) {
        if (isCorrelated === void 0) { isCorrelated = false; }
        var freshnessScore = 0;
        var focusScore = 0;
        var positionScore = 0;
        var correlationScore = 0;
        var capitalScore = 0;
        var details = [];
        // 1. 账号新鲜度 (Max 30%) - 越新越可疑
        // 特殊规则: 如果是单市场专用账户 (Dedicated Account)，无论交易次数多少，视为"新/专用"账户
        // 使用 Event Count 判断真实专注度
        var effectiveFocusCount = profile.eventCount !== undefined && profile.eventCount > 0
            ? profile.eventCount
            : profile.marketCount;
        if (effectiveFocusCount === 1) {
            freshnessScore = 30;
            details.push("Dedicated Account (Single Event)");
        }
        else if (profile.firstSeenTimestamp) {
            // 时间衰减算法: 优先基于时间打分
            var nowSeconds = Math.floor(Date.now() / 1000);
            var ageHours = (nowSeconds - profile.firstSeenTimestamp) / 3600;
            if (ageHours < 24) {
                freshnessScore = 40;
                details.push("Brand New (<24h)");
            }
            else if (ageHours < 48) {
                freshnessScore = 30;
                details.push("Very New (<48h)");
            }
            else if (ageHours < 168) { // 1 week
                freshnessScore = 20;
                details.push("New (<1w)");
            }
            else if (ageHours < 720) { // 30 days
                freshnessScore = 10;
                details.push("Recent (<1mo)");
            }
            // > 1 month gets 0 freshness score
        }
        else if (profile.transactionCount < 5) {
            freshnessScore = 30;
            details.push("New Account (Tx<5)");
        }
        else if (profile.transactionCount < 20) {
            freshnessScore = 20;
            details.push("Recent Account (Tx<20)");
        }
        else if (profile.transactionCount < 50) {
            freshnessScore = 10;
            details.push("Active Account (Tx<50)");
        }
        // 2. 专注度 (Max 30%) - 狙击手通常只关注极少数目标 (Events or Markets)
        // 优先使用 Event Count 判断 (如果可用)
        var focusCount = profile.eventCount !== undefined && profile.eventCount > 0
            ? profile.eventCount
            : profile.marketCount;
        // 市场数/事件数 = 1: 30分; <= 3: 15分
        if (focusCount === 1) {
            focusScore = 30;
            details.push("Single Event/Market Focus");
        }
        else if (focusCount <= 3) {
            focusScore = 15;
            details.push("High Focus (<=".concat(focusCount, " Events)"));
        }
        // 3. 本市场持仓 (Max 20%) - 投入越大信心越足
        // > $50k: 20分; > $10k: 15分; > $1k: 5分
        if (positionValue >= 50000) {
            positionScore = 20;
            details.push("Heavy Position (>$50k)");
        }
        else if (positionValue >= 10000) {
            positionScore = 15;
            details.push("Large Position (>$10k)");
        }
        else if (positionValue >= 1000) {
            positionScore = 5;
            details.push("Medium Position (>$1k)");
        }
        // 4. 关联性 (Max 10%) - 团伙作案特征
        // 检测到同源资金: 10分
        if (isCorrelated) {
            correlationScore = 10;
            details.push("Funded by Shared Source");
        }
        // 5. 资金储备 (Max 10%) - 弹药库
        // USDC > $50k: 10分; > $10k: 5分
        if (profile.usdcBalance >= 50000) {
            capitalScore = 10;
            details.push("High Capital (>$50k)");
        }
        else if (profile.usdcBalance >= 10000) {
            capitalScore = 5;
            details.push("Good Capital (>$10k)");
        }
        var totalScore = freshnessScore + focusScore + positionScore + correlationScore + capitalScore;
        return {
            address: profile.address,
            totalScore: totalScore,
            profile: profile,
            positionValue: positionValue,
            breakdown: {
                freshness: freshnessScore,
                focus: focusScore,
                position: positionScore,
                correlation: correlationScore,
                capital: capitalScore
            },
            details: details
        };
    };
    return Scorer;
}());
exports.Scorer = Scorer;
