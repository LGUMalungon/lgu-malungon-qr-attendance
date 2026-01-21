"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { AuthGuard } from "../components/AuthGuard";

type Role = "app_master" | "hr_admin" | "hr_scanner";

type ActiveSession = {
  session_id: string;
  event_name: string;
  started_at: string;
};

type EmployeeRow = {
  employee_id: string;
  full_name: string;
  department: string;
  is_active: boolean;
};

type ResultStatus = "neutral" | "good" | "bad" | "dup";

function formatPH(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function getOrCreateDeviceId() {
  if (typeof window === "undefined") return "web-unknown";
  const key = "lgu_attendance_device_id";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;

  const id =
    "web-" +
    Math.random().toString(16).slice(2) +
    "-" +
    Date.now().toString(16);

  window.localStorage.setItem(key, id);
  return id;
}

function ScannerInner() {
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);

  // ✅ added: role (so we can show Back to Dashboard for admin/app master)
  const [role, setRole] = useState<Role | "">("");

  const [loadingSession, setLoadingSession] = useState(true);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);

  const [manualId, setManualId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [status, setStatus] = useState<ResultStatus>("neutral");
  const [scanBorderClass, setScanBorderClass] = useState("scan-neutral");

  const [latest, setLatest] = useState<{
    status: ResultStatus;
    time: string | null;
    name: string;
    dept: string;
    employeeId: string;
    note: string;
  }>({
    status: "neutral",
    time: null,
    name: "Employee name",
    dept: "Department",
    employeeId: "Employee ID",
    note: "No scan yet.",
  });

  const [counts, setCounts] = useState({
    scanned: 0,
    manual: 0,
    total: 0,
  });

    // --- Sounds (no external files) ---
  const audioCtxRef = useRef<AudioContext | null>(null);

  function playTone(kind: "good" | "bad" | "dup") {
    try {
      if (typeof window === "undefined") return;

      const AudioContextAny =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextAny) return;

      if (!audioCtxRef.current) audioCtxRef.current = new AudioContextAny();

      const ctx = audioCtxRef.current;
      if (!ctx) return; // ✅ TS fix: ctx can be null

      const o = ctx.createOscillator();
      const g = ctx.createGain();

      o.connect(g);
      g.connect(ctx.destination);

      if (kind === "good") o.frequency.value = 880;
      if (kind === "dup") o.frequency.value = 440;
      if (kind === "bad") o.frequency.value = 220;

      o.type = kind === "good" ? "sine" : "square";

      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);

      o.start();
      o.stop(ctx.currentTime + 0.28);
    } catch {}
  }


  function setVisuals(next: ResultStatus) {
    setStatus(next);

    if (next === "good") setScanBorderClass("scan-good");
    else if (next === "bad") setScanBorderClass("scan-bad");
    else if (next === "dup") setScanBorderClass("scan-dup");
    else setScanBorderClass("scan-neutral");
  }

  async function loadActiveSession() {
    setLoadingSession(true);
    const { data, error } = await supabase
      .from("v_active_session")
      .select("*")
      .maybeSingle();

    if (error) console.error("loadActiveSession error:", error);
    setActiveSession((data as any) ?? null);
    setLoadingSession(false);
  }

  async function loadCounts(sessionId: string) {
    const { data, error } = await supabase
      .from("attendance")
      .select("method")
      .eq("session_id", sessionId);

    if (error) {
      console.error("loadCounts error:", error);
      return;
    }

    const scanned = (data ?? []).filter((r: any) => r.method === "qr").length;
    const manual = (data ?? []).filter((r: any) => r.method === "manual").length;
    const total = (data ?? []).length;

    setCounts({ scanned, manual, total });
  }

  // ✅ added: get role once (does not affect scanner UI)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setRole((data.session?.user?.user_metadata?.role ?? "") as Role | "");
    });
  }, []);

  useEffect(() => {
    loadActiveSession();
  }, []);

  useEffect(() => {
    if (!activeSession?.session_id) return;

    loadCounts(activeSession.session_id);

    const channel = supabase
      .channel("attendance-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "attendance",
          filter: `session_id=eq.${activeSession.session_id}`,
        },
        () => loadCounts(activeSession.session_id)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeSession?.session_id]);

  async function submitEmployee(empIdRaw: string, method: "manual" | "qr") {
    const empId = empIdRaw.trim();
    if (!empId) return;
    if (!activeSession) {
      setVisuals("bad");
      playTone("bad");
      setLatest({
        status: "bad",
        time: new Date().toISOString(),
        name: "No active session",
        dept: "",
        employeeId: empId,
        note: "Scanning is disabled. Ask Admin to start a session.",
      });
      return;
    }

    if (submitting) return;
    setSubmitting(true);

    try {
      const { data: emp, error: empErr } = await supabase
        .from("employees")
        .select("employee_id, full_name, department, is_active")
        .eq("employee_id", empId)
        .maybeSingle();

      if (empErr) {
        setVisuals("bad");
        playTone("bad");
        setLatest({
          status: "bad",
          time: new Date().toISOString(),
          name: "Error",
          dept: "",
          employeeId: empId,
          note: "System error while checking employee.",
        });
        return;
      }

      if (!emp || !emp.is_active) {
        setVisuals("bad");
        playTone("bad");
        setLatest({
          status: "bad",
          time: new Date().toISOString(),
          name: "Invalid Employee ID",
          dept: "",
          employeeId: empId,
          note: "Employee ID not found in masterlist.",
        });
        return;
      }

      const employee = emp as EmployeeRow;

      const { data: ins, error: insErr } = await supabase
        .from("attendance")
        .insert([
          {
            session_id: activeSession.session_id,
            employee_id: employee.employee_id,
            method,
            device_id: deviceId,
          },
        ])
        .select("scanned_at")
        .single();

      if (!insErr) {
        setVisuals("good");
        playTone("good");
        const iso = (ins as any)?.scanned_at ?? new Date().toISOString();

        setLatest({
          status: "good",
          time: iso,
          name: employee.full_name,
          dept: employee.department,
          employeeId: employee.employee_id,
          note: method === "qr" ? "Recorded via QR." : "Recorded via manual entry.",
        });

        if (method === "manual") setManualId("");
        await loadCounts(activeSession.session_id);
        return;
      }

      const pgCode = (insErr as any)?.code;
      if (pgCode === "23505") {
        const { data: existing } = await supabase
          .from("attendance")
          .select("scanned_at, method")
          .eq("session_id", activeSession.session_id)
          .eq("employee_id", employee.employee_id)
          .order("scanned_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        const firstIso =
          (existing as any)?.scanned_at ?? new Date().toISOString();
        const firstMethod = (existing as any)?.method ?? "manual";

        setVisuals("dup");
        playTone("dup");
        setLatest({
          status: "dup",
          time: firstIso,
          name: employee.full_name,
          dept: employee.department,
          employeeId: employee.employee_id,
          note: `Duplicate. First recorded: ${formatPH(firstIso)} (${firstMethod}).`,
        });

        await loadCounts(activeSession.session_id);
        return;
      }

      setVisuals("bad");
      playTone("bad");
      setLatest({
        status: "bad",
        time: new Date().toISOString(),
        name: "Error",
        dept: "",
        employeeId: employee.employee_id,
        note: `Submit failed: ${insErr.message}`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitManual() {
    await submitEmployee(manualId, "manual");
  }

  // QR camera (html5-qrcode)
  const html5Ref = useRef<any>(null);
  const scannerRunningRef = useRef(false);
  const lastScanRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  async function startQrScanner() {
    if (scannerRunningRef.current) return;
    if (!activeSession) return;

    const mod = await import("html5-qrcode");
    const Html5Qrcode = (mod as any).Html5Qrcode;

    const elId = "qr-reader";
    const instance = new Html5Qrcode(elId);
    html5Ref.current = instance;
    scannerRunningRef.current = true;

    const config = {
      fps: 10,
      qrbox: { width: 240, height: 240 },
      aspectRatio: 1.0,
    };

    try {
      await instance.start(
        { facingMode: "environment" },
        config,
        async (decodedText: string) => {
          const now = Date.now();
          const last = lastScanRef.current;
          const isSame = decodedText === last.text;
          const tooSoon = now - last.at < 1200;
          if (isSame && tooSoon) return;

          lastScanRef.current = { text: decodedText, at: now };
          await submitEmployee(decodedText, "qr");
        },
        () => {}
      );
    } catch (e: any) {
      scannerRunningRef.current = false;
      setVisuals("bad");
      playTone("bad");
      setLatest({
        status: "bad",
        time: new Date().toISOString(),
        name: "Camera error",
        dept: "",
        employeeId: "",
        note:
          "Unable to start camera. Please allow camera permission and reload the page.",
      });
    }
  }

  async function stopQrScanner() {
    try {
      const inst = html5Ref.current;
      if (inst && scannerRunningRef.current) {
        await inst.stop();
        await inst.clear();
      }
    } catch {
    } finally {
      scannerRunningRef.current = false;
      html5Ref.current = null;
    }
  }

  useEffect(() => {
    if (activeSession?.session_id) startQrScanner();
    else stopQrScanner();

    return () => {
      stopQrScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.session_id]);

  const resultClass =
    status === "good"
      ? "result-card result-good"
      : status === "bad"
      ? "result-card result-bad"
      : status === "dup"
      ? "result-card result-dup"
      : "result-card result-neutral";

  return (
    <div className="scanner-wrap">
      <div className="scanner-header">
        <div>
          <div className="page-title">Scanner</div>
          <div className="page-subtitle">
            Scan QR (Employee ID) or use manual entry.
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          
          <div className="scanner-session">
  {loadingSession ? (
    <>
      <div className="session-label">Checking session…</div>
      <div className="session-sub">Please wait</div>
    </>
  ) : activeSession ? (
    <>
      <div className="pill pill-active">
        <span className="pill-dot" />
        ACTIVE SESSION
      </div>

      <div
        style={{
          marginTop: 8,
          fontSize: 14,          // same as Dashboard feel
          fontWeight: 800,
          color: "#111827",
          letterSpacing: "0.2px",
        }}
      >
        {activeSession.event_name} • {formatPH(activeSession.started_at)}
      </div>
    </>
  ) : (
    <>
<div className="pill pill-inactive">
  <span className="pill-dot" />
  NO ACTIVE SESSION
</div>


      <div className="session-sub" style={{ marginTop: 10 }}>
        Scanning is disabled.
      </div>
    </>
  )}
</div>



          {/* ✅ added: Back to Dashboard for HR Admin / App Master only */}
          {(role === "hr_admin" || role === "app_master") && (
            <a href="/dashboard" className="btn btn-blue">
              ← Back to Dashboard
            </a>
          )}

          <a href="/logout" className="btn btn-grey">
            Logout
          </a>
        </div>
      </div>

      <div className="scanner-grid">
        <div className="scanner-left">
          <div className="card">
            <div className="card-title">Scan QR</div>
            <div className="card-subtitle">
              Point camera at QR code (Employee ID).
            </div>

            {!loadingSession && !activeSession && (
              <div className="hint" style={{ color: "#dc2626", fontWeight: 800 }}>
                Scanning is disabled. No active session.
              </div>
            )}

            <div className={`scan-box ${scanBorderClass}`}>
              <div id="qr-reader" className="qr-reader" />
            </div>

            <div className="hint">
              Sound: bell = valid, buzz = invalid, low tone = duplicate.
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-title">Manual entry</div>
            <div className="card-subtitle">
              Enter Employee ID only, then submit.
            </div>

            <div className="field">
              <label className="label">Employee ID</label>
              <input
                className="input"
                placeholder="e.g., EMP-0001"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                disabled={!activeSession || submitting}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitManual();
                }}
              />
            </div>

            <div style={{ height: 12 }} />

            <button
              className="btn btn-orange"
              onClick={submitManual}
              disabled={
                !activeSession || submitting || manualId.trim().length === 0
              }
            >
              {submitting ? "Submitting..." : "Submit"}
            </button>

            <div className="hint" style={{ marginTop: 10 }}>
              Green = recorded. Red = invalid. Yellow = duplicate.
            </div>
          </div>
        </div>

        <div className="scanner-right">
          <div className="card">
            <div className="card-title">Latest result</div>
            <div className="card-subtitle">
              Shows the most recent scan or manual entry.
            </div>

            <div className={resultClass}>
              <div className="result-top">
                <div className="result-status">
                  {latest.status === "good"
                    ? "Recorded"
                    : latest.status === "bad"
                    ? "Invalid"
                    : latest.status === "dup"
                    ? "Duplicate"
                    : "Waiting"}
                </div>
                <div className="result-time">
                  {latest.time ? formatPH(latest.time) : "PH time will appear here"}
                </div>
              </div>

              <div className="result-main">
                <div className="result-name">{latest.name}</div>
                <div className="result-meta">
                  {latest.dept ? `${latest.dept} • ` : ""}
                  {latest.employeeId}
                </div>
              </div>

              <div className="result-note">{latest.note}</div>
            </div>

            <div style={{ height: 14 }} />

            <div className="card-subtitle">Today’s counters (live)</div>

            <div className="mini-stats">
              <div className="mini">
                <div className="mini-label">Scanned</div>
                <div className="mini-value">{counts.scanned}</div>
              </div>
              <div className="mini">
                <div className="mini-label">Manual</div>
                <div className="mini-value">{counts.manual}</div>
              </div>
              <div className="mini">
                <div className="mini-label">Total</div>
                <div className="mini-value">{counts.total}</div>
              </div>
            </div>

            <div className="hint" style={{ marginTop: 10 }}>
              Device ID: {deviceId}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ScannerPage() {
  return (
    <AuthGuard allowRoles={["hr_scanner", "hr_admin", "app_master"]}>
      <ScannerInner />
    </AuthGuard>
  );
}
