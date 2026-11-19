/**
 * Local-only review themes for unpaired and demo workspaces.
 *
 * Paired businesses MUST use the themes returned by Marketplace; this helper is
 * never applied to a paired inbox. It mirrors the Marketplace buckets so a
 * merchant moving between demo and live data sees the same language.
 */

import type { ReviewTheme } from "./types";

const FEEDBACK_WINDOW_DAYS = 30;

type ThemeRow = {
  review: string;
  rating: number | null;
  feedbackAt: string | Date | null;
};

const THEME_RULES = [
  {
    key: "food",
    label: "Food quality",
    terms: ["taste", "tasty", "delicious", "flavour", "flavor", "fresh", "bland", "dry", "burnt", "salty", "spicy", "cold", "hot", "quality"],
  },
  {
    key: "delivery",
    label: "Delivery",
    terms: ["delivery", "late", "delay", "rider", "arrived", "arrival", "slow", "fast", "minutes", "time"],
  },
  {
    key: "packaging",
    label: "Packaging",
    terms: ["pack", "packaging", "leak", "leaked", "spill", "spilled", "box", "wrapper", "seal"],
  },
  {
    key: "service",
    label: "Service",
    terms: ["staff", "rude", "service", "support", "behaviour", "behavior", "response", "called"],
  },
  {
    key: "value",
    label: "Value",
    terms: ["price", "priced", "expensive", "worth", "value", "money", "cost", "portion", "quantity"],
  },
] as const;

export function localReviewThemes(rows: readonly ThemeRow[], now = new Date()): ReviewTheme[] {
  const since = now.getTime() - FEEDBACK_WINDOW_DAYS * 86_400_000;
  const buckets = new Map<string, { label: string; count: number; ratings: number[] }>();

  const add = (key: string, label: string, rating: number | null) => {
    const bucket = buckets.get(key) ?? { label, count: 0, ratings: [] };
    bucket.count += 1;
    if (typeof rating === "number") bucket.ratings.push(rating);
    buckets.set(key, bucket);
  };

  for (const row of rows) {
    const stamp = row.feedbackAt ? new Date(row.feedbackAt).getTime() : Number.NaN;
    if (!Number.isFinite(stamp) || stamp < since) continue;
    const text = row.review.trim().toLowerCase();
    if (!text) continue;
    const matched = THEME_RULES.filter((rule) => rule.terms.some((term) => text.includes(term)));
    if (!matched.length) add("other", "Other", row.rating);
    else for (const rule of matched) add(rule.key, rule.label, row.rating);
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      count: bucket.count,
      averageRating: bucket.ratings.length
        ? Math.round((bucket.ratings.reduce((sum, rating) => sum + rating, 0) / bucket.ratings.length) * 10) / 10
        : null,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 5);
}
