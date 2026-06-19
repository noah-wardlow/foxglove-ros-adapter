import { describe, expect, it, vi } from "vitest";

import { ActionClient } from "../src/action-client";
import type { Ros } from "../src/ros";

describe("ActionClient", () => {
  it("waitGoal resolves even when the result arrives before waitGoal is called", async () => {
    const ros = {
      sendActionGoal: vi.fn((_name, _type, _goal, onResult, _onFeedback, _onError, goalId) => {
        onResult?.({
          action: "/fast",
          id: goalId,
          status: 4,
          result: true,
          accepted: true,
          values: {},
          response: {}
        });
        return goalId;
      }),
      cancelActionGoal: vi.fn()
    } as unknown as Ros;

    const client = new ActionClient({ ros, name: "/fast", actionType: "example/action/Fast" });
    const goalId = client.sendGoal({});

    await expect(client.waitGoal(goalId, 10)).resolves.toBeUndefined();
  });
});
