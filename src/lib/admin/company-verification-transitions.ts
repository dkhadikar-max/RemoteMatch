export type VerificationAction = 'mark_under_review' | 'verify' | 'reject' | 'suspend' | 'reinstate';

export const TRANSITIONS: Record<VerificationAction, { from: string[]; to: string }> = {
  mark_under_review: { from: ['pending'], to: 'under_review' },
  verify: { from: ['pending', 'under_review'], to: 'verified' },
  reject: { from: ['pending', 'under_review'], to: 'rejected' },
  suspend: { from: ['verified'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'verified' },
};
