"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Profiler = void 0;
var GammaClient_js_1 = require("./GammaClient.js");
var ChainAnalyzer_js_1 = require("./ChainAnalyzer.js");
var Scorer_js_1 = require("./Scorer.js");
var Profiler = /** @class */ (function () {
    function Profiler(gamma, analyzer, scorer) {
        if (gamma === void 0) { gamma = new GammaClient_js_1.GammaClient(); }
        if (analyzer === void 0) { analyzer = new ChainAnalyzer_js_1.ChainAnalyzer(); }
        if (scorer === void 0) { scorer = new Scorer_js_1.Scorer(); }
        this.gamma = gamma;
        this.analyzer = analyzer;
        this.scorer = scorer;
    }
    /**
     * 分析特定市场的持仓者
     * @param tokenId Polymarket Token ID
     * @param conditionId Optional Condition ID (if known) to bypass Gamma lookup
     * @param currentPrice 当前代币价格 (用于计算持仓价值)
     * @returns 高分可疑钱包列表
     */
    Profiler.prototype.analyzeMarket = function (tokenId_1, conditionId_1) {
        return __awaiter(this, arguments, void 0, function (tokenId, conditionId, currentPrice) {
            var targetConditionId, metadata, holders, profilesWithHoldings, _i, holders_1, holder, profile, activities, oldestActivity, uniqueMarkets, uniqueEvents, err_1, fundingSources, results, _a, profilesWithHoldings_1, item, positionValue, isCorrelated, sourceCount, scoreResult;
            if (currentPrice === void 0) { currentPrice = 0.5; }
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        console.log("[Profiler] \u6B63\u5728\u5206\u6790\u5E02\u573A\u6301\u4ED3\u8005: ".concat(tokenId, " (\u4EF7\u683C: ").concat(currentPrice, ")"));
                        targetConditionId = conditionId;
                        if (!!targetConditionId) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.gamma.getMarketMetadataByTokenId(tokenId)];
                    case 1:
                        metadata = _b.sent();
                        if (metadata && metadata.conditionId) {
                            targetConditionId = metadata.conditionId;
                        }
                        _b.label = 2;
                    case 2:
                        if (!targetConditionId) {
                            console.warn("[Profiler] \u672A\u627E\u5230\u5BF9\u5E94\u7684\u5E02\u573A\u5143\u6570\u636E (Condition ID): ".concat(tokenId));
                            return [2 /*return*/, []];
                        }
                        return [4 /*yield*/, this.gamma.getTopHolders(targetConditionId, tokenId, 20)];
                    case 3:
                        holders = _b.sent();
                        if (holders.length === 0) {
                            console.log("[Profiler] \u672A\u627E\u5230\u6301\u4ED3\u8005\u6570\u636E: ".concat(tokenId));
                            return [2 /*return*/, []];
                        }
                        console.log("[Profiler] \u627E\u5230 ".concat(holders.length, " \u4E2A\u6301\u4ED3\u8005\uFF0C\u5F00\u59CB\u5206\u6790\u753B\u50CF..."));
                        profilesWithHoldings = [];
                        _i = 0, holders_1 = holders;
                        _b.label = 4;
                    case 4:
                        if (!(_i < holders_1.length)) return [3 /*break*/, 10];
                        holder = holders_1[_i];
                        _b.label = 5;
                    case 5:
                        _b.trys.push([5, 8, , 9]);
                        return [4 /*yield*/, this.analyzer.getProfile(holder.address)];
                    case 6:
                        profile = _b.sent();
                        return [4 /*yield*/, this.gamma.getUserActivity(holder.address, 50)];
                    case 7:
                        activities = _b.sent();
                        // 修正交易次数: 取 RPC Nonce 和 Activity Log Length 的较大值
                        // 如果 Activity 拿满了50条，说明非常活跃，直接覆盖
                        if (activities.length > 0) {
                            profile.transactionCount = Math.max(profile.transactionCount, activities.length);
                            oldestActivity = activities[activities.length - 1];
                            if (oldestActivity && oldestActivity.timestamp) {
                                profile.firstSeenTimestamp = oldestActivity.timestamp;
                            }
                            uniqueMarkets = new Set(activities.map(function (a) { return a.slug; }).filter(function (slug) { return !!slug; }));
                            uniqueEvents = new Set(activities.map(function (a) { return a.eventSlug; }).filter(function (slug) { return !!slug; }));
                            if (uniqueMarkets.size > 0) {
                                profile.marketCount = Math.max(profile.marketCount, uniqueMarkets.size);
                                // Store eventCount in profile (if property exists, need to ensure types.ts update propagates)
                                profile.eventCount = uniqueEvents.size;
                                console.log("[Profiler] ".concat(holder.address, " \u5E02\u573A\u4FEE\u6B63: MarketCount -> ").concat(profile.marketCount, " (Events: ").concat(uniqueEvents.size, ")"));
                            }
                        }
                        profilesWithHoldings.push({ profile: profile, balance: holder.balance });
                        return [3 /*break*/, 9];
                    case 8:
                        err_1 = _b.sent();
                        console.error("[Profiler] \u5206\u6790\u94B1\u5305\u5931\u8D25 ".concat(holder.address, ":"), err_1);
                        return [3 /*break*/, 9];
                    case 9:
                        _i++;
                        return [3 /*break*/, 4];
                    case 10:
                        fundingSources = new Map();
                        profilesWithHoldings.forEach(function (item) {
                            if (item.profile.fundingAddress) {
                                var count = fundingSources.get(item.profile.fundingAddress) || 0;
                                fundingSources.set(item.profile.fundingAddress, count + 1);
                            }
                        });
                        results = [];
                        // 5. 打分
                        for (_a = 0, profilesWithHoldings_1 = profilesWithHoldings; _a < profilesWithHoldings_1.length; _a++) {
                            item = profilesWithHoldings_1[_a];
                            positionValue = item.balance * currentPrice;
                            isCorrelated = false;
                            if (item.profile.fundingAddress) {
                                sourceCount = fundingSources.get(item.profile.fundingAddress) || 0;
                                if (sourceCount > 1) {
                                    isCorrelated = true;
                                }
                            }
                            scoreResult = this.scorer.score(item.profile, positionValue, isCorrelated);
                            // 仅记录有一定可疑度的钱包 (新阈值 60)
                            if (scoreResult.totalScore >= 60) {
                                results.push(__assign(__assign({}, scoreResult), { profile: item.profile }));
                            }
                        }
                        // 按分数降序排列
                        return [2 /*return*/, results.sort(function (a, b) { return b.totalScore - a.totalScore; })];
                }
            });
        });
    };
    return Profiler;
}());
exports.Profiler = Profiler;
