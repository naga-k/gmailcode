import { useEffect, useRef, useCallback } from 'react';

export type WsNotification =
  | { method: 'stream'; params: { sessionId: string; delta: string } }
  | { method: 'gmail_auth_url'; params: { url: string } };

type PendingRequest = { resolve: (v: any) => void; reject: (e: Error) => void };

export function useWs(onNotification: (n: WsNotification) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<number, PendingRequest>>(new Map());
  const queueRef = useRef<string[]>([]);
  const msgIdRef = useRef(0);
  const onNotifRef = useRef(onNotification);
  onNotifRef.current = onNotification;

  useEffect(() => {
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Flush queued messages
        queueRef.current.forEach(msg => ws.send(msg));
        queueRef.current = [];
      };

      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.method) {
          onNotifRef.current(data as WsNotification);
          return;
        }
        const cb = pendingRef.current.get(data.id);
        if (cb) {
          pendingRef.current.delete(data.id);
          if (data.error) cb.reject(new Error(data.error.message));
          else cb.resolve(data.result);
        }
      };

      ws.onclose = () => setTimeout(connect, 2000);
    }
    connect();
    return () => wsRef.current?.close();
  }, []);

  const rpc = useCallback(<T = any>(method: string, params?: unknown): Promise<T> => {
    return new Promise((resolve, reject) => {
      const id = ++msgIdRef.current;
      pendingRef.current.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, method, params });
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      } else {
        queueRef.current.push(msg);
      }
    });
  }, []);

  return { rpc };
}
