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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Default selection: active session if present, else most recent
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

    // Raw attendance (PRESENT)
    const { data: raw, error: rawErr } = await supabase
      .from("v_session_raw_attendance")
      .select("employee_id,full_name,department,method,recorded_at")
      .eq("session_id", session_id);

    if (rawErr) {
      alert(`Raw export failed: ${rawErr.message}`);
      return;
    }

    // ALL ACTIVE EMPLOYEES (for ABSENT computation)
    const { data: employees, error: empErr } = await supabase
      .from("employees")
      .select("employee_id,full_name,department")
      .eq("is_active", true);

    if (empErr) {
      alert(`Employee load failed: ${empErr.message}`);
      return;
    }

    const presentIds = new Set(
      (raw ?? []).map((r: any) => String(r.employee_id))
    );

    const absent = (employees ?? []).filter(
      (e: any) => !presentIds.has(String(e.employee_id))
    );

    const wb = new ExcelJS.Workbook();

    /* =========================
       Sheet 1: Summary
       ========================= */
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

    /* =========================
       Sheet 2: Raw Attendance (Present)
       ========================= */
    const s2 = wb.addWorksheet("Raw Attendance");
    s2.addRow(["Employee ID", "Full Name", "Department", "Method", "Recorded At (PH)"]);
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

    /* =========================
       Sheet 3: Absent
       ========================= */
    const s3 = wb.addWorksheet("Absent");
    s3.addRow(["Employee ID", "Full Name", "Department"]);
    absent.forEach((e: any) => {
      s3.addRow([e.employee_id, e.full_name, e.department]);
    });
    s3.columns.forEach((c) => (c.width = 26));

    console.log("ABSENT COUNT:", absent.length);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const dateTag = (selectedSession.started_at || new Date().toISOString()).slice(0, 10);
    const fname = `Attendance_Summary_${selectedSession.event_name.replace(/\s+/g, "_")}_${dateTag}.xlsx`;

    saveAs(blob, fname);
  } finally {
    setExportLoading(false);
  }
}


  // Monthly export: ALL sessions become columns + average %
  async function exportMonthlyTrend() {
    setMonthlyLoading(true);
    try {
      const start = monthStartISOFromKey(selectedMonth);
      const end = monthEndISOFromKey(selectedMonth);

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

      const sessionsList = (ses as any[]) ?? [];
      const sessionIds = sessionsList.map((s) => s.session_id);

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
        const dept = String(r.department ?? "").trim();
        if (!dept) return;
        deptTotalsMap[dept] = (deptTotalsMap[dept] ?? 0) + 1;
      });

      const departments = Object.keys(deptTotalsMap).sort((a, b) => a.localeCompare(b));

      // Attendance rows for those sessions (for per-session presence)
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

      // presentSets[dept][session_id] => Set(employee_id)
      const presentSets: Record<string, Record<string, Set<string>>> = {};
      enriched.forEach((r) => {
        const dept = String(r.department ?? "").trim();
        const sid = String(r.session_id ?? "");
        const emp = String(r.employee_id ?? "");
        if (!dept || !sid || !emp) return;

        if (!presentSets[dept]) presentSets[dept] = {};
        if (!presentSets[dept][sid]) presentSets[dept][sid] = new Set<string>();
        presentSets[dept][sid].add(emp);
      });

      // Sessions Breakdown sheet rows
      const sessionOfficeRows: SessionOfficeRow[] = [];
      sessionsList.forEach((s) => {
        const sid = s.session_id;
        const started = s.started_at;
        const ev = s.event_name;

        departments.forEach((dept) => {
          const total = deptTotalsMap[dept] ?? 0;
          const present = presentSets[dept]?.[sid]?.size ?? 0;
          const rate = total ? Math.round((present / total) * 1000) / 10 : 0;

          sessionOfficeRows.push({
            month_start: start,
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

      // Sheet 1: Pivot-style monthly report
      const s1 = wb.addWorksheet("Monthly Report");
      s1.addRow(["Month", selectedMonth]);
      s1.addRow([]);

      const header: string[] = ["Office", "Total employees"];
      sessionsList.forEach((s) => {
        const dt = formatPH(s.started_at);
        const ev = String(s.event_name ?? "").trim();
        const evShort = ev.length > 18 ? ev.slice(0, 18) + "…" : ev;
        header.push(`${dt} - ${evShort}`);
      });
      header.push("Average (%)");

      s1.addRow(header);

      // Header row is the 3rd row (after Month row + blank row)
      const hdrRow = s1.getRow(3);
      hdrRow.font = { bold: true };
      hdrRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };

      departments.forEach((dept) => {
        const total = deptTotalsMap[dept] ?? 0;

        let sumRate = 0;
        let count = 0;

        const row: any[] = [dept, total];

        sessionsList.forEach((s) => {
          const sid = s.session_id;
          const present = presentSets[dept]?.[sid]?.size ?? 0;
          const rate = total ? Math.round((present / total) * 1000) / 10 : 0;

          sumRate += rate;
          count += 1;

          row.push(`${present} (${rate.toFixed(1)}%)`);
        });

        const avg = count ? Math.round((sumRate / count) * 10) / 10 : 0;
        row.push(`${avg.toFixed(1)}%`);

        s1.addRow(row);
      });

      // widths + freeze
      const totalCols = header.length;
      for (let c = 1; c <= totalCols; c++) {
        const col = s1.getColumn(c);
        if (c === 1) col.width = 28;
        else if (c === 2) col.width = 16;
        else if (c === totalCols) col.width = 16;
        else col.width = 26;
      }
      s1.views = [{ state: "frozen", ySplit: 3, xSplit: 2 }];

      // Sheet 2: Sessions Breakdown
      const s2 = wb.addWorksheet("Sessions Breakdown");
      s2.addRow(["Session Date (PH)", "Event Name", "Session ID", "Department", "Present", "Total", "Rate (%)"]);
      sessionOfficeRows.forEach((r) => {
        s2.addRow([
          formatPH(r.started_at),
          r.event_name,
          r.session_id,
          r.department,
          r.dept_present,
          r.dept_total,
          r.dept_rate,
        ]);
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

        <a className="sidebar-link" href="/dashboard">
          Dashboard
        </a>
        <a className="sidebar-link" href="/scanner">
          Scanner
        </a>
        <a className="sidebar-link active" href="/reports">
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
            <div className="page-title">Reports</div>
            <div className="page-subtitle">Export any session and monthly trends.</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
          {/* Session export */}
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

            <button className="btn btn-blue" disabled={monthlyLoading} onClick={exportMonthlyTrend}>
              {monthlyLoading ? "Generating..." : "Export monthly trend (Excel)"}
            </button>

            <div className="hint" style={{ marginTop: 10 }}>
              Sheets: Monthly Report + Sessions Breakdown.
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


