import type { LabelCounts } from '../types';

const CATEGORIES = [
  { query: 'in:inbox', label: 'All Mail', icon: '\u25B8', countKey: 'INBOX' },
  { query: 'category:promotions', label: 'Promotions', dot: '#e879f9', countKey: 'CATEGORY_PROMOTIONS' },
  { query: 'category:updates', label: 'Updates', dot: '#34d399', countKey: 'CATEGORY_UPDATES' },
  { query: 'category:social', label: 'Social', dot: '#fb923c', countKey: 'CATEGORY_SOCIAL' },
  { query: 'category:forums', label: 'Forums', icon: '#', countKey: 'CATEGORY_FORUMS' },
];

const OTHER = [
  { query: 'in:spam', label: 'Spam', icon: '!', countKey: 'SPAM' },
  { query: 'in:trash', label: 'Trash', icon: '\u00D7', countKey: 'TRASH' },
];

function fmt(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

interface Props {
  labels: LabelCounts;
  currentQuery: string;
  onSelect: (query: string) => void;
}

export function Sidebar({ labels, currentQuery, onSelect }: Props) {
  return (
    <div className="sidebar">
      <nav className="nav-section">
        <div className="nav-label">Inbox</div>
        {CATEGORIES.map((c) => (
          <button
            key={c.query}
            className={`nav-item ${currentQuery === c.query ? 'active' : ''}`}
            onClick={() => onSelect(c.query)}
          >
            {c.icon ? (
              <span className="icon" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{c.icon}</span>
            ) : (
              <span className="cat-dot" style={{ background: c.dot }} />
            )}
            <span>{c.label}</span>
            <span className="count">{labels[c.countKey] ? fmt(labels[c.countKey].total) : '\u2014'}</span>
          </button>
        ))}
      </nav>
      <nav className="nav-section">
        <div className="nav-label">Other</div>
        {OTHER.map((c) => (
          <button
            key={c.query}
            className={`nav-item ${currentQuery === c.query ? 'active' : ''}`}
            onClick={() => onSelect(c.query)}
          >
            <span className="icon" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{c.icon}</span>
            <span>{c.label}</span>
            <span className="count">{labels[c.countKey] ? fmt(labels[c.countKey].total) : '\u2014'}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
