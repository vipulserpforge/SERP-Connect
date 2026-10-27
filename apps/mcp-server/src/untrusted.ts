/**
 * Tool results carry text that strangers can influence: search queries, page titles, URLs, referrers and event names
 * (anyone can plant text in a GA4 property with fake hits). It reaches the model, so it is returned as plain, bounded data:
 * invisible and control characters are removed and each text cell is capped. Structure, keys and numbers never change.
 */

/** C0/C1 controls (newlines included, so one cell cannot fake extra lines), bidi overrides, zero-width and tag characters. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿\u{e0000}-\u{e007f}]/gu;

export const MAX_CELL_CHARS = 500;

/** Keys whose contents are data taken from the user's sites and accounts; text under them is length-capped. */
const DATA_KEYS = new Set(["rows", "breakdowns", "snapshots", "properties", "property", "connections"]);

export function cleanText(value: string, maxChars?: number): string {
  const cleaned = value.replace(HIDDEN, " ");
  if (maxChars === undefined || cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…`;
}

function walk(value: unknown, inData: boolean, depth: number): unknown {
  if (typeof value === "string") return cleanText(value, inData ? MAX_CELL_CHARS : undefined);
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, inData, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, inData || DATA_KEYS.has(k), depth + 1)]));
}

export const sanitizeToolOutput = (data: Record<string, unknown>): Record<string, unknown> => walk(data, false, 0) as Record<string, unknown>;
