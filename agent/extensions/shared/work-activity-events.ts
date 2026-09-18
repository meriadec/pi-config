/** Shared extension-bus channel for the live `/track-pr` background activity. */
export const TRACK_PR_ACTIVITY_EVENT = "work:track-pr-activity";

export interface TrackPrActivityEvent {
  active: boolean;
  pullRequest: {
    number: number;
    url: string;
  };
}
