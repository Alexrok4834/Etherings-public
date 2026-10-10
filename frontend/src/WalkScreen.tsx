import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  FinishWalkSessionInput,
  ProfileResponse,
  WalkSession,
  fetchProfile,
  finishWalkSession,
  listWalkSessions,
  startWalkSession,
} from './api';

const algorithmVersion = 'client-peak-v2';
const stepsPerDetectedPeak = 2;

type MotionState = 'checking' | 'available' | 'permission-required' | 'unavailable';

type WalkRun = {
  session: WalkSession;
  startedAt: string;
  steps: number;
  samplesCount: number;
  lastMagnitude: number;
  lastPeakAt: number;
};

export function WalkScreen({ token, onProfileUpdate }: { token: string; onProfileUpdate: (profile: ProfileResponse) => void }) {
  const [motionState, setMotionState] = useState<MotionState>('checking');
  const [walkRun, setWalkRun] = useState<WalkRun | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastSession, setLastSession] = useState<WalkSession | null>(null);
  const [recentSessions, setRecentSessions] = useState<WalkSession[]>([]);
  const [message, setMessage] = useState('Checking motion sensors');
  const [isBusy, setIsBusy] = useState(false);
  const walkRunRef = useRef<WalkRun | null>(null);

  useEffect(() => {
    const available = 'DeviceMotionEvent' in window;
    setMotionState(available ? 'available' : 'unavailable');
    setMessage(available ? 'Motion sensor is available.' : 'Motion sensor is not available in this browser.');

    void listWalkSessions(token)
      .then((sessions) => setRecentSessions(sessions.slice(0, 3)))
      .catch(() => setRecentSessions([]));
  }, [token]);

  useEffect(() => {
    if (!walkRun) return;

    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - Date.parse(walkRun.startedAt)) / 1000)));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [walkRun]);
  useEffect(() => {
    if (!walkRun) return;

    function handleMotion(event: DeviceMotionEvent) {
      const acceleration = event.accelerationIncludingGravity;
      if (!acceleration) return;

      const x = acceleration.x ?? 0;
      const y = acceleration.y ?? 0;
      const z = acceleration.z ?? 0;
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const now = Date.now();
      const current = walkRunRef.current;
      if (!current) return;

      const risingPeak = magnitude > 12.2 && current.lastMagnitude <= 11.2;
      const enoughGap = now - current.lastPeakAt > 320;
      const steps = risingPeak && enoughGap ? current.steps + stepsPerDetectedPeak : current.steps;
      const nextRun = {
        ...current,
        steps,
        samplesCount: current.samplesCount + 1,
        lastMagnitude: magnitude,
        lastPeakAt: risingPeak && enoughGap ? now : current.lastPeakAt,
      };

      walkRunRef.current = nextRun;
      setWalkRun(nextRun);
    }

    window.addEventListener('devicemotion', handleMotion);
    return () => window.removeEventListener('devicemotion', handleMotion);
  }, [walkRun?.session.id]);

  const startWalk = useCallback(async () => {
    setIsBusy(true);
    setMessage('Starting walk session');

    try {
      const permissionGranted = await requestMotionPermissionIfNeeded();
      if (!permissionGranted) {
        setMotionState('permission-required');
        setMessage('Motion permission was not granted. Walk tracking is disabled.');
        return;
      }

      const session = await startWalkSession(token);
      const startedAt = new Date(session.startedAt).toISOString();
      const nextRun = { session, startedAt, steps: 0, samplesCount: 0, lastMagnitude: 0, lastPeakAt: 0 };

      walkRunRef.current = nextRun;
      setWalkRun(nextRun);
      setElapsedSeconds(0);
      setLastSession(null);
      setMotionState('available');
      setMessage('Walk session is recording motion.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }, [token]);

  const finishWalk = useCallback(async () => {
    const current = walkRunRef.current;
    if (!current) return;

    setIsBusy(true);
    setMessage('Submitting walk summary');

    try {
      const endedAt = new Date().toISOString();
      const durationSeconds = Math.max(1, Math.floor((Date.parse(endedAt) - Date.parse(current.startedAt)) / 1000));
      const payload: FinishWalkSessionInput = {
        clientStepCount: current.steps,
        startedAt: current.startedAt,
        endedAt,
        durationSeconds,
        distanceMeters: null,
        samplesCount: current.samplesCount,
        algorithmVersion,
      };
      const finished = await finishWalkSession(token, current.session.id, payload);
      const profile = await fetchProfile(token);
      const sessions = await listWalkSessions(token);

      walkRunRef.current = null;
      setWalkRun(null);
      setElapsedSeconds(0);
      setLastSession(finished);
      setRecentSessions(sessions.slice(0, 3));
      onProfileUpdate(profile);
      setMessage(walkResultMessage(finished));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }, [onProfileUpdate, token]);
  const canStart = motionState === 'available' && !walkRun && !isBusy;
  const sensorLabel = motionState === 'available' ? 'Available' : motionState === 'checking' ? 'Checking' : 'Unavailable';

  return (
    <>
      <section className="walk-panel" aria-label="Walk session">
        <div className="walk-header">
          <div>
            <span>Walk</span>
            <strong>{walkRun ? 'Session running' : 'Ready to walk'}</strong>
          </div>
          <b>{sensorLabel}</b>
        </div>

        <div className="walk-metrics" aria-label="Walk metrics">
          <article>
            <span>Estimated steps</span>
            <strong>{formatNumber(walkRun?.steps ?? lastSession?.clientStepCount ?? 0)}</strong>
          </article>
          <article>
            <span>Elapsed</span>
            <strong>{formatDuration(walkRun ? elapsedSeconds : lastSession?.durationSeconds ?? 0)}</strong>
          </article>
          <article>
            <span>Samples</span>
            <strong>{formatNumber(walkRun?.samplesCount ?? Number(lastSession?.rawSummary?.samplesCount ?? 0))}</strong>
          </article>
        </div>

        <p className={motionState === 'available' ? 'walk-message' : 'walk-message warning'}>{message}</p>

        <div className="walk-notice" role="note">
          Keep Telegram open and the screen active while walking. Step tracking pauses when the app is backgrounded or the screen is locked.
        </div>

        <div className="algorithm-row">
          <span>Algorithm</span>
          <strong>{algorithmVersion}</strong>
        </div>

        <div className="walk-actions">
          <button type="button" onClick={startWalk} disabled={!canStart}>Start</button>
          <button type="button" className="secondary-button" onClick={finishWalk} disabled={!walkRun || isBusy}>Finish</button>
        </div>
      </section>

      <section className="panel compact-panel">
        <div>
          <h2>Validation result</h2>
          <p>{lastSession ? validationText(lastSession) : 'Finish a recorded session to see accepted steps and earned ERT.'}</p>
        </div>
        {lastSession ? (
          <div className="result-grid">
            <span>{lastSession.status}</span>
            <strong>{formatNumber(lastSession.earnedErt)} ERT</strong>
          </div>
        ) : null}
      </section>

      <section className="panel compact-panel">
        <div>
          <h2>Recent walks</h2>
          <p>{recentSessions.length === 0 ? 'No walk sessions yet.' : 'Latest submitted walk sessions.'}</p>
        </div>
        {recentSessions.length > 0 ? (
          <div className="recent-list">
            {recentSessions.map((session) => (
              <div key={session.id}>
                <span>{session.status}</span>
                <strong>{formatNumber(session.acceptedStepCount ?? session.clientStepCount ?? 0)} steps</strong>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}

async function requestMotionPermissionIfNeeded() {
  const motionEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };

  if (typeof motionEvent.requestPermission !== 'function') return true;
  return (await motionEvent.requestPermission()) === 'granted';
}

function validationText(session: WalkSession) {
  if (session.status === 'ACCEPTED') {
    return `${formatNumber(session.acceptedStepCount ?? 0)} accepted steps. ${formatNumber(session.earnedErt)} ERT earned.`;
  }

  if (session.status === 'REJECTED') {
    return `Rejected: ${session.rejectionReason ?? 'validation failed'}.`;
  }

  return 'Submitted walk is being processed.';
}

function walkResultMessage(session: WalkSession) {
  if (session.status === 'ACCEPTED') return `Accepted ${formatNumber(session.acceptedStepCount ?? 0)} steps.`;
  if (session.status === 'REJECTED') return `Walk rejected: ${session.rejectionReason ?? 'validation failed'}.`;
  return 'Walk summary submitted.';
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected walk error';
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}