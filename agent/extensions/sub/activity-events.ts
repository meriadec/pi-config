/** Versioned extension-bus channel for aggregate parent-owned Delegation Job activity. */
export const DELEGATION_ACTIVITY_EVENT_V1 = "sub:delegation-activity:v1";

/**
 * Semantic activity shared with other extensions.
 *
 * The payload deliberately excludes Job Mailbox and child-session details.
 */
export interface DelegationActivityEventV1 {
  version: 1;
  active: boolean;
}

export function delegationActivityEvent(active: boolean): DelegationActivityEventV1 {
  return { version: 1, active };
}

export function isDelegationActivityEventV1(value: unknown): value is DelegationActivityEventV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event["version"] === 1 && typeof event["active"] === "boolean";
}
