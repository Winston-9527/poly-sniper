# Fix Gamma Client Metadata Lookup

## Summary
Fixed a critical bug in `GammaClient.getMarketMetadataByTokenId` where using `clob_token_ids_contains` caused incorrect market metadata (Market ID 12) to be returned for many assets, leading to failures in holder analysis.

## Motivation
Sentinel alerts were generating "Not Found" errors in the Profiler because the system was querying holder data for the wrong market hash (Condition ID `0xe3b4...` which corresponds to an old 2020 election market) instead of the correct market for the assets.

## Solution
Updated `GammaClient.ts` to use the exact match parameter `clob_token_ids` instead of the fuzzy `clob_token_ids_contains`.

## Verification
- Verified with `debug-gamma.ts` that `clob_token_ids` returns correct metadata for the affected Token IDs.
- Verified that `clob_token_ids_contains` was indeed returning the default/incorrect market.
