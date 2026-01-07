# Tasks: Manual Analysis Command

- [x] Update `TelegramMessenger` initialization to support `polling: true` (controlled by config/env). <!-- id: 0 -->
- [x] Implement `onText` listener for `/suspicious` command. <!-- id: 1 -->
- [x] Implement state management to track "Waiting for URL" state for users. <!-- id: 2 -->
- [x] Implement URL parser to extract `slug` or `conditionId` from `https://polymarket.com/event/...` or `.../market/...` links. <!-- id: 3 -->
- [x] Integrate with `GammaClient` to resolve slugs to Token IDs/Condition IDs if necessary. <!-- id: 4 -->
- [x] Wire up `Profiler.analyzeMarket` to be called with the resolved ID. <!-- id: 5 -->
- [x] Implement response formatting (reuse existing `sendProfilerReport` logic if possible, or adapt it). <!-- id: 6 -->
- [x] Add access control check (ignore commands from unauthorized Chat IDs). <!-- id: 7 -->
