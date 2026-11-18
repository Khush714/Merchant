import "server-only";

import type { orders } from "@/db/schema";
import type { FeedbackSummary } from "@/lib/types";

export const FEEDBACK_WINDOW_DAYS = 30;
export const MAX_REVIEW_CHARS = 500;

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

/** Marketplace may nest feedback or use customer-facing field names; accept both without trusting their shape. */
export function remoteFeedback(order: any) {
  const source = order?.feedback ?? order;
  if (!source || typeof source !== "object") return null;
  const text = (value: unknown) => typeof value === "string" ? value.trim().slice(0, MAX_REVIEW_CHARS) : "";
  const stamp = (value: unknown) => typeof value === "string" ? value : null;
  const rating = ratingValue(source.rating ?? source.customerRating);
  const review = text(source.review ?? source.customerReview ?? source.comment);
  const merchantResponse = text(source.merchantResponse ?? source.sellerResponse ?? source.reply);
  if (rating === null && !review && !merchantResponse) return null;
  return {
    rating,
    review,
    feedbackAt: stamp(source.feedbackAt ?? source.reviewedAt),
    merchantResponse,
    merchantRespondedAt: stamp(source.merchantRespondedAt ?? source.repliedAt),
  };
}
