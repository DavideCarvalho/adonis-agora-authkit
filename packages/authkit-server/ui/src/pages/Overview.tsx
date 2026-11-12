import React from 'react';
import { ConsolesContainer } from '../containers/consoles.containers';
import {
  MetricsContainer,
  RecentEventsContainer,
  SignInsChartContainer,
  SignUpsChartContainer,
} from '../containers/overview.containers';

export function Overview() {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">Overview</div>
        <div className="page-sub">Identity provider metrics</div>
      </div>

      <MetricsContainer />

      <div className="grid-2" style={{ marginTop: 16 }}>
        <SignInsChartContainer />
        <SignUpsChartContainer />
      </div>

      <div style={{ marginTop: 16 }}>
        <RecentEventsContainer />
      </div>

      <ConsolesContainer />
    </div>
  );
}
