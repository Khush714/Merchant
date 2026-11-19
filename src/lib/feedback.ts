import "server-only";

import type { orders } from "@/db/schema";
import { FEEDBACK_WINDOW_DAYS, MAX_REVIEW_CHARS, normalizeRemoteFeedback } from "@/lib/marketplace-payload";
import { localReviewThemes } from "@/lib/review-themes";
import type { FeedbackSummary, Review, ReviewInbox } from "@/lib/types";

export { FEEDBACK_WINDOW_DAYS, MAX_REVIEW_CHARS };
export const remoteFeedback = normalizeRemoteFeedback;

type FeedbackColumns = Pick<typeof orders.$inferSelect, "rating" | "review" | "feedbackAt" | "merchantResponse" | "merchantRespondedAt">;
type LocalReviewRow = FeedbackColumns & { id: string };

export function feedbackDto(row: FeedbackColumns) {
  return {
    rating: row.rating,
    review: row.review,
    feedbackAt: row.feedbackAt ? row.feedbackAt.toISOString() : null,
    merchantResponse: row.merchantResponse,
    merchantRespondedAt: row.merchantRespondedAt ? row.merchantRespondedAt.toISOString() : null,
  };
}

/** Local reply handle is the order id; paired replies use the Marketplace order code. */
export function reviewDto(row: LocalReviewRow): Review {
  return { orderCode: row.id, ...feedbackDto(row) };
}

export function ratingValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

export function emptyFeedbackSummary(available = false): FeedbackSummary {
  return { available, windowDays: FEEDBACK_WINDOW_DAYS, averageRating: null, reviewCount: 0, badOrders: 0, pendingReplies: 0 };
}

/** Unpaired-only inbox: summary and themes come from local orders, never from a paired listing. */
export function localFeedbackInbox(rows: readonly LocalReviewRow[], now = new Date()): ReviewInbox {
  const reviews = rows.map(reviewDto);
  const since = now.getTime() - FEEDBACK_WINDOW_DAYS * 86_400_000;
  const recent = reviews.filter((row) => row.feedbackAt && Date.parse(row.feedbackAt) >= since);
  const ratings = recent.map((row) => row.rating).filter((rating): rating is number => typeof rating === "number");
  const summary: FeedbackSummary = {
    available: true,
    windowDays: FEEDBACK_WINDOW_DAYS,
    averageRating: ratings.length ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10 : null,
    reviewCount: recent.length,
    badOrders: ratings.filter((rating) => rating <= 2).length,
    pendingReplies: recent.filter((row) => !row.merchantResponse.trim()).length,
  };
  return { reviews, summary, themes: localReviewThemes(recent, now) };
}
