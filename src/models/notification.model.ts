export type NotificationKind = "run" | "error" | "board" | "search";

export type BoardErrorCode =
  | "not_found"
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "parse"
  | "network";

export interface RunPayload {
  status: "completed" | "completed_with_errors";
  jobsSearched: number;
  jobsSaved: number;
  belowThreshold: number;
  boardsFailed: number;
  aiError: string | null;
}

export interface BoardFailurePayload {
  token: string;
  companyName: string;
  code: BoardErrorCode;
  reason: string;
}

export interface ErrorPayload {
  reason: string;
  jobsSaved: number;
  boards: BoardFailurePayload[]; // non-empty only when every board failed
}

export interface BoardPayload extends BoardFailurePayload {
  provider: string; // display label, e.g. "Greenhouse"
}

/** A Find jobs run that added jobs to its results. */
export interface SearchPayload {
  searchId: string;
  searchName: string;
  rankingId: string;
  added: number;
}

export type NotificationTab = "all" | "unread" | "errors" | "runs";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  payload: RunPayload | ErrorPayload | BoardPayload | SearchPayload;
  occurrences: number;
  occurredAt: Date;
  createdAt: Date;
  readAt: Date | null;
  dismissedAt: Date | null;
  automation: { id: string; name: string } | null; // null for kind "search"
}

export interface NotificationSummary {
  unread: number;
  unreadErrors: number;
}
