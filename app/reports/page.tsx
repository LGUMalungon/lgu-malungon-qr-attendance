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

function ReportsInner() {
  const [role, setRole] = useState<Role | "">("");
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const r = (data.session?.user?.user_metadata?.role ?? "") as Role | "";
      setRole(r);
    });
  }, []);

  async function refreshActiveSession() {
    const { data } = await supabase.from("v_active_session").select("*").maybeSingle();
    setActiveSession((data as any) ?? null);
  }

  useEffect(() => {
    refreshActiveSession();
  }, []);

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-title">Menu</div>

        <a className="sidebar-link" href="/dashboard">Dashboard</a>
        <a className="sidebar-link" href="/scanner">Scanner</a>
        <a className="sidebar-link active" href="/reports">Reports</a>

        {role === "app_master" && (
          <a className="sidebar-link" href="/masterlist">Masterlist</a>
        )}

        <div style={{ height: 10 }} />
        <SignOutButton />
      </aside>

      <section className="content">
        <div className="content-header">
          <div>
            <div className="page-title">Reports</div>
            <div className="page-subtitle">
              Export current session and generate other reports.
            </div>
          </div>

          <div className="session-indicator">
            {!activeSession ? (
              <>
                <div className="session-label">No Active Session</div>
                <div className="session-sub">Start a session to export.</div>
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

        <div className="card">
          <div className="card-title">Current session export</div>
          <div className="card-subtitle">
            Next step: generate Excel (Summary sheet + Raw sheet).
          </div>

          <button className="btn btn-orange" disabled={!activeSession}>
            Export current session (Excel)
          </button>

          <div style={{ height: 10 }} />
          <button className="btn btn-grey">Monthly trend report (soon)</button>
        </div>
      </section>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <AuthGuard allowRoles={["hr_admin", "app_master"]}>
      <ReportsInner />
    </AuthGuard>
  );
}
