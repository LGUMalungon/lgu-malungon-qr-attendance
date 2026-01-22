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
