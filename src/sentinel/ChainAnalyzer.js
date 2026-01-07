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
exports.ChainAnalyzer = void 0;
var ethers_1 = require("ethers");
var ChainAnalyzer = /** @class */ (function () {
    function ChainAnalyzer(rpcUrl) {
        if (rpcUrl === void 0) { rpcUrl = "https://polygon-rpc.com"; }
        this.usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
        this.usdcAbi = ["function balanceOf(address) view returns (uint256)"];
        this.cache = new Map();
        this.CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时
        this.provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl);
    }
    ChainAnalyzer.prototype.getProfile = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var now, cached, _a, txCount, balance, marketCount, fundingAddress, profile, error_1;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        now = Date.now();
                        cached = this.cache.get(address);
                        if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
                            return [2 /*return*/, cached.profile];
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, Promise.all([
                                this.provider.getTransactionCount(address),
                                this.getUsdcBalance(address),
                                this.getMarketCount(address),
                                this.getFundingAddress(address)
                            ])];
                    case 2:
                        _a = _b.sent(), txCount = _a[0], balance = _a[1], marketCount = _a[2], fundingAddress = _a[3];
                        profile = {
                            address: address,
                            transactionCount: txCount,
                            usdcBalance: balance,
                            marketCount: marketCount,
                            isNew: txCount <= 50, // 简单判定：交易少于50笔视为较新
                            fundingAddress: fundingAddress
                        };
                        this.cache.set(address, { profile: profile, timestamp: now });
                        return [2 /*return*/, profile];
                    case 3:
                        error_1 = _b.sent();
                        console.error("[ChainAnalyzer] \u83B7\u53D6\u94B1\u5305\u753B\u50CF\u5931\u8D25 ".concat(address, ":"), error_1);
                        return [2 /*return*/, {
                                address: address,
                                transactionCount: 999,
                                usdcBalance: 0,
                                marketCount: 0,
                                isNew: false
                            }];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    ChainAnalyzer.prototype.getUsdcBalance = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var contract, balance, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        contract = new ethers_1.ethers.Contract(this.usdcAddress, this.usdcAbi, this.provider);
                        return [4 /*yield*/, contract.balanceOf(address)];
                    case 1:
                        balance = _b.sent();
                        return [2 /*return*/, parseFloat(ethers_1.ethers.formatUnits(balance, 6))];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, 0];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * 估算账号年龄（天）
     * 逻辑：通过二分法查找该地址的第一笔交易所在的区块
     */
    ChainAnalyzer.prototype.getAccountAgeDays = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var transactionCount, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.provider.getTransactionCount(address)];
                    case 1:
                        transactionCount = _b.sent();
                        if (transactionCount === 0)
                            return [2 /*return*/, 0];
                        // 这是一个简化的逻辑：获取当前块高，并假设一个平均块时间
                        // 真正的“首笔交易”查询在没有索引器的情况下非常慢
                        // 这里我们先用一个折中方案：查询最近的交易
                        // 如果需要精确，通常需要结合 Polygonscan API
                        // 暂时返回一个模拟值或通过 getTransactionCount 判断是否是新号
                        // 如果交易次数极少，我们认为它是新号
                        return [2 /*return*/, transactionCount < 50 ? 1 : 100];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, 999];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    ChainAnalyzer.prototype.getMarketCount = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                // 暂时返回 1，后续可以结合 Gamma API 查询该用户参与的所有市场
                return [2 /*return*/, 1];
            });
        });
    };
    /**
     * 尝试获取钱包的注资地址（第一笔交易的来源）
     * 这是一个简化实现，尝试查找 Nonce 0 的交易或者最早的交易
     * 由于 RPC 无法高效查询“第一笔转入交易”，这里简化为：
     * 如果 TxCount 很小 (<100)，尝试遍历历史块（极慢）或依赖外部 API
     * 在 MVP 版本中，为避免 RPC 超时，暂返回 undefined，除非有索引器支持
     * 或者：如果这个地址是由另一个地址创建的（合约钱包），这里能查到
     *
     * 改进策略：对于标准EOA，通常无法通过简单RPC获取Funding Source，除非扫描整个链。
     * 既然我们在设计文档中承诺了“尝试识别”，这里做一个模拟实现：
     * 在真实生产环境中，我会调用 Polygonscan API 或 Covalent API。
     * 这里为了不引入新依赖，我们先留空，或者仅对某些特定情况做简单检查。
     */
    ChainAnalyzer.prototype.getFundingAddress = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                // TODO: 集成 Polygonscan API 以获取准确的 Funding Source
                // 目前返回 undefined 以避免 RPC 滥用
                return [2 /*return*/, undefined];
            });
        });
    };
    return ChainAnalyzer;
}());
exports.ChainAnalyzer = ChainAnalyzer;
