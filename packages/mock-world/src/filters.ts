export type RelativeDate = "today" | "yesterday" | "last_week" | "last_month";

/** Convert rupee amount from tool args to paise stored in mock tables. */
export function amountToPaise(amount: number): number {
  return Math.round(amount * 100);
}

export function relativeDateRange(
  relativeDate: RelativeDate,
  now = new Date(),
): { from: Date; to: Date } {
  const to = new Date(now);
  const from = new Date(now);

  switch (relativeDate) {
    case "today": {
      from.setHours(0, 0, 0, 0);
      break;
    }
    case "yesterday": {
      from.setDate(from.getDate() - 1);
      from.setHours(0, 0, 0, 0);
      to.setHours(0, 0, 0, 0);
      break;
    }
    case "last_week": {
      from.setDate(from.getDate() - 7);
      break;
    }
    case "last_month": {
      from.setDate(from.getDate() - 30);
      break;
    }
  }

  return { from, to };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
}
