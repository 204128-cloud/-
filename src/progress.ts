export type TaskStage = "baseline" | "localize" | "generate" | "review" | "verify"
  | "target-tests" | "regression-tests" | "replay";

export type TaskProgress = { stage: TaskStage; attempt?: number };
export type ProgressSink = (event: TaskProgress) => void;

export function emitProgress(stage: TaskStage, onProgress?: ProgressSink, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  onProgress?.({ stage });
  signal?.throwIfAborted();
}
