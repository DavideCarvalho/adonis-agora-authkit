import { MoonIcon, SignOutIcon, SunIcon } from '../icons';
import type { SignOut, Viewer } from '../shell-config';
import { useTheme } from '../theme';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Button } from '../ui/button';

function initials(viewer: Viewer): string {
  const source = viewer.label.includes('@') ? (viewer.label.split('@')[0] ?? '') : viewer.label;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : source.slice(0, 2);
  return letters.toUpperCase() || '?';
}

/**
 * The sidebar footer: who is signed in (absent viewer → no user row), the theme toggle, and the
 * sign-out (a POST form with the CSRF token, or a plain link) when the server announced one.
 */
export function UserFooter({ viewer, signOut }: { viewer?: Viewer; signOut?: SignOut }) {
  const { theme, toggle } = useTheme();
  return (
    <div className="flex flex-col gap-2.5">
      {viewer && (
        <div className="flex items-center gap-[9px] px-2 py-1.5" data-agora-viewer="">
          <Avatar className="size-7 after:hidden">
            <AvatarFallback className="border border-brand-border bg-brand-soft text-[10.5px] font-semibold text-brand">
              {initials(viewer)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 leading-[normal]">
            <div
              className="truncate text-[11px] font-medium text-fg"
              title={viewer.email ?? viewer.label}
            >
              {viewer.label}
            </div>
            {(viewer.role || (viewer.email && viewer.email !== viewer.label)) && (
              <div className="mono truncate text-[9.5px] text-faint">
                {viewer.role ?? viewer.email}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 justify-start gap-2"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <SunIcon className="size-[13px]" />
          ) : (
            <MoonIcon className="size-[13px]" />
          )}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </Button>
        {signOut &&
          ('action' in signOut ? (
            <form method="post" action={signOut.action} className="contents">
              {signOut.csrfToken && <input type="hidden" name="_csrf" value={signOut.csrfToken} />}
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                aria-label="Sign out"
                title="Sign out"
                className="text-dim"
              >
                <SignOutIcon className="size-[13px]" />
              </Button>
            </form>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Sign out"
              title="Sign out"
              className="text-dim"
              nativeButton={false}
              render={<a href={signOut.href} />}
            >
              <SignOutIcon className="size-[13px]" />
            </Button>
          ))}
      </div>
    </div>
  );
}
