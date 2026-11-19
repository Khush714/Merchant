/**
 * Pure change tokens for the workspace refresh loop.
 *
 * Paired businesses get these tokens from Marketplace; unpaired businesses get
 * the same shape computed from their local orders. The browser only ever
 * compares them for inequality, so the two producers need no shared algorithm.
 */

export interface WorkspaceSyncSnapshot {
  count: number;
  paidCount: number;
  latestCreated: string | null;
  latestStatus: string | null;
  latestEvent: string | null;
  latestFeedback: string | null;
  latestReply: string | null;
}

export interface WorkspaceSyncVersion {
  orders: string;
  feedback: string;
}

const token = (value: string | null) => value ?? "-";

export function workspaceSyncVersion(snapshot: WorkspaceSyncSnapshot): WorkspaceSyncVersion {
  return {
    orders: [
      snapshot.count,
      snapshot.paidCount,
      token(snapshot.latestCreated),
      token(snapshot.latestStatus),
      token(snapshot.latestEvent),
    ].join("|"),
    feedback: [token(snapshot.latestFeedback), token(snapshot.latestReply)].join("|"),
  };
}
