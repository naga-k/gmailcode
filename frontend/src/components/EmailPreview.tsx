import { useRef, useEffect } from 'react';
import type { EmailFull } from '../types';

interface Props {
  email: EmailFull | null;
  onTrash: () => void;
  onSearchSender: (email: string) => void;
}

function extractUnsubUrl(header: string): string | null {
  const urlMatch = header.match(/<(https?:[^>]+)>/);
  if (urlMatch) return urlMatch[1];
  return null;
}

function HtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument;
    if (!doc) return;

    // Inject HTML with dark theme styles and link target override
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
<base target="_blank" />
<style>
  body {
    margin: 0;
    padding: 16px;
    background: #0c0e14;
    color: #d6daf0;
    font-family: 'Outfit', -apple-system, sans-serif;
    font-size: 13.5px;
    line-height: 1.7;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  a { color: #00e5ff; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100% !important; }
  pre, code { white-space: pre-wrap; word-wrap: break-word; }
  * { max-width: 100% !important; box-sizing: border-box; }
</style>
</head>
<body>${html}</body>
</html>`);
    doc.close();

    // Auto-resize iframe to content height
    const resize = () => {
      if (iframe.contentDocument?.body) {
        iframe.style.height = iframe.contentDocument.body.scrollHeight + 32 + 'px';
      }
    };
    resize();
    // Resize after images load
    const observer = new MutationObserver(resize);
    if (iframe.contentDocument?.body) {
      observer.observe(iframe.contentDocument.body, { childList: true, subtree: true });
    }
    iframe.contentWindow?.addEventListener('load', resize);
    // Fallback resize after a delay for slow-loading content
    const timer = setTimeout(resize, 500);

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [html]);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin allow-popups"
      style={{
        width: '100%',
        border: 'none',
        minHeight: '200px',
        background: '#0c0e14',
        borderRadius: '6px',
      }}
      title="Email content"
    />
  );
}

export function EmailPreview({ email, onTrash, onSearchSender }: Props) {
  if (!email) {
    return (
      <div className="preview-empty">
        <div className="empty-icon">&gt;_</div>
        <div>select an email to read</div>
      </div>
    );
  }

  const unsubUrl = email.unsubHeader ? extractUnsubUrl(email.unsubHeader) : null;

  return (
    <div className="email-view">
      <div className="email-header">
        <h2>{email.subject}</h2>
        <div className="email-meta-row"><strong>from</strong> {email.from}</div>
        <div className="email-meta-row"><strong>to</strong> {email.to}</div>
        <div className="email-meta-row"><strong>date</strong> {email.date}</div>
        <div className="email-actions">
          <button className="tb-btn danger" onClick={onTrash}>trash</button>
          <button className="tb-btn" onClick={() => onSearchSender(email.from)}>from sender</button>
          {unsubUrl && (
            <a className="tb-btn" href={unsubUrl} target="_blank" rel="noreferrer">
              unsubscribe
            </a>
          )}
        </div>
      </div>
      {email.bodyHtml ? (
        <HtmlBody html={email.bodyHtml} />
      ) : (
        <div className="email-body">{email.body}</div>
      )}
    </div>
  );
}
