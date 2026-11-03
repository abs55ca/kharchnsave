"use client";

import { useEffect, useRef } from "react";

/*
 * Cloudflare Turnstile, rendered explicitly so the token can be bound to the
 * current checkout key (cData) and reset when the server asks for a new
 * check. Script URL and options per
 * https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/.
 */

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load")));
    script.onerror = () => {
      loading = null;
      reject(new Error("Turnstile didn't load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function TurnstileWidget({
  siteKey,
  cData,
  resetSignal,
  onToken,
  onUnavailable,
}: {
  siteKey: string;
  cData: string;
  /** Change this number to ask for a fresh check. */
  resetSignal: number;
  onToken: (token: string | null) => void;
  onUnavailable: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const callbacks = useRef({ onToken, onUnavailable });
  useEffect(() => {
    callbacks.current = { onToken, onUnavailable };
  });

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId.current = turnstile.render(container.current, {
          sitekey: siteKey,
          action: "place_order",
          cData,
          "refresh-expired": "auto",
          callback: (token: string) => callbacks.current.onToken(token),
          "expired-callback": () => callbacks.current.onToken(null),
          "timeout-callback": () => callbacks.current.onToken(null),
          "error-callback": () => {
            callbacks.current.onToken(null);
            return false;
          },
        });
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onUnavailable();
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, cData]);

  useEffect(() => {
    if (resetSignal > 0 && widgetId.current && window.turnstile) {
      callbacks.current.onToken(null);
      window.turnstile.reset(widgetId.current);
    }
  }, [resetSignal]);

  return <div ref={container} className="min-h-[65px]" />;
}
