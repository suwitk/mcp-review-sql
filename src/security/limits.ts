/**
 * Row-limit and text-truncation helpers shared by all tools (spec §15).
 */
import type { AppConfig } from "../config/index.js";
import { McpToolError } from "../types/index.js";

/** Clamp a caller-requested row limit to the configured global maximum. */
export function clampMaxRows(requested: number | undefined, config: AppConfig): number {
  const def = config.limits.defaultRows;
  const cap = config.limits.maxRows;
  if (requested === undefined) return Math.min(def, cap);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new McpToolError("INVALID_INPUT", "maxRows must be a positive number.");
  }
  return Math.min(Math.floor(requested), cap);
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + `\n... [truncated, ${text.length - maxChars} more chars]`, truncated: true };
}

export function noteRowLimitExceeded(returned: number, cap: number): string | undefined {
  if (returned >= cap) {
    return `Result truncated at the configured maximum of ${cap} rows. Refine your filter to see more.`;
  }
  return undefined;
}
