import { useOverviewQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton, SkeletonCard, SkeletonCards, SkeletonPanelTable } from '../components/Skeleton';
import { TrendChart } from '../components/TrendChart';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function eventBadgeClass(type: string) {
  if (type.includes('login') || type.includes('signin')) return 'badge-green';
  if (type.includes('fail') || type.includes('error') || type.includes('locked'))
    return 'badge-red';
  if (type.includes('register') || type.includes('signup')) return 'badge-accent';
  if (type.includes('settings') || type.includes('admin')) return 'badge-amber';
  return 'badge-muted';
}

// ── MetricsContainer ──────────────────────────────────────────────────────────

export function MetricsContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonCards count={6} columns={3} />}
    >
      {data && (
        <div className="cards">
          <div className="card c-accent">
            <div className="card-label">Total Users</div>
            <div className="card-value">{data.usersTotal.toLocaleString()}</div>
            <div className="card-hint">registered accounts</div>
          </div>
          <div className="card c-green">
            <div className="card-label">Active Sessions</div>
            <div className="card-value">{(data.activeSessions ?? 0).toLocaleString()}</div>
            <div className="card-hint">currently logged in</div>
          </div>
          <div className="card c-amber">
            <div className="card-label">MAU</div>
            <div className="card-value">{data.mau.toLocaleString()}</div>
            <div className="card-hint">monthly active users</div>
          </div>
          <div className="card">
            <div className="card-label">Sign-ins</div>
            <div className="card-value" style={{ color: 'var(--text)' }}>
              {data.signInsTotal.toLocaleString()}
            </div>
            <div className="card-hint">last {data.windowDays} days</div>
          </div>
          <div className="card c-blue">
            <div className="card-label">Sign-ups</div>
            <div className="card-value">{data.signUpsTotal.toLocaleString()}</div>
            <div className="card-hint">new registrations</div>
          </div>
          <div className="card">
            <div className="card-label">OAuth Clients</div>
            <div className="card-value" style={{ color: 'var(--text)' }}>
              {data.clientsCount.toLocaleString()}
            </div>
            <div className="card-hint">OIDC clients</div>
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}

// ── SignInsChartContainer ─────────────────────────────────────────────────────

function ChartPanelSkeleton({ title }: { title: string }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
      </div>
      <div className="panel-body" style={{ paddingBottom: 4 }}>
        <Skeleton height={60} borderRadius={8} />
      </div>
    </div>
  );
}

export function SignInsChartContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<ChartPanelSkeleton title="Sign-ins / day" />}
    >
      {data && (
        <div className="panel">
          <div className="panel-head">
            <h3>Sign-ins / day</h3>
            <span className="meta">last {data.windowDays}d</span>
          </div>
          <div className="panel-body" style={{ paddingBottom: '4px' }}>
            {data.signInsPerDay.length > 0 ? (
              <TrendChart data={data.signInsPerDay} color="var(--accent)" label="sign-ins" />
            ) : (
              <div
                style={{
                  height: 60,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--faint)',
                  fontSize: 12,
                }}
              >
                No data yet
              </div>
            )}
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}

// ── SignUpsChartContainer ─────────────────────────────────────────────────────

export function SignUpsChartContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<ChartPanelSkeleton title="Sign-ups / day" />}
    >
      {data && (
        <div className="panel">
          <div className="panel-head">
            <h3>Sign-ups / day</h3>
            <span className="meta">last {data.windowDays}d</span>
          </div>
          <div className="panel-body" style={{ paddingBottom: '4px' }}>
            {data.signUpsPerDay.length > 0 ? (
              <TrendChart data={data.signUpsPerDay} color="var(--green)" label="sign-ups" />
            ) : (
              <div
                style={{
                  height: 60,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--faint)',
                  fontSize: 12,
                }}
              >
                No data yet
              </div>
            )}
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}

// ── RecentEventsContainer ─────────────────────────────────────────────────────

export function RecentEventsContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonPanelTable rows={5} cols={4} />}
    >
      {data?.auditSupported && data.recentEvents.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>Recent Events</h3>
            {data.auditTotal !== null && (
              <span className="meta">{data.auditTotal.toLocaleString()} total</span>
            )}
          </div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Account</th>
                  <th>IP</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.recentEvents.map((ev) => (
                  <tr key={ev.id} className="static" style={{ cursor: 'default' }}>
                    <td>
                      <span className={`badge ${eventBadgeClass(ev.type)}`}>{ev.type}</span>
                    </td>
                    <td>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '11.5px' }}>
                        {ev.email ?? ev.accountId ?? '—'}
                      </span>
                    </td>
                    <td>
                      <span className="code">{ev.ip ?? '—'}</span>
                    </td>
                    <td>
                      <span
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: '11px',
                          color: 'var(--faint)',
                        }}
                      >
                        {ev.createdAt ? fmtDate(ev.createdAt) : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}
