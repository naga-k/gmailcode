import { useState, useCallback, useRef, useEffect } from 'react';
import { useWs } from './hooks/useWs';
import type { WsNotification } from './hooks/useWs';
import { Sidebar } from './components/Sidebar';
import { EmailList } from './components/EmailList';
import { EmailPreview } from './components/EmailPreview';
import { ChatPanel } from './components/ChatPanel';
import type { EmailSummary, EmailFull, LabelCounts, ChatMessage, TriageDecision, TriageCategory } from './types';
import './App.css';

type Tab = 'email' | 'chat';

export default function App() {
  const [account, setAccount] = useState('connecting...');
  const [labels, setLabels] = useState<LabelCounts>({});
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [openEmail, setOpenEmail] = useState<EmailFull | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentQuery, setCurrentQuery] = useState('in:inbox');
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('email');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState('');
  const [triageResults, setTriageResults] = useState<Map<string, TriageDecision>>(new Map());
  const [triaging, setTriaging] = useState(false);
  const [triageProgress, setTriageProgress] = useState<{ done: number; total: number } | null>(null);
  const [trashingAll, setTrashingAll] = useState(false);
  const [trashAllFound, setTrashAllFound] = useState(0);
  const streamingIndexRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const onNotification = useCallback((n: WsNotification) => {
    if (n.method === 'gmail_auth_url') {
      setAuthUrl(n.params.url);
    } else if (n.method === 'triage_progress') {
      setTriageProgress({ done: n.params.done as number, total: n.params.total as number });
    } else if (n.method === 'trash_query_progress') {
      setTrashAllFound(n.params.found as number);
    } else if (n.method === 'stream') {
      setChatMessages(prev => {
        const idx = streamingIndexRef.current;
        if (idx === null) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], text: updated[idx].text + n.params.delta };
        return updated;
      });
    }
  }, []);

  const { rpc } = useWs(onNotification);

  useEffect(() => {
    rpc('gmail_login').then((r: any) => {
      setAccount(r.email);
      loadLabels();
      loadEmails('in:inbox');
    }).catch(() => {});
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+K focuses search
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function loadLabels() {
    const res = await rpc<{ labels: LabelCounts }>('gmail_labels');
    setLabels(res.labels);
  }

  async function loadEmails(query: string, pageToken?: string) {
    if (!pageToken) { setEmails([]); setSelectedIds(new Set()); setNextPageToken(null); }
    const res = await rpc<{ messages: EmailSummary[]; nextPageToken: string | null }>(
      'gmail_emails', { query, pageToken, maxResults: 50 }
    );
    setEmails(prev => pageToken ? [...prev, ...res.messages] : res.messages);
    setNextPageToken(res.nextPageToken);
  }

  async function openEmailById(id: string) {
    setTab('email');
    const email = await rpc<EmailFull>('gmail_email', { id });
    setOpenEmail(email);
  }

  async function trashSelected() {
    const ids = [...selectedIds];
    await rpc('gmail_trash', { ids });
    setEmails(prev => prev.filter(e => !ids.includes(e.id)));
    setSelectedIds(new Set());
    loadLabels();
  }

  async function trashOpen() {
    if (!openEmail) return;
    await rpc('gmail_trash', { ids: [openEmail.id] });
    setEmails(prev => prev.filter(e => e.id !== openEmail.id));
    setOpenEmail(null);
    loadLabels();
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(emails.map(e => e.id)) : new Set());
  }

  async function sendChat(text: string) {
    let streamIdx = 0;
    setChatMessages(prev => {
      streamIdx = prev.length + 1;
      streamingIndexRef.current = streamIdx;
      return [...prev, { role: 'user', text }, { role: 'assistant', text: '', streaming: true }];
    });
    try {
      const res = await rpc<{ text: string }>('chat', { message: text });
      setChatMessages(prev => {
        const u = [...prev];
        u[streamIdx] = { role: 'assistant', text: res.text };
        streamingIndexRef.current = null;
        return u;
      });
    } catch (err: any) {
      setChatMessages(prev => {
        const u = [...prev];
        u[streamIdx] = { role: 'assistant', text: `Error: ${err.message}` };
        streamingIndexRef.current = null;
        return u;
      });
    }
  }

  async function submitAuthCode() {
    await rpc('gmail_auth_code', { code: authCode });
    setAuthUrl(null);
    const r = await rpc<{ email: string }>('gmail_login');
    setAccount(r.email);
    loadLabels();
    loadEmails(currentQuery);
  }

  async function trashAllMatching(query: string) {
    setTrashingAll(true);
    setTrashAllFound(0);
    try {
      const res = await rpc<{ trashed: number }>('gmail_trash_query', { query });
      setEmails([]);
      setSelectedIds(new Set());
      loadLabels();
      setTrashAllFound(res.trashed);
    } finally {
      setTrashingAll(false);
    }
  }

  async function runTriage(query: string) {
    setTriaging(true);
    setTriageProgress(null);
    setTriageResults(new Map());
    try {
      const res = await rpc<{
        trash: Array<{ id: string; from: string; subject: string; reason: string; category: TriageCategory }>;
        keep: Array<{ id: string; from: string; subject: string; reason: string; category: TriageCategory }>;
        review: Array<{ id: string; from: string; subject: string; reason: string; category: TriageCategory }>;
      }>('triage_emails', { query });
      const map = new Map<string, TriageDecision>();
      for (const e of res.trash) map.set(e.id, { decision: 'trash', category: e.category ?? 'other', reason: e.reason, from: e.from, subject: e.subject });
      for (const e of res.keep) map.set(e.id, { decision: 'keep', category: e.category ?? 'other', reason: e.reason, from: e.from, subject: e.subject });
      for (const e of res.review) map.set(e.id, { decision: 'review', category: e.category ?? 'other', reason: e.reason, from: e.from, subject: e.subject });
      setTriageResults(map);
    } finally {
      setTriaging(false);
      setTriageProgress(null);
    }
  }

  async function executeDecisions(action: 'trash' | 'keep', ids: string[]) {
    await rpc('cleanup_execute', { action, ids });
    setTriageResults(prev => { const m = new Map(prev); ids.forEach(id => m.delete(id)); return m; });
    setEmails(prev => action === 'trash' ? prev.filter(e => !ids.includes(e.id)) : prev);
    loadLabels();
  }

  const inboxCount = labels['INBOX']?.total ?? 0;
  const unreadCount = labels['UNREAD']?.unread ?? labels['INBOX']?.unread ?? 0;

  return (
    <div className="app">
      {authUrl && (
        <div className="auth-overlay">
          <div className="auth-box">
            <h2>&gt; connect gmail</h2>
            <p>Open this link in your browser, then paste the authorization code below.</p>
            <a href={authUrl} target="_blank" rel="noreferrer" className="auth-url">{authUrl}</a>
            <input className="auth-input" placeholder="paste authorization code..." value={authCode} onChange={e => setAuthCode(e.target.value)} />
            <button className="auth-submit" onClick={submitAuthCode}>CONNECT</button>
          </div>
        </div>
      )}

      <header className="topbar">
        <span className="logo">gmailcode</span>
        <input
          ref={searchRef}
          className="search"
          placeholder="search emails... (gmail query syntax)"
          onChange={e => { const q = e.target.value.trim() || 'in:inbox'; setCurrentQuery(q); loadEmails(q); }}
        />
        <span className="kbd-hint">{navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+K</span>
        <div className="account"><span className="dot" />{account}</div>
      </header>

      <div className="main">
        <Sidebar labels={labels} currentQuery={currentQuery} onSelect={q => { setCurrentQuery(q); loadEmails(q); }} />
        <EmailList emails={emails} selectedIds={selectedIds} openId={openEmail?.id ?? null} nextPageToken={nextPageToken}
          onOpen={openEmailById} onToggleSelect={toggleSelect} onToggleAll={toggleAll}
          onTrashSelected={trashSelected} onRefresh={() => { loadEmails(currentQuery); loadLabels(); }}
          onLoadMore={() => loadEmails(currentQuery, nextPageToken!)}
          decisions={triageResults} triaging={triaging} triageProgress={triageProgress}
          onTriage={() => runTriage(currentQuery)}
          onExecuteDecisions={executeDecisions}
          trashingAll={trashingAll} trashAllFound={trashAllFound}
          onTrashAll={() => trashAllMatching(currentQuery)} />
        <div className="preview-panel">
          <div className="preview-tabs">
            <button className={`tab ${tab === 'email' ? 'active' : ''}`} onClick={() => setTab('email')}>
              mail
            </button>
            <button className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
              claude
            </button>
          </div>
          <div className={`preview-content ${tab !== 'email' ? 'hidden' : ''}`}>
            <EmailPreview email={openEmail} onTrash={trashOpen} onSearchSender={(from) => {
              const match = from.match(/<([^>]+)>/);
              const addr = match ? match[1] : from;
              const domain = addr.split('@')[1];
              const q = `from:${domain}`;
              setCurrentQuery(q);
              loadEmails(q);
            }} />
          </div>
          {tab === 'chat' && <ChatPanel messages={chatMessages} onSend={sendChat} />}
        </div>
      </div>

      <div className="statusbar">
        <span className="statusbar-item">
          <span className="statusbar-accent">ws</span> connected
        </span>
        <span className="statusbar-item">
          query: <span className="statusbar-accent">{currentQuery}</span>
        </span>
        <span className="statusbar-item">
          {emails.length} loaded
        </span>
        <div className="statusbar-right">
          <span className="statusbar-item">
            inbox: <span className="statusbar-accent">{inboxCount}</span>
          </span>
          {unreadCount > 0 && (
            <span className="statusbar-item">
              unread: <span className="statusbar-accent">{unreadCount}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
