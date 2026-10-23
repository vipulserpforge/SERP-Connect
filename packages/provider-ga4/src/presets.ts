import type { Ga4Preset, QueryGa4Input } from "@serp/contracts";

export interface PresetDef {
  label: string;
  dimensions: string[];
  metrics: string[];
  orderBy: { field: string; direction: "asc" | "desc" };
  dimensionFilters?: QueryGa4Input["dimensionFilters"];
  metricFilters?: QueryGa4Input["metricFilters"];
  limit?: number;
  /** Plain-English caveat shown as a warning with every result of this preset. */
  note?: string;
  /** "funnel": the single result row is shown as ordered steps with conversion between them. */
  special?: "funnel";
}

const PAGE_METRICS = ["sessions", "activeUsers", "engagementRate", "keyEvents"];
const TRAFFIC_METRICS = ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents"];
const ITEM_METRICS = ["itemRevenue", "itemsPurchased", "itemsViewed", "itemsAddedToCart"];
const DEMOGRAPHIC_NOTE = "Age and gender come only from users GA4 can identify (Google signals), so these figures cover part of your traffic and small groups may be withheld.";
const desc = (field: string) => ({ field, direction: "desc" as const });

/**
 * Curated reports for the GA4 Reports areas. Dimension and metric choices stay inside combinations GA4 accepts and every request is
 * still checked against the property's own metadata and compatibility, which has the last word.
 */
export const GA4_PRESET_DEFS: Record<Ga4Preset, PresetDef> = {
  // ---- Acquisition
  organic_landing_pages: {
    label: "Top organic landing pages by active users",
    dimensions: ["landingPage"],
    metrics: ["activeUsers", "sessions", "engagementRate", "keyEvents"],
    orderBy: desc("activeUsers"),
    dimensionFilters: [{ field: "sessionDefaultChannelGroup", matchType: "EXACT", value: "Organic Search" }],
  },
  sessions_by_channel: { label: "Sessions by channel", dimensions: ["sessionDefaultChannelGroup"], metrics: TRAFFIC_METRICS, orderBy: desc("sessions") },
  traffic_by_channel_medium: { label: "Traffic by channel and medium", dimensions: ["sessionDefaultChannelGroup", "sessionMedium"], metrics: TRAFFIC_METRICS, orderBy: desc("sessions") },
  traffic_by_source_medium: { label: "Traffic by source / medium", dimensions: ["sessionSourceMedium"], metrics: TRAFFIC_METRICS, orderBy: desc("sessions") },
  traffic_by_campaign: { label: "Traffic by campaign", dimensions: ["sessionCampaignName"], metrics: TRAFFIC_METRICS, orderBy: desc("sessions"), note: 'Sessions without a campaign appear as "(not set)" or "(direct)"; that is normal.' },
  user_acquisition_by_channel: { label: "New users by first-touch channel", dimensions: ["firstUserDefaultChannelGroup"], metrics: ["newUsers", "totalUsers", "keyEvents"], orderBy: desc("newUsers") },
  new_vs_returning: { label: "New vs returning users", dimensions: ["newVsReturning"], metrics: ["activeUsers", "sessions", "engagementRate", "keyEvents"], orderBy: desc("activeUsers") },
  traffic_trend: { label: "Traffic trend by day", dimensions: ["date"], metrics: ["sessions", "activeUsers", "keyEvents"], orderBy: { field: "date", direction: "asc" }, limit: 1000 },

  // ---- Engagement
  engagement_by_page: { label: "Engagement by page", dimensions: ["pagePath"], metrics: ["screenPageViews", "activeUsers", "userEngagementDuration", "eventCount", "keyEvents"], orderBy: desc("screenPageViews") },
  landing_pages: { label: "Landing pages (all channels)", dimensions: ["landingPage"], metrics: PAGE_METRICS, orderBy: desc("sessions") },
  key_events_by_page: {
    label: "Key events by page",
    dimensions: ["pagePath"],
    metrics: ["keyEvents", "screenPageViews", "activeUsers"],
    orderBy: desc("keyEvents"),
    metricFilters: [{ field: "keyEvents", operator: "GREATER_THAN", value: 0 }],
  },
  events_overview: { label: "Events", dimensions: ["eventName"], metrics: ["eventCount", "totalUsers", "eventCountPerUser"], orderBy: desc("eventCount") },

  // ---- Audience
  device_breakdown: { label: "Device breakdown", dimensions: ["deviceCategory"], metrics: PAGE_METRICS, orderBy: desc("sessions") },
  country_breakdown: { label: "Country breakdown", dimensions: ["country"], metrics: PAGE_METRICS, orderBy: desc("sessions") },
  city_breakdown: { label: "City breakdown", dimensions: ["city"], metrics: PAGE_METRICS, orderBy: desc("sessions") },
  age_breakdown: { label: "Age breakdown", dimensions: ["userAgeBracket"], metrics: ["activeUsers", "sessions", "keyEvents"], orderBy: desc("activeUsers"), note: DEMOGRAPHIC_NOTE },
  gender_breakdown: { label: "Gender breakdown", dimensions: ["userGender"], metrics: ["activeUsers", "sessions", "keyEvents"], orderBy: desc("activeUsers"), note: DEMOGRAPHIC_NOTE },

  // ---- Retention (cohort retention has its own tool: query_ga4_cohort)
  user_stickiness: {
    label: "User stickiness (daily, weekly and monthly active users)",
    dimensions: [],
    metrics: ["dauPerMau", "dauPerWau", "wauPerMau", "active1DayUsers", "active7DayUsers", "active28DayUsers"],
    orderBy: desc("dauPerMau"),
    note: "Stickiness is measured for the last day, week and month of the chosen range. DAU/MAU is the share of monthly users who visit on a given day.",
  },

  // ---- Monetization
  revenue_by_product: { label: "Revenue by product", dimensions: ["itemName"], metrics: ITEM_METRICS, orderBy: desc("itemRevenue") },
  revenue_by_category: { label: "Revenue by product category", dimensions: ["itemCategory"], metrics: ITEM_METRICS, orderBy: desc("itemRevenue") },
  revenue_by_channel: { label: "Revenue by channel", dimensions: ["sessionDefaultChannelGroup"], metrics: ["totalRevenue", "transactions", "averagePurchaseRevenue"], orderBy: desc("totalRevenue") },
  promotions_performance: { label: "Promotions", dimensions: ["itemPromotionName"], metrics: ["itemsViewedInPromotion", "itemsClickedInPromotion", "itemRevenue"], orderBy: desc("itemsViewedInPromotion") },
  ecommerce_funnel: {
    label: "Purchase journey",
    dimensions: [],
    metrics: ["sessions", "itemsViewed", "addToCarts", "checkouts", "ecommercePurchases"],
    orderBy: desc("sessions"),
    special: "funnel",
    note: "Each step counts events (not distinct people), so a person who adds to cart twice counts twice. Use it to spot where volume drops, not as an exact conversion rate.",
  },
  lifetime_value_by_channel: {
    label: "Revenue per user by first-touch channel",
    dimensions: ["firstUserDefaultChannelGroup"],
    metrics: ["totalUsers", "totalRevenue", "averageRevenuePerUser"],
    orderBy: desc("totalRevenue"),
    note: "This is revenue earned inside the chosen date range by users first acquired through each channel. GA4's multi-year lifetime-value exploration is not available through the Data API.",
  },
};

/** Replaces dimensions, metrics and sort with the preset's; filters the caller supplied are added to the preset's. */
export function applyGa4Preset<T extends Pick<QueryGa4Input, "dimensions" | "metrics" | "orderBy" | "dimensionFilters" | "metricFilters" | "limit">>(preset: Ga4Preset | undefined, input: T): T {
  if (!preset) return input;
  const def = GA4_PRESET_DEFS[preset];
  return {
    ...input,
    dimensions: def.dimensions,
    metrics: def.metrics,
    orderBy: def.orderBy,
    dimensionFilters: [...(def.dimensionFilters ?? []), ...input.dimensionFilters],
    metricFilters: [...(def.metricFilters ?? []), ...input.metricFilters],
    ...(def.limit !== undefined && { limit: Math.max(input.limit, def.limit) }),
  };
}
