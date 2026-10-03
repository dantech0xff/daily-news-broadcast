import type { ChannelRecord } from '../api/types';
import { Select } from './form-controls';

/**
 * Labelled channel picker ("Kênh"). With `allowAll` the empty value means
 * every channel. A value that is not in `channels` (e.g. a deleted channel
 * kept in the URL) stays selectable so the page can explain it.
 */
export function ChannelSelect({ id, value, onChange, channels, allowAll = false }: {
  id: string;
  value: string;
  onChange: (channelId: string) => void;
  channels: readonly ChannelRecord[];
  allowAll?: boolean;
}) {
  const unknown = value !== '' && !channels.some(channel => channel.id === value);
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium whitespace-nowrap text-slate-700">Kênh</label>
      <Select id={id} value={value} onChange={event => onChange(event.target.value)} className="min-w-48">
        {allowAll ? <option value="">Tất cả kênh</option> : null}
        {channels.map(channel => (
          <option key={channel.id} value={channel.id}>{channel.name} ({channel.id})</option>
        ))}
        {unknown ? <option value={value}>{value} (không tìm thấy)</option> : null}
      </Select>
    </div>
  );
}
