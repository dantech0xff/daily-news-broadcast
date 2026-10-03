/** Building blocks shared by the channel form sections. */

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { Credential, CredentialKind, FieldSpec, LimitKey, Meta } from '../../api/types';
import { Card, CardBody, CardHeader } from '../../components/card';
import { describedBy, Field, Select, TextInput } from '../../components/form-controls';
import {
  CREDENTIAL_KIND_LABELS,
  ENUM_OPTION_LABELS,
  JSON_FIELD_LABELS,
  LIMIT_LABELS,
  SOURCE_FIELD_LABELS,
  labelOf,
} from '../../lib/labels';
import type { ChannelFormValues } from './channel-form-model';

/** What every section needs: the values, an updater that clears the edited field's server error, and errors by path. */
export interface ChannelFormApi {
  values: ChannelFormValues;
  meta: Meta;
  credentials: Credential[];
  readOnly: boolean;
  /** Apply a change; `path` is the API field path it edits ('sources' for list changes). */
  update: (path: string, updater: (values: ChannelFormValues) => ChannelFormValues) => void;
  errorFor: (path: string) => string | undefined;
}

export function FormSection({ id, title, description, children }: { id: string; title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader id={id} title={title} description={description} />
      <CardBody className="space-y-4">{children}</CardBody>
    </Card>
  );
}

/**
 * Credential slot select, filtered by kind. Slots may be saved empty; `neededToRun`
 * marks the ones the channel needs before it can resume or preview.
 */
export function CredentialSelect({ id, kind, value, onChange, credentials, error, hint, label, neededToRun }: {
  id: string;
  kind: CredentialKind;
  value: string;
  onChange: (value: string) => void;
  credentials: Credential[];
  error?: string;
  hint?: ReactNode;
  label?: ReactNode;
  neededToRun?: boolean;
}) {
  const options = credentials.filter(credential => credential.kind === kind);
  const unknown = value !== '' && !credentials.some(credential => credential.id === value);
  const help = hint ?? (
    <>
      {options.length === 0 ? `Chưa có credential loại ${CREDENTIAL_KIND_LABELS[kind]}. ` : null}
      <Link to="/secrets" className="text-indigo-700 hover:underline">Quản lý credential</Link>
    </>
  );
  const title = label ?? CREDENTIAL_KIND_LABELS[kind];
  return (
    <Field
      id={id}
      label={neededToRun ? <>{title} <span className="text-xs font-normal text-slate-500">(cần để chạy)</span></> : title}
      error={error}
      hint={help}
    >
      <Select id={id} value={value} invalid={Boolean(error)} aria-describedby={describedBy(id, { error, hint: help })} onChange={event => onChange(event.target.value)}>
        <option value="">— Chưa chọn —</option>
        {options.map(credential => (
          <option key={credential.id} value={credential.id}>
            {credential.label}{credential.isSet ? '' : ' (chưa có giá trị)'}
          </option>
        ))}
        {unknown ? <option value={value}>{value} (không tìm thấy)</option> : null}
      </Select>
    </Field>
  );
}

/** Input for one spec'd field (typed source config or gateway setting). */
export function SpecInput({ id, spec, value, onChange, error, label, hint }: {
  id: string;
  spec: FieldSpec;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  label?: ReactNode;
  hint?: ReactNode;
}) {
  const describe = describedBy(id, { error, hint });
  let control: ReactNode;
  if (spec.kind === 'enum') {
    control = (
      <Select id={id} value={value} invalid={Boolean(error)} aria-describedby={describe} onChange={event => onChange(event.target.value)}>
        <option value="">{spec.required ? '— Chọn —' : '(Mặc định)'}</option>
        {(spec.options ?? []).map(option => <option key={option} value={option}>{labelOf(ENUM_OPTION_LABELS, option)}</option>)}
      </Select>
    );
  } else {
    control = (
      <TextInput
        id={id}
        value={value}
        invalid={Boolean(error)}
        aria-describedby={describe}
        onChange={event => onChange(event.target.value)}
        type={spec.kind === 'integer' ? 'number' : 'text'}
        inputMode={spec.kind === 'integer' ? 'numeric' : spec.kind === 'url' ? 'url' : undefined}
        min={spec.kind === 'integer' ? spec.min : undefined}
        max={spec.kind === 'integer' ? spec.max : undefined}
        step={spec.kind === 'integer' ? 1 : undefined}
        maxLength={spec.kind === 'integer' ? undefined : spec.maxLength}
        spellCheck={false}
        autoComplete="off"
        className={spec.kind === 'jsonPath' || spec.kind === 'url' ? 'font-mono' : undefined}
        placeholder={spec.kind === 'url' ? 'https://' : undefined}
      />
    );
  }
  return (
    <Field id={id} label={label ?? labelOf(SOURCE_FIELD_LABELS, spec.key)} required={spec.required} error={error} hint={hint ?? rangeHint(spec)}>
      {control}
    </Field>
  );
}

function rangeHint(spec: FieldSpec): string | undefined {
  if (spec.kind === 'integer' && spec.min !== undefined && spec.max !== undefined) return `Từ ${spec.min} đến ${spec.max}.`;
  return undefined;
}

const PATH_LABELS: Readonly<Record<string, string>> = {
  '': 'Dữ liệu',
  id: 'ID kênh',
  name: 'Tên kênh',
  enabled: 'Bật/tắt',
  mode: 'Mode',
  cron: 'Cron',
  timezone: 'Timezone',
  notBefore: 'Mốc cutover',
  sources: 'Nguồn',
  prompt: 'Prompt',
  'prompt.language': 'Ngôn ngữ',
  'prompt.style': 'Style',
  'prompt.audience': 'Audience',
  'prompt.customSystemPrompt': 'System prompt riêng',
  ai: 'AI',
  'ai.provider': 'AI provider',
  'ai.model': 'Model',
  'ai.name': 'Tên hiển thị của AI',
  'ai.baseUrl': 'Base URL',
  'ai.apiKeyCredentialId': 'AI API key',
  'ai.gateway': 'AI Gateway',
  'ai.gateway.accountId': 'Gateway account ID',
  'ai.gateway.gatewayId': 'Gateway ID',
  'ai.gateway.byokAlias': 'BYOK alias',
  'ai.gateway.tokenCredentialId': 'AI Gateway token',
  telegram: 'Telegram',
  'telegram.botTokenCredentialId': 'Telegram bot token',
  'telegram.chatIdCredentialId': 'Telegram chat ID',
  limits: 'Giới hạn',
  version: 'Phiên bản',
};

/** Human label of an API field path: `sources.0.config.feedUrl` → `Nguồn #1 › URL feed`. */
export function describeFieldPath(path: string): string {
  if (path in PATH_LABELS) return PATH_LABELS[path] ?? path;
  const limit = /^limits\.(\w+)$/.exec(path);
  if (limit?.[1] && limit[1] in LIMIT_LABELS) return LIMIT_LABELS[limit[1] as LimitKey].label;
  const source = /^sources\.(\d+)(?:\.(.*))?$/.exec(path);
  if (source?.[1]) {
    const parts = [`Nguồn #${Number(source[1]) + 1}`];
    const rest = source[2] ?? '';
    const config = /^config\.([^.]+)(?:\.([^.]+))?$/.exec(rest);
    if (config?.[1]) {
      parts.push(labelOf(SOURCE_FIELD_LABELS, config[1]));
      if (config[2]) parts.push(labelOf(JSON_FIELD_LABELS, config[2]));
    } else if (rest) {
      parts.push(rest);
    }
    return parts.join(' › ');
  }
  return path;
}
