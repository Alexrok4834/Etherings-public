import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RequestWithUser } from './jwt-auth.guard';
import { readMobileAuthAccounts } from './mobile-auth-config';
import { MobileSessionService } from './mobile-session.service';
import { MobileCredentialService } from './mobile-credential.service';
import { MobileRegistrationService } from './mobile-registration.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly mobileSessionService: MobileSessionService,
    private readonly mobileCredentialService: MobileCredentialService,
    private readonly mobileRegistrationService: MobileRegistrationService,
  ) {}

  @Post('auth/telegram')
  @HttpCode(HttpStatus.OK)
  async telegramLogin(@Body('initData') initData: string) {
    return this.authService.loginWithTelegram(
      initData,
      this.configService.get<string>('TELEGRAM_BOT_TOKEN') ?? '',
    );
  }

  @Post('auth/admin-password')
  @HttpCode(HttpStatus.OK)
  async adminPasswordLogin(@Body('username') username: unknown, @Body('password') password: unknown) {
    const expectedUsername = this.configService.get<string>('ADMIN_WEB_USERNAME') ?? '';
    const expectedPassword = this.configService.get<string>('ADMIN_WEB_PASSWORD') ?? '';
    const adminTelegramId = this.configService.get<string>('ADMIN_WEB_TELEGRAM_ID') ?? '';

    if (!expectedUsername || !expectedPassword || !adminTelegramId) {
      throw new ServiceUnavailableException('Admin password login is not configured');
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    return this.authService.loginWithAdminPassword({
      username,
      password,
      expectedUsername,
      expectedPassword,
      adminTelegramId,
    });
  }

  @Post('auth/mobile-password')
  @HttpCode(HttpStatus.OK)
  async mobilePasswordLogin(
    @Body('username') username: unknown,
    @Body('password') password: unknown,
    @Body('installationId') installationId: unknown,
  ) {
    const enabled = this.configService.get<string>('MOBILE_AUTH_ENABLED') === 'true';
    if (!enabled) {
      throw new ServiceUnavailableException('Mobile password login is not configured');
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new UnauthorizedException('Invalid mobile credentials');
    }

    const persistedUser = await this.mobileCredentialService.authenticate(username, password);
    let login;
    if (persistedUser) {
      login = { accessToken: await this.authService.signUserToken(persistedUser), user: persistedUser };
    } else {
      let accounts;
      try {
        accounts = readMobileAuthAccounts(this.configService);
      } catch {
        throw new ServiceUnavailableException('Mobile password login is not configured');
      }
      const account = accounts.find((candidate) => candidate.username === username);
      if (!account) throw new UnauthorizedException('Invalid mobile credentials');
      login = await this.authService.loginWithMobilePassword({
        username,
        password,
        expectedUsername: account.username,
        expectedPassword: account.password,
        mobileTelegramId: account.telegramId,
        displayName: account.displayName,
      });
      await this.mobileCredentialService.bootstrap(login.user, username, password);
    }

    // Transitional compatibility for installed pre-outbox APKs. New clients must
    // provide installationId and receive rotating refresh credentials.
    if (installationId === undefined) return login;
    this.assertInstallationId(installationId);

    return {
      ...login,
      ...(await this.mobileSessionService.issue(login.user, installationId)),
    };
  }

  @Post('auth/mobile-register')
  @HttpCode(HttpStatus.CREATED)
  async mobileRegister(
    @Body('username') username: unknown,
    @Body('password') password: unknown,
    @Body('displayName') displayName: unknown,
    @Body('installationId') installationId: unknown,
  ) {
    const authEnabled = this.configService.get<string>('MOBILE_AUTH_ENABLED') === 'true';
    const registrationEnabled = this.configService.get<string>('MOBILE_REGISTRATION_ENABLED') === 'true';
    if (!authEnabled || !registrationEnabled) {
      throw new ServiceUnavailableException('Mobile registration is not enabled');
    }
    this.assertInstallationId(installationId);
    const user = await this.mobileRegistrationService.register({ username, password, displayName });
    return {
      user,
      ...(await this.mobileSessionService.issue(user, installationId)),
    };
  }

  @Post('auth/mobile-refresh')
  @HttpCode(HttpStatus.OK)
  async mobileRefresh(
    @Body('refreshToken') refreshToken: unknown,
    @Body('installationId') installationId: unknown,
  ) {
    this.assertRefreshToken(refreshToken);
    this.assertInstallationId(installationId);
    return this.mobileSessionService.refresh(refreshToken, installationId);
  }

  @Post('auth/mobile-logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async mobileLogout(@Body('refreshToken') refreshToken: unknown) {
    this.assertRefreshToken(refreshToken);
    await this.mobileSessionService.logout(refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@Req() request: RequestWithUser) {
    if (!request.user) {
      throw new UnauthorizedException('User is missing from request');
    }

    return this.authService.getUserProfile(request.user);
  }

  @Get('me/activity')
  @UseGuards(JwtAuthGuard)
  getActivity(
    @Req() request: RequestWithUser,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ) {
    return this.authService.getActivityHistory(this.requireUser(request), from, to);
  }

  @Post('me/display-name')
  @UseGuards(JwtAuthGuard)
  async updateDisplayName(@Req() request: RequestWithUser, @Body('displayName') displayName: unknown) {
    const user = this.requireUser(request);
    const updatedUser = await this.mobileCredentialService.updateDisplayName(user, displayName);
    return this.authService.getUserProfile(updatedUser);
  }

  @Post('me/password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  changePassword(
    @Req() request: RequestWithUser,
    @Body('currentPassword') currentPassword: unknown,
    @Body('newPassword') newPassword: unknown,
  ) {
    return this.mobileCredentialService.changePassword(this.requireUser(request), currentPassword, newPassword);
  }

  private requireUser(request: RequestWithUser) {
    if (!request.user) throw new UnauthorizedException('User is missing from request');
    return request.user;
  }

  private assertInstallationId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException({ message: 'installationId must be a UUID', code: 'INVALID_INSTALLATION_ID' });
    }
  }

  private assertRefreshToken(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length < 40 || value.length > 256) {
      throw new UnauthorizedException({ message: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
    }
  }
}
