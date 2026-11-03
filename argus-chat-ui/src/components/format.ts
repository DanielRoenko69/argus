/** Format token count: ≥1000 → "1.5k" (one decimal, trailing-zero-trimmed), else integer. */
export function formatTok(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // one decimal, drop trailing zero
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1).replace(/\.?0+$/, '')}k`;
  }
  return String(Math.round(n));
}

/** Format cost as € with German decimal comma, up to 4 decimals.
 *  Returns empty string when cost === 0 (self-hosted / free models). */
export function formatEur(c: number): string {
  if (c === 0) return '';
  // toLocaleString with de-DE gives comma decimal separator
  return `€${c.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
