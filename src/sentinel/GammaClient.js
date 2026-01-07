"use strict";
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
exports.GammaClient = void 0;
var undici_1 = require("undici");
var GammaClient = /** @class */ (function () {
    function GammaClient() {
        this.baseUrl = "https://gamma-api.polymarket.com";
        this.dataApiUrl = "https://data-api.polymarket.com";
        var proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxyUrl) {
            console.log("[GammaClient] \u4F7F\u7528\u4EE3\u7406: ".concat(proxyUrl));
            this.dispatcher = new undici_1.ProxyAgent(proxyUrl);
        }
    }
    /**
     * 获取市场的 Top 持仓者
     * @param conditionId 市场的 Condition ID
     * @param tokenId 特定的 Token ID (用于过滤 Yes/No)
     * @param limit 获取前多少名
     */
    GammaClient.prototype.getTopHolders = function (conditionId_1, tokenId_1) {
        return __awaiter(this, arguments, void 0, function (conditionId, tokenId, limit) {
            var url, response, data, tokenData, error_1;
            if (limit === void 0) { limit = 20; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 3, , 4]);
                        url = "".concat(this.dataApiUrl, "/holders?market=").concat(conditionId, "&limit=").concat(limit);
                        console.log("[GammaClient] \u6B63\u5728\u8BF7\u6C42: ".concat(url));
                        return [4 /*yield*/, (0, undici_1.fetch)(url, { dispatcher: this.dispatcher })];
                    case 1:
                        response = _a.sent();
                        if (!response.ok) {
                            console.error("[GammaClient] Data API \u9519\u8BEF: ".concat(response.status, " ").concat(response.statusText));
                            return [2 /*return*/, []];
                        }
                        return [4 /*yield*/, response.json()];
                    case 2:
                        data = _a.sent();
                        console.log("[GammaClient] \u6536\u5230\u6570\u636E\uFF0C\u957F\u5EA6: ".concat(data.length));
                        tokenData = data.find(function (item) { return item.token === tokenId; });
                        if (!tokenData || !tokenData.holders) {
                            console.log("[GammaClient] \u672A\u627E\u5230 Token ID ".concat(tokenId, " \u7684\u6301\u4ED3\u6570\u636E"));
                            return [2 /*return*/, []];
                        }
                        return [2 /*return*/, tokenData.holders.map(function (item) { return ({
                                address: item.proxyWallet || item.userAddress,
                                balance: parseFloat(item.amount)
                            }); })];
                    case 3:
                        error_1 = _a.sent();
                        console.error("[GammaClient] \u83B7\u53D6\u6301\u4ED3\u8005\u5931\u8D25:", error_1);
                        return [2 /*return*/, []];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * 根据 Token ID 查找对应的市场元数据
     */
    GammaClient.prototype.getMarketMetadataByTokenId = function (tokenId) {
        return __awaiter(this, void 0, void 0, function () {
            var url, response, data, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 3, , 4]);
                        url = "".concat(this.baseUrl, "/markets?clob_token_ids=").concat(tokenId);
                        return [4 /*yield*/, (0, undici_1.fetch)(url, { dispatcher: this.dispatcher })];
                    case 1:
                        response = _a.sent();
                        if (!response.ok)
                            return [2 /*return*/, null];
                        return [4 /*yield*/, response.json()];
                    case 2:
                        data = _a.sent();
                        if (data.length > 0) {
                            return [2 /*return*/, {
                                    id: data[0].id,
                                    conditionId: data[0].conditionId
                                }];
                        }
                        return [2 /*return*/, null];
                    case 3:
                        error_2 = _a.sent();
                        return [2 /*return*/, null];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * 根据 Slug 查找市场元数据
     */
    GammaClient.prototype.getMarketMetadataBySlug = function (slug) {
        return __awaiter(this, void 0, void 0, function () {
            var eventUrl, response, data, market, marketUrl, mResponse, mData, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 7, , 8]);
                        eventUrl = "".concat(this.baseUrl, "/events?slug=").concat(slug);
                        return [4 /*yield*/, (0, undici_1.fetch)(eventUrl, { dispatcher: this.dispatcher })];
                    case 1:
                        response = _a.sent();
                        if (!response.ok) return [3 /*break*/, 3];
                        return [4 /*yield*/, response.json()];
                    case 2:
                        data = _a.sent();
                        if (data.length > 0 && data[0].markets && data[0].markets.length > 0) {
                            market = data[0].markets[0];
                            return [2 /*return*/, {
                                    id: market.id,
                                    conditionId: market.conditionId,
                                    title: market.question,
                                    tokenIds: JSON.parse(market.clobTokenIds || "[]")
                                }];
                        }
                        _a.label = 3;
                    case 3:
                        marketUrl = "".concat(this.baseUrl, "/markets?slug=").concat(slug);
                        return [4 /*yield*/, (0, undici_1.fetch)(marketUrl, { dispatcher: this.dispatcher })];
                    case 4:
                        mResponse = _a.sent();
                        if (!mResponse.ok) return [3 /*break*/, 6];
                        return [4 /*yield*/, mResponse.json()];
                    case 5:
                        mData = _a.sent();
                        if (mData.length > 0) {
                            return [2 /*return*/, {
                                    id: mData[0].id,
                                    conditionId: mData[0].conditionId,
                                    title: mData[0].question,
                                    tokenIds: JSON.parse(mData[0].clobTokenIds || "[]")
                                }];
                        }
                        _a.label = 6;
                    case 6: return [2 /*return*/, null];
                    case 7:
                        error_3 = _a.sent();
                        console.error("[GammaClient] Failed to resolve slug:", error_3);
                        return [2 /*return*/, null];
                    case 8: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * 获取用户的最近活动 (用于修正交易次数和市场专注度)
     * @param address 钱包地址
     * @param limit 获取的条目数 (默认 50，足以判断活跃度)
     */
    GammaClient.prototype.getUserActivity = function (address_1) {
        return __awaiter(this, arguments, void 0, function (address, limit) {
            var url, response, data, error_4;
            if (limit === void 0) { limit = 50; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 3, , 4]);
                        url = "".concat(this.dataApiUrl, "/activity?user=").concat(address, "&limit=").concat(limit);
                        return [4 /*yield*/, (0, undici_1.fetch)(url, { dispatcher: this.dispatcher })];
                    case 1:
                        response = _a.sent();
                        if (!response.ok) {
                            console.warn("[GammaClient] Activity API Error: ".concat(response.status));
                            return [2 /*return*/, []];
                        }
                        return [4 /*yield*/, response.json()];
                    case 2:
                        data = _a.sent();
                        return [2 /*return*/, data.map(function (item) { return ({
                                timestamp: item.timestamp,
                                type: item.type,
                                slug: item.slug,
                                eventSlug: item.eventSlug, // Added Mapping
                                marketId: item.marketId || item.conditionId, // 兼容不同字段
                                asset: item.asset,
                                side: item.side,
                                size: item.size,
                                usdcSize: item.usdcSize
                            }); })];
                    case 3:
                        error_4 = _a.sent();
                        console.warn("[GammaClient] \u83B7\u53D6\u7528\u6237\u6D3B\u52A8\u5931\u8D25 ".concat(address, ":"), error_4);
                        return [2 /*return*/, []];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    return GammaClient;
}());
exports.GammaClient = GammaClient;
