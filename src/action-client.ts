import { Ros } from "./ros";
import type { ActionFeedback, ActionResult } from "./types";

function newActionGoalId(): string {
  const cryptoLike = globalThis.crypto as Crypto | undefined;
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoLike?.getRandomValues) {
    cryptoLike.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

export interface ActionClientOptions {
  ros: Ros;
  /** ROS action name, e.g. `/fibonacci` or `/do_objective`. */
  name: string;
  /** ROS action type, e.g. `example_interfaces/action/Fibonacci`. */
  actionType: string;
  /** Accepted for roslib compatibility; reconnect behavior is owned by Ros. */
  reconnectOnClose?: boolean;
}

export class ActionClient<
  TGoal = Record<string, unknown>,
  TResult = unknown,
  TFeedback = unknown
> {
  ros: Ros;
  name: string;
  actionType: string;
  reconnectOnClose: boolean;

  private readonly waiters = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly completedGoals = new Set<string>();
  private readonly failedGoals = new Map<string, Error>();

  constructor(options: ActionClientOptions) {
    this.ros = options.ros;
    this.name = options.name;
    this.actionType = options.actionType;
    this.reconnectOnClose = options.reconnectOnClose ?? true;
  }

  sendGoal(
    goal: TGoal,
    onResult?: (result: ActionResult<TResult>) => void,
    onFeedback?: (feedback: ActionFeedback<TFeedback>) => void,
    onError?: (error: Error) => void
  ): string {
    const goalId = newActionGoalId();
    return this.ros.sendActionGoal<TGoal, TResult, TFeedback>(
      this.name,
      this.actionType,
      goal,
      (result) => {
        this.resolveWaiter(goalId);
        onResult?.(result);
      },
      onFeedback,
      (error) => {
        this.rejectWaiter(goalId, error);
        onError?.(error);
      },
      goalId
    );
  }

  cancelGoal(goalId: string): Promise<Record<string, unknown>> {
    this.resolveWaiter(goalId);
    return this.ros.cancelActionGoal(this.name, goalId);
  }

  waitGoal(goalId: string, timeoutMs?: number): Promise<void> {
    if (this.completedGoals.has(goalId)) return Promise.resolve();
    const priorError = this.failedGoals.get(goalId);
    if (priorError) return Promise.reject(priorError);

    if (this.waiters.has(goalId)) {
      return Promise.reject(new Error(`Already waiting for goal ${goalId}`));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: undefined as ReturnType<typeof setTimeout> | undefined
      };
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.waiters.delete(goalId);
          reject(new Error(`Timed out waiting for action goal ${goalId}`));
        }, timeoutMs);
      }
      this.waiters.set(goalId, waiter);
    });
  }

  private resolveWaiter(goalId: string): void {
    this.completedGoals.add(goalId);
    this.failedGoals.delete(goalId);
    const waiter = this.waiters.get(goalId);
    if (!waiter) return;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    this.waiters.delete(goalId);
    waiter.resolve();
  }

  private rejectWaiter(goalId: string, error: Error): void {
    this.failedGoals.set(goalId, error);
    this.completedGoals.delete(goalId);
    const waiter = this.waiters.get(goalId);
    if (!waiter) return;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    this.waiters.delete(goalId);
    waiter.reject(error);
  }
}
