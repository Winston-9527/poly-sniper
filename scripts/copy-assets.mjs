#!/usr/bin/env node
/**
 * 构建后把非 TS 资产复制到 dist。
 * 目的：保证「构建产物与源码对应」——dist 必须由 src 生成，src 下不再存放编译产物（方案 §11 P0）。
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = [['src/db/schema.sql', 'dist/db/schema.sql']];
for (const [from, to] of assets) {
    const src = join(ROOT, from), dst = join(ROOT, to);
    if (!existsSync(src)) { console.error(`[copy-assets] 缺少 ${from}`); process.exit(1); }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    console.log(`[copy-assets] ${from} → ${to}`);
}
