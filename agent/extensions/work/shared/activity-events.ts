/** Shared extension-bus channel for the live `/track-pr` background activity. */
export const TRACK_PR_ACTIVITY_EVENT = "work:track-pr-activity";

export interface TrackPrActivityEvent {
  active: boolean;
  pullRequest: {
    number: number;
    url: string;
  };
}

/** Accepts only the small, explicit activity payload shared by trusted extensions. */
export function isTrackPrActivityEvent(value: unknown): value is TrackPrActivityEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const activity = value as Record<string, unknown>;
  const pullRequest = activity["pullRequest"];
  if (
    typeof activity["active"] !== "boolean" ||
    pullRequest === null ||
    typeof pullRequest !== "object"
  ) {
    return false;
  }
  const reference = pullRequest as Record<string, unknown>;
  return (
    typeof reference["number"] === "number" &&
    Number.isInteger(reference["number"]) &&
    reference["number"] > 0 &&
    typeof reference["url"] === "string" &&
    /^https:\/\/github\.com\/[^\s]+$/.test(reference["url"])
  );
}
