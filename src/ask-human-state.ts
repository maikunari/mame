// src/ask-human-state.ts — State machine for the MCP `ask_human` tool.
//
// Evening 6 of the pi-ai migration: lets Claude Code (or any other
// child agent) pause mid-task and ask Mame a clarifying question, which
// routes through the messaging gateway to the human user, who answers
// in the same channel that dispatched the task. The answer becomes the
// child agent's tool result and it resumes from where it paused.
//
// This module is the shared state between three components:
// 1. src/tools/claude-code.ts — registers the task before spawning the
//    subprocess, clears it on exit
// 2. src/mcp-server.ts — the HTTP MCP server's ask_human tool handler
//    reads activeTask to know where to route questions
// 3. src/gateway.ts — the Discord/Signal message handler checks whether
//    a pending question is waiting for this channel before treating the
//    incoming message as a fresh prompt
//
// ## Simplifying constraint for v1
//
// Only one active ask-human task at a time. A second registerTask() call
// while one is active throws. This is a personal-agent-scale design
// decision — if you ever need concurrent orchestration, this map becomes
// keyed by taskId and the gateway routes by matching the incoming
// channel to the right task.

import { childLogger } from "./logger.js";

const log = childLogger("ask-human");

export type AskHumanChannel = "discord" | "signal" | "cli" | "webhook";

export interface ActiveTask {
  /**
   * Unique identifier for this dispatch. Used in logs and (eventually)
   * in multi-task routing.
   */
  taskId: string;

  /**
   * Which messaging channel dispatched the task. Questions from the
   * child agent route back to this channel so the user sees them in
   * the same conversation they started.
   */
  channel: AskHumanChannel;

  /**
   * Channel-specific identifier (Discord channel ID, Signal number, etc).
   * Passed to gateway.notify() to deliver the question.
   */
  channelId?: string;

  /**
   * The persona whose agent loop dispatched this task. Included in logs
   * for traceability.
   */
  persona: string;

  /**
   * Short human-readable description of what the child agent is doing.
   * Shown alongside the question when it arrives in Discord so the user
   * has context — "I'm working on the spring product descriptions, and
   * I need to know..."
   */
  description?: string;

  /**
   * Epoch millis the task was registered.
   */
  startedAt: number;

  /**
   * When the child agent is currently waiting for a human answer, this
   * holds the resolve/reject pair from the Promise the ask_human tool
   * handler returned, plus the timeout handle so we can cancel it when
   * the answer arrives.
   *
   * Null when the task is running but not currently blocked on a question.
   */
  pendingQuestion: {
    question: string;
    asked: number;
    resolve: (answer: string) => void;
    reject: (err: Error) => void;
    timeoutHandle: NodeJS.Timeout;
  } | null;
}

/**
 * Module-level singleton: the currently-active task (if any). Null
 * when no child agent is running. Mutated only through the exported
 * helpers below so we get consistent logging.
 */
let activeTask: ActiveTask | null = null;

/**
 * Default timeout for a pending question. After this, the promise
 * rejects with a "user unavailable" error and the child agent continues
 * with whatever fallback the model chooses.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Register a new task before spawning the child agent subprocess.
 *
 * Throws if another task is already active — v1 is single-task only.
 * The caller (claude-code tool) should catch this and return an error
 * to Mame's agent loop rather than retrying.
 */
export function registerTask(task: Omit<ActiveTask, "startedAt" | "pendingQuestion">): void {
  if (activeTask !== null) {
    throw new Error(
      `Cannot register ask-human task ${task.taskId}: another task ${activeTask.taskId} is already active (started ${Math.round((Date.now() - activeTask.startedAt) / 1000)}s ago). v1 only supports one concurrent task.`
    );
  }

  activeTask = {
    ...task,
    startedAt: Date.now(),
    pendingQuestion: null,
  };

  log.info(
    {
      taskId: task.taskId,
      channel: task.channel,
      channelId: task.channelId,
      persona: task.persona,
      description: task.description,
    },
    "Registered ask-human task"
  );
}

/**
 * Called by the MCP ask_human tool handler when the child agent wants
 * to pause and ask the human a question. Returns a Promise that resolves
 * with the human's answer (or rejects on timeout).
 *
 * The caller is expected to have an `onQuestion` callback that actually
 * DELIVERS the question to the human (via gateway.notify). This module
 * only manages the state — it doesn't know about messaging channels.
 */
export async function askHuman(
  question: string,
  onQuestion: (task: ActiveTask, question: string) => Promise<void>,
  timeoutMs: number = DEFAULT_ASK_TIMEOUT_MS
): Promise<string> {
  if (activeTask === null) {
    throw new Error(
      "ask_human called but no task is active. This tool is only usable from within a child agent that was dispatched via the claude-code tool (or equivalent orchestrated subprocess)."
    );
  }

  if (activeTask.pendingQuestion !== null) {
    throw new Error(
      `ask_human called but the current task ${activeTask.taskId} already has a pending question. Wait for the current question to be answered before asking another.`
    );
  }

  const task = activeTask;

  return new Promise<string>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      if (task.pendingQuestion !== null) {
        log.warn(
          { taskId: task.taskId, question, elapsed_ms: Date.now() - task.pendingQuestion.asked },
          "ask-human question timed out; resolving with unavailable-user fallback"
        );
        task.pendingQuestion = null;
        reject(
          new Error(
            `User did not respond within ${Math.round(timeoutMs / 60000)} minutes. Use your best judgment and continue the task, or stop here and report what you've done so far.`
          )
        );
      }
    }, timeoutMs);

    task.pendingQuestion = {
      question,
      asked: Date.now(),
      resolve: (answer: string) => {
        clearTimeout(timeoutHandle);
        resolve(answer);
      },
      reject: (err: Error) => {
        clearTimeout(timeoutHandle);
        reject(err);
      },
      timeoutHandle,
    };

    log.info(
      {
        taskId: task.taskId,
        channel: task.channel,
        question,
      },
      "ask-human question queued; delivering to user via onQuestion callback"
    );

    // Deliver the question. If this throws, reject the promise
    // immediately — we can't wait on an answer we never asked for.
    onQuestion(task, question).catch((err) => {
      log.error(
        { taskId: task.taskId, err: err instanceof Error ? err.message : String(err) },
        "Failed to deliver ask-human question to user"
      );
      clearTimeout(timeoutHandle);
      if (task.pendingQuestion !== null) {
        task.pendingQuestion = null;
        reject(
          new Error(
            `Failed to deliver question to user: ${err instanceof Error ? err.message : String(err)}. Use your best judgment.`
          )
        );
      }
    });
  });
}

/**
 * Called by the gateway when the user sends a reply while a question
 * is pending. Resolves the Promise returned by askHuman(), which
 * unblocks the child agent's MCP tool call.
 *
 * Returns true if there WAS a pending question and the answer was
 * delivered, false otherwise. Gateway callers use this to decide
 * whether the incoming message should also be treated as a fresh prompt.
 */
export function provideAnswer(channel: AskHumanChannel, channelId: string | undefined, answer: string): boolean {
  if (activeTask === null || activeTask.pendingQuestion === null) {
    return false;
  }

  // Only route if the channel matches — otherwise a message in a
  // different Discord channel shouldn't accidentally answer a question
  // being asked in another channel.
  if (activeTask.channel !== channel) {
    return false;
  }
  if (activeTask.channelId && channelId && activeTask.channelId !== channelId) {
    return false;
  }

  const { resolve, question, asked } = activeTask.pendingQuestion;
  activeTask.pendingQuestion = null;

  log.info(
    {
      taskId: activeTask.taskId,
      question,
      answer_preview: answer.slice(0, 80),
      elapsed_ms: Date.now() - asked,
    },
    "ask-human answer delivered to child agent"
  );

  resolve(answer);
  return true;
}

/**
 * Called by the claude-code tool when the child subprocess exits.
 * Cleans up the state. If the task was waiting on a question when the
 * subprocess exited, the pending promise is rejected (the subprocess
 * is gone, nothing to answer to).
 */
export function clearTask(taskId: string): void {
  if (activeTask === null) {
    log.warn({ taskId }, "clearTask called but no task is active");
    return;
  }
  if (activeTask.taskId !== taskId) {
    log.warn(
      { expected: activeTask.taskId, got: taskId },
      "clearTask called with wrong taskId; ignoring"
    );
    return;
  }

  if (activeTask.pendingQuestion !== null) {
    activeTask.pendingQuestion.reject(
      new Error("Child agent exited while a question was pending; answer will not be delivered.")
    );
  }

  log.info(
    { taskId, elapsed_ms: Date.now() - activeTask.startedAt },
    "Cleared ask-human task"
  );
  activeTask = null;
}

/**
 * Read-only view of the current active task. Used by the MCP server
 * to surface status and by tests.
 */
export function getActiveTask(): ActiveTask | null {
  return activeTask;
}

/**
 * Whether there's a task currently waiting for a human answer. Used by
 * the gateway to decide routing for incoming messages.
 */
export function hasPendingQuestion(channel?: AskHumanChannel, channelId?: string): boolean {
  if (activeTask === null || activeTask.pendingQuestion === null) return false;
  if (channel && activeTask.channel !== channel) return false;
  if (channelId && activeTask.channelId && activeTask.channelId !== channelId) return false;
  return true;
}
