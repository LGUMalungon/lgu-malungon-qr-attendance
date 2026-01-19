"use client";

import { useEffect, useState } from "react";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { supabase } from "../lib/supabaseClient";
import { AuthGuard, SignOutButton } from "../components/AuthGuard";

type Role = "app_master" | "hr_admin" | "hr_scanner";

type ActiveSession = {
  session_id: string;
  event_name: string;
  started_at: string;
  ended_at?: string | null;
};

type OfficeStat = {
  department: string;
  dept_total: number;
  dept_present: number;
  dept_rate: number;
};

function formatPH(iso?: string | null) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function duration(start?: string, end?: string | null) {
  if (!start) return "-";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const mins = Math.floor((e - s) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function ReportsInner() {
  const [role, setRole] = useState<Role | "">("");
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setRole((data.session?.user?.user_metadata?.role ?? "") as Role | "");
    });
    refreshActiveSession();
  }, []);

  async function refreshActiveSession() {
    const { data } = await supabase
      .from("sessions")
      .select("session_id,event_name,started_at,ended_at")
      .eq("status", "active")
      .maybeSingle();

    setActiveSession((data as any) ?? null);
  }

  async function exportCurrentSession() {
    if (!activeSession) return;

    setLoading(true);
    try {
      // Office summary
      const { data: officeStats } = await supabase
        .from("v_office_stats")
        .select("*")
        .eq("session_id", activeSession.session_id);

      const sorted = (officeStats as OfficeStat[]).sort(
        (a, b) => b.dept_rate - a.dept_rate
      );

      // Raw attendance (VIEW)
      const { data: raw, error: rawErr } = await supabase
        .from("v_session_raw_attendance")
        .select("employee_id,full_name,department,method,recorded_at")
        .eq("session_id", activeSession.session_id);

      if (rawErr) {
        alert(`Raw export failed: ${rawErr.message}`);
        return;
      }

      const wb = new ExcelJS.Workbook();

      /* ===== Sheet 1: Summary ===== */
      const s1 = wb.addWorksheet("Summary");

      s1.addRows([
        ["Event", activeSession.event_name],
        ["Session started", formatPH(activeSession.started_at)],
        ["Session ended", formatPH(activeSession.ended_at)],
        ["Duration", duration(activeSession.started_at, activeSession.ended_at)],
        [],
        ["Department", "Present", "Total", "Rate (%)"],
      ]);

      sorted.forEach((d) => {
        s1.addRow([
          d.department,
          d.dept_present,
          d.dept_total,
          d.dept_rate,
        ]);
      });

      s1.columns.forEach((c) => (c.width = 22));

      /* ===== Sheet 2: Raw ===== */
      const s2 = wb.addWorksheet("Raw Attendance");

      s2.addRow([
        "Employee ID",
        "Full Name",
        "Department",
        "Method",
        "Recorded At (PH)",
      ]);

      raw?.forEach((r: any) => {
        s2.addRow([
          r.employee_id,
          r.full_name,
          r.department,
          r.method,
          formatPH(r.recorded_at),
        ]);
      });

      s2.columns.forEach((c) => (c.width = 26));

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const fname = `Attendance_${activeSession.event_name.replace(
        /\s+/g,
        "_"
      )}_${new Date().toISOString().slice(0, 10)}.xlsx`;

      saveAs(blob, fname);
    } finally {
      setLoading(false);
    }
  }

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
              Export current session and future reports.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Current session</div>
          <div className="card-subtitle">
            Generates Excel (Summary + Raw).
          </div>

          <button
            className="btn btn-orange"
            disabled={!activeSession || loading}
            onClick={exportCurrentSession}
          >
            {loading ? "Exporting..." : "Export current session (Excel)"}
          </button>

          {!activeSession && (
            <div className="hint" style={{ marginTop: 10 }}>
              No active session to export.
            </div>
          )}
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
