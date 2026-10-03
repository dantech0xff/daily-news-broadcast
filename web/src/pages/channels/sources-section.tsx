import { useState } from 'react';

import type { FieldSpec } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Checkbox, Field, Select } from '../../components/form-controls';
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconTrash } from '../../components/icons';
import { Notice } from '../../components/states';
import {
  JSON_FIELD_LABELS,
  PRESET_LABELS,
  SOURCE_FIELD_HINTS,
  SOURCE_TYPE_LABELS,
  labelOf,
} from '../../lib/labels';
import { emptySourceDraft, sourceFieldSpecs, type SourceDraft } from './channel-form-model';
import { FormSection, SpecInput, type ChannelFormApi } from './form-parts';

export function SourcesSection({ form }: { form: ChannelFormApi }) {
  const { values, meta, update, errorFor, readOnly } = form;
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [presetToAdd, setPresetToAdd] = useState('');
  const [typeToAdd, setTypeToAdd] = useState('');
  const usedPresets = new Set(values.sources.filter(source => source.type === 'preset').map(source => source.preset));
  const availablePresets = meta.sources.presets.filter(preset => !usedPresets.has(preset.id));
  const full = values.sources.length >= meta.sources.maxEntries;

  const setSources = (updater: (sources: SourceDraft[]) => SourceDraft[]) => {
    update('sources', current => ({ ...current, sources: updater(current.sources) }));
  };
  const editSource = (index: number, path: string, updater: (draft: SourceDraft) => SourceDraft) => {
    update(path, current => ({
      ...current,
      sources: current.sources.map((draft, position) => (position === index ? updater(draft) : draft)),
    }));
  };
  // Editing a field keeps its source expanded even after the field's error clears.
  const editField = (index: number, path: string, updater: (draft: SourceDraft) => SourceDraft) => {
    const key = values.sources[index]?.key;
    if (key) setOpenKeys(current => (current.has(key) ? current : new Set(current).add(key)));
    editSource(index, path, updater);
  };
  const toggleOpen = (key: string) => {
    setOpenKeys(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const move = (index: number, offset: number) => {
    setSources(sources => {
      const target = index + offset;
      if (target < 0 || target >= sources.length) return sources;
      const next = [...sources];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
  };
  const addPreset = () => {
    if (!presetToAdd) return;
    setSources(sources => [...sources, emptySourceDraft('preset', presetToAdd)]);
    setPresetToAdd('');
  };
  const addTyped = () => {
    if (!typeToAdd) return;
    const draft = emptySourceDraft(typeToAdd);
    setSources(sources => [...sources, draft]);
    setOpenKeys(current => new Set(current).add(draft.key));
    setTypeToAdd('');
  };

  return (
    <FormSection
      id="section-sources"
      title="Nguồn"
      description="Thứ tự nguồn là thứ tự quét. Preset là bộ nguồn dựng sẵn; nguồn riêng cấu hình theo từng loại."
    >
      {errorFor('sources') ? <Notice tone="danger">{errorFor('sources')}</Notice> : null}
      {values.sources.length === 0 ? (
        <p className="text-sm text-slate-500">Chưa có nguồn nào. Thêm một preset hoặc một nguồn riêng bên dưới.</p>
      ) : (
        <ol className="space-y-3">
          {values.sources.map((draft, index) => {
            const specs = draft.type === 'preset' ? undefined : sourceFieldSpecs(meta, draft.type);
            const open = openKeys.has(draft.key) || hasSourceErrors(form, index);
            const presetMeta = draft.type === 'preset' ? meta.sources.presets.find(preset => preset.id === draft.preset) : undefined;
            return (
              <li key={draft.key} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 text-xs font-medium text-slate-400">#{index + 1}</span>
                  <Checkbox
                    id={`${draft.key}-enabled`}
                    label={<span className="sr-only">Bật nguồn #{index + 1}</span>}
                    checked={draft.enabled}
                    onChange={checked => editSource(index, 'sources', current => ({ ...current, enabled: checked }))}
                  />
                  <Badge tone={draft.type === 'preset' ? 'indigo' : 'blue'}>{labelOf(SOURCE_TYPE_LABELS, draft.type)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{sourceTitle(draft)}</span>
                  {!draft.enabled ? <Badge tone="slate">Đang tắt</Badge> : null}
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" aria-label={`Đưa nguồn #${index + 1} lên`} disabled={index === 0} onClick={() => move(index, -1)} icon={<IconArrowUp className="size-4" />} />
                    <Button size="sm" variant="ghost" aria-label={`Đưa nguồn #${index + 1} xuống`} disabled={index === values.sources.length - 1} onClick={() => move(index, 1)} icon={<IconArrowDown className="size-4" />} />
                    {specs ? (
                      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => toggleOpen(draft.key)} icon={<IconEdit className="size-4" />}>
                        {open ? 'Thu gọn' : 'Cấu hình'}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Xoá nguồn #${index + 1}`}
                      onClick={() => setSources(sources => sources.filter((_, position) => position !== index))}
                      icon={<IconTrash className="size-4 text-rose-600" />}
                    />
                  </div>
                </div>
                {errorFor(`sources.${index}`) ? <p className="mt-2 text-xs text-rose-600">{errorFor(`sources.${index}`)}</p> : null}
                {errorFor(`sources.${index}.preset`) ? <p className="mt-2 text-xs text-rose-600">{errorFor(`sources.${index}.preset`)}</p> : null}
                {errorFor(`sources.${index}.type`) ? <p className="mt-2 text-xs text-rose-600">{errorFor(`sources.${index}.type`)}</p> : null}
                {presetMeta ? (
                  <p className="mt-2 text-xs text-slate-500">
                    {presetMeta.sources.length} nguồn: {presetMeta.sources.map(source => source.name).join(', ')}
                  </p>
                ) : null}
                {draft.type !== 'preset' && !specs ? (
                  <p className="mt-2 text-xs text-amber-700">Loại nguồn này không còn được hỗ trợ; cấu hình được giữ nguyên khi lưu.</p>
                ) : null}
                {specs && open ? <TypedSourceFields form={form} draft={draft} index={index} specs={specs} onEdit={editField} /> : null}
              </li>
            );
          })}
        </ol>
      )}

      {!readOnly ? (
        <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
          <div className="flex items-end gap-2">
            <Field id="add-preset" label="Thêm preset" className="flex-1">
              <Select id="add-preset" value={presetToAdd} onChange={event => setPresetToAdd(event.target.value)} disabled={full || availablePresets.length === 0}>
                <option value="">— Chọn preset —</option>
                {availablePresets.map(preset => (
                  <option key={preset.id} value={preset.id}>{labelOf(PRESET_LABELS, preset.id)} ({preset.sources.length} nguồn)</option>
                ))}
              </Select>
            </Field>
            <Button onClick={addPreset} disabled={!presetToAdd || full} icon={<IconPlus className="size-4" />}>Thêm</Button>
          </div>
          <div className="flex items-end gap-2">
            <Field id="add-source-type" label="Thêm nguồn riêng" className="flex-1">
              <Select id="add-source-type" value={typeToAdd} onChange={event => setTypeToAdd(event.target.value)} disabled={full}>
                <option value="">— Chọn loại nguồn —</option>
                {meta.sources.types.map(entry => (
                  <option key={entry.type} value={entry.type}>{labelOf(SOURCE_TYPE_LABELS, entry.type)}</option>
                ))}
              </Select>
            </Field>
            <Button onClick={addTyped} disabled={!typeToAdd || full} icon={<IconPlus className="size-4" />}>Thêm</Button>
          </div>
          {full ? <p className="text-xs text-slate-500 sm:col-span-2">Đã đạt tối đa {meta.sources.maxEntries} nguồn.</p> : null}
        </div>
      ) : null}
    </FormSection>
  );
}

function TypedSourceFields({ form, draft, index, specs, onEdit }: {
  form: ChannelFormApi;
  draft: SourceDraft;
  index: number;
  specs: FieldSpec[];
  onEdit: (index: number, path: string, updater: (draft: SourceDraft) => SourceDraft) => void;
}) {
  const base = `sources.${index}.config`;
  return (
    <div className="mt-3 grid gap-4 border-t border-slate-100 pt-3 sm:grid-cols-2">
      {specs.map(spec => {
        if (spec.kind === 'jsonFields') {
          return (
            <fieldset key={spec.key} className="space-y-3 rounded-lg bg-slate-50 p-3 sm:col-span-2">
              <legend className="px-1 text-sm font-medium text-slate-700">
                Ánh xạ trường (fields){spec.required ? <span className="ml-0.5 text-rose-600" aria-hidden="true">*</span> : null}
              </legend>
              <p className="text-xs text-slate-500">{SOURCE_FIELD_HINTS.fields}</p>
              {form.errorFor(`${base}.${spec.key}`) ? <p className="text-xs text-rose-600">{form.errorFor(`${base}.${spec.key}`)}</p> : null}
              <div className="grid gap-3 sm:grid-cols-3">
                {(spec.fields ?? []).map(nested => (
                  <SpecInput
                    key={nested.key}
                    id={`${draft.key}-fields-${nested.key}`}
                    spec={nested}
                    label={labelOf(JSON_FIELD_LABELS, nested.key)}
                    value={draft.mapping[nested.key] ?? ''}
                    error={form.errorFor(`${base}.${spec.key}.${nested.key}`)}
                    onChange={value => onEdit(index, `${base}.${spec.key}.${nested.key}`, current => ({
                      ...current,
                      mapping: { ...current.mapping, [nested.key]: value },
                    }))}
                  />
                ))}
              </div>
            </fieldset>
          );
        }
        return (
          <SpecInput
            key={spec.key}
            id={`${draft.key}-${spec.key}`}
            spec={spec}
            value={draft.values[spec.key] ?? ''}
            error={form.errorFor(`${base}.${spec.key}`)}
            hint={SOURCE_FIELD_HINTS[spec.key]}
            onChange={value => onEdit(index, `${base}.${spec.key}`, current => ({
              ...current,
              values: { ...current.values, [spec.key]: value },
            }))}
          />
        );
      })}
    </div>
  );
}

// A source with a config error stays expanded so the error is visible.
function hasSourceErrors(form: ChannelFormApi, index: number): boolean {
  const base = `sources.${index}.config`;
  if (form.errorFor(base)) return true;
  const draft = form.values.sources[index];
  const specs = draft ? sourceFieldSpecs(form.meta, draft.type) ?? [] : [];
  return specs.some(spec => {
    if (form.errorFor(`${base}.${spec.key}`)) return true;
    return spec.kind === 'jsonFields' && (spec.fields ?? []).some(nested => Boolean(form.errorFor(`${base}.${spec.key}.${nested.key}`)));
  });
}

function sourceTitle(draft: SourceDraft): string {
  if (draft.type === 'preset') return labelOf(PRESET_LABELS, draft.preset, '(chưa chọn preset)');
  const value = (key: string) => (draft.values[key] ?? '').trim();
  switch (draft.type) {
    case 'hackernews':
      return value('query') ? `Tìm "${value('query')}"` : 'Hacker News';
    case 'reddit':
      return value('subreddit') ? `r/${value('subreddit')}` : '(chưa nhập subreddit)';
    case 'devto':
      return value('tag') ? `#${value('tag')}` : 'Mọi tag';
    case 'github-trending':
      return value('language') || 'Mọi ngôn ngữ';
    default:
      return value('name') || value('id') || value('url') || value('feedUrl') || '(chưa đặt tên)';
  }
}
