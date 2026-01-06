export function defaultBrainReply(args: { transcript: string; tenantId?: string }): string {
  void args.tenantId;
  const text = args.transcript.trim().toLowerCase();

  if (text.includes('open')) {
    return 'We open at 9:00 AM.';
  }

  if (text.includes('close') || text.includes('closing')) {
    return 'We close at 6:00 PM.';
  }

  if (text.includes('hours')) {
    return 'Our hours are 9:00 AM to 6:00 PM, Monday through Saturday.';
  }

  if (text.includes('appointment') || text.includes('book')) {
    return 'Sure - would you like to book for today or another day?';
  }

  return 'Got it - do you want hours, services, or to book an appointment?';
}