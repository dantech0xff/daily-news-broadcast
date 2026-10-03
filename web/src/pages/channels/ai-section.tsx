import { Checkbox, describedBy, Field, Select, TextInput } from '../../components/form-controls';
import { AI_PROVIDER_LABELS, labelOf } from '../../lib/labels';
import { apiKeyRequirement, providerMeta, type ChannelFormValues } from './channel-form-model';
import { CredentialSelect, FormSection, SpecInput, type ChannelFormApi } from './form-parts';

const GATEWAY_LABELS: Readonly<Record<string, string>> = {
  accountId: 'Cloudflare account ID',
  gatewayId: 'Gateway ID',
  byokAlias: 'BYOK alias',
};

export function AiSection({ form }: { form: ChannelFormApi }) {
  const { values, meta, credentials, update, errorFor } = form;
  const ai = values.ai;
  const rules = providerMeta(meta, ai.provider);
  const apiKey = apiKeyRequirement(meta, ai);
  const patch = (path: string, changes: Partial<ChannelFormValues['ai']>) => {
    update(path, current => ({ ...current, ai: { ...current.ai, ...changes } }));
  };
  const patchGateway = (path: string, changes: Partial<ChannelFormValues['ai']['gateway']>) => {
    update(path, current => ({ ...current, ai: { ...current.ai, gateway: { ...current.ai.gateway, ...changes } } }));
  };

  return (
    <FormSection id="section-ai" title="AI" description="Provider và model dùng để tóm tắt bài cho kênh này.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="ai-provider" label="AI provider" required error={errorFor('ai.provider')}>
          <Select id="ai-provider" value={ai.provider} invalid={Boolean(errorFor('ai.provider'))} onChange={event => patch('ai.provider', { provider: event.target.value })}>
            {meta.ai.providers.map(provider => (
              <option key={provider.id} value={provider.id}>{labelOf(AI_PROVIDER_LABELS, provider.id)}</option>
            ))}
          </Select>
        </Field>
        <Field id="ai-model" label="Model" error={errorFor('ai.model')} hint="Để trống để dùng model mặc định của provider.">
          <TextInput
            id="ai-model"
            value={ai.model}
            maxLength={meta.ai.modelMaxLength}
            invalid={Boolean(errorFor('ai.model'))}
            aria-describedby={describedBy('ai-model', { error: errorFor('ai.model'), hint: true })}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            placeholder="ví dụ gemini-2.0-flash"
            onChange={event => patch('ai.model', { model: event.target.value })}
          />
        </Field>
        {rules?.customName ? (
          <Field id="ai-name" label="Tên hiển thị" error={errorFor('ai.name')} hint="Tên provider tuỳ chỉnh hiển thị trong log.">
            <TextInput
              id="ai-name"
              value={ai.name}
              maxLength={meta.ai.nameMaxLength}
              invalid={Boolean(errorFor('ai.name'))}
              aria-describedby={describedBy('ai-name', { error: errorFor('ai.name'), hint: true })}
              onChange={event => patch('ai.name', { name: event.target.value })}
            />
          </Field>
        ) : null}
        {rules && rules.baseUrl !== 'none' ? (
          <Field
            id="ai-base-url"
            label="Base URL"
            required={rules.baseUrl === 'required'}
            error={errorFor('ai.baseUrl')}
            hint={rules.baseUrl === 'required' ? 'Endpoint OpenAI-compatible, ví dụ https://llm.example.com/v1.' : 'Để trống để dùng http://localhost:11434/v1.'}
          >
            <TextInput
              id="ai-base-url"
              value={ai.baseUrl}
              inputMode="url"
              maxLength={meta.ai.baseUrlMaxLength}
              invalid={Boolean(errorFor('ai.baseUrl'))}
              aria-describedby={describedBy('ai-base-url', { error: errorFor('ai.baseUrl'), hint: true })}
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              placeholder="https://"
              onChange={event => patch('ai.baseUrl', { baseUrl: event.target.value })}
            />
          </Field>
        ) : null}
      </div>

      {rules?.gateway ? (
        <div className="space-y-4 rounded-lg bg-slate-50 p-4">
          <Checkbox
            id="ai-use-gateway"
            label="Gọi qua Cloudflare AI Gateway"
            description="Khoá của provider được lưu trong gateway (BYOK); kênh chỉ cần token của gateway."
            checked={ai.useGateway}
            onChange={checked => patch('ai.gateway', { useGateway: checked })}
          />
          {errorFor('ai.gateway') ? <p className="text-xs text-rose-600">{errorFor('ai.gateway')}</p> : null}
          {ai.useGateway ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {rules.gateway.fields.map(spec => {
                const key = spec.key as keyof ChannelFormValues['ai']['gateway'];
                return (
                  <SpecInput
                    key={spec.key}
                    id={`ai-gateway-${spec.key}`}
                    spec={spec}
                    label={labelOf(GATEWAY_LABELS, spec.key)}
                    value={ai.gateway[key] ?? ''}
                    error={errorFor(`ai.gateway.${spec.key}`)}
                    onChange={value => patchGateway(`ai.gateway.${spec.key}`, { [key]: value })}
                  />
                );
              })}
              <CredentialSelect
                id="ai-gateway-token"
                kind="ai_gateway_token"
                value={ai.gateway.tokenCredentialId}
                credentials={credentials}
                error={errorFor('ai.gateway.tokenCredentialId')}
                neededToRun={rules.gateway.tokenRequired}
                onChange={value => patchGateway('ai.gateway.tokenCredentialId', { tokenCredentialId: value })}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {apiKey !== 'none' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <CredentialSelect
            id="ai-api-key"
            kind="ai_api_key"
            value={ai.apiKeyCredentialId}
            credentials={credentials}
            error={errorFor('ai.apiKeyCredentialId')}
            neededToRun={apiKey === 'required'}
            onChange={value => patch('ai.apiKeyCredentialId', { apiKeyCredentialId: value })}
          />
        </div>
      ) : null}
      <p className="text-xs text-slate-500">
        Credential có thể để trống khi lưu, nhưng kênh chỉ Resume hoặc Preview được khi đủ credential bắt buộc.
      </p>
    </FormSection>
  );
}
