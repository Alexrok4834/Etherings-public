import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApp } from './AdminApp';
import { ApiError, ProfileResponse, apiConfig, fetchProfile, loginWithAdminPassword, loginWithTelegram } from './api';
import { getTelegramInitData, hasTelegramWebApp, prepareTelegramWebApp } from './telegram';
import { RaffleScreen } from './RaffleScreen';
import { RewardsScreen } from './RewardsScreen';
import { WalkScreen } from './WalkScreen';

const tokenStorageKey = 'etherings_mvp_access_token';
const devTelegramInitData = import.meta.env?.VITE_DEV_TELEGRAM_INIT_DATA?.trim() ?? '';
const dailyStepLimitBase = 5000;

type SessionState =
  | { status: 'loading'; message: string }
  | { status: 'telegram-unavailable'; message: string }
  | { status: 'authenticated'; token: string; profile: ProfileResponse }
  | { status: 'error'; message: string; statusCode?: number };

type PlayerView = 'home' | 'walk' | 'raffle' | 'rewards';

export function App() {
  const isAdminRoute = window.location.pathname.startsWith('/admin');
  const [session, setSession] = useState<SessionState>({ status: 'loading', message: 'Preparing session' });

  const authenticate = useCallback(async (initDataOverride?: string) => {
    setSession({ status: 'loading', message: 'Connecting to Etherings' });
    prepareTelegramWebApp();

    try {
      const storedToken = sessionStorage.getItem(tokenStorageKey);

      if (storedToken) {
        const profile = await fetchProfile(storedToken);
        setSession({ status: 'authenticated', token: storedToken, profile });
        return;
      }

      const initData = initDataOverride ?? getTelegramInitData();

      if (!initData) {
        setSession({
          status: 'telegram-unavailable',
          message: hasTelegramWebApp()
            ? 'Telegram did not provide signed initData for this session.'
            : 'Open this app from Telegram Mini Apps to start a signed session.',
        });
        return;
      }

      const login = await loginWithTelegram(initData);
      sessionStorage.setItem(tokenStorageKey, login.accessToken);
      const profile = await fetchProfile(login.accessToken);
      setSession({ status: 'authenticated', token: login.accessToken, profile });
    } catch (error) {
      sessionStorage.removeItem(tokenStorageKey);
      setSession(toErrorState(error));
    }
  }, []);

  useEffect(() => {
    void authenticate();
  }, [authenticate]);

  const authenticateAdminPassword = useCallback(async (username: string, password: string) => {
    setSession({ status: 'loading', message: 'Checking admin credentials' });

    try {
      const login = await loginWithAdminPassword(username, password);
      sessionStorage.setItem(tokenStorageKey, login.accessToken);
      const profile = await fetchProfile(login.accessToken);
      setSession({ status: 'authenticated', token: login.accessToken, profile });
    } catch (error) {
      sessionStorage.removeItem(tokenStorageKey);
      setSession(toErrorState(error));
    }
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(tokenStorageKey);
    setSession({
      status: 'telegram-unavailable',
      message: isAdminRoute ? 'Admin session cleared. Sign in with admin credentials.' : 'Session cleared. Reopen the Mini App from Telegram to sign in again.',
    });
  }, [isAdminRoute]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Etherings MVP-v1</p>
          <h1>{isAdminRoute ? 'Admin App' : 'Player App'}</h1>
        </div>
        <span className="status-pill">{statusLabel(session.status)}</span>
      </header>

      {session.status === 'authenticated' ? (
        isAdminRoute ? (
          <AdminApp token={session.token} profile={session.profile} onRetry={() => authenticate()} onLogout={logout} />
        ) : (
          <AuthenticatedShell
            token={session.token}
            profile={session.profile}
            onProfileUpdate={(profile) => setSession({ status: 'authenticated', token: session.token, profile })}
            onRetry={authenticate}
            onLogout={logout}
          />
        )
      ) : isAdminRoute ? (
        <AdminPasswordPanel session={session} onSubmit={authenticateAdminPassword} />
      ) : (
        <SessionPanel session={session} onRetry={() => authenticate()} onDevLogin={devTelegramInitData ? () => authenticate(devTelegramInitData) : undefined} />
      )}
    </main>
  );
}
export function AuthenticatedShell({
  token,
  profile,
  onProfileUpdate,
  onRetry,
  onLogout,
  initialView = 'home',
}: {
  token: string;
  profile: ProfileResponse;
  onProfileUpdate: (profile: ProfileResponse) => void;
  onRetry: () => void;
  onLogout: () => void;
  initialView?: PlayerView;
}) {
  const [view, setView] = useState<PlayerView>(initialView);

  return (
    <>
      <nav className="view-tabs" aria-label="Player views">
        <button type="button" className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}>Home</button>
        <button type="button" className={view === 'walk' ? 'active' : ''} onClick={() => setView('walk')}>Walk</button>
        <button type="button" className={view === 'raffle' ? 'active' : ''} onClick={() => setView('raffle')}>Raffle</button>
        <button type="button" className={view === 'rewards' ? 'active' : ''} onClick={() => setView('rewards')}>Rewards</button>
      </nav>

      {view === 'home' ? (
        <HomeScreen
          profile={profile}
          onRetry={onRetry}
          onLogout={onLogout}
          onOpenWalk={() => setView('walk')}
          onOpenRaffle={() => setView('raffle')}
          onOpenRewards={() => setView('rewards')}
        />
      ) : view === 'walk' ? (
        <WalkScreen token={token} onProfileUpdate={onProfileUpdate} />
      ) : view === 'raffle' ? (
        <RaffleScreen token={token} onProfileUpdate={onProfileUpdate} />
      ) : (
        <RewardsScreen token={token} />
      )}
    </>
  );
}

function HomeScreen({
  profile,
  onRetry,
  onLogout,
  onOpenWalk,
  onOpenRaffle,
  onOpenRewards,
}: {
  profile: ProfileResponse;
  onRetry: () => void;
  onLogout: () => void;
  onOpenWalk: () => void;
  onOpenRaffle: () => void;
  onOpenRewards: () => void;
}) {
  const displayName = useMemo(() => formatUserName(profile.user), [profile.user]);
  const acceptedSteps = profile.todayStats.acceptedSteps;
  const remainingSteps = Math.max(0, dailyStepLimitBase - acceptedSteps);
  const progressPercent = Math.min(100, Math.round((acceptedSteps / dailyStepLimitBase) * 100));

  return (
    <>
      <section className="home-hero" aria-label="Player home">
        <div className="profile-strip profile-strip-plain" aria-label="Player profile">
          <div className="avatar" aria-hidden="true">
            {profile.user.photoUrl ? <img src={profile.user.photoUrl} alt="" /> : initialsFor(profile.user)}
          </div>
          <div className="profile-copy">
            <strong>{displayName}</strong>
            <span>{profile.user.username ? `@${profile.user.username}` : `Telegram ID ${profile.user.telegramId}`}</span>
          </div>
        </div>

        <div className="balance-block" aria-label="ERT balance">
          <span>ERT balance</span>
          <strong>{formatNumber(profile.balance.ertBalance)}</strong>
        </div>
      </section>
      <section className="progress-panel" aria-label="Daily step progress">
        <div className="progress-heading">
          <div>
            <span>Daily progress</span>
            <strong>{formatNumber(acceptedSteps)} / {formatNumber(dailyStepLimitBase)} steps</strong>
          </div>
          <b>{progressPercent}%</b>
        </div>
        <div className="progress-track" aria-hidden="true"><div style={{ width: `${progressPercent}%` }} /></div>
        <p>{remainingSteps > 0 ? `${formatNumber(remainingSteps)} steps left before today's base cap.` : 'Daily base cap reached.'}</p>
      </section>

      <section className="summary-grid" aria-label="Home stats">
        <article><span>Today earned</span><strong>{formatNumber(profile.todayStats.earnedErt)} ERT</strong></article>
        <article><span>Raffle attempts</span><strong>{formatNumber(profile.todayStats.raffleAttempts)}</strong></article>
        <article><span>Lifetime earned</span><strong>{formatNumber(profile.balance.lifetimeEarnedErt)} ERT</strong></article>
      </section>

      <nav className="home-actions" aria-label="Player sections">
        <button type="button" onClick={onOpenWalk}><span>Walk</span><small>Start session</small></button>
        <button type="button" onClick={onOpenRaffle}><span>Raffle</span><small>Spend ERT</small></button>
        <button type="button" onClick={onOpenRewards}><span>Rewards</span><small>Inventory</small></button>
      </nav>

      <section className="panel compact-panel">
        <div>
          <h2>Home</h2>
          <p>Authenticated against {apiConfig.baseUrl}. Use Walk, Raffle, and Rewards from the tabs above.</p>
        </div>
        <div className="panel-actions">
          <button type="button" className="secondary-button" onClick={onRetry}>Refresh</button>
          <button type="button" className="ghost-button" onClick={onLogout}>Logout</button>
        </div>
      </section>
    </>
  );
}

export function AdminPasswordPanel({
  session,
  onSubmit,
}: {
  session: Exclude<SessionState, { status: 'authenticated' }>;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const isLoading = session.status === 'loading';

  return (
    <section className="panel session-panel admin-login-panel">
      <div className={isLoading ? 'loader' : 'state-icon'} aria-hidden="true" />
      <h2>Admin login</h2>
      <p>{session.status === 'telegram-unavailable' ? 'Sign in with admin credentials to manage Raffle v2 versions, rewards, availability, and audit evidence.' : session.message}</p>
      {session.status === 'error' && session.statusCode ? <p className="error-code">HTTP {session.statusCode}</p> : null}
      <form
        className="admin-login-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(username, password);
        }}
      >
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" disabled={isLoading} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" disabled={isLoading} />
        </label>
        <button type="submit" disabled={isLoading || username.trim() === '' || password === ''}>{isLoading ? 'Signing in...' : 'Login'}</button>
      </form>
      <div className="connection-meta"><span>API</span><strong>{apiConfig.baseUrl}</strong></div>
    </section>
  );
}
function SessionPanel({
  session,
  onRetry,
  onDevLogin,
}: {
  session: Exclude<SessionState, { status: 'authenticated' }>;
  onRetry: () => void;
  onDevLogin?: () => void;
}) {
  const isLoading = session.status === 'loading';

  return (
    <section className="panel session-panel">
      <div className={isLoading ? 'loader' : 'state-icon'} aria-hidden="true" />
      <h2>{sessionTitle(session)}</h2>
      <p>{session.message}</p>
      {session.status === 'error' && session.statusCode ? <p className="error-code">HTTP {session.statusCode}</p> : null}
      <div className="connection-meta"><span>API</span><strong>{apiConfig.baseUrl}</strong></div>
      <button type="button" onClick={onRetry} disabled={isLoading}>{isLoading ? 'Connecting...' : 'Retry'}</button>
      {onDevLogin ? <button type="button" className="secondary-button dev-auth-button" onClick={onDevLogin} disabled={isLoading}>Dev login</button> : null}
    </section>
  );
}

function toErrorState(error: unknown): SessionState {
  if (error instanceof ApiError) return { status: 'error', message: error.message, statusCode: error.status };
  if (error instanceof Error) return { status: 'error', message: error.message };
  return { status: 'error', message: 'Unknown session error' };
}

function statusLabel(status: SessionState['status']) {
  if (status === 'authenticated') return 'Online';
  if (status === 'loading') return 'Loading';
  if (status === 'telegram-unavailable') return 'Telegram required';
  return 'Error';
}

function sessionTitle(session: Exclude<SessionState, { status: 'authenticated' }>) {
  if (session.status === 'loading') return 'Starting session';
  if (session.status === 'telegram-unavailable') return 'Telegram session required';
  return 'Could not sign in';
}

function formatUserName(user: ProfileResponse['user']) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || `Player ${user.telegramId}`;
}

function initialsFor(user: ProfileResponse['user']) {
  const name = formatUserName(user);
  return name.slice(0, 2).toUpperCase();
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}
