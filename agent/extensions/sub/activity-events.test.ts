import { describe, expect, test } from "bun:test";
import {
  DELEGATION_ACTIVITY_EVENT_V1,
  delegationActivityEvent,
  isDelegationActivityEventV1,
} from "./activity-events.ts";

describe("Delegation Job activity event contract", () => {
  test("publishes only versioned aggregate activity", () => {
    expect(DELEGATION_ACTIVITY_EVENT_V1).toBe("sub:delegation-activity:v1");
    expect(delegationActivityEvent(true)).toEqual({ version: 1, active: true });
    expect(Object.keys(delegationActivityEvent(false))).toEqual(["version", "active"]);
  });

  test("rejects malformed or unversioned payloads", () => {
    expect(isDelegationActivityEventV1({ version: 1, active: true })).toBe(true);
    expect(isDelegationActivityEventV1({ active: true })).toBe(false);
    expect(isDelegationActivityEventV1({ version: 2, active: true })).toBe(false);
    expect(isDelegationActivityEventV1({ version: 1, active: "yes" })).toBe(false);
  });
});
