const API_URL = import.meta.env?.VITE_API_URL ?? 'http://localhost:4000';

export type User = {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  isAdmin: boolean;
};

export type AuthResponse = {
  accessToken: string;
  user: User;
};

export type ProfileResponse = {
  user: User;
  balance: {
    ertBalance: number;
    lifetimeEarnedErt: number;
    lifetimeSpentErt: number;
    eruBalance: number | null;
    eruBalanceExact: string;
    lifetimeEarnedEru: number | null;
    lifetimeEarnedEruExact: string;
    lifetimeSpentEru: number | null;
    lifetimeSpentEruExact: string;
    updatedAt: string;
  };
  todayStats: {
    acceptedSteps: number;
    earnedErt: number;
    raffleAttempts: number;
  };
};

export type AdminEruBalance = {
  userId: string;
  eruBalance: number | null;
  eruBalanceExact: string;
  lifetimeEarnedEru: number | null;
  lifetimeEarnedEruExact: string;
  lifetimeSpentEru: number | null;
  lifetimeSpentEruExact: string;
  updatedAt: string;
};

export type WalkSession = {
  id: string;
  userId: string;
  status: 'STARTED' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';
  startedAt: string;
  endedAt: string | null;
  clientStepCount: number | null;
  acceptedStepCount: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  avgSpeedMps: number | null;
  source: string;
  rejectionReason: string | null;
  rawSummary: Record<string, unknown> | null;
  earnedErt: number;
  createdAt: string;
};

export type FinishWalkSessionInput = {
  clientStepCount: number;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distanceMeters?: number | null;
  samplesCount: number;
  algorithmVersion: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const apiConfig = {
  baseUrl: API_URL,
};

export async function loginWithTelegram(initData: string) {
  return request<AuthResponse>('/auth/telegram', {
    method: 'POST',
    body: JSON.stringify({ initData }),
  });
}

export async function loginWithAdminPassword(username: string, password: string) {
  return request<AuthResponse>('/auth/admin-password', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function fetchProfile(accessToken: string) {
  return request<ProfileResponse>('/me', {
    headers: authHeaders(accessToken),
  });
}

export async function fetchAdminEruBalance(accessToken: string, userId: string) {
  return request<AdminEruBalance>(`/admin/balances/${encodeURIComponent(userId)}/eru`, {
    headers: authHeaders(accessToken),
  });
}

export async function startWalkSession(accessToken: string) {
  return request<WalkSession>('/walk/sessions/start', {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
}

export async function finishWalkSession(accessToken: string, sessionId: string, input: FinishWalkSessionInput) {
  return request<WalkSession>(`/walk/sessions/${sessionId}/finish`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(input),
  });
}

export async function listWalkSessions(accessToken: string) {
  return request<WalkSession[]>('/walk/sessions', {
    headers: authHeaders(accessToken),
  });
}

function authHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new ApiError(await responseMessage(response), response.status);
  }

  return response.json() as Promise<T>;
}

async function responseMessage(response: Response) {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
  } catch {
    // Ignore malformed error bodies and fall back to a stable message.
  }

  return `Request failed with status ${response.status}`;
}
export type RaffleReward = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  type: 'ERT' | 'ERU' | 'BADGE' | 'ITEM' | 'NFT_PLACEHOLDER';
  amount: number | null;
  amountExact: string | null;
  amountDisplay: string | null;
  metadata: Record<string, unknown> | null;
  imageUrl: string | null;
  stockRemaining: number | null;
  weight: number;
  probability: number;
};

export type RafflePool = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  costErt: number;
  dailyUserAttemptLimit: number | null;
  rewards: RaffleReward[];
};

export type UserReward = {
  id: string;
  userId: string;
  rewardId: string;
  raffleDrawId: string;
  title: string;
  type: RaffleReward['type'];
  amount: number | null;
  amountExact: string | null;
  amountDisplay: string | null;
  eruBalanceAfterExact: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type RaffleDraw = {
  id: string;
  userId: string;
  poolId: string;
  rewardId: string;
  costErt: number;
  randomRoll: number;
  weightsSnapshot: Record<string, unknown>;
  rewardSnapshot: Record<string, unknown>;
  createdAt: string;
};

export type RaffleDrawResult = {
  draw: RaffleDraw;
  userReward: UserReward;
};

export type RaffleHistoryItem = {
  draw: RaffleDraw;
  userReward: UserReward | null;
};

export async function listRafflePools() {
  return request<RafflePool[]>('/raffle/pools');
}

export async function drawRafflePool(accessToken: string, poolId: string) {
  return request<RaffleDrawResult>(`/raffle/pools/${poolId}/draw`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
}

export async function listRaffleHistory(accessToken: string) {
  return request<RaffleHistoryItem[]>('/raffle/history', {
    headers: authHeaders(accessToken),
  });
}
export type AdminReward = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  type: RaffleReward['type'];
  amount: number | null;
  amountExact: string | null;
  amountDisplay: string | null;
  metadata: Record<string, unknown> | null;
  imageUrl: string | null;
  isActive: boolean;
  stockTotal: number | null;
  stockRemaining: number | null;
  perUserLimit: number | null;
  dailyGlobalLimit: number | null;
  createdAt: string;
  updatedAt: string;
};

export async function listAdminRewards(accessToken: string) {
  return request<AdminReward[]>('/admin/rewards', {
    headers: authHeaders(accessToken),
  });
}

export type AdminRafflePool = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  costErt: number;
  costErtExact: string;
  costErtDisplay: string;
  isActive: boolean;
  dailyUserAttemptLimit: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminRaffleDraw = {
  id: string;
  userId: string;
  poolId: string;
  rewardId: string;
  costErt: number;
  costErtExact: string;
  costErtDisplay: string;
  randomRoll: number;
  weightsSnapshot: Record<string, unknown>;
  rewardSnapshot: Record<string, unknown>;
  createdAt: string;
  user?: User;
  pool?: AdminRafflePool;
  reward?: AdminReward;
};

export async function listAdminRaffleDraws(accessToken: string) {
  return request<AdminRaffleDraw[]>('/admin/raffle-draws', {
    headers: authHeaders(accessToken),
  });
}

export type RaffleV2RewardType = 'ERT' | 'ERU' | 'COPPER_RING';

export type AdminRaffleV2Outcome = {
  rewardId: string;
  segmentIndex: number;
  weight: string;
  probability: { numerator: string; denominator: string };
  snapshot: Record<string, unknown>;
  live: {
    code: string;
    title: string;
    type: RaffleV2RewardType;
    active: boolean;
    stockTotal: number | null;
    stockRemaining: number | null;
    perUserLimit: number | null;
    dailyGlobalLimit: number | null;
  };
};

export type AdminRaffleV2Configuration = {
  id: string;
  contractVersion: 'raffle-v2';
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED';
  title: string;
  description: string | null;
  cost: { currency: 'ERT'; amountExact: string; amountDisplay: string };
  dailyUserAttemptLimit: number;
  createdByUserId: string | null;
  createdAt: string;
  activatedAt: string | null;
  disabledAt: string | null;
  totalWeight: string;
  rewards: AdminRaffleV2Outcome[];
};

export type AdminRaffleV2Overview = {
  machine: {
    id: string;
    code: string;
    available: boolean;
    pausedAt: string | null;
    createdAt: string;
  } | null;
  configurations: AdminRaffleV2Configuration[];
};

export type AdminRaffleV2Preview = {
  configurationId: string;
  status: 'DRAFT';
  valid: boolean;
  totalWeight: string;
  issues: Array<{ severity: 'ERROR' | 'WARNING'; code: string; message: string }>;
  outcomes: Array<Record<string, unknown>>;
  economy: Record<string, unknown>;
};

export type AdminRaffleV2DrawPage = {
  limit: number;
  offset: number;
  items: Array<Record<string, unknown> & { id: string; operationKey: string; createdAt: string }>;
};

export async function getAdminRaffleV2(accessToken: string) {
  return request<AdminRaffleV2Overview>('/admin/raffle-v2', { headers: authHeaders(accessToken) });
}

export async function listAdminRaffleV2Draws(accessToken: string, limit = 50, offset = 0) {
  return request<AdminRaffleV2DrawPage>(`/admin/raffle-v2/draws?limit=${limit}&offset=${offset}`, {
    headers: authHeaders(accessToken),
  });
}

export async function createAdminRaffleV2Reward(accessToken: string, input: Record<string, unknown>) {
  return request<Record<string, unknown>>('/admin/raffle-v2/rewards', {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(input),
  });
}

export async function createAdminRaffleV2Draft(accessToken: string, input: Record<string, unknown>) {
  return request<Record<string, unknown>>('/admin/raffle-v2/configurations', {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(input),
  });
}

export async function updateAdminRaffleV2Draft(accessToken: string, id: string, input: Record<string, unknown>) {
  return request<Record<string, unknown>>(`/admin/raffle-v2/configurations/${id}`, {
    method: 'PATCH', headers: authHeaders(accessToken), body: JSON.stringify(input),
  });
}

export async function replaceAdminRaffleV2Outcomes(accessToken: string, id: string, rewards: Array<{ rewardId: string; weight: number }>) {
  return request<Record<string, unknown>>(`/admin/raffle-v2/configurations/${id}/rewards`, {
    method: 'PUT', headers: authHeaders(accessToken), body: JSON.stringify({ rewards }),
  });
}

export async function previewAdminRaffleV2Draft(accessToken: string, id: string) {
  return request<AdminRaffleV2Preview>(`/admin/raffle-v2/configurations/${id}/preview`, {
    headers: authHeaders(accessToken),
  });
}

export async function activateAdminRaffleV2Draft(accessToken: string, id: string, input: Record<string, unknown>) {
  return request<Record<string, unknown>>(`/admin/raffle-v2/configurations/${id}/activate`, {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(input),
  });
}

export async function setAdminRaffleV2Availability(accessToken: string, action: 'pause' | 'resume', input: Record<string, unknown>) {
  return request<Record<string, unknown>>(`/admin/raffle-v2/${action}`, {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(input),
  });
}
