import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function createHost(url = '/test') {
  let statusCode = 0;
  let body: unknown;

  const response = {
    status: (nextStatusCode: number) => {
      statusCode = nextStatusCode;
      return {
        json: (nextBody: unknown) => {
          body = nextBody;
        },
      };
    },
  };

  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url }),
      }),
    },
    result: () => ({ statusCode, body }),
  };
}

describe('HttpExceptionFilter', () => {
  it('normalizes Nest HTTP exceptions into a stable JSON shape', () => {
    const { host, result } = createHost('/admin/rewards');
    const filter = new HttpExceptionFilter();

    filter.catch(new BadRequestException('code is required'), host as never);

    const response = result();
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, {
      statusCode: 400,
      message: 'code is required',
      error: 'Bad Request',
      path: '/admin/rewards',
      timestamp: (response.body as { timestamp: string }).timestamp,
    });
    assert.match((response.body as { timestamp: string }).timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('hides unexpected exception details behind a generic 500 response', () => {
    const { host, result } = createHost('/walk/sessions/start');
    const filter = new HttpExceptionFilter();

    filter.catch(new Error('database password leaked in message'), host as never);

    assert.equal(result().statusCode, 500);
    assert.equal((result().body as { message: string }).message, 'Internal server error');
    assert.equal((result().body as { error: string }).error, 'Internal Server Error');
  });

  it('preserves an explicit machine-readable conflict code', () => {
    const { host, result } = createHost('/step-sync/batches');
    const filter = new HttpExceptionFilter();

    filter.catch(new ConflictException({
      message: 'Batch identity already exists with a different payload',
      error: 'Conflict',
      code: 'IDEMPOTENCY_CONFLICT',
    }), host as never);

    assert.equal(result().statusCode, 409);
    assert.equal((result().body as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
  });
});
