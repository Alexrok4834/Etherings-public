type RateLimitRequest = {
  method?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  originalUrl?: string;
  url?: string;
};

type RateLimitResponse = {
  setHeader?: (name: string, value: string) => void;
  status: (statusCode: number) => { json: (body: unknown) => void };
};

type RateLimitNext = () => void;

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type WriteRateLimitOptions = {
  enabled: boolean;
  windowMs: number;
  max: number;
  registrationMax?: number;
  now?: () => number;
};

const writeMethods = new Set(['POST', 'PATCH', 'DELETE']);

export function createWriteRateLimitMiddleware(options: WriteRateLimitOptions) {
  const buckets = new Map<string, RateLimitBucket>();
  const now = options.now ?? Date.now;

  return (request: RateLimitRequest, response: RateLimitResponse, next: RateLimitNext) => {
    if (!options.enabled || options.windowMs <= 0 || options.max <= 0 || !writeMethods.has((request.method ?? '').toUpperCase())) {
      next();
      return;
    }

    const currentTime = now();
    const registrationRequest = requestPath(request) === '/auth/mobile-register';
    const limit = registrationRequest ? (options.registrationMax ?? options.max) : options.max;
    const key = `${registrationRequest ? 'registration' : 'write'}:${clientKey(request)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= currentTime) {
      buckets.set(key, { count: 1, resetAt: currentTime + options.windowMs });
      next();
      return;
    }

    if (bucket.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
      response.setHeader?.('Retry-After', String(retryAfterSeconds));
      response.status(429).json({
        statusCode: 429,
        message: 'Too many write requests. Try again later.',
        error: 'Too Many Requests',
        retryAfterSeconds,
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}

function requestPath(request: RateLimitRequest) {
  return (request.originalUrl ?? request.url ?? '').split('?')[0];
}

function clientKey(request: RateLimitRequest) {
  const forwardedFor = request.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwardedIp = forwardedValue?.split(',')[0]?.trim();

  return forwardedIp || request.ip || request.socket?.remoteAddress || 'unknown';
}
