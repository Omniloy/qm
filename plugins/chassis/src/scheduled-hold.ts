interface ApprovalShape {
  request?: { surface?: unknown } | null;
  securityHold?: { scheduledTask?: unknown } | null;
}

export function isScheduledHoldRecord(record: ApprovalShape | null | undefined): boolean {
  return (
    record?.request?.surface === "cron" &&
    typeof record.securityHold?.scheduledTask === "object" &&
    record.securityHold.scheduledTask !== null
  );
}
