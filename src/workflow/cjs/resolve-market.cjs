const { GammaClient } = require("../../../dist/sentinel/GammaClient.js");

async function resolveMarket() {
    const slug = process.env.E2E_MARKET_SLUG || "";
    const tokenId = process.env.E2E_MARKET_ID || "";

    const client = new GammaClient();

    if (slug) {
        const metadata = await client.getMarketMetadataBySlug(slug);
        if (!metadata) {
            throw new Error(`未找到 slug 对应市场: ${slug}`);
        }
        const tokenIds = metadata.tokenIds || [];
        if (tokenIds.length === 0) {
            throw new Error("未找到市场的 tokenIds");
        }
        return {
            tokenId: tokenIds[0],
            conditionId: metadata.conditionId,
            title: metadata.title
        };
    }

    if (tokenId) {
        const metadata = await client.getMarketMetadataByTokenId(tokenId);
        if (!metadata) {
            throw new Error(`未找到 tokenId 对应市场: ${tokenId}`);
        }
        return {
            tokenId,
            conditionId: metadata.conditionId,
            title: tokenId
        };
    }

    throw new Error("请设置 E2E_MARKET_SLUG 或 E2E_MARKET_ID");
}

resolveMarket().then(({ tokenId, conditionId, title }) => {
    console.log("[E2E] 真实市场解析成功:");
    console.log(`- tokenId: ${tokenId}`);
    console.log(`- conditionId: ${conditionId}`);
    console.log(`- title: ${title}`);
    process.exit(0);
}).catch(error => {
    console.error("[E2E] 真实市场解析失败:", error);
    process.exit(1);
});
