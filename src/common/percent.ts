export function isValidPercent(percent: number): boolean {
  return Number.isFinite(percent) && percent >= 0 && percent <= 100;
}

export const MAX_PERCENT = 100;
