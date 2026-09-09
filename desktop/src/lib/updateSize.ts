export function updateDownloadSize(bytes: number | null | undefined, locale: string): { compact: string; exact: string } | null {
  if (!Number.isSafeInteger(bytes) || !bytes || bytes < 0) return null;
  return {
    compact: `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1048576)} MiB`,
    exact: `${new Intl.NumberFormat(locale).format(bytes)} B`,
  };
}
