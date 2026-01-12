import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

import { useSession } from '../session/SessionContext';

export type RealtimeEvents =
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'qr'
  | 'ready'
  | 'disconnected'
  | 'message'
  | 'message_ack'
  | 'message_revoked'
  | 'media_downloaded'
  | 'chat_updated'
  | 'sync_chats_indexed'
  | 'sync_progress'
  | 'sync_complete';

type Listener = (payload: any) => void;

export type RealtimeApi = {
  connected: boolean;
  subscribe: (event: RealtimeEvents, listener: Listener) => () => void;
};

const RealtimeContext = createContext<RealtimeApi | null>(null);

function computeSocketTarget(baseUrl: string) {
  const u = new URL(baseUrl);
  const pathBase = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  const origin = u.origin;
  const path = `${pathBase || ''}/socket.io/`;
  return { origin, path };
}

export function RealtimeProvider(props: { children: ReactNode }) {
  const session = useSession();
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<RealtimeEvents, Set<Listener>>>(new Map());
  const socketRef = useRef<Socket | null>(null);

  const subscribe = useMemo<RealtimeApi['subscribe']>(() => {
    return (event, listener) => {
      const map = listenersRef.current;
      const set = map.get(event) || new Set<Listener>();
      set.add(listener);
      map.set(event, set);
      return () => {
        const current = map.get(event);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) map.delete(event);
      };
    };
  }, []);

  useEffect(() => {
    if (session.status !== 'signedIn') return;
    if (!session.tokens?.accessToken) return;

    const { origin, path } = computeSocketTarget(session.baseUrl);
    const socket = io(origin, {
      path,
      transports: ['websocket'],
      auth: {
        token: session.tokens.accessToken,
        accountId: session.accountId || undefined,
      },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10_000,
    });
    socketRef.current = socket;

    const emitToListeners = (event: RealtimeEvents, payload: any) => {
      const set = listenersRef.current.get(event);
      if (!set || set.size === 0) return;
      for (const listener of Array.from(set)) {
        try {
          listener(payload);
        } catch {}
      }
    };

    socket.on('connect', () => {
      setConnected(true);
      emitToListeners('connect', null);
    });
    socket.on('disconnect', () => {
      setConnected(false);
      emitToListeners('disconnect', null);
    });

    const forward = (event: RealtimeEvents) => socket.on(event, (payload: any) => emitToListeners(event, payload));
    forward('status');
    forward('qr');
    forward('ready');
    forward('disconnected');
    forward('message');
    forward('message_ack');
    forward('message_revoked');
    forward('media_downloaded');
    forward('chat_updated');
    forward('sync_chats_indexed');
    forward('sync_progress');
    forward('sync_complete');

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (!socket.connected) socket.connect();
      } else {
        socket.disconnect();
      }
    });

    return () => {
      try {
        sub.remove();
      } catch {}
      try {
        socket.disconnect();
      } catch {}
      socketRef.current = null;
      setConnected(false);
    };
  }, [session.accountId, session.baseUrl, session.status, session.tokens?.accessToken]);

  const value = useMemo<RealtimeApi>(() => ({ connected, subscribe }), [connected, subscribe]);
  return <RealtimeContext.Provider value={value}>{props.children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used within RealtimeProvider');
  return ctx;
}

