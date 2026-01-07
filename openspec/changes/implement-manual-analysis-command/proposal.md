# Implement Manual Analysis Command

## Summary
Add interactive capabilities to the Telegram, specifically a `/suspicious` command that allows users to manually request a profiler analysis for a specific Polymarket URL.

## Motivation
Currently, the Sentinel only reports anomalies it detects passively. Users often discover markets via other channels (Twitter, Discord) and want to use the Sentinel's powerful `Profiler` to check for insider activity on those specific markets immediately.

## Solution
1.  **Enable Polling**: Switch `TelegramMessenger` to use polling mode (or at least listen for updates) to receive user messages.
2.  **Command Handler**: Implement a handler for `/suspicious` that initiates a dialogue.
3.  **URL Parsing**: Add logic to extract `slug` or `conditionId` from provided Polymarket URLs.
4.  **On-Demand Profiling**: Expose a method to run `Profiler` on the extracted target and return the results directly to the chat.

## Risks
-   **Performance**: Parsing and profiling a market is resource-intensive (RPC calls). If multiple users spam the command, it could rate-limit the bot or slow down the passive monitoring.
    -   *Mitigation*: Restrict commands to the authorized `TELEGRAM_CHAT_ID`.
-   **State Management**: Need to track which user is currently being asked for a URL.
