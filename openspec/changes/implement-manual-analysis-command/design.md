# Design: Interactive Bot Commands

## Architecture
The `TelegramMessenger` class will evolve from a pure "Output" sink to an interactive component.

### State Flow
1.  **Idle**: Listening for commands.
2.  **Command Received (`/suspicious`)**:
    -   Check if `chatId` matches authorized admin ID.
    -   Set state `userState[chatId] = 'AWAITING_MARKET_LINK'`.
    -   Reply: "Please send the Polymarket market/event link."
3.  **Message Received**:
    -   Check `userState[chatId]`.
    -   If `AWAITING_MARKET_LINK`:
        -   Validate URL.
        -   Extract Slug.
        -   Resolve Metadata (via Gamma).
        -   Trigger `Profiler`.
        -   Send "Analyzing..." message.
        -   (Async) Send Report.
        -   Clear State.

### Components
-   **TelegramMessenger**: Handles the UI/UX.
-   **Sentinel**: Needs to expose access to `Profiler` or `TelegramMessenger` needs to hold a reference to `Profiler`.
    -   *Decision*: Currently `Sentinel` owns `Profiler`. We should pass `Profiler` instance to `TelegramMessenger` or provide a callback. Passing the `Profiler` dependency to `TelegramMessenger` seems cleaner for this specific feature, as `Messenger` becomes a controller for this action.

### Dependency Injection
Current: `Sentinel` -> creates `TelegramMessenger`
Proposed: `Sentinel` -> creates `Profiler`, then creates `TelegramMessenger(profiler)`.

### URL Resolution
Polymarket URLs are typically:
-   `https://polymarket.com/event/will-btc-hit-100k` (Event Slug)
-   `https://polymarket.com/market/will-btc-hit-100k-binary` (Market Slug)

We need `GammaClient` to lookup markets by `slug`. Existing `getMarketMetadataByTokenId` uses ID. We might need a new method `getMarketMetadataBySlug`.
