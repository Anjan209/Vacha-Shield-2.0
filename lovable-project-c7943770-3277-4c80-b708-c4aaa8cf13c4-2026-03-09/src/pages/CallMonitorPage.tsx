import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowLeft,
  Clock3,
  Radio,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Waves,
  Zap,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type AnalysisResult = {
  synthetic_probability: number;
  human_probability: number;
  alert: boolean;
  threshold: number;
  model_probability?: number;
  artifact_probability?: number;
  chunk_count?: number;
};

type ThreatLevel = "idle" | "safe" | "warning" | "alert";

type MonitorQueueItem = {
  id: number;
  blob: Blob;
  capturedAt: number;
  mimeType: string;
};

const MONITOR_WINDOW_MS = 4000;
const MAX_MONITOR_HISTORY = 18;
const MAX_MONITOR_QUEUE = 2;
const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm"];

const threatCopy: Record<ThreatLevel, { label: string; detail: string }> = {
  idle: {
    label: "Shield idle",
    detail: "Arm the monitor when you start a call or suspect a live voice scam.",
  },
  safe: {
    label: "Shield stable",
    detail: "Recent windows look organic. The monitor is still checking the newest speech every few seconds.",
  },
  warning: {
    label: "Shield cautious",
    detail: "Some windows are borderline. Stay alert and keep listening for verification cues.",
  },
  alert: {
    label: "High alert",
    detail: "The live stream is showing strong synthetic markers. Treat the caller as suspicious until verified.",
  },
};

const selectRecorderMimeType = () => {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  const supported = RECORDER_MIME_CANDIDATES.find((candidate) => {
    if (typeof MediaRecorder.isTypeSupported !== "function") {
      return candidate === "audio/webm";
    }
    return MediaRecorder.isTypeSupported(candidate);
  });

  if (!supported) {
    throw new Error("This browser does not support live audio capture in a backend-compatible format.");
  }

  return supported;
};

const normalizeAnalysisResult = (data: any): AnalysisResult => {
  const synthetic = Number(data.synthetic_probability ?? data.fake_probability ?? data.probability ?? 0);
  const threshold = Number(data.threshold ?? 0.5);
  const human = Number(data.human_probability ?? 1 - synthetic);

  return {
    synthetic_probability: Number.isFinite(synthetic) ? synthetic : 0,
    human_probability: Number.isFinite(human) ? human : 0,
    alert: Boolean(data.alert ?? synthetic > threshold),
    threshold: Number.isFinite(threshold) ? threshold : 0.5,
    model_probability: Number.isFinite(data?.model_probability) ? Number(data.model_probability) : undefined,
    artifact_probability: Number.isFinite(data?.artifact_probability) ? Number(data.artifact_probability) : undefined,
    chunk_count: Number.isFinite(data?.chunk_count) ? Number(data.chunk_count) : undefined,
  };
};

const getThreatLevel = (analysis: AnalysisResult | null, liveFeedActive: boolean): ThreatLevel => {
  if (!analysis) {
    return liveFeedActive ? "safe" : "idle";
  }
  if (analysis.alert || analysis.synthetic_probability >= 0.68) {
    return "alert";
  }
  if (analysis.synthetic_probability >= 0.45) {
    return "warning";
  }
  return "safe";
};

const formatLatency = (value: number | null) => (value == null ? "--" : `${Math.round(value)} ms`);

const formatRelativeTimestamp = (timestamp: number | null) => {
  if (!timestamp) {
    return "Waiting";
  }

  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 2) {
    return "Just now";
  }
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }

  return `${Math.round(deltaSeconds / 60)}m ago`;
};

const Tile = ({ label, value, hint }: { label: string; value: string; hint: string }) => (
  <div className="rounded-3xl border border-white/10 bg-black/12 p-5">
    <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">{label}</p>
    <p className="mt-2 font-display text-3xl font-bold">{value}</p>
    <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
  </div>
);

const ScoreRail = ({ label, value, accentClass }: { label: string; value: number; accentClass: string }) => (
  <div>
    <div className="mb-3 flex items-end justify-between gap-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">{label}</p>
      <span className={`font-mono text-2xl font-bold ${accentClass}`}>{(value * 100).toFixed(1)}%</span>
    </div>
    <div className="h-3 overflow-hidden rounded-full bg-muted">
      <motion.div
        className={`h-full rounded-full ${accentClass === "text-destructive" ? "bg-gradient-to-r from-destructive to-[#ff9c7e]" : "bg-gradient-to-r from-safe to-[#b6ffd1]"} progress-shimmer`}
        initial={{ width: 0 }}
        animate={{ width: `${Math.max(0, Math.min(value * 100, 100))}%` }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      />
    </div>
  </div>
);

const CallMonitorPage = () => {
  const { toast } = useToast();

  const [isMonitorStarting, setIsMonitorStarting] = useState(false);
  const [isMonitorActive, setIsMonitorActive] = useState(false);
  const [monitorThreatLevel, setMonitorThreatLevel] = useState<ThreatLevel>("idle");
  const [monitorMessage, setMonitorMessage] = useState(threatCopy.idle.detail);
  const [monitorLatencyMs, setMonitorLatencyMs] = useState<number | null>(null);
  const [lastMonitorScanAt, setLastMonitorScanAt] = useState<number | null>(null);
  const [monitorWindowCount, setMonitorWindowCount] = useState(0);
  const [monitorAlertCount, setMonitorAlertCount] = useState(0);
  const [monitorQueueDepth, setMonitorQueueDepth] = useState(0);
  const [latestLiveResult, setLatestLiveResult] = useState<AnalysisResult | null>(null);
  const [monitorHistory, setMonitorHistory] = useState<number[]>([]);

  const monitorStreamRef = useRef<MediaStream | null>(null);
  const monitorRecorderRef = useRef<MediaRecorder | null>(null);
  const monitorAbortControllerRef = useRef<AbortController | null>(null);
  const monitorQueueRef = useRef<MonitorQueueItem[]>([]);
  const monitorProcessingRef = useRef(false);
  const monitorEnabledRef = useRef(false);
  const monitorSequenceRef = useRef(0);

  const backendUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
  const resolveBackendUrl = useCallback(() => {
    if (backendUrl) {
      return backendUrl;
    }

    const host = window.location.hostname;
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    if (isLocalHost && window.location.port !== "5000") {
      return "http://127.0.0.1:5000";
    }

    return "";
  }, [backendUrl]);

  const rollingThreatProbability = useMemo(() => {
    if (!monitorHistory.length) {
      return 0;
    }
    return monitorHistory.reduce((sum, item) => sum + item, 0) / monitorHistory.length;
  }, [monitorHistory]);

  const processMonitorQueue = useCallback(async () => {
    if (monitorProcessingRef.current || !monitorEnabledRef.current) {
      return;
    }

    const nextChunk = monitorQueueRef.current.shift();
    setMonitorQueueDepth(monitorQueueRef.current.length);
    if (!nextChunk) {
      return;
    }

    monitorProcessingRef.current = true;
    const controller = new AbortController();
    monitorAbortControllerRef.current = controller;

    try {
      const formData = new FormData();
      formData.append(
        "file",
        new File([nextChunk.blob], `live_window_${nextChunk.id}.webm`, {
          type: nextChunk.mimeType,
        })
      );
      formData.append("analysis_profile", "strict");
      formData.append("chunk_seconds", "0.9");
      formData.append("hop_seconds", "0.35");

      const response = await fetch(`${resolveBackendUrl()}/detect_voice`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const data = await response.json();
      const normalized = normalizeAnalysisResult(data);
      const nextThreatLevel = getThreatLevel(normalized, true);

      setLatestLiveResult(normalized);
      setMonitorThreatLevel(nextThreatLevel);
      setMonitorMessage(threatCopy[nextThreatLevel].detail);
      setMonitorLatencyMs(performance.now() - nextChunk.capturedAt);
      setLastMonitorScanAt(Date.now());
      setMonitorWindowCount((count) => count + 1);
      setMonitorHistory((history) => [...history.slice(-(MAX_MONITOR_HISTORY - 1)), normalized.synthetic_probability]);
      if (normalized.alert) {
        setMonitorAlertCount((count) => count + 1);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      setMonitorThreatLevel("warning");
      setMonitorMessage("A live window missed analysis. The next chunk will retry automatically.");
      toast({
        title: "Monitor window failed",
        description: error instanceof Error ? error.message : "The backend did not return a live verdict.",
        variant: "destructive",
      });
    } finally {
      monitorProcessingRef.current = false;
      monitorAbortControllerRef.current = null;
      if (monitorQueueRef.current.length && monitorEnabledRef.current) {
        void processMonitorQueue();
      }
    }
  }, [resolveBackendUrl, toast]);

  const stopMonitor = useCallback(
    (resetHistory = false) => {
      monitorEnabledRef.current = false;
      monitorAbortControllerRef.current?.abort();
      monitorAbortControllerRef.current = null;

      const recorder = monitorRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      monitorRecorderRef.current = null;

      monitorStreamRef.current?.getTracks().forEach((track) => track.stop());
      monitorStreamRef.current = null;

      monitorQueueRef.current = [];
      monitorProcessingRef.current = false;
      setMonitorQueueDepth(0);
      setIsMonitorActive(false);
      setIsMonitorStarting(false);
      setMonitorThreatLevel(resetHistory ? "idle" : latestLiveResult ? getThreatLevel(latestLiveResult, false) : "idle");
      setMonitorMessage(resetHistory ? threatCopy.idle.detail : "Monitor paused. The last verdict is still visible for review.");

      if (resetHistory) {
        setLatestLiveResult(null);
        setMonitorHistory([]);
        setMonitorWindowCount(0);
        setMonitorAlertCount(0);
        setMonitorLatencyMs(null);
        setLastMonitorScanAt(null);
      }
    },
    [latestLiveResult]
  );

  const startMonitor = useCallback(async () => {
    setIsMonitorStarting(true);
    setMonitorMessage("Arming the guardian. Waiting for microphone access and the first rolling window.");
    setMonitorWindowCount(0);
    setMonitorAlertCount(0);
    setMonitorQueueDepth(0);
    setMonitorLatencyMs(null);
    setLastMonitorScanAt(null);
    setLatestLiveResult(null);
    setMonitorHistory([]);

    try {
      const mimeType = selectRecorderMimeType();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      recorder.ondataavailable = (event) => {
        if (!monitorEnabledRef.current || event.data.size < 2048) {
          return;
        }

        const queueItem: MonitorQueueItem = {
          id: ++monitorSequenceRef.current,
          blob: event.data,
          capturedAt: performance.now(),
          mimeType: recorder.mimeType || mimeType,
        };

        let nextQueue = [...monitorQueueRef.current, queueItem];
        if (nextQueue.length > MAX_MONITOR_QUEUE) {
          nextQueue = nextQueue.slice(-MAX_MONITOR_QUEUE);
          setMonitorMessage("Skipping stale windows to keep the live verdict current.");
        } else {
          setMonitorMessage("Live feed active. The newest speech window is being analyzed.");
        }

        monitorQueueRef.current = nextQueue;
        setMonitorQueueDepth(nextQueue.length);
        void processMonitorQueue();
      };

      recorder.onerror = () => {
        setMonitorThreatLevel("warning");
        setMonitorMessage("The recorder hit an issue. Stop and restart the monitor if the feed stalls.");
      };

      monitorSequenceRef.current = 0;
      monitorEnabledRef.current = true;
      monitorStreamRef.current = stream;
      monitorRecorderRef.current = recorder;
      monitorQueueRef.current = [];
      setIsMonitorActive(true);
      setMonitorThreatLevel("safe");
      recorder.start(MONITOR_WINDOW_MS);

      toast({
        title: "Call Monitor armed",
        description: "Rolling 4 second windows are now being analyzed in the background.",
      });
    } catch (error) {
      stopMonitor(true);
      toast({
        title: "Could not start Call Monitor",
        description: error instanceof Error ? error.message : "Check microphone permissions and browser support.",
        variant: "destructive",
      });
    } finally {
      setIsMonitorStarting(false);
    }
  }, [processMonitorQueue, stopMonitor, toast]);

  useEffect(() => {
    return () => {
      stopMonitor(true);
    };
  }, [stopMonitor]);

  const liveThreat = threatCopy[isMonitorActive ? monitorThreatLevel : "idle"];

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground noise grid-overlay">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(106,197,134,0.18),transparent_32%),radial-gradient(circle_at_88%_10%,rgba(255,116,116,0.12),transparent_28%)]" />

      <nav className="relative z-20 flex flex-col gap-4 border-b border-border/40 px-6 py-5 md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-3xl bg-primary/12">
            <Shield className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight">Call Monitor</h1>
            <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-muted-foreground">Live Protection Mode</p>
          </div>
        </div>
        <Button asChild variant="outline">
          <Link to="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Analysis
          </Link>
        </Button>
      </nav>

      <main className="relative z-10 mx-auto max-w-6xl px-6 py-10 md:px-8">
        <motion.section
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 grid gap-8 lg:grid-cols-[1fr_0.95fr]"
        >
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.28em] text-primary">
              <Radio className="h-3.5 w-3.5" />
              Persistent stream protection
            </div>
            <h2 className="mt-5 max-w-xl font-display text-5xl font-extrabold leading-[0.98]">Keep the shield on while the call is happening.</h2>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
              This page stays focused on the live guardian. No acoustic map here, just the shield state, the rolling verdicts, and the metrics that prove the monitor is alive.
            </p>
          </div>

          <div className={`glass rounded-[32px] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.2)] ${monitorThreatLevel === "alert" ? "border-destructive/30" : monitorThreatLevel === "warning" ? "border-warning/30" : ""}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Shield status</p>
                <h3 className="mt-2 font-display text-3xl font-bold">{liveThreat.label}</h3>
              </div>
              <div className={`flex h-14 w-14 items-center justify-center rounded-3xl ${monitorThreatLevel === "alert" ? "bg-destructive/15 text-destructive" : monitorThreatLevel === "warning" ? "bg-warning/15 text-warning" : "bg-primary/12 text-primary"}`}>
                {monitorThreatLevel === "alert" ? <ShieldAlert className="h-7 w-7" /> : <ShieldCheck className="h-7 w-7" />}
              </div>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{monitorMessage}</p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                onClick={isMonitorActive ? () => stopMonitor(false) : startMonitor}
                disabled={isMonitorStarting}
                className={isMonitorActive ? "bg-destructive hover:bg-destructive/85" : "bg-gradient-to-r from-primary to-[#c2ff7a] text-primary-foreground"}
              >
                {isMonitorStarting ? "Arming..." : isMonitorActive ? "Stop Monitor" : "Start Monitor"}
              </Button>
              <Button variant="outline" onClick={() => stopMonitor(true)}>
                Clear Session
              </Button>
            </div>
          </div>
        </motion.section>

        <section className="mb-8 grid gap-4 md:grid-cols-4">
          <Tile label="Window" value="4.0s" hint="Rolling speech window length." />
          <Tile label="Latency" value={formatLatency(monitorLatencyMs)} hint="Time from chunk capture to verdict." />
          <Tile label="Last Scan" value={formatRelativeTimestamp(lastMonitorScanAt)} hint="Freshness heartbeat for the live session." />
          <Tile label="Threat Avg" value={`${Math.round(rollingThreatProbability * 100)}%`} hint="Rolling mean of recent live scores." />
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="glass rounded-[32px] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.18)]">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12">
                <Activity className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Monitor HUD</p>
                <h3 className="font-display text-2xl font-bold">Live session telemetry</h3>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Tile label="Windows" value={String(monitorWindowCount).padStart(2, "0")} hint="Completed live analyses this session." />
              <Tile label="Alerts" value={String(monitorAlertCount).padStart(2, "0")} hint="Windows that crossed the synthetic threshold." />
              <Tile label="Queue" value={String(monitorQueueDepth)} hint="Backlog kept short to stay real time." />
              <Tile label="Chunks" value={latestLiveResult?.chunk_count ? String(latestLiveResult.chunk_count) : "--"} hint="Internal slices in the latest inference." />
            </div>

            <div className="mt-6 space-y-6">
              <ScoreRail label="Synthetic Probability" value={latestLiveResult?.synthetic_probability ?? 0} accentClass="text-destructive" />
              <ScoreRail label="Human Probability" value={latestLiveResult?.human_probability ?? 0} accentClass="text-safe" />
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <Tile label="Model" value={latestLiveResult?.model_probability != null ? `${Math.round(latestLiveResult.model_probability * 100)}%` : "--"} hint="CNN contribution." />
              <Tile label="Artifact" value={latestLiveResult?.artifact_probability != null ? `${Math.round(latestLiveResult.artifact_probability * 100)}%` : "--"} hint="Spoof-cue contribution." />
              <Tile label="Threshold" value={latestLiveResult ? `${Math.round(latestLiveResult.threshold * 100)}%` : "--"} hint="Decision floor for the latest window." />
            </div>
          </div>

          <div className="glass rounded-[32px] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.18)]">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12">
                <Clock3 className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Rolling history</p>
                <h3 className="font-display text-2xl font-bold">Recent threat windows</h3>
              </div>
            </div>

            <div className="rounded-[28px] border border-white/10 bg-black/10 p-5">
              <div className="flex h-44 items-end gap-2">
                {(monitorHistory.length ? monitorHistory : [0.08, 0.14, 0.11, 0.18, 0.12, 0.16]).map((score, index) => (
                  <div
                    key={`${index}-${score}`}
                    className="flex-1 rounded-t-[18px] bg-gradient-to-t from-primary/35 via-[#dffb8f]/55 to-[#fff6c7]"
                    style={{
                      height: `${Math.max(14, score * 100)}%`,
                      opacity: monitorHistory.length ? 0.35 + score * 0.75 : 0.18,
                      boxShadow: score >= 0.68 ? "0 0 20px rgba(255, 102, 102, 0.35)" : "none",
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <Tile label="Mode" value={isMonitorActive ? "Live" : "Standby"} hint="Current monitor state." />
              <Tile label="Feed" value={isMonitorActive ? "Listening" : "Off"} hint="Microphone capture state." />
              <Tile label="Latest Risk" value={`${Math.round((latestLiveResult?.synthetic_probability ?? 0) * 100)}%`} hint="Newest live synthetic score." />
            </div>

            <div className="mt-6 rounded-[28px] border border-white/10 bg-black/10 p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12">
                  <Zap className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h4 className="font-display text-xl font-bold">Why this page is separate</h4>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    The monitor now lives away from the analysis screen so the user gets one focused job per page: either inspect a clip, or guard a live call.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 px-6 py-8 text-center font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground/60 md:px-8">
        Vacha Shield - live guardian mode
      </footer>
    </div>
  );
};

export default CallMonitorPage;
