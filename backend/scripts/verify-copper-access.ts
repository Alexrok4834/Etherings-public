import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!new URL(databaseUrl).pathname.slice(1).toLowerCase().includes('qa')) {
  throw new Error('Refusing to use a database whose name does not contain qa');
}
if (process.env.COPPER_ACCESS_QA_CONFIRM !== 'disposable') {
  throw new Error('COPPER_ACCESS_QA_CONFIRM=disposable is required');
}

process.env.NODE_ENV = 'development';
process.env.TYPEORM_SYNCHRONIZE = 'true';
process.env.JWT_SECRET = 'copper-access-qa-secret-not-production';
process.env.MOBILE_AUTH_ENABLED = 'true';
process.env.MOBILE_REGISTRATION_ENABLED = 'true';
process.env.RATE_LIMIT_ENABLED = 'false';
delete process.env.PUBLIC_API_URL;

type Session = {
  accessToken: string;
  user: { id: string };
};

type RingView = {
  id: string;
  equipped: boolean;
  [key: string]: unknown;
};

type ApiResponse<T> = {
  status: number;
  body: T;
};

let app: INestApplication | undefined;
let dataSource: DataSource | undefined;

async function main() {
  try {
    const [appModule, authService, userEntity, filter, equipmentEntity, ringEntity, eventEntity] = await Promise.all([
      import('../dist/app.module.js'),
      import('../dist/auth/auth.service.js'),
      import('../dist/auth/user.entity.js'),
      import('../dist/common/http-exception.filter.js'),
      import('../dist/ring/equipped-ring.entity.js'),
      import('../dist/ring/game-ring.entity.js'),
      import('../dist/ring/ring-event.entity.js'),
    ]);
    const { AppModule } = appModule;
    const { AuthService } = authService;
    const { User } = userEntity;
    const { HttpExceptionFilter } = filter;
    const { EquippedRing } = equipmentEntity;
    const { GameRing } = ringEntity;
    const { RingEvent } = eventEntity;

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    dataSource = app.get(DataSource);

    const address = app.getHttpServer().address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const ownerA = await register(baseUrl, 'owner_a');
    const ownerB = await register(baseUrl, 'owner_b');

    const unauthenticatedPlayer = await api(baseUrl, '/me/rings');
    assert.equal(unauthenticatedPlayer.status, 401);
    const ownerAList = await api<{ rings: RingView[] }>(baseUrl, '/me/rings', token(ownerA));
    const ownerBList = await api<{ rings: RingView[] }>(baseUrl, '/me/rings', token(ownerB));
    assert.equal(ownerAList.status, 200);
    assert.equal(ownerBList.status, 200);
    assert.equal(ownerAList.body.rings.length, 1);
    assert.equal(ownerBList.body.rings.length, 1);
    assert.notEqual(ownerAList.body.rings[0].id, ownerBList.body.rings[0].id);
    assert.equal('ownerUserId' in ownerAList.body.rings[0], false);

    const ownDetail = await api<RingView>(baseUrl, `/me/rings/${ownerAList.body.rings[0].id}`, token(ownerA));
    const equipped = await api<{ ring: RingView }>(baseUrl, '/me/rings/equipped', token(ownerA));
    assert.equal(ownDetail.status, 200);
    assert.equal(equipped.status, 200);
    assert.equal(equipped.body.ring.id, ownerAList.body.rings[0].id);
    assert.equal(equipped.body.ring.equipped, true);

    const foreign = await api<{ code: string }>(
      baseUrl,
      `/me/rings/${ownerBList.body.rings[0].id}`,
      token(ownerA),
    );
    assert.deepEqual({ status: foreign.status, code: foreign.body.code }, {
      status: 404,
      code: 'RING_NOT_FOUND',
    });

    const equipCommand = await api(baseUrl, `/me/rings/${ownerBList.body.rings[0].id}/equip`, {
      ...token(ownerA),
      method: 'POST',
    });
    assert.equal(equipCommand.status, 404);

    const unauthenticatedAdmin = await api(baseUrl, '/admin/rings');
    const playerAdmin = await api(baseUrl, '/admin/rings', token(ownerA));
    assert.equal(unauthenticatedAdmin.status, 401);
    assert.equal(playerAdmin.status, 403);

    const adminSession = await register(baseUrl, 'ring_admin');
    await dataSource.getRepository(User).update({ id: adminSession.user.id }, { isAdmin: true });
    const adminUser = await dataSource.getRepository(User).findOneByOrFail({ id: adminSession.user.id });
    const adminToken = await app.get(AuthService).signUserToken(adminUser);
    const eventsBeforeAdminReads = await dataSource.getRepository(RingEvent).count();
    const adminList = await api<{ items: Array<{ id: string }>; total: number }>(
      baseUrl,
      '/admin/rings?q=owner_a&limit=10&offset=0',
      bearer(adminToken),
    );
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.total, 1);
    const adminAudit = await api<{ items: Array<{ ringId: string }>; total: number }>(
      baseUrl,
      `/admin/rings/${ownerAList.body.rings[0].id}/events`,
      bearer(adminToken),
    );
    assert.equal(adminAudit.status, 200);
    assert.equal(adminAudit.body.total, 1);
    assert.equal(adminAudit.body.items[0].ringId, ownerAList.body.rings[0].id);
    assert.equal(await dataSource.getRepository(RingEvent).count(), eventsBeforeAdminReads);

    const legacyUser = await dataSource.getRepository(User).save(dataSource.getRepository(User).create({
      telegramId: `copper-access-qa:${randomUUID()}`,
      username: 'legacy_concurrent',
      firstName: 'Legacy Concurrent',
      lastName: null,
      photoUrl: null,
      isAdmin: false,
      lastLoginAt: new Date(),
    }));
    const legacyToken = await app.get(AuthService).signUserToken(legacyUser);
    const concurrentReads = await Promise.all(Array.from({ length: 12 }, () =>
      api<{ rings: RingView[] }>(baseUrl, '/me/rings', bearer(legacyToken))));
    assert.equal(concurrentReads.every((response) => response.status === 200), true);
    const concurrentRingIds = concurrentReads.map((response) => response.body.rings[0]?.id);
    assert.equal(new Set(concurrentRingIds).size, 1);
    assert.equal(concurrentReads.every((response) => response.body.rings.length === 1), true);
    assert.equal(concurrentReads.every((response) => response.body.rings[0].equipped), true);

    const [ringCount, equipmentCount, eventCount] = await Promise.all([
      dataSource.getRepository(GameRing).countBy({ ownerUserId: legacyUser.id }),
      dataSource.getRepository(EquippedRing).countBy({ userId: legacyUser.id }),
      dataSource.getRepository(RingEvent).countBy({ ownerUserId: legacyUser.id }),
    ]);
    assert.deepEqual({ ringCount, equipmentCount, eventCount }, {
      ringCount: 1,
      equipmentCount: 1,
      eventCount: 1,
    });

    const retryReads = await Promise.all(Array.from({ length: 5 }, () =>
      api<{ rings: RingView[] }>(baseUrl, '/me/rings', bearer(legacyToken))));
    assert.equal(new Set(retryReads.map((response) => response.body.rings[0].id)).size, 1);
    assert.equal(await dataSource.getRepository(RingEvent).countBy({ ownerUserId: legacyUser.id }), 1);

    console.log(JSON.stringify({
      unauthenticatedPlayerRejected: true,
      unauthenticatedAdminRejected: true,
      nonAdminRejectedFromAdmin: true,
      ownerReadsIsolated: true,
      foreignRingMasked: true,
      playerRingDtoHidesOwner: true,
      noPlayerEquipCommand: true,
      adminAuditReadAuthorized: true,
      adminReadsCreateNoAuditEvents: true,
      concurrentLazyEnsureSingleRing: true,
      concurrentLazyEnsureSingleEquipment: true,
      concurrentLazyEnsureSingleEvent: true,
      retryReadsStableWithoutDuplicateEvents: true,
    }, null, 2));
  } finally {
    if (dataSource?.isInitialized) await dataSource.dropDatabase();
    if (app) await app.close();
  }
}

async function register(baseUrl: string, username: string) {
  const response = await api<Session>(baseUrl, '/auth/mobile-register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: `Qa-${randomUUID()}`,
      displayName: username,
      installationId: randomUUID(),
    }),
  });
  assert.equal(response.status, 201);
  assert.ok(response.body.accessToken);
  return response.body;
}

function token(session: Session) {
  return bearer(session.accessToken);
}

function bearer(accessToken: string) {
  return { headers: { authorization: `Bearer ${accessToken}` } };
}

async function api<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  return { status: response.status, body };
}

void main();
