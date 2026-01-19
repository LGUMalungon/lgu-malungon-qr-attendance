"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { AuthGuard, SignOutButton } from "../components/AuthGuard";

type Role = "app_master" | "hr_admin" | "hr_scanner";

type ActiveSession = {
  session_id: string;
  event_name: string;
  started_at: string;
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

function DashboardInner() {
  const [role, setRole] = useState<Role | "">("");
  const [loading, setLoading] = useState(false);

  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [eventName, setEventName] = useState("");

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
      alert(`Failed to load active session: ${error.message}`);
      return;
    }

    setActiveSession((data as any) ?? null);
  }

  useEffect(() => {
    refreshActiveSession();
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
        .update({
          status: "ended",
          ended_at: new Date().toISOString(),
        })
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

        {/* App Master-only menu */}
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
            <div className="page-subtitle">
              Session control, real-time progress, export.
            </div>
          </div>

          <div className="session-indicator">
            {!activeSession ? (
              <>
                <div className="session-label">No Active Session</div>
                <div className="session-sub">Start a session to begin.</div>
              </>
            ) : (
              <>
                <div className="session-label">
                  Active Session: {activeSession.session_id}
                </div>
                <div className="session-sub">
                  {activeSession.event_name} • {formatPH(activeSession.started_at)}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="grid-3">
          <div className="card">
            <div className="card-title">Session control</div>
            <div className="card-subtitle">
              Event name is required before starting.
            </div>

            <div className="field">
              <label className="label">Event name</label>
              <input
                className="input"
                placeholder="e.g., Flag Ceremony"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                disabled={!!activeSession || loading}
              />
            </div>

            <div className="button-row">
              <button
                className="btn btn-blue"
                onClick={startSession}
                disabled={!canStart}
              >
                {loading ? "Working..." : "Start session"}
              </button>

              <button
                className="btn btn-red"
                onClick={endSession}
                disabled={!canEnd}
              >
                {loading ? "Working..." : "End session"}
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Real-time attendance progress</div>
            <div className="card-subtitle">
              Next: LGU total + office ranking + chart.
            </div>
            <div className="hint">We wire this after export.</div>
          </div>

          <div className="card">
            <div className="card-title">Export</div>
            <div className="card-subtitle">
              Export per-session report (summary + raw).
            </div>

            <button className="btn btn-orange" disabled={!activeSession}>
              Export current session (Excel)
            </button>

            <div style={{ height: 10 }} />

            <button className="btn btn-grey">Export monthly report</button>
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
