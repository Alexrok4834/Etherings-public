import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MobileSessionService } from './mobile-session.service';
import { MobileCredentialService } from './mobile-credential.service';
import { User } from './user.entity';
import { MobileRegistrationService } from './mobile-registration.service';

const installationId = 'f7d59d61-8d12-4d6f-a779-339298a37df2';

class FakeAuthService {
  activityCalls: Array<{ user: unknown; from: unknown; to: unknown }> = [];
  async loginWithMobilePassword() {
    return { accessToken: 'legacy-access', user: { id: 'user-id' } };
  }

  async signUserToken() {
    return 'persisted-access';
  }

  async getUserProfile(user: unknown) {
    return { user };
  }

  async getActivityHistory(user: unknown, from: unknown, to: unknown) {
    this.activityCalls.push({ user, from, to });
    return { from, to, days: [] };
  }
}

class FakeMobileSessionService {
  issued: string[] = [];
  refreshed: Array<{ refreshToken: string; installationId: string }> = [];
  loggedOut: string[] = [];

  async issue(_user: unknown, requestedInstallationId: string) {
    this.issued.push(requestedInstallationId);
    return { accessToken: 'renewable-access', refreshToken: 'r'.repeat(43), refreshTokenExpiresAt: new Date().toISOString() };
  }

  async refresh(refreshToken: string, requestedInstallationId: string) {
    this.refreshed.push({ refreshToken, installationId: requestedInstallationId });
    return { accessToken: 'next-access', refreshToken: 'n'.repeat(43), refreshTokenExpiresAt: new Date().toISOString() };
  }

  async logout(refreshToken: string) {
    this.loggedOut.push(refreshToken);
  }
}

class FakeMobileCredentialService {
  bootstrapped: string[] = [];
  persistedUser: User | null = null;
  displayNames: unknown[] = [];
  passwordChanges: Array<{ currentPassword: unknown; newPassword: unknown }> = [];

  async authenticate() {
    return this.persistedUser;
  }

  async bootstrap(_user: unknown, username: string) {
    this.bootstrapped.push(username);
  }

  async updateDisplayName(user: User, displayName: unknown) {
    this.displayNames.push(displayName);
    return { ...user, firstName: displayName } as User;
  }

  async changePassword(_user: User, currentPassword: unknown, newPassword: unknown) {
    this.passwordChanges.push({ currentPassword, newPassword });
    return { reauthenticationRequired: true };
  }
}

class FakeMobileRegistrationService {
  registrations: Array<{ username: unknown; password: unknown; displayName: unknown }> = [];

  async register(input: { username: unknown; password: unknown; displayName: unknown }) {
    this.registrations.push(input);
    return { id: 'registered-user', username: input.username } as User;
  }
}

function fixture() {
  const auth = new FakeAuthService();
  const sessions = new FakeMobileSessionService();
  const credentials = new FakeMobileCredentialService();
  const registration = new FakeMobileRegistrationService();
  const values: Record<string, string> = {
    MOBILE_AUTH_ENABLED: 'true',
    MOBILE_REGISTRATION_ENABLED: 'true',
    MOBILE_AUTH_USERNAME: 'test',
    MOBILE_AUTH_PASSWORD: 'test',
    MOBILE_AUTH_TELEGRAM_ID: 'android-test',
    MOBILE_AUTH_DISPLAY_NAME: 'Test',
  };
  const controller = new AuthController(
    auth as unknown as AuthService,
    { get: (key: string) => values[key] } as ConfigService,
    sessions as unknown as MobileSessionService,
    credentials as unknown as MobileCredentialService,
    registration as unknown as MobileRegistrationService,
  );
  return { controller, auth, sessions, credentials, registration, values };
}

describe('AuthController mobile session contract', () => {
  it('preserves access-only login for an installed legacy client', async () => {
    const { controller, sessions, credentials } = fixture();
    const result = await controller.mobilePasswordLogin('test', 'test', undefined);
    assert.equal(result.accessToken, 'legacy-access');
    assert.equal('refreshToken' in result, false);
    assert.deepEqual(sessions.issued, []);
    assert.deepEqual(credentials.bootstrapped, ['test']);
  });

  it('issues renewable credentials only for a valid installation UUID', async () => {
    const { controller, sessions } = fixture();
    const result = await controller.mobilePasswordLogin('test', 'test', installationId);
    assert.equal(result.accessToken, 'renewable-access');
    assert.equal((result as typeof result & { refreshToken: string }).refreshToken.length, 43);
    assert.deepEqual(sessions.issued, [installationId]);
    await assert.rejects(() => controller.mobilePasswordLogin('test', 'test', 'bad-id'), /installationId/);
  });

  it('uses a persisted credential without falling back to the environment account', async () => {
    const { controller, credentials } = fixture();
    credentials.persistedUser = { id: 'persisted-user' } as User;

    const result = await controller.mobilePasswordLogin('test', 'changed-password', undefined);

    assert.equal(result.accessToken, 'persisted-access');
    assert.deepEqual(credentials.bootstrapped, []);
  });

  it('registers a player only when enabled and issues an installation-bound session', async () => {
    const { controller, registration, sessions, values } = fixture();
    const result = await controller.mobileRegister('New_Player', 'secure-password', 'New Player', installationId);

    assert.equal(result.user.id, 'registered-user');
    assert.equal(result.accessToken, 'renewable-access');
    assert.deepEqual(registration.registrations, [{
      username: 'New_Player', password: 'secure-password', displayName: 'New Player',
    }]);
    assert.deepEqual(sessions.issued, [installationId]);

    values.MOBILE_REGISTRATION_ENABLED = 'false';
    await assert.rejects(
      () => controller.mobileRegister('other', 'secure-password', 'Other', installationId),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 503,
    );
    values.MOBILE_REGISTRATION_ENABLED = 'true';
    await assert.rejects(() => controller.mobileRegister('other', 'secure-password', 'Other', 'bad-id'), /installationId/);
  });

  it('validates and forwards refresh and logout requests', async () => {
    const { controller, sessions } = fixture();
    const token = 'x'.repeat(43);
    await controller.mobileRefresh(token, installationId);
    await controller.mobileLogout(token);
    assert.deepEqual(sessions.refreshed, [{ refreshToken: token, installationId }]);
    assert.deepEqual(sessions.loggedOut, [token]);
    await assert.rejects(() => controller.mobileRefresh('short', installationId), /Invalid refresh token/);
  });

  it('forwards authenticated profile mutations and requires a request user', async () => {
    const { controller, credentials } = fixture();
    const user = { id: 'user-id', firstName: 'Old' } as User;
    const request = { headers: {}, user };

    const profile = await controller.updateDisplayName(request, 'New Name');
    const changed = await controller.changePassword(request, 'old-password', 'new-password');

    assert.equal(profile.user.firstName, 'New Name');
    assert.deepEqual(credentials.displayNames, ['New Name']);
    assert.deepEqual(credentials.passwordChanges, [{ currentPassword: 'old-password', newPassword: 'new-password' }]);
    assert.deepEqual(changed, { reauthenticationRequired: true });
    await assert.rejects(() => controller.updateDisplayName({ headers: {} }, 'No User'), /User is missing/);
  });

  it('forwards an owner-bound activity date range', async () => {
    const { controller, auth } = fixture();
    const user = { id: 'user-id' } as User;

    const result = await controller.getActivity({ headers: {}, user }, '2026-08-01', '2026-08-14');

    assert.deepEqual(result, { from: '2026-08-01', to: '2026-08-14', days: [] });
    assert.deepEqual(auth.activityCalls, [{ user, from: '2026-08-01', to: '2026-08-14' }]);
    assert.throws(() => controller.getActivity({ headers: {} }, '2026-08-01', '2026-08-14'), /User is missing/);
  });
});
