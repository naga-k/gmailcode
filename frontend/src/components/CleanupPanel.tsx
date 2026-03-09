import { useState } from 'react';

export interface TriageResult {
  trash: Array<{ id: string; from: string; subject: string; reason: string }>;
  keep: Array<{ id: string; from: string; subject: string; reason: string }>;
  review: Array<{ id: string; from: string; subject: string; reason: string }>;
}

interface Props {
  onScan: (category: string) => Promise<TriageResult>;
  onExecute: (action: 'trash' | 'keep', ids: string[]) => Promise<void>;
}

export function CleanupPanel({ onScan, onExecute }: Props) {
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<TriageResult | null>(null);
  const [executing, setExecuting] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('spam');
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  const handleScan = async () => {
    setScanning(true);
    try {
      const result = await onScan(selectedCategory);
      setResults(result);
      setLastScan(new Date());
    } finally {
      setScanning(false);
    }
  };

  const handleExecuteTrash = async () => {
    if (!results) return;
    setExecuting('trash');
    try {
      await onExecute('trash', results.trash.map(e => e.id));
      setResults(null);
    } finally {
      setExecuting(null);
    }
  };

  const handleExecuteKeep = async () => {
    if (!results) return;
    setExecuting('keep');
    try {
      await onExecute('keep', results.keep.map(e => e.id));
      setResults(null);
    } finally {
      setExecuting(null);
    }
  };

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  return (
    <div className="cleanup-panel">
      {/* Header with glow effect */}
      <div className="cleanup-header">
        <div className="header-badge">triage control center</div>
        <h2>Inbox Cleanup</h2>
        <p>AI-powered email analysis & bulk actions</p>
      </div>

      {/* Control Section */}
      <div className="cleanup-controls">
        <div className="category-selector">
          <span className="selector-label">target:</span>
          <div className="category-tabs">
            {['spam', 'promotions'].map(cat => (
              <button
                key={cat}
                className={`category-tab ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => !scanning && setSelectedCategory(cat)}
                disabled={scanning}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <button
          className={`scan-trigger ${scanning ? 'scanning' : ''}`}
          onClick={handleScan}
          disabled={scanning}
        >
          <span className="scan-icon">{scanning ? '⊙' : '▶'}</span>
          <span>{scanning ? 'analyzing...' : 'start analysis'}</span>
        </button>

        {lastScan && (
          <div className="scan-meta">
            last scan: {lastScan.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>

      {/* Results Dashboard */}
      {results && (
        <div className="cleanup-results">
          <div className="status-grid">
            {/* Trash Card */}
            <div className="status-card trash-card">
              <div className="card-shine" />
              <div className="card-content">
                <div className="card-icon">🗑️</div>
                <div className="card-stat">{results.trash.length}</div>
                <div className="card-label">ready to trash</div>
                <button
                  className="action-button danger-btn"
                  onClick={handleExecuteTrash}
                  disabled={!!executing}
                >
                  {executing === 'trash' ? (
                    <>
                      <span className="spinner" />
                      deleting
                    </>
                  ) : (
                    <>
                      <span className="btn-icon">→</span>
                      execute
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Keep Card */}
            <div className="status-card keep-card">
              <div className="card-shine" />
              <div className="card-content">
                <div className="card-icon">✓</div>
                <div className="card-stat">{results.keep.length}</div>
                <div className="card-label">rescue to inbox</div>
                <button
                  className="action-button keep-btn"
                  onClick={handleExecuteKeep}
                  disabled={!!executing}
                >
                  {executing === 'keep' ? (
                    <>
                      <span className="spinner" />
                      restoring
                    </>
                  ) : (
                    <>
                      <span className="btn-icon">↑</span>
                      restore
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Review Card */}
            <div className="status-card review-card">
              <div className="card-shine" />
              <div className="card-content">
                <div className="card-icon">?</div>
                <div className="card-stat">{results.review.length}</div>
                <div className="card-label">needs decision</div>
                <button
                  className="action-button review-btn"
                  onClick={() => toggleSection('review')}
                >
                  <span className="btn-icon">·</span>
                  details
                </button>
              </div>
            </div>
          </div>

          {/* Detailed Listings */}
          <div className="details-container">
            {results.trash.length > 0 && (
              <div className="details-panel">
                <div
                  className="panel-header"
                  onClick={() => toggleSection('trash')}
                >
                  <span className="toggle-icon">
                    {expandedSection === 'trash' ? '▼' : '▶'}
                  </span>
                  <h3>trash queue</h3>
                  <span className="count">{results.trash.length}</span>
                </div>
                {expandedSection === 'trash' && (
                  <div className="panel-content">
                    {results.trash.map(e => (
                      <div key={e.id} className="email-entry">
                        <div className="entry-from">{e.from}</div>
                        <div className="entry-subject">{e.subject}</div>
                        <div className="entry-reason">{e.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {results.keep.length > 0 && (
              <div className="details-panel">
                <div
                  className="panel-header"
                  onClick={() => toggleSection('keep')}
                >
                  <span className="toggle-icon">
                    {expandedSection === 'keep' ? '▼' : '▶'}
                  </span>
                  <h3>rescue queue</h3>
                  <span className="count">{results.keep.length}</span>
                </div>
                {expandedSection === 'keep' && (
                  <div className="panel-content">
                    {results.keep.map(e => (
                      <div key={e.id} className="email-entry">
                        <div className="entry-from">{e.from}</div>
                        <div className="entry-subject">{e.subject}</div>
                        <div className="entry-reason">{e.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {results.review.length > 0 && (
              <div className="details-panel">
                <div
                  className="panel-header"
                  onClick={() => toggleSection('review')}
                >
                  <span className="toggle-icon">
                    {expandedSection === 'review' ? '▼' : '▶'}
                  </span>
                  <h3>review queue</h3>
                  <span className="count">{results.review.length}</span>
                </div>
                {expandedSection === 'review' && (
                  <div className="panel-content">
                    {results.review.map(e => (
                      <div key={e.id} className="email-entry">
                        <div className="entry-from">{e.from}</div>
                        <div className="entry-subject">{e.subject}</div>
                        <div className="entry-reason">{e.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Empty State - Landing Pad */}
      {!results && !scanning && (
        <div className="cleanup-empty">
          <div className="empty-visual">
            <div className="empty-grid" />
            <div className="empty-icon">⟿</div>
          </div>
          <h3>awaiting analysis</h3>
          <p>select a category and initiate scan</p>
        </div>
      )}
    </div>
  );
}
