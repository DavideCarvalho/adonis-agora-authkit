import { PageHeader } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { ConsolesContainer } from '../containers/consoles.containers';
import {
  MetricsContainer,
  RecentEventsContainer,
  SignInsChartContainer,
  SignUpsChartContainer,
} from '../containers/overview.containers';

export function Overview() {
  return (
    <PageBody>
      <PageHeader title="Overview" description="Identity provider metrics" />
      <MetricsContainer />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SignInsChartContainer />
        <SignUpsChartContainer />
      </div>
      <RecentEventsContainer />
      <ConsolesContainer />
    </PageBody>
  );
}
