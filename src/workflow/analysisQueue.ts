// LLM 分析任务队列上限
const ANALYSIS_TASK_QUEUE_LIMIT = 5;
// LLM 分析并发数
const ANALYSIS_TASK_CONCURRENCY = 1;

type AnalysisTask = {
    label: string;
    run: () => Promise<void>;
};

const queue: AnalysisTask[] = [];
let inFlight = 0;
const maxQueueSize = ANALYSIS_TASK_QUEUE_LIMIT;
const concurrency = ANALYSIS_TASK_CONCURRENCY;

export function enqueueAnalysisTask(label: string, run: () => Promise<void>): boolean {
    if (queue.length >= maxQueueSize) {
        console.warn(`[AnalysisQueue] 队列已满，跳过任务: ${label}`);
        return false;
    }
    queue.push({ label, run });
    processQueue();
    return true;
}

function processQueue() {
    while (inFlight < concurrency && queue.length > 0) {
        const task = queue.shift();
        if (!task) {
            return;
        }
        inFlight += 1;
        console.log(`[AnalysisQueue] 开始任务: ${task.label}，并发: ${inFlight}/${concurrency}`);
        task.run()
            .catch(error => {
                console.error(`[AnalysisQueue] 任务失败: ${task.label}`, error);
            })
            .finally(() => {
                inFlight = Math.max(0, inFlight - 1);
                console.log(`[AnalysisQueue] 结束任务: ${task.label}，并发: ${inFlight}/${concurrency}`);
                processQueue();
            });
    }
}
