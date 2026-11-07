/** Usage warehouse port (ADR-0002): pre-aggregated monthly figures, newest first. */
export interface UsageMonth {
  /** `YYYY-MM`. */
  month: string;
  protectedTb: number;
  apiCalls: number;
  activeUsers: number;
}

export interface UsageWarehouse {
  /** The latest `months` months for one account, newest first; empty when there is no data. */
  monthlyUsage(accountId: string, months: number): Promise<UsageMonth[]>;
}
