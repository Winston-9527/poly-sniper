import { FetchRequest } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, setGlobalDispatcher } from "undici";

let configured = false;
let proxyUrl = "";
let undiciProxy: ProxyAgent | undefined;
let httpsProxy: HttpsProxyAgent<any> | undefined;

// 代理连接池最大连接数
const PROXY_MAX_CONNECTIONS = 6;
// 代理管线并发
const PROXY_PIPELINING = 1;
// 代理连接超时
const PROXY_CONNECT_TIMEOUT_MS = 10000;
// 代理空闲连接上限
const PROXY_MAX_FREE_SOCKETS = 5;
// HTTPS 代理 socket 上限
const PROXY_MAX_SOCKETS = 10;

export function getProxyUrl(): string {
    if (!configured) {
        configureProxyAgents();
    }
    return proxyUrl;
}

export function getUndiciDispatcher(): ProxyAgent | undefined {
    if (!configured) {
        configureProxyAgents();
    }
    return undiciProxy;
}

export function getHttpsProxyAgent(): HttpsProxyAgent<any> | undefined {
    if (!configured) {
        configureProxyAgents();
    }
    return httpsProxy;
}

export function configureProxyAgents() {
    if (configured) {
        return;
    }
    proxyUrl = process.env.https_proxy
        || process.env.HTTPS_PROXY
        || process.env.http_proxy
        || process.env.HTTP_PROXY
        || "";

    if (!proxyUrl) {
        configured = true;
        return;
    }

    const connections = PROXY_MAX_CONNECTIONS;
    const pipelining = PROXY_PIPELINING;
    const connectTimeout = PROXY_CONNECT_TIMEOUT_MS;
    undiciProxy = new ProxyAgent({
        uri: proxyUrl,
        connections,
        pipelining,
        connect: { timeout: connectTimeout }
    });

    const maxSockets = PROXY_MAX_SOCKETS;
    const maxFreeSockets = PROXY_MAX_FREE_SOCKETS;
    httpsProxy = new HttpsProxyAgent(proxyUrl, {
        keepAlive: true,
        maxSockets,
        maxFreeSockets
    } as any);

    setGlobalDispatcher(undiciProxy);
    FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc({ agent: httpsProxy }));
    configured = true;
}
