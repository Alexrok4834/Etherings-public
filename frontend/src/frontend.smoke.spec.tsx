import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminApp } from './AdminApp';
import { AdminPasswordPanel, AuthenticatedShell } from './App';
import { ProfileResponse } from './api';

const profile: ProfileResponse = {
  user: {
    id: 'user-1',
    telegramId: '999004',
    username: 'walksmoke999004',
    firstName: 'Walk',
    lastName: 'Smoke',
    photoUrl: null,
    isAdmin: true,
  },
  balance: {
    ertBalance: 125,
    lifetimeEarnedErt: 250,
    lifetimeSpentErt: 40,
    eruBalance: 12,
    eruBalanceExact: '12',
    lifetimeEarnedEru: 20,
    lifetimeEarnedEruExact: '20',
    lifetimeSpentEru: 8,
    lifetimeSpentEruExact: '8',
    updatedAt: '2026-06-22T00:00:00.000Z',
  },
  todayStats: {
    acceptedSteps: 1500,
    earnedErt: 15,
    raffleAttempts: 2,
  },
};

function renderPlayer(initialView: 'home' | 'walk' | 'raffle' | 'rewards') {
  return renderToStaticMarkup(
    <AuthenticatedShell
      token="test-token"
      profile={profile}
      initialView={initialView}
      onProfileUpdate={() => undefined}
      onRetry={() => undefined}
      onLogout={() => undefined}
    />,
  );
}

describe('frontend player smoke', () => {
  it('renders Home navigation with Walk, Raffle, and Rewards entry points', () => {
    const html = renderPlayer('home');

    assert.match(html, /aria-label="Player views"/);
    assert.match(html, />Home</);
    assert.match(html, />Walk</);
    assert.match(html, />Raffle</);
    assert.match(html, />Rewards</);
    assert.match(html, /ERT balance/);
    assert.match(html, /Daily progress/);
  });

  it('renders Walk and Raffle target views without crashing', () => {
    const walkHtml = renderPlayer('walk');
    const raffleHtml = renderPlayer('raffle');

    assert.match(walkHtml, /aria-label="Walk session"/);
    assert.match(walkHtml, /Estimated steps/);
    assert.match(walkHtml, />Start</);
    assert.match(raffleHtml, /aria-label="Raffle pools"/);
    assert.match(raffleHtml, /Active pools/);
    assert.match(raffleHtml, /Recent draws/);
  });
});

describe('frontend admin auth smoke', () => {
  it('renders admin password login form for browser access', () => {
    const html = renderToStaticMarkup(
      <AdminPasswordPanel
        session={{ status: 'telegram-unavailable', message: 'Admin session required' }}
        onSubmit={async () => undefined}
      />,
    );

    assert.match(html, /Admin login/);
    assert.match(html, /Username/);
    assert.match(html, /Password/);
    assert.match(html, />Login</);
  });
});
describe('frontend admin smoke', () => {
  it('renders the dedicated Raffle v2 management surface instead of legacy pool controls', () => {
    const html = renderToStaticMarkup(
      <AdminApp token="admin-token" profile={profile} initialSection="Draw" onRetry={() => undefined} onLogout={() => undefined} />,
    );

    assert.match(html, /aria-label="Raffle v2 management"/);
    assert.match(html, /Configuration economics/);
    assert.match(html, /Validate \/ preview/);
    assert.match(html, /Raffle v2 immutable draw evidence/);
    assert.doesNotMatch(html, />Pools</);
    assert.doesNotMatch(html, />Probabilities</);
  });

  it('renders the generic reward catalog without legacy mutation controls', () => {
    const html = renderToStaticMarkup(
      <AdminApp token="admin-token" profile={profile} initialSection="Rewards" onRetry={() => undefined} onLogout={() => undefined} />,
    );

    assert.match(html, /aria-label="Reward catalog"/);
    assert.match(html, /Read-only catalog/);
    assert.doesNotMatch(html, /Create reward/);
    assert.doesNotMatch(html, /Edit reward/);
    assert.doesNotMatch(html, />Disable</);
    assert.doesNotMatch(html, />Enable</);
  });
});
