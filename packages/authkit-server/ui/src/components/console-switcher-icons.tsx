import React from 'react';
import { type ConsoleIconKey, iconKey } from '../lib/console_switcher';

/** The 7 console icons, 24×24 stroke SVGs (no icon library). Unknown keys render `generic`. */
const PATHS: Record<ConsoleIconKey, React.ReactNode> = {
  workflow: (
    <>
      <rect x="3" y="4" width="6" height="5" rx="1.5" />
      <rect x="15" y="4" width="6" height="5" rx="1.5" />
      <rect x="9" y="15" width="6" height="5" rx="1.5" />
      <path d="M6 9v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9M12 13v2" />
    </>
  ),
  telescope: (
    <>
      <path d="M4 10.5 17.5 4l2 4.5L6 15z" />
      <path d="m9.5 13.5 2.5 6.5M14.5 11.5 12 20M9 21h6" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="m21 16-5-5-9 9" />
    </>
  ),
  payments: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6.5 15h4" />
    </>
  ),
  agent: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 12.5v1M15 12.5v1M2 12v3M22 12v3" />
    </>
  ),
  identity: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z" />
      <circle cx="12" cy="10.5" r="2.5" />
      <path d="M8 16.5c.9-1.6 2.3-2.5 4-2.5s3.1.9 4 2.5" />
    </>
  ),
  generic: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
};

export function ConsoleIcon({ icon, size = 16 }: { icon: unknown; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[iconKey(icon)]}
    </svg>
  );
}
