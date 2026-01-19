import { AnomalyWebhookPayload } from "../sentinel/types.js";

export interface AnomalyRecord extends AnomalyWebhookPayload {
    receivedAt: number;
}

const anomalies: AnomalyRecord[] = [];
const MAX_ANOMALIES = 200;

export function recordAnomaly(payload: AnomalyWebhookPayload) {
    anomalies.unshift({
        ...payload,
        receivedAt: Date.now()
    });

    if (anomalies.length > MAX_ANOMALIES) {
        anomalies.length = MAX_ANOMALIES;
    }
}

export function listRecentAnomalies(limit: number = 20): AnomalyRecord[] {
    return anomalies.slice(0, limit);
}

export function clearAnomalies() {
    anomalies.length = 0;
}
