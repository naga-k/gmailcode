import { useState } from 'react';
import type { EmailSummary, TriageDecision, TriageCategory } from '../types';

function fmtDate(dateStr: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

const CATEGORY_META: Record<TriageCategory, { icon: string; label: string; defaultDecision: 'trash' | 'keep' }> = {
  newsletter:    { icon: '📰', label: 'newsletters',    defaultDecision: 'trash' },
  promotion:     { icon: '🏷',  label: 'promotions',    defaultDecision: 'trash' },
  social:        { icon: '🔔', label: 'social',         defaultDecision: 'trash' },
  alert:         { icon: '⚡', label: 'alerts',         defaultDecision: 'trash' },
  transactional: { icon: '🧾', label: 'receipts',       defaultDecision: 'keep'  },
  personal:      { icon: '✉️', label: 'personal',       defaultDecision: 'keep'  },
  system:        { icon: '🔑', label: 'system',         defaultDecision: 'keep'  },
  other:         { icon: '📂', label: 'other',          defaultDecision: 'review'},
};

interface CategoryRow {
  category: TriageCategory;
  trashIds: string[];
  keepIds: string[];
  reviewIds: string[];
}

function buildCategoryRows(decisions: Map<string, TriageDecision>): CategoryRow[] {
  const map = new Map<TriageCategory, CategoryRow>();
  for (const [id, d] of decisions.entries()) {
    const cat = d.category ?? 'other';
    if (!map.has(cat)) map.set(cat, { category: cat, trashIds: [], keepIds: [], reviewIds: [] });
    const row = map.get(cat)!;
    if (d.decision === 'trash') row.trashIds.push(id);
    else if (d.decision === 'keep') row.keepIds.push(id);
    else row.reviewIds.push(id);
  }
  // Sort: trash-heavy categories first
  return [...map.values()].sort((a, b) => b.trashIds.length - a.trashIds.length);
}

interface Props {
  emails: EmailSummary[];
  selectedIds: Set<string>;
  openId: string | null;
  nextPageToken: string | null;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  onTrashSelected: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  decisions?: Map<string, TriageDecision>;
  triaging?: boolean;
  triageProgress?: { done: number; total: number } | null;
  onTriage?: () => void;
  onExecuteDecisions?: (action: 'trash' | 'keep', ids: string[]) => void;
  trashingAll?: boolean;
  trashAllFound?: number;
  onTrashAll?: () => void;
}

export function EmailList({
  emails, selectedIds, openId, nextPageToken,
  onOpen, onToggleSelect, onToggleAll, onTrashSelected, onRefresh, onLoadMore,
  decisions = new Map(), triaging = false, triageProgress = null, onTriage, onExecuteDecisions,
  trashingAll = false, trashAllFound = 0, onTrashAll,
}: Props) {
  const [hoveredDecision, setHoveredDecision] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const allChecked = emails.length > 0 && emails.every(e => selectedIds.has(e.id));

  const trashIds = [...decisions.entries()].filter(([, d]) => d.decision === 'trash').map(([id]) => id);
  const keepIds = [...decisions.entries()].filter(([, d]) => d.decision === 'keep').map(([id]) => id);
  const categoryRows = buildCategoryRows(decisions);

  return (
    <div className="email-list-panel">
      <div className="list-toolbar">
        <input type="checkbox" checked={allChecked} onChange={e => onToggleAll(e.target.checked)} />
        {selectedIds.size > 0 && <span className="sel-count">{selectedIds.size} sel</span>}
        <button className="tb-btn danger" disabled={selectedIds.size === 0} onClick={onTrashSelected}>trash</button>
        <button className="tb-btn" onClick={onRefresh}>refresh</button>
        {onTriage && (
          <button
            className={`tb-btn triage-btn ${triaging ? 'loading' : ''}`}
            onClick={onTriage}
            disabled={triaging || trashingAll}
            title="AI triage current view"
          >
            {triaging
              ? triageProgress
                ? `triaging ${triageProgress.done}/${triageProgress.total}`
                : 'fetching...'
              : '✦ triage'}
          </button>
        )}
        {onTrashAll && (
          <button
            className={`tb-btn danger ${trashingAll ? 'loading' : ''}`}
            onClick={onTrashAll}
            disabled={trashingAll || triaging}
            title="Trash ALL emails matching current query"
          >
            {trashingAll ? `found ${trashAllFound}… deleting` : '⚡ trash all'}
          </button>
        )}
        {decisions.size > 0 && !triaging && (
          <span className="triage-summary">
            {trashIds.length > 0 && onExecuteDecisions && (
              <button className="tb-btn danger triage-exec" onClick={() => onExecuteDecisions('trash', trashIds)}>
                trash {trashIds.length}
              </button>
            )}
            {keepIds.length > 0 && onExecuteDecisions && (
              <button className="tb-btn success triage-exec" onClick={() => onExecuteDecisions('keep', keepIds)}>
                keep {keepIds.length}
              </button>
            )}
            <button className="tb-btn muted triage-exec" onClick={() => setSummaryOpen(o => !o)}>
              {summaryOpen ? 'hide' : 'categories'}
            </button>
          </span>
        )}
      </div>

      {/* Category summary panel */}
      {decisions.size > 0 && !triaging && summaryOpen && categoryRows.length > 0 && (
        <div className="category-panel">
          <div className="category-panel-header">
            <span className="category-panel-title">triage results — {decisions.size} emails</span>
            <span className="category-panel-counts">
              <span className="cp-trash">{trashIds.length} trash</span>
              <span className="cp-keep">{keepIds.length} keep</span>
            </span>
          </div>
          {categoryRows.map(row => {
            const meta = CATEGORY_META[row.category];
            const total = row.trashIds.length + row.keepIds.length + row.reviewIds.length;
            return (
              <div key={row.category} className="category-row">
                <span className="cat-icon">{meta.icon}</span>
                <span className="cat-label">{meta.label}</span>
                <span className="cat-count">{total}</span>
                <span className="cat-breakdown">
                  {row.trashIds.length > 0 && <span className="cb-trash">{row.trashIds.length}🗑</span>}
                  {row.keepIds.length > 0 && <span className="cb-keep">{row.keepIds.length}✓</span>}
                  {row.reviewIds.length > 0 && <span className="cb-review">{row.reviewIds.length}?</span>}
                </span>
                <span className="cat-actions">
                  {row.trashIds.length > 0 && onExecuteDecisions && (
                    <button
                      className="cat-btn cat-btn-trash"
                      onClick={() => onExecuteDecisions('trash', row.trashIds)}
                    >
                      trash
                    </button>
                  )}
                  {row.keepIds.length > 0 && onExecuteDecisions && (
                    <button
                      className="cat-btn cat-btn-keep"
                      onClick={() => onExecuteDecisions('keep', row.keepIds)}
                    >
                      keep
                    </button>
                  )}
                  {(row.trashIds.length > 0 || row.keepIds.length > 0) && onExecuteDecisions && (
                    <button
                      className="cat-btn cat-btn-all"
                      onClick={() => onExecuteDecisions('trash', [...row.trashIds, ...row.reviewIds])}
                      title="Trash everything in this category"
                    >
                      all
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="email-list">
        {emails.length === 0 && <div className="list-empty" />}
        {emails.map((email, i) => {
          const d = decisions.get(email.id);
          const catMeta = d ? CATEGORY_META[d.category ?? 'other'] : null;
          return (
            <div
              key={email.id}
              className={`email-row ${openId === email.id ? 'active' : ''} ${selectedIds.has(email.id) ? 'selected' : ''} ${d ? `triage-${d.decision}` : ''}`}
              onClick={() => onOpen(email.id)}
              style={{ animationDelay: `${Math.min(i * 15, 300)}ms` }}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(email.id)}
                onChange={() => onToggleSelect(email.id)}
                onClick={e => e.stopPropagation()}
              />
              <div className="email-meta">
                <div className="email-from">{email.from}</div>
                <div className="email-subj">{email.subject}</div>
                {d && hoveredDecision === email.id ? (
                  <div className="triage-reason">{d.reason}</div>
                ) : (
                  <div className="email-snippet">{email.snippet}</div>
                )}
              </div>
              <div className="email-right">
                <span className="email-date">{fmtDate(email.date)}</span>
                {d && (
                  <span
                    className={`triage-badge triage-badge-${d.decision}`}
                    title={`${catMeta?.label ?? d.category}: ${d.reason}`}
                    onMouseEnter={() => setHoveredDecision(email.id)}
                    onMouseLeave={() => setHoveredDecision(null)}
                    onClick={e => { e.stopPropagation(); setHoveredDecision(hoveredDecision === email.id ? null : email.id); }}
                  >
                    {catMeta?.icon ?? '?'}
                  </span>
                )}
                {email.labels.includes('CATEGORY_PROMOTIONS') && <span className="tag promo">promo</span>}
                {email.hasUnsub && <span className="tag unsub">unsub</span>}
              </div>
            </div>
          );
        })}
        {nextPageToken && (
          <div className="load-more">
            <button onClick={onLoadMore}>load more</button>
          </div>
        )}
      </div>
    </div>
  );
}
