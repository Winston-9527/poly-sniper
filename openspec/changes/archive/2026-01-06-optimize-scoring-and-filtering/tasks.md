# 任务列表

## 市场过滤优化
- [x] **更新 MarketFilter 逻辑** <!-- id: update-market-filter -->
    - 修改 `shouldInclude` 方法。
    - 增加 Crypto 短时市场（15m/1h/4h/Daily）的正则排除规则。
    - 增加 Sports 类别的排除规则。
    - 确保 `Pre-market` 关键词拥有最高优先级（即使包含 Crypto 关键词也应保留）。
- [x] **实施流动性阈值** <!-- id: check-liquidity -->
    - 在 `Sentinel` 的 `handleUpdate` 或元数据加载阶段，检查 `liquidity` 字段。
    - 过滤掉流动性 < $10,000 的市场。

## 关联性分析基础
- [x] **扩展 WalletProfile 结构** <!-- id: update-profile-type -->
    - 在 `types.ts` 中为 `WalletProfile` 增加 `fundingAddress` (string | undefined) 字段。
- [x] **实现资金源探测** <!-- id: implement-funder-check -->
    - 在 `ChainAnalyzer` 中新增方法，查询钱包的第一笔入金交易（或最早交易）的 `from` 地址。
    - 处理 RPC 限制，确保不会因为查询历史交易导致超时。

## 打分算法重构
- [x] **升级 Profiler 批处理逻辑** <!-- id: profiler-batch-analysis -->
    - 修改 `Profiler.analyzeMarket`。
    - 在获取所有钱包画像后，进行一轮“同源检测”，找出哪些钱包共享相同的 `fundingAddress`。
    - 将 `isCorrelated` (boolean) 标志传递给 Scorer。
- [x] **重写 Scorer 算法** <!-- id: rewrite-scorer -->
    - 在 `Scorer.ts` 中实现新的权重逻辑：
        - 新鲜度 (30%)
        - 专注度 (30%)
        - 本市场持仓 (20%)
        - 关联性 (10%)
        - 总资金 (10%)
    - 更新 `score` 方法签名，接受 `isCorrelated` 参数。
    - 设置新的警报阈值为 60。

## 验证
- [x] **验证过滤规则** <!-- id: verify-filters -->
    - 使用 `test-detector.ts` 或新脚本测试不同类型的市场 Title 是否被正确过滤或保留。
- [x] **验证打分结果** <!-- id: verify-scoring -->
    - 运行 `src/analyze-khamenei-real.ts` (或其他真实分析脚本)，确认打分结果符合预期分布。
