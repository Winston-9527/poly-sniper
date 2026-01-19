import { ScoreResult, AnomalyWebhookPayload } from "../sentinel/types.js";

export interface WorkflowState {
    anomaly?: AnomalyWebhookPayload;
    wallets?: ScoreResult[];
    llmReport?: string;
    errors?: string[];
}
