"use client";

import { useEffect, useMemo, useState } from "react";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { supabase } from "../lib/supabaseClient";
import { AuthGuard, SignOutButton } from "../components/AuthGuard";

type Role = "app_master" | "hr_admin" | "hr_scanner";

type SessionRow = {
  session_id: string;
  event_name: string;
  status: "active" | "ended";
  started_at: string;
  ended_at: string | null;
};

type OfficeStat = {
  department: string;
  dept_total: number;
  dept_present: number;
  dept_rate: number;
};

type MonthlyOfficeSummary = {
  month_start: string;
  department: string;
  dept_total: number;
  dept_present: number;
  dept_rate: number;
};

type SessionOfficeRow = {
  month_start: string;
  session_id: string;
  started_at: string;
  event_name: string;
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

function monthKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthStartISOFromKey(key: string) {
  return `${key}-01T00:00:00.000Z`;
}

function monthEndISOFromKey(key: string) {
  const [yStr, mStr] = key.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const end = new Date(Date.UTC(y, m, 1)); // next month 1st day
  return end.toISOString();
}

function ReportsInner() {
  const [role, setRole] = useState<Role | "">("");

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");

  const [exportLoading, setExportLoading] = useState(false);

  const defaultMonth = useMemo(() => monthKey(new Date()), []);
  const [selectedMonth, setSelectedMonth] = useState<string>(defaultMonth);
  const [monthlyLoading, setMonthlyLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setRole((data.session?.user?.user_metadata?.role ?? "") as Role | "");
    });
    refreshSessions();
  }, []);

  async function refreshSessions() {
    const { data, error } = await supabase
      .from("sessions")
      .select("session_id,event_name,status,started_at,ended_at")
      .order("started_at", { ascending: false })
      .limit(50);

    if (error) {
      alert(`Failed to load sessions: ${error.message}`);
      return;
    }

    const list = (data as any as SessionRow[]) ?? [];
    setSessions(list);

    // Default selection: active session if present, else most recent ended
    const active = list.find((s) => s.status === "active");
    if (active) setSelectedSessionId(active.session_id);
    else if (list[0]) setSelectedSessionId(list[0].session_id);
  }

  const selectedSession = useMemo(
    () => sessions.find((s) => s.session_id === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  async function exportSelectedSession() {
    if (!selectedSession) {
      alert("Please select a session first.");
      return;
    }

    setExportLoading(true);
    try {
      const session_id = selectedSession.session_id;

      // Office summary
      const { data: officeStats, error: osErr } = await supabase
        .from("v_office_stats")
        .select("*")
        .eq("session_id", session_id);

      if (osErr) {
        alert(`Office stats load failed: ${osErr.message}`);
        return;
      }

      const sorted = (officeStats as OfficeStat[]).slice().sort(
        (a, b) => b.dept_rate - a.dept_rate || b.dept_present - a.dept_present
      );

      // Raw attendance (VIEW)
      const { data: raw, error: rawErr } = await supabase
        .from("v_session_raw_attendance")
        .select("employee_id,full_name,department,method,recorded_at")
        .eq("session_id", session_id);

      if (rawErr) {
        alert(`Raw export failed: ${rawErr.message}`);
        return;
      }

      const wb = new ExcelJS.Workbook();

      // Sheet 1: Summary
      const s1 = wb.addWorksheet("Summary");

      s1.addRows([
        ["Event", selectedSession.event_name],
        ["Session started", formatPH(selectedSession.started_at)],
        ["Session ended", formatPH(selectedSession.ended_at)],
        ["Duration", duration(selectedSession.started_at, selectedSession.ended_at)],
        ["Session ID", selectedSession.session_id],
        ["Status", selectedSession.status],
        [],
        ["Department", "Present", "Total", "Rate (%)"],
      ]);

      sorted.forEach((d) => {
        s1.addRow([d.department, d.dept_present, d.dept_total, d.dept_rate]);
      });

      s1.columns.forEach((c) => (c.width = 24));

      // Sheet 2: Raw Attendance
      const s2 = wb.addWorksheet("Raw Attendance");
      s2.addRow(["Employee ID", "Full Name", "Department", "Method", "Recorded At (PH)"]);
      raw?.forEach((r: any) => {
        s2.addRow([r.employee_id, r.full_name, r.department, r.method, formatPH(r.recorded_at)]);
      });
      s2.columns.forEach((c) => (c.width = 26));

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const dateTag = (selectedSession.started_at || new Date().toISOString()).slice(0, 10);
      const fname = `Attendance_${selectedSession.event_name.replace(/\s+/g, "_")}_${dateTag}.xlsx`;

      saveAs(blob, fname);
    } finally {
      setExportLoading(false);
    }
  }

  async function exportMonthlyTrend() {
    setMonthlyLoading(true);
    try {
      const start = monthStartISOFromKey(selectedMonth);
      const end = monthEndISOFromKey(selectedMonth);

      // Monthly office summary (view)
      const { data: monthly, error: mErr } = await supabase
        .from("v_monthly_office_summary")
        .select("month_start,department,dept_total,dept_present,dept_rate")
        .gte("month_start", start)
        .lt("month_start", end);

      if (mErr) {
        alert(`Monthly summary load failed: ${mErr.message}`);
        return;
      }

      const monthlySorted = (monthly as MonthlyOfficeSummary[])
        .slice()
        .sort((a, b) => b.dept_rate - a.dept_rate || b.dept_present - a.dept_present);

      // Sessions in the month
      const { data: ses, error: sErr } = await supabase
        .from("sessions")
        .select("session_id,event_name,started_at")
        .gte("started_at", start)
        .lt("started_at", end)
        .order("started_at", { ascending: true });

      if (sErr) {
        alert(`Sessions load failed: ${sErr.message}`);
        return;
      }

      // Active employee totals by department
      const { data: totals, error: tErr } = await supabase
        .from("employees")
        .select("department")
        .eq("is_active", true);

      if (tErr) {
        alert(`Active employee load failed: ${tErr.message}`);
        return;
      }

      const deptTotalsMap: Record<string, number> = {};
      (totals as any[]).forEach((r) => {
        deptTotalsMap[r.department] = (deptTotalsMap[r.department] ?? 0) + 1;
      });

      const sessionIds = (ses as any[]).map((s) => s.session_id);
      let enriched: any[] = [];
      if (sessionIds.length) {
        const { data: enr, error: eErr } = await supabase
          .from("v_attendance_enriched")
          .select("session_id,event_name,started_at,employee_id,department")
          .in("session_id", sessionIds);

        if (eErr) {
          alert(`Monthly attendance load failed: ${eErr.message}`);
          return;
        }
        enriched = (enr as any[]) ?? [];
      }

      const bySessionDept: Record<string, { [dept: string]: Set<string> }> = {};
      enriched.forEach((r) => {
        const sid = r.session_id;
        const dept = r.department;
        const emp = r.employee_id;
        if (!bySessionDept[sid]) bySessionDept[sid] = {};
        if (!bySessionDept[sid][dept]) bySessionDept[sid][dept] = new Set<string>();
        bySessionDept[sid][dept].add(emp);
      });

      const sessionOfficeRows: SessionOfficeRow[] = [];
      (ses as any[]).forEach((s) => {
        const sid = s.session_id;
        const started = s.started_at;
        const ev = s.event_name;
        const month_start = start;

        const deptMap = bySessionDept[sid] ?? {};
        const allDepts = Object.keys(deptTotalsMap).sort((a, b) => a.localeCompare(b));

        allDepts.forEach((dept) => {
          const total = deptTotalsMap[dept] ?? 0;
          const present = deptMap[dept] ? deptMap[dept].size : 0;
          const rate = total ? Math.round((present / total) * 1000) / 10 : 0;
          sessionOfficeRows.push({
            month_start,
            session_id: sid,
            started_at: started,
            event_name: ev,
            department: dept,
            dept_total: total,
            dept_present: present,
            dept_rate: rate,
          });
        });
      });

      const wb = new ExcelJS.Workbook();

      const s1 = wb.addWorksheet("Monthly Summary");
      s1.addRow(["Month", selectedMonth]);
      s1.addRow([]);
      s1.addRow(["Department", "Present (unique)", "Total", "Rate (%)"]);
      monthlySorted.forEach((d) => {
        s1.addRow([d.department, d.dept_present, d.dept_total, d.dept_rate]);
      });
      s1.columns.forEach((c) => (c.width = 24));

      const s2 = wb.addWorksheet("Sessions Breakdown");
      s2.addRow(["Session Date (PH)", "Event Name", "Session ID", "Department", "Present", "Total", "Rate (%)"]);
      sessionOfficeRows.forEach((r) => {
        s2.addRow([formatPH(r.started_at), r.event_name, r.session_id, r.department, r.dept_present, r.dept_total, r.dept_rate]);
      });
      s2.columns.forEach((c) => (c.width = 24));

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      saveAs(blob, `Monthly_Trend_${selectedMonth}.xlsx`);
    } finally {
      setMonthlyLoading(false);
    }
  }

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-title">Menu</div>

        <a className="sidebar-link" href="/dashboard">Dashboard</a>
        <a className="sidebar-link" href="/scanner">Scanner</a>
        <a className="sidebar-link active" href="/reports">Reports</a>

        {role === "app_master" && <a className="sidebar-link" href="/masterlist">Masterlist</a>}

        <div style={{ height: 10 }} />
        <SignOutButton />
      </aside>

      <section className="content">
        <div className="content-header">
          <div>
            <div className="page-title">Reports</div>
            <div className="page-subtitle">Export any session and monthly trends.</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
          {/* Past/Current session export */}
          <div className="card">
            <div className="card-title">Session export</div>
            <div className="card-subtitle">
              Select a session (active or ended) then export Excel (Summary + Raw).
            </div>

            <div className="field">
              <label className="label">Select session</label>
              <select
                className="input"
                value={selectedSessionId}
                onChange={(e) => setSelectedSessionId(e.target.value)}
              >
                {sessions.map((s) => (
                  <option key={s.session_id} value={s.session_id}>
                    {s.status === "active" ? "[ACTIVE] " : ""}
                    {formatPH(s.started_at)} — {s.event_name} ({s.session_id})
                  </option>
                ))}
              </select>
            </div>

            {selectedSession && (
              <div className="hint" style={{ marginBottom: 12 }}>
                <b>{selectedSession.event_name}</b> • {formatPH(selectedSession.started_at)} •{" "}
                {selectedSession.status.toUpperCase()}
              </div>
            )}

            <button
              className="btn btn-orange"
              disabled={!selectedSession || exportLoading}
              onClick={exportSelectedSession}
            >
              {exportLoading ? "Exporting..." : "Export selected session (Excel)"}
            </button>

            <div style={{ height: 10 }} />
            <button className="btn btn-grey" onClick={refreshSessions}>
              Refresh sessions list
            </button>
          </div>

          {/* Monthly trend export */}
          <div className="card">
            <div className="card-title">Monthly trend (on-demand)</div>
            <div className="card-subtitle">
              Generates office performance for the selected month (Excel).
            </div>

            <div className="field">
              <label className="label">Select month</label>
              <input
                className="input"
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              />
            </div>

            <button className="btn btn-grey" disabled={monthlyLoading} onClick={exportMonthlyTrend}>
              {monthlyLoading ? "Generating..." : "Export monthly trend (Excel)"}
            </button>

            <div className="hint" style={{ marginTop: 10 }}>
              Sheets: Monthly Summary + Sessions Breakdown.
            </div>
          </div>
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
