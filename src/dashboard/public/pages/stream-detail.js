/**
 * Stream Detail Page — Config summary + run history (read-only)
 */

import { useState, useEffect, useCallback } from 'https://esm.sh/preact@10.25.4/hooks';
import { html, api, navigate, useSSE, toast } from '../app.js';

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(d) { return d ? new Date(d).toLocaleString() : '-'; }

function StatusBadge({ status }) {
  const map = {
    success: 'badge-success', error: 'badge-error', skipped: 'badge-warning',
    preview: 'badge-info', running: 'badge-running', dry_run: 'badge-info',
  };
  return html`<span class="badge ${map[status] || 'badge-dim'}">${status}</span>`;
}

function sourceLabel(src) {
  if (src.type === 'preset') return `📦 ${src.preset}`;
  if (src.type === 'reddit') return `🔴 r/${src.config?.subreddit || 'reddit'}`;
  if (src.type === 'hackernews') return `🟠 HN${src.config?.query ? `: ${src.config.query}` : ''}`;
  if (src.type === 'devto') return `🧑‍💻 Dev.to${src.config?.tag ? `: ${src.config.tag}` : ''}`;
  if (src.config?.name) return `📡 ${src.config.name}`;
  return `📡 ${src.type}`;
}

function outputLabel(out) {
  const icons = { telegram: '✈️', slack: '💬', discord: '🎮', email: '📧', webhook: '🔗', markdown: '📝' };
  return `${icons[out.type] || '📤'} ${out.type}`;
}

export default function StreamDetailPage({ id }) {
  const [stream, setStream] = useState(null);
  const [runs, setRuns] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [recoveryOffset, setRecoveryOffset] = useState(0);
  const [action, setAction] = useState(null);

  const loadStream = useCallback(() => api(`/streams/${id}`).then(setStream).catch(e => toast(e.message, 'error')), [id]);
  const loadRuns = useCallback(() => api(`/streams/${id}/runs?limit=50`).then(setRuns).catch(e => toast(e.message, 'error')), [id]);
  const loadRecovery = useCallback(() => api(`/streams/${id}/unresolved?limit=50&offset=${recoveryOffset}`)
    .then(setRecovery)
    .catch(() => setRecovery({ unavailable: true, channel: null, targets: [], page: { total: 0, limit: 50, offset: 0 } })), [id, recoveryOffset]);

  useEffect(() => { loadStream(); loadRuns(); loadRecovery(); }, [id, recoveryOffset]);
  useSSE((event) => {
    if (event.data?.streamId === id || event.type?.startsWith('run:')) {
      loadStream(); loadRuns(); loadRecovery();
    }
  });

  const handleRun = async () => {
    setAction('run');
    try {
      await api(`/streams/${id}/run`, { method: 'POST' });
      toast('Run completed!', 'success');
      loadRuns(); loadStream();
    } catch (err) { toast(err.message, 'error'); }
    finally { setAction(null); }
  };

  const handlePreview = async () => {
    setAction('preview');
    try {
      const result = await api(`/streams/${id}/preview`, { method: 'POST' });
      toast('Preview done!', 'success');
      loadRuns();
      if (result.id) navigate(`/runs/${result.id}`);
    } catch (err) { toast(err.message, 'error'); }
    finally { setAction(null); }
  };

  if (!stream) return html`<div class="container" style="text-align:center;padding:48px"><div class="spinner"></div></div>`;

  return html`
    <div class="container">
      <div class="breadcrumb">
        <a href="#/">Streams</a> / ${stream.name}
      </div>

      <div class="page-header">
        <div>
          <h1 class="page-title" style="display:flex;align-items:center;gap:10px">
            ${stream.name}
            <span class="badge ${stream.enabled ? 'badge-success' : 'badge-dim'}">
              ${stream.enabled ? 'Active' : 'Disabled'}
            </span>
          </h1>
          <p style="color:var(--text-dim);font-size:12px;margin-top:4px">ID: ${stream.id}</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" onClick=${handlePreview} disabled=${!!action}>
            ${action === 'preview' ? html`<span class="spinner"></span>` : 'Preview'}
          </button>
          <button class="btn btn-primary" onClick=${handleRun} disabled=${!!action || !stream.enabled}>
            ${action === 'run' ? html`<span class="spinner"></span>` : 'Run Now'}
          </button>
        </div>
      </div>

      <!-- Config Summary -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
        <div class="card">
          <div class="section-title">Schedule</div>
          <div style="font-size:20px;font-weight:600;margin-bottom:4px">🕐 ${stream.cron}</div>
          <div style="font-size:13px;color:var(--text-dim)">Timezone: ${stream.timezone}</div>
        </div>
        <div class="card">
          <div class="section-title">AI Persona</div>
          ${stream.ai && stream.ai.provider !== 'none' ? html`
            <div style="font-size:16px;font-weight:600;margin-bottom:4px">
              🤖 ${stream.ai.provider}${stream.ai.model ? ` (${stream.ai.model})` : ''}
            </div>
            <div style="font-size:13px;color:var(--text-dim)">
              ${stream.ai.language || 'vi'} · ${stream.ai.style || 'digest'}
            </div>
          ` : html`<div style="color:var(--text-dim)">No AI (raw mode)</div>`}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
        <div class="card">
          <div class="section-title">Sources (${stream.sources.length})</div>
          <div class="plugin-list">
            ${stream.sources.map((s, i) => html`<span key=${i} class="plugin-tag">${sourceLabel(s)}</span>`)}
          </div>
        </div>
        <div class="card">
          <div class="section-title">Outputs (${stream.outputs.length})</div>
          <div class="plugin-list">
            ${stream.outputs.map((o, i) => html`<span key=${i} class="plugin-tag">${outputLabel(o)}</span>`)}
          </div>
        </div>
      </div>

      <!-- Redacted Recovery Targets -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <span class="card-title">Recovery Targets</span>
          <span style="font-size:12px;color:var(--text-dim)">${recovery?.page?.total || 0} unresolved</span>
        </div>
        ${!recovery ? html`<div style="text-align:center;padding:24px"><div class="spinner"></div></div>` :
          recovery.unavailable ? html`<div class="empty-state" style="padding:24px">Operator access required.</div>` : html`
            ${recovery.channel ? html`
              <div style="font-size:12px;margin-bottom:12px;color:var(--text-dim)">
                Channel: <strong>${recovery.channel.state}</strong>
                · expected version ${recovery.channel.expectedVersion}
                · ${recovery.channel.allowedActions.join(', ')}
              </div>
            ` : null}
            ${recovery.targets.length === 0 ? html`
              <div class="empty-state" style="padding:24px">No unresolved delivery targets.</div>
            ` : html`
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Kind</th><th>Exact target</th><th>State</th><th>Version</th><th>Allowed actions</th></tr></thead>
                  <tbody>
                    ${recovery.targets.map((target, index) => html`
                      <tr key=${`${target.kind}-${index}`}>
                        <td><span class="meta-tag">${target.kind}</span></td>
                        <td style="font-size:11px;word-break:break-all">
                          ${target.deliveryId ? html`delivery: ${target.deliveryId}` : null}
                          ${target.outputKey ? html`<br />output: ${target.outputKey}` : null}
                          ${target.outboxId ? html`outbox: ${target.outboxId}` : null}
                        </td>
                        <td><${StatusBadge} status=${target.state} /></td>
                        <td>${target.expectedVersion}</td>
                        <td style="font-size:12px">${target.allowedActions.join(', ')}</td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `}
            ${recovery.page.total > recovery.page.limit ? html`
              <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
                <button class="btn" disabled=${recoveryOffset === 0}
                  onClick=${() => setRecoveryOffset(Math.max(0, recoveryOffset - recovery.page.limit))}>Previous</button>
                <button class="btn" disabled=${recoveryOffset + recovery.page.limit >= recovery.page.total}
                  onClick=${() => setRecoveryOffset(recoveryOffset + recovery.page.limit)}>Next</button>
              </div>
            ` : null}
          `}
      </div>

      <!-- Run History -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Run History</span>
          <span style="font-size:12px;color:var(--text-dim)">${runs?.total || 0} total (in-memory)</span>
        </div>

        ${!runs ? html`<div style="text-align:center;padding:24px"><div class="spinner"></div></div>` :
          runs.runs.length === 0 ? html`
            <div class="empty-state" style="padding:24px">
              <div style="font-size:14px">No runs yet. Click "Run Now" or "Preview" to test.</div>
            </div>
          ` : html`
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Trigger</th>
                    <th>Articles</th>
                    <th>Duration</th>
                    <th>Time</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${runs.runs.map(r => html`
                    <tr key=${r.id} style="cursor:pointer" onClick=${() => navigate(`/runs/${r.id}`)}>
                      <td><${StatusBadge} status=${r.status} /></td>
                      <td><span class="meta-tag">${r.trigger_type}</span></td>
                      <td>${r.stats?.articles ?? '-'}</td>
                      <td>${r.stats?.durationMs ? `${(r.stats.durationMs / 1000).toFixed(1)}s` : '-'}</td>
                      <td style="font-size:12px">${formatDate(r.started_at)}</td>
                      <td><span style="color:var(--text-dim);font-size:12px">View →</span></td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
          `}
      </div>
    </div>
  `;
}
