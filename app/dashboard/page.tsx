"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { AuthGuard, SignOutButton } from "../components/AuthGuard";

type Role = "app_master" | "hr_admin" | "hr_scanner";

type ActiveSession = {
  session_id: string;
  event_name: string;
  started_at: string;
};

type SessionStats = {
  session_id: string;
  lgu_total: number;
  present_total: number;
  scanned_total: number;
  manual_total: number;
};

type OfficeStat = {
  department: string;
  dept_total: number;
  dept_present: number;
  dept_rate: number;
};

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

function pct(present: number, total: number) {
  if (!total) return 0;
  return Math.round((present / total) * 1000) / 10;
}

function DashboardInner() {
  const [role, setRole] = useState<Role | "">("");
  const [loading, setLoading] = useState(false);

  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [eventName, setEventName] = useState("");

  const [stats, setStats] = useState<SessionStats>({
    session_id: "",
    lgu_total: 0,
    present_total: 0,
    scanned_total: 0,
    manual_total: 0,
  });

  const [officeStats, setOfficeStats] = useState<OfficeStat[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const r = (data.session?.user?.user_metadata?.role ?? "") as Role | "";
      setRole(r);
    });
  }, []);

  async function refreshActiveSession() {
    const { data, error } = await supabase
      .from("v_active_session")
      .select("*")
      .maybeSingle();

    if (error) {
  // Ignore aborted fetches (common on mobile / slow networks)
  if ((error as any)?.name === "AbortError") return;

  alert(`Failed to load active session: ${error.message}`);
  return;
}


    const s = (data as any) ?? null;
    setActiveSession(s);

    if (!s?.session_id) {
      setStats({
        session_id: "",
        lgu_total: 0,
        present_total: 0,
        scanned_total: 0,
        manual_total: 0,
      });
      setOfficeStats([]);
      stopRealtime();
      return;
    }

    await fetchStatsAndOffices(s.session_id);
    startRealtime(s.session_id);
  }

  async function fetchStatsAndOffices(session_id: string) {
    const { data: st, error: stErr } = await supabase
      .from("v_session_stats")
      .select("session_id,lgu_total,present_total,scanned_total,manual_total")
      .eq("session_id", session_id)
      .single();

    if (stErr) {
      alert(`Stats load failed: ${stErr.message}`);
      return;
    }

    setStats(st as any);

    const { data: os, error: osErr } = await supabase
      .from("v_office_stats")
      .select("department,dept_total,dept_present,dept_rate")
      .eq("session_id", session_id);

    if (osErr) {
      alert(`Office stats load failed: ${osErr.message}`);
      return;
    }

    const sorted = (os as any as OfficeStat[])
      .slice()
      .sort(
        (a, b) => b.dept_rate - a.dept_rate || b.dept_present - a.dept_present
      );

    setOfficeStats(sorted);
  }

  function stopRealtime() {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }

  function startRealtime(session_id: string) {
    stopRealtime();

    const ch = supabase
      .channel(`rt-attendance-${session_id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "attendance",
          filter: `session_id=eq.${session_id}`,
        },
        async () => {
          await fetchStatsAndOffices(session_id);
        }
      )
      .subscribe();

    channelRef.current = ch;
  }

  useEffect(() => {
    refreshActiveSession();
    return () => stopRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startSession() {
    const name = eventName.trim();
    if (!name) {
      alert("Please enter an event name.");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("sessions")
        .insert([{ event_name: name, status: "active" }])
        .select("session_id")
        .single();

      if (error) {
        alert(`Start session failed: ${error.message}`);
        return;
      }

      await supabase.from("audit_logs").insert([
        {
          action: "session_started",
          session_id: data.session_id,
          actor_role: role || "unknown",
          details: { event_name: name },
        },
      ]);

      setEventName("");
      await refreshActiveSession();
    } finally {
      setLoading(false);
    }
  }

  async function endSession() {
    if (!activeSession) return;

    setLoading(true);
    try {
      const { error } = await supabase
        .from("sessions")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("session_id", activeSession.session_id)
        .eq("status", "active");

      if (error) {
        alert(`End session failed: ${error.message}`);
        return;
      }

      await supabase.from("audit_logs").insert([
        {
          action: "session_ended",
          session_id: activeSession.session_id,
          actor_role: role || "unknown",
          details: {},
        },
      ]);

      await refreshActiveSession();
    } finally {
      setLoading(false);
    }
  }

  const attRate = useMemo(
    () => pct(stats.present_total, stats.lgu_total),
    [stats.present_total, stats.lgu_total]
  );

  const canStart = !loading && !activeSession && eventName.trim().length > 0;
  const canEnd = !loading && !!activeSession;

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-title">Menu</div>

        <a className="sidebar-link active" href="/dashboard">
          Dashboard
        </a>
        <a className="sidebar-link" href="/scanner">
          Scanner
        </a>
        <a className="sidebar-link" href="/reports">
          Reports
        </a>

        {role === "app_master" && (
          <a className="sidebar-link" href="/masterlist">
            Masterlist
          </a>
        )}

        <div style={{ height: 10 }} />
        <SignOutButton />
      </aside>

      <section className="content">
        <div className="content-header">
          <div>
            <div className="page-title">Admin dashboard</div>
            <div className="page-subtitle">Session control and live stats.</div>
          </div>

          <div className="session-indicator">
            {!activeSession ? (
              <>
                <div className="pill pill-inactive">
                  <span className="pill-dot" />
                  NO ACTIVE SESSION
                </div>
                <div className="session-sub" style={{ marginTop: 8 }}>
                  Start a session to begin.
                </div>
              </>
            ) : (
              <>
                <div className="pill pill-active">
                  <span className="pill-dot" />
                  ACTIVE SESSION
                </div>

                <div className="session-when">
                  {activeSession.event_name} • {formatPH(activeSession.started_at)}
                </div>
              </>
            )}
          </div>
        </div>

        <div
  style={{
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 16,
  }}
>

          <div className="card">
            <div className="card-title">Session control</div>
            <div className="card-subtitle">
              Event name is required before starting.
            </div>

            <div
  style={{
    display: "grid",
    gridTemplateColumns: "2fr 1fr 1fr",
    gap: 10,
    alignItems: "end",
  }}
>
  {/* Event name */}
  <div>
    <label className="label">Event name</label>
    <input
      className="input"
      placeholder="e.g., Flag Ceremony"
      value={eventName}
      onChange={(e) => setEventName(e.target.value)}
      disabled={!!activeSession || loading}
    />
  </div>

  {/* Start */}
  <button
    className="btn btn-blue"
    onClick={startSession}
    disabled={!canStart}
    style={{ height: 42 }}
  >
    {loading ? "Working..." : "Start session"}
  </button>

  {/* End */}
  <button
    className="btn btn-red"
    onClick={endSession}
    disabled={!canEnd}
    style={{ height: 42 }}
  >
    {loading ? "Working..." : "End session"}
  </button>
</div>


            


            <div style={{ height: 10 }} />
            <div className="hint">
              Tip: Open <b>Reports</b> to export the current session.
            </div>
          </div>


          <div className="card">
            <div className="card-title">Real-time attendance stats</div>
            <div className="card-subtitle">
              LGU totals + department performance (sorted high → low).
            </div>

            

            <div style={{ display: "grid", gap: 14 }}>
  {/* KPI CARD (TOP) */}
  <div
    style={{
      border: "1px solid rgba(0,0,0,0.08)",
      borderRadius: 16,
      padding: 14,
      background: "rgba(255,255,255,0.9)",
      boxShadow: "0 10px 22px rgba(0,0,0,0.06)",
    }}
  >
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.2fr 1.1fr 0.85fr 0.85fr",
        gap: 12,
        alignItems: "stretch",
      }}
    >
      {/* 1) Present / Total */}
      <div
        style={{
          borderRadius: 14,
          border: "1px solid rgba(0,0,0,0.08)",
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 900, color: "#6b7280" }}>
          Present / Total
        </div>
        <div style={{ marginTop: 6, fontSize: 26, fontWeight: 1000, color: "#111827" }}>
          {stats.present_total} <span style={{ fontSize: 14, fontWeight: 900, color: "#6b7280" }}>/ {stats.lgu_total}</span>
        </div>
      </div>

      {/* 2) Attendance rate */}
      <div
        style={{
          borderRadius: 14,
          border: "1px solid rgba(0,0,0,0.08)",
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 900, color: "#6b7280" }}>
          Attendance rate
        </div>
        <div style={{ marginTop: 6, fontSize: 26, fontWeight: 1000, color: "#111827" }}>
          {attRate}%
        </div>
      </div>

      {/* 3) Scanned in (smaller) */}
      <div
        style={{
          borderRadius: 14,
          border: "1px solid rgba(22,163,74,0.28)",
          background: "rgba(22,163,74,0.10)",
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 900, color: "#065f46" }}>
          Scanned in
        </div>
        <div style={{ marginTop: 6, fontSize: 22, fontWeight: 1000, color: "#065f46" }}>
          {stats.scanned_total}
        </div>
      </div>

      {/* 4) Manual entry (smaller) */}
      <div
        style={{
          borderRadius: 14,
          border: "1px solid rgba(37,99,235,0.25)",
          background: "rgba(37,99,235,0.08)",
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 900, color: "#1d4ed8" }}>
          Manual entry
        </div>
        <div style={{ marginTop: 6, fontSize: 22, fontWeight: 1000, color: "#1d4ed8" }}>
          {stats.manual_total}
        </div>
      </div>
    </div>
  </div>

  {/* DEPARTMENT PERFORMANCE CARD (BOTTOM) */}
  <div
    style={{
      border: "1px solid rgba(0,0,0,0.08)",
      borderRadius: 16,
      padding: 14,
      background: "rgba(255,255,255,0.9)",
      boxShadow: "0 10px 22px rgba(0,0,0,0.06)",
    }}
  >
    <div style={{ fontWeight: 1000, marginBottom: 10, color: "#111827" }}>
      Department performance
    </div>

    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.8fr 120px 70px",
        gap: 10,
        fontSize: 12,
        fontWeight: 900,
        color: "#6b7280",
        marginBottom: 8,
      }}
    >
      <div>Department</div>
      <div>Present/Total</div>
      <div>Rate</div>
    </div>

    <div style={{ maxHeight: 420, overflow: "auto", paddingRight: 4 }}>
      {officeStats.map((d) => (
        <div key={d.department} style={{ marginBottom: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.8fr 120px 70px",
              gap: 10,
              alignItems: "center",
            }}
          >
            <div style={{ fontWeight: 900 }}>{d.department}</div>
            <div style={{ fontSize: 12, color: "#374151", fontWeight: 900 }}>
              {d.dept_present}/{d.dept_total}
            </div>
            <div style={{ fontSize: 12, color: "#374151", fontWeight: 900 }}>
              {d.dept_rate}%
            </div>
          </div>

          <div
            style={{
              position: "relative",
              height: 10,
              borderRadius: 999,
              background: "rgba(0,0,0,0.06)",
              overflow: "hidden",
              marginTop: 6,
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, d.dept_rate))}%`,
                background: "rgba(249,115,22,0.85)",
              }}
            />
          </div>
        </div>
      ))}

      {activeSession && officeStats.length === 0 && (
        <div className="hint">No department data yet.</div>
      )}

      {!activeSession && (
        <div className="hint">Start a session to see live stats.</div>
      )}
    </div>
  </div>
</div>



          </div>
        </div>
      </section>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthGuard allowRoles={["hr_admin", "app_master"]}>
      <DashboardInner />
    </AuthGuard>
  );
}
