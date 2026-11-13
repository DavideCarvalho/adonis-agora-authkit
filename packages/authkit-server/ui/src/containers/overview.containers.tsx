import { useOverviewQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import { MetricCard, MetricGrid } from '../agora-kit/blocks/metric-card';
import { Panel } from '../agora-kit/blocks/panel';
import { Badge } from '../agora-kit/ui/badge';
import { AdminTable, Cell, Code, Row } from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton, SkeletonCards, SkeletonPanelTable } from '../components/Skeleton';
import { TrendChart } from '../components/TrendChart';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type Tone = 'good' | 'destructive' | 'brand' | 'warn' | 'neutral';

/** Badge tone of an audit event type. */
export function eventTone(type: string): Tone {
  if (type.includes('login') || type.includes('signin')) return 'good';
  if (type.includes('fail') || type.includes('error') || type.includes('locked'))
    return 'destructive';
  if (type.includes('register') || type.includes('signup')) return 'brand';
  if (type.includes('settings') || type.includes('admin')) return 'warn';
  return 'neutral';
}

// ── MetricsContainer ──────────────────────────────────────────────────────────

export function MetricsContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      label="Metrics"
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonCards count={6} />}
    >
      {data && (
        <MetricGrid>
          <MetricCard
            label="Total Users"
            value={data.usersTotal.toLocaleString()}
            caption="registered accounts"
            tone="brand"
          />
          <MetricCard
            label="Active Sessions"
            value={(data.activeSessions ?? 0).toLocaleString()}
            caption="currently logged in"
            tone="good"
          />
          <MetricCard
            label="MAU"
            value={data.mau.toLocaleString()}
            caption="monthly active users"
            tone="warn"
          />
          <MetricCard
            label="Sign-ins"
            value={data.signInsTotal.toLocaleString()}
            caption={`last ${data.windowDays} days`}
          />
          <MetricCard
            label="Sign-ups"
            value={data.signUpsTotal.toLocaleString()}
            caption="new registrations"
            tone="info"
          />
          <MetricCard
            label="OAuth Clients"
            value={data.clientsCount.toLocaleString()}
            caption="OIDC clients"
          />
        </MetricGrid>
      )}
    </QueryBoundary>
  );
}

// ── Charts ────────────────────────────────────────────────────────────────────

function ChartPanelSkeleton({ title }: { title: string }) {
  return (
    <Panel title={title} bodyClassName="pb-1">
      <Skeleton height={150} />
    </Panel>
  );
}

function ChartEmpty() {
  return (
    <div className="flex h-[60px] items-center justify-center text-xs text-faint">No data yet</div>
  );
}

function TrendPanel({
  title,
  windowDays,
  data,
  color,
  label,
}: {
  title: string;
  windowDays: number;
  data: Array<{ date: string; count: number }>;
  color: string;
  label: string;
}) {
  return (
    <Panel title={title} description={`last ${windowDays}d`} bodyClassName="pb-1">
      {data.length > 0 ? <TrendChart data={data} color={color} label={label} /> : <ChartEmpty />}
    </Panel>
  );
}

export function SignInsChartContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      label="Sign-ins"
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<ChartPanelSkeleton title="Sign-ins / day" />}
    >
      {data && (
        <TrendPanel
          title="Sign-ins / day"
          windowDays={data.windowDays}
          data={data.signInsPerDay}
          color="var(--agora-accent)"
          label="sign-ins"
        />
      )}
    </QueryBoundary>
  );
}

export function SignUpsChartContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      label="Sign-ups"
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<ChartPanelSkeleton title="Sign-ups / day" />}
    >
      {data && (
        <TrendPanel
          title="Sign-ups / day"
          windowDays={data.windowDays}
          data={data.signUpsPerDay}
          color="var(--agora-good)"
          label="sign-ups"
        />
      )}
    </QueryBoundary>
  );
}

// ── RecentEventsContainer ─────────────────────────────────────────────────────

export function RecentEventsContainer() {
  const { data, isLoading, error, refetch } = useQuery(useOverviewQueryOptions());

  return (
    <QueryBoundary
      label="Recent events"
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonPanelTable rows={5} cols={4} />}
    >
      {data?.auditSupported && data.recentEvents.length > 0 && (
        <Panel
          title="Recent Events"
          description={
            data.auditTotal !== null ? `${data.auditTotal.toLocaleString()} total` : undefined
          }
          flush
        >
          <AdminTable head={['Type', 'Account', 'IP', 'When']} label="Recent events">
            {data.recentEvents.map((ev) => (
              <Row key={ev.id}>
                <Cell>
                  <Badge variant={eventTone(ev.type)}>{ev.type}</Badge>
                </Cell>
                <Cell className="mono text-[11.5px]">{ev.email ?? ev.accountId ?? '—'}</Cell>
                <Cell>
                  <Code>{ev.ip ?? '—'}</Code>
                </Cell>
                <Cell className="mono text-[11px] text-faint">
                  {ev.createdAt ? fmtDate(ev.createdAt) : '—'}
                </Cell>
              </Row>
            ))}
          </AdminTable>
        </Panel>
      )}
    </QueryBoundary>
  );
}
