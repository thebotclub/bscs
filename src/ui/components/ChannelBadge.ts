import { html } from 'htm/preact';

interface ChannelBadgeProps {
  channels: string[];
}

function channelClass(ch: string): string {
  const upper = ch.toUpperCase();
  if (upper === 'TG' || upper === 'TELEGRAM') return 'tg';
  if (upper === 'WA' || upper === 'WHATSAPP') return 'wa';
  if (upper === 'DC' || upper === 'DISCORD') return 'dc';
  return 'other';
}

function channelLabel(ch: string): string {
  const upper = ch.toUpperCase();
  if (upper === 'TELEGRAM') return 'TG';
  if (upper === 'WHATSAPP') return 'WA';
  if (upper === 'DISCORD') return 'DC';
  return upper.substring(0, 4);
}

export function ChannelBadge({ channels }: ChannelBadgeProps) {
  if (!channels || channels.length === 0) {
    return html`<span class="channel-pills"></span>`;
  }
  return html`
    <span class="channel-pills">
      ${channels.map(
        (ch) => html`
          <span class=${'channel-pill ' + channelClass(ch)}>${channelLabel(ch)}</span>
        `,
      )}
    </span>
  `;
}
