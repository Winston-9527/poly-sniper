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
exports.TelegramMessenger = void 0;
var node_telegram_bot_api_1 = require("node-telegram-bot-api");
var https_proxy_agent_1 = require("https-proxy-agent");
var GammaClient_js_1 = require("./GammaClient.js");
var TelegramMessenger = /** @class */ (function () {
    function TelegramMessenger(profiler, botOverride) {
        this.bot = null;
        this.chatId = null;
        this.profiler = null;
        this.userStates = new Map(); // ChatID -> State
        this.profiler = profiler || null;
        this.gamma = new GammaClient_js_1.GammaClient(); // Used for slug resolution
        var token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID || null;
        var proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (botOverride) {
            this.bot = botOverride;
            // 如果提供了 botOverride，我们假设它是用于测试，或者已经初始化好的
            // 但我们需要确保 chatId 存在以便进行权限检查（如果是测试，可以模拟一个）
            if (!this.chatId)
                this.chatId = "TEST_CHAT_ID";
            if (this.profiler) {
                this.setupCommands();
            }
        }
        else if (token && this.chatId) {
            var options = {
                polling: !!profiler // Only enable polling if profiler is provided (interactive mode)
            };
            if (proxyUrl) {
                console.log("[Messenger] Telegram \u673A\u5668\u4EBA\u6B63\u5728\u4F7F\u7528\u4EE3\u7406: ".concat(proxyUrl));
                // @ts-ignore - node-telegram-bot-api 的类型定义可能不包含 request 选项
                options.request = {
                    agent: new https_proxy_agent_1.HttpsProxyAgent(proxyUrl)
                };
            }
            this.bot = new node_telegram_bot_api_1.default(token, options);
            console.log("[Messenger] Telegram \u673A\u5668\u4EBA\u5DF2\u521D\u59CB\u5316\u3002\u76EE\u6807 Chat ID: ".concat(this.chatId));
            if (this.profiler) {
                this.setupCommands();
            }
        }
        else {
            console.warn("[Messenger] 未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，Telegram 推送已禁用。");
        }
    }
    TelegramMessenger.prototype.setupCommands = function () {
        var _this = this;
        if (!this.bot)
            return;
        console.log("[Messenger] 正在启用交互式指令 (/suspicious)...");
        // Command: /suspicious
        this.bot.onText(/\/suspicious/, function (msg) {
            var _a;
            var chatId = msg.chat.id;
            if (_this.chatId && chatId.toString() !== _this.chatId)
                return; // Auth Check
            _this.userStates.set(chatId, 'AWAITING_LINK');
            (_a = _this.bot) === null || _a === void 0 ? void 0 : _a.sendMessage(chatId, "请发送 Polymarket 市场或事件链接 (例如 https://polymarket.com/event/...)");
        });
        // Message Handler
        this.bot.on('message', function (msg) { return __awaiter(_this, void 0, void 0, function () {
            var chatId, state;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        chatId = msg.chat.id;
                        if (this.chatId && chatId.toString() !== this.chatId)
                            return [2 /*return*/];
                        if (!msg.text || msg.text.startsWith('/'))
                            return [2 /*return*/]; // Ignore commands
                        state = this.userStates.get(chatId);
                        if (!(state === 'AWAITING_LINK')) return [3 /*break*/, 2];
                        this.userStates.delete(chatId); // Clear state immediately
                        return [4 /*yield*/, this.handleManualAnalysis(chatId, msg.text)];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2: return [2 /*return*/];
                }
            });
        }); });
    };
    TelegramMessenger.prototype.handleManualAnalysis = function (chatId, url) {
        return __awaiter(this, void 0, void 0, function () {
            var slug, urlObj, parts, metadata, suspiciousWallets, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.bot || !this.profiler)
                            return [2 /*return*/];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 15, , 17]);
                        return [4 /*yield*/, this.bot.sendMessage(chatId, "正在解析链接...")];
                    case 2:
                        _a.sent();
                        slug = "";
                        try {
                            urlObj = new URL(url);
                            if (urlObj.hostname.includes('polymarket.com')) {
                                parts = urlObj.pathname.split('/').filter(function (p) { return !!p; });
                                if (parts.length >= 2 && (parts[0] === 'event' || parts[0] === 'market')) {
                                    slug = parts[1];
                                }
                            }
                        }
                        catch (e) {
                            // Ignore URL parsing errors
                        }
                        if (!slug) {
                            slug = url.trim(); // Assume user might have sent raw slug
                        }
                        if (!!slug) return [3 /*break*/, 4];
                        return [4 /*yield*/, this.bot.sendMessage(chatId, "无法识别有效的市场 Slug 或链接。")];
                    case 3:
                        _a.sent();
                        return [2 /*return*/];
                    case 4: return [4 /*yield*/, this.bot.sendMessage(chatId, "\u6B63\u5728\u5206\u6790\u5E02\u573A: ".concat(slug, " ... (\u53EF\u80FD\u9700\u8981\u51E0\u5341\u79D2)"))];
                    case 5:
                        _a.sent();
                        return [4 /*yield*/, this.gamma.getMarketMetadataBySlug(slug)];
                    case 6:
                        metadata = _a.sent();
                        if (!!metadata) return [3 /*break*/, 8];
                        return [4 /*yield*/, this.bot.sendMessage(chatId, "无法找到该市场的元数据 (Gamma API 返回空)。")];
                    case 7:
                        _a.sent();
                        return [2 /*return*/];
                    case 8: return [4 /*yield*/, this.profiler.analyzeMarket(metadata.tokenIds[0] || metadata.id, metadata.conditionId, 0.5)];
                    case 9:
                        suspiciousWallets = _a.sent();
                        if (!(suspiciousWallets.length > 0)) return [3 /*break*/, 12];
                        return [4 /*yield*/, this.sendProfilerReport({
                                title: metadata.title,
                                marketId: metadata.id,
                                category: "Manual",
                                slug: slug,
                                outcome: "N/A"
                            }, suspiciousWallets)];
                    case 10:
                        _a.sent();
                        return [4 /*yield*/, this.bot.sendMessage(chatId, "\u5206\u6790\u5B8C\u6210\u3002\u53D1\u73B0 ".concat(suspiciousWallets.length, " \u4E2A\u9AD8\u7591\u94B1\u5305\u3002"))];
                    case 11:
                        _a.sent();
                        return [3 /*break*/, 14];
                    case 12: return [4 /*yield*/, this.bot.sendMessage(chatId, "\u5206\u6790\u5B8C\u6210\u3002\u672A\u53D1\u73B0\u663E\u8457\u5F02\u5E38 (Top \u6301\u4ED3\u8005\u770B\u8D77\u6765\u6BD4\u8F83\u6B63\u5E38)\u3002")];
                    case 13:
                        _a.sent();
                        _a.label = 14;
                    case 14: return [3 /*break*/, 17];
                    case 15:
                        error_1 = _a.sent();
                        console.error("Manual analysis failed:", error_1);
                        return [4 /*yield*/, this.bot.sendMessage(chatId, "\u5206\u6790\u901A\u8FC7\uFF0C\u8BE6\u60C5\u8BF7\u770B\u7EC8\u7AEF\u65E5\u5FD7: ".concat(error_1.message))];
                    case 16:
                        _a.sent();
                        return [3 /*break*/, 17];
                    case 17: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * 发送异动警报
     */
    TelegramMessenger.prototype.sendAlert = function (anomaly, metadata) {
        return __awaiter(this, void 0, void 0, function () {
            var time, eventUrl, marketUrl, searchUrl, linkSection, message, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.bot || !this.chatId)
                            return [2 /*return*/];
                        time = new Date().toLocaleTimeString();
                        eventUrl = metadata.slug ? "https://polymarket.com/event/".concat(metadata.slug) : "";
                        marketUrl = metadata.slug ? "https://polymarket.com/market/".concat(metadata.slug) : "";
                        searchUrl = "https://polymarket.com/search?q=".concat(encodeURIComponent(metadata.title));
                        linkSection = "";
                        if (eventUrl) {
                            linkSection = "[\u5B98\u7F51\u76F4\u8FBE](".concat(eventUrl, ") | [\u5907\u7528\u94FE\u63A5](").concat(marketUrl, ") | [\u641C\u7D22](").concat(searchUrl, ")");
                        }
                        else {
                            linkSection = "[\u641C\u7D22\u8DF3\u8F6C](".concat(searchUrl, ")");
                        }
                        message = "\n*[!!! \u5F02\u52A8\u8B66\u62A5 !!!]* ".concat(time, "\n*\u5E02\u573A:* ").concat(this.escapeMarkdown(metadata.title), "\n*\u5E45\u5EA6:* `").concat(anomaly.changePercentage, "`\n*\u4EF7\u683C:* `").concat(anomaly.previousPrice.toFixed(2), " -> ").concat(anomaly.currentPrice.toFixed(2), "`\n*\u94FE\u63A5:* ").concat(linkSection, "\n        ").trim();
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' })];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        error_2 = _a.sent();
                        console.error("[Messenger] \u53D1\u9001 Telegram \u6D88\u606F\u5931\u8D25: ".concat(error_2.message));
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * 发送画像分析报告
     */
    TelegramMessenger.prototype.sendProfilerReport = function (metadata, results) {
        return __awaiter(this, void 0, void 0, function () {
            var report, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.bot || !this.chatId)
                            return [2 /*return*/];
                        report = "*[\uD83D\uDD0D \u5185\u5E55\u753B\u50CF\u5206\u6790]* \n";
                        report += "*\u5E02\u573A:* ".concat(this.escapeMarkdown(metadata.title), "\n\n");
                        results.forEach(function (res, index) {
                            var profileUrl = "https://polymarket.com/profile/".concat(res.address);
                            report += "".concat(index + 1, ". *\u94B1\u5305:* [").concat(res.address, "](").concat(profileUrl, ")\n");
                            report += "   *\u5F97\u5206:* `".concat(res.totalScore, "`\n");
                            report += "   *\u7279\u5F81:* ".concat(res.details.join(", "), "\n\n");
                        });
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.bot.sendMessage(this.chatId, report, {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true
                            })];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        error_3 = _a.sent();
                        console.error("[Messenger] \u53D1\u9001\u753B\u50CF\u62A5\u544A\u5931\u8D25: ".concat(error_3.message));
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * 转义 Markdown 特殊字符
     */
    TelegramMessenger.prototype.escapeMarkdown = function (text) {
        return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
    };
    return TelegramMessenger;
}());
exports.TelegramMessenger = TelegramMessenger;
