import { AlertIcon } from '../icons';
import { cn } from '../lib/utils';
import { Badge } from '../ui/badge';

/**
 * How a console reaches another app it lists in its "App" picker:
 * - `control-plane`: the app reports to this console's server; the data lives here and this
 *   server runs the actions.
 * - `federated`: this console reads the app's own store; the data stays in the app.
 *
 * And who runs actions (retry, cancel, delete…) on that app's data from here:
 * - `here`: this console's server (control plane);
 * - `app`: the app itself, which this console asks to act;
 * - `none`: nobody: this console only browses that app.
 */
export type AppMode = 'control-plane' | 'federated';
export type AppActions = 'here' | 'app' | 'none';

/** One entry of a console's `/apps` answer. Older servers send neither field. */
export interface AppModeInfo {
  mode?: AppMode | undefined;
  actions?: AppActions | undefined;
}

/** What a federated app's data and actions mean, in one or two sentences. */
export function federatedDescription(appLabel: string, actions: AppActions | undefined): string {
  const data = `Federated: this console reads ${appLabel}'s data from ${appLabel}'s own store.`;
  if (actions === 'none') return `${data} Read-only here: change it in ${appLabel} itself.`;
  if (actions === 'app') return `${data} Actions are sent to ${appLabel}, which runs them itself.`;
  return data;
}

/** Why an action is unavailable for the picked app, or undefined when it is available. */
export function actionsUnavailableReason(
  appLabel: string,
  info: AppModeInfo | undefined,
): string | undefined {
  if (info?.mode !== 'federated' || info.actions !== 'none') return undefined;
  return `${appLabel} is federated and read-only here: change it in ${appLabel} itself.`;
}

/**
 * The small "federated" tag next to an app's name (in the App picker's options and trigger).
 * Renders nothing for control-plane apps or servers that don't say.
 */
export function AppModeBadge({
  mode,
  actions,
  appLabel,
  className,
}: AppModeInfo & { appLabel: string; className?: string | undefined }) {
  if (mode !== 'federated') return null;
  return (
    <Badge
      variant="info"
      className={cn('shrink-0', className)}
      title={federatedDescription(appLabel, actions)}
      data-app-mode="federated"
    >
      federated
    </Badge>
  );
}

/**
 * The strip under the topbar while the console shows a federated app: where the data comes from
 * and who runs actions. Renders nothing for this app, control-plane apps or older servers.
 */
export function FederatedNotice({
  appLabel,
  mode,
  actions,
  className,
}: AppModeInfo & { appLabel: string; className?: string | undefined }) {
  if (mode !== 'federated') return null;
  return (
    <div
      role="note"
      data-federated-notice
      className={cn(
        'flex items-start gap-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-xs text-fg-2',
        className,
      )}
    >
      <AlertIcon className="mt-px shrink-0 text-info" aria-hidden />
      <span>{federatedDescription(appLabel, actions)}</span>
    </div>
  );
}
