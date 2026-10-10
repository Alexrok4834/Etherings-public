import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWriteRateLimitMiddleware } from './write-rate-limit.middleware';

function createResponse() {
  let statusCode = 0;
  let body: unknown;
  const headers = new Map<string, string>();

  return {
    response: {
      setHeader: (name: string, value: string) => headers.set(name, value),
      status: (nextStatusCode: number) => {
        statusCode = nextStatusCode;
        return {
          json: (nextBody: unknown) => {
            body = nextBody;
          },
        };
      },
    },
    result: () => ({ statusCode, body, headers }),
  };
}

describe('createWriteRateLimitMiddleware', () => {
  it('allows reads and limits repeated write requests by client key', () => {
    let currentTime = 1_000;
    let nextCalls = 0;
    const middleware = createWriteRateLimitMiddleware({
      enabled: true,
      windowMs: 10_000,
      max: 2,
      now: () => currentTime,
    });

    middleware({ method: 'GET', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });
    middleware({ method: 'POST', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });
    middleware({ method: 'POST', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });
    const blocked = createResponse();
    middleware({ method: 'POST', ip: '127.0.0.1' }, blocked.response, () => { nextCalls += 1; });

    assert.equal(nextCalls, 3);
    assert.equal(blocked.result().statusCode, 429);
    assert.equal((blocked.result().body as { error: string }).error, 'Too Many Requests');
    assert.equal(blocked.result().headers.get('Retry-After'), '10');

    currentTime += 10_000;
    middleware({ method: 'POST', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });
    assert.equal(nextCalls, 4);
  });

  it('can be disabled for local tests or trusted environments', () => {
    let nextCalls = 0;
    const middleware = createWriteRateLimitMiddleware({ enabled: false, windowMs: 10_000, max: 1 });

    middleware({ method: 'POST', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });
    middleware({ method: 'POST', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });

    assert.equal(nextCalls, 2);
  });

  it('uses a stricter independent bucket for public mobile registration', () => {
    let nextCalls = 0;
    const middleware = createWriteRateLimitMiddleware({
      enabled: true,
      windowMs: 10_000,
      max: 10,
      registrationMax: 2,
    });

    middleware({ method: 'POST', originalUrl: '/auth/mobile-register', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });
    middleware({ method: 'POST', originalUrl: '/auth/mobile-register', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });
    const blocked = createResponse();
    middleware({ method: 'POST', originalUrl: '/auth/mobile-register', ip: '127.0.0.1' }, blocked.response, () => { nextCalls += 1; });
    middleware({ method: 'POST', originalUrl: '/me/display-name', ip: '127.0.0.1' }, createResponse().response, () => { nextCalls += 1; });

    assert.equal(blocked.result().statusCode, 429);
    assert.equal(nextCalls, 3);
  });
});
