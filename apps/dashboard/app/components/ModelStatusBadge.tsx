"use client";

import { useEffect, useState } from "react";

import { CORE_URL } from "@/app/lib/clientEnv";

const POLL_MS = 4000;

// Mirrors the core /status contract:
//   { ok, model: { id, state, target, ramHeadroomGB, fallbackActive } }
// state ∈ unloaded | loading | ready | generating | error
type ModelState =
  | "unloaded"
  | "loading"
  | "ready"
  | "generating"
  | "error"
  | "unreachable";

interface StatusResponse {
  ok: boolean;
  model: {
    id: string;
    state: ModelState;
    target?: string;
    ramHeadroomGB?: number;
    fallbackActive?: boolean;
  };
}

const LABELS: Record<ModelState, string> = {
  unloaded: "standby",
  loading: "waking up…",
  ready: "online",
  generating: "processing…",
  error: "model fault",
  unreachable: "core offline",
};

export default function ModelStatusBadge() {
  const [state, setState] = useState<ModelState>("unreachable");
  const [modelId, setModelId] = useState<string>("");
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(`${CORE_URL}/status`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as StatusResponse;
        if (cancelled) return;
        setState(json.model?.state ?? "error");
        setModelId(json.model?.id ?? "");
        setFallback(Boolean(json.model?.fallbackActive));
      } catch {
        if (!cancelled) setState("unreachable");
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const label = LABELS[state] ?? state;
  // Long repo ids ("mlx-community/Qwen3-4B-…") → short model name for the chip.
  const shortId = modelId.split("/").pop() ?? "";

  return (
    <span className="badge" title={modelId ? `model: ${modelId}` : undefined}>
      <span className={`badge__dot badge__dot--${state}`} />
      {label}
      {fallback ? " · cloud" : ""}
      {shortId && state !== "unreachable" ? ` · ${shortId}` : ""}
    </span>
  );
}
