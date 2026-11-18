import "server-only";

import type { orders } from "@/db/schema";
import { FEEDBACK_WINDOW_DAYS, MAX_REVIEW_CHARS, normalizeRemoteFeedback } from "@/lib/marketplace-payload";
import type { FeedbackSummary } from "@/lib/types";

export { FEEDBACK_WINDOW_DAYS, MAX_REVIEW_CHARS };
export const remoteFeedback = normalizeRemoteFeedback;

type FeedbackColumns = Pick<typeof orders.$inferSelect, "rating" | "review" | "feedbackAt" | "merchantResponse" | "merchantRespondedAt">;

export function feedbackDto(row: FeedbackColumns) {
  return {
    rating: row.rating,
    review: row.review,
    feedbackAt: row.feedbackAt ? row.feedbackAt.toISOString() : null,
    merchantResponse: row.merchantResponse,
    merchantRespondedAt: row.merchantRespondedAt ? row.merchantRespondedAt.toISOString() : null,
  };
}

export function ratingValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

export function emptyFeedbackSummary(available = false): FeedbackSummary {
  return { available, windowDays: FEEDBACK_WINDOW_DAYS, averageRating: null, reviewCount: 0, badOrders: 0, pendingReplies: 0 };
}
