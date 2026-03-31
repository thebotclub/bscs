import { html } from 'htm/preact';

export type StatusValue = 'running' | 'stopped' | 'unknown' | 'created';

interface StatusBadgeProps {
  status: StatusValue;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const label: string = status;
  return html`
    <span class=${'status-badge ' + status}>
      <span class=${'status-dot ' + status}></span>
      ${label}
    </span>
  `;
}
