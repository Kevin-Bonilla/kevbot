export type UserRecord = {
  username: string;
  id: string;
};

export type KickOutcome = {
  id: string;
  username: string;
  status: 'kicked' | 'failed';
  error?: string;
  at: string;
};

export type PurgeResult = {
  timestamp: string;
  totalTargets: number;
  kicked: KickOutcome[];
  failed: KickOutcome[];
  whitelistedSkipped: string[];
};