import { useState, useEffect, useRef } from "react";

// ---------- date helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const addDays = (ds, n) => {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dateStr(dt);
};
const prettyDate = (ds) => {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
};
const shortDay = (ds) => {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short" });
};
const dayOfWeek = (ds) => {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=Sun … 6=Sat
};
// Monday-first ordering for day pickers
const WEEK = [
  { v: 1, l: "Mon" }, { v: 2, l: "Tue" }, { v: 3, l: "Wed" }, { v: 4, l: "Thu" },
  { v: 5, l: "Fri" }, { v: 6, l: "Sat" }, { v: 0, l: "Sun" },
];

const CATEGORIES = ["Compliance", "Projects", "Admin", "Meetings", "Personal"];
const CAT_COLORS = {
  Compliance: "#0B6E4F", Projects: "#1F5FA8", Admin: "#6B5CA5",
  Meetings: "#C77D1F", Personal: "#8A6A4F",
};
const STORE_KEY = "daylog:data";
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Storage adapter: uses the browser's localStorage when hosted (e.g. on Vercel),
// falls back to window.storage when running inside a Claude artifact.
const store = {
  async get(key) {
    if (typeof window !== "undefined" && window.localStorage) {
      const v = window.localStorage.getItem(key);
      return v == null ? null : { key, value: v };
    }
    return window.storage.get(key);
  },
  async set(key, value) {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, value);
      return { key, value };
    }
    return window.storage.set(key, value);
  },
};

const emptyDay = () => ({ tasks: [], closed: false, note: "", summary: null });

export default function DailyTaskSystem() {
  const [data, setData] = useState(null); // { days: {} }
  const [viewDate, setViewDate] = useState(todayStr());
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [category, setCategory] = useState("Compliance");
  const [priority, setPriority] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [reviewChoices, setReviewChoices] = useState({});
  const [saveState, setSaveState] = useState("idle");
  const saveTimer = useRef(null);
  const [now, setNow] = useState(Date.now());
  const [showReminder, setShowReminder] = useState(false);
  const notifiedRef = useRef(0);
  const REMIND_MS = 2 * 60 * 60 * 1000; // 2 hours
  // sidebar + recurring tasks
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [rTitle, setRTitle] = useState("");
  const [rTime, setRTime] = useState("");
  const [rCategory, setRCategory] = useState("Compliance");
  const [rHigh, setRHigh] = useState(false);
  const [rDays, setRDays] = useState([1, 2, 3, 4, 5]); // default Mon–Fri
  const [showReport, setShowReport] = useState(false);
  const [copied, setCopied] = useState(false);

  // ---------- load ----------
  useEffect(() => {
    (async () => {
      try {
        const res = await store.get(STORE_KEY);
        const parsed = res ? JSON.parse(res.value) : { days: {} };
        const safe = parsed && parsed.days ? parsed : { days: {} };
        if (!safe.settings) safe.settings = { reminders: true, lastReminderAt: Date.now() };
        if (!safe.recurring) safe.recurring = [];
        setData(safe);
      } catch {
        setData({ days: {}, recurring: [], settings: { reminders: true, lastReminderAt: Date.now() } });
      }
    })();
  }, []);

  // materialize recurring tasks into today + the viewed day (never past days, never closed days)
  useEffect(() => {
    if (!data || !(data.recurring || []).length) return;
    const targets = [...new Set([todayStr(), viewDate])].filter((ds) => ds >= todayStr());
    let changed = false;
    const nextDays = { ...data.days };
    for (const ds of targets) {
      const d = nextDays[ds] || emptyDay();
      if (d.closed) continue;
      const added = d.recAdded || [];
      const dow = dayOfWeek(ds);
      const toAdd = data.recurring.filter(
        (r) => r.active !== false && (r.days || []).includes(dow) && !added.includes(r.id)
      );
      if (!toAdd.length) continue;
      nextDays[ds] = {
        ...d,
        tasks: [
          ...d.tasks,
          ...toAdd.map((r) => ({
            id: uid(), title: r.title, time: r.time || "", category: r.category,
            high: !!r.high, done: false, doneAt: null, moves: 0, recId: r.id,
          })),
        ],
        recAdded: [...added, ...toAdd.map((r) => r.id)],
      };
      changed = true;
    }
    if (changed) persist({ ...data, days: nextDays });
  }, [data, viewDate]);

  // clock tick (every 30s) so reminders can fire
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(iv);
  }, []);

  // fire a reminder every 2 hours while there are pending tasks today
  useEffect(() => {
    if (!data) return;
    const settings = data.settings || {};
    if (settings.reminders === false) return;
    const td = data.days[todayStr()];
    const pending = td && !td.closed ? td.tasks.filter((t) => !t.done) : [];
    if (pending.length === 0) return;
    const last = settings.lastReminderAt || 0;
    if (now - last >= REMIND_MS) {
      setShowReminder(true);
      if (notifiedRef.current !== last) {
        notifiedRef.current = last;
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Mike's Day Book", {
              body: `${pending.length} pending task${pending.length > 1 ? "s" : ""}: ${pending.slice(0, 3).map((t) => t.title).join(", ")}${pending.length > 3 ? "…" : ""}`,
            });
          }
        } catch {}
      }
    }
  }, [now, data]);

  // ---------- save (debounced) ----------
  const persist = (next) => {
    setData(next);
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await store.set(STORE_KEY, JSON.stringify(next));
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1500);
      } catch {
        setSaveState("error");
      }
    }, 400);
  };

  if (!data) {
    return (
      <div style={{ ...S.page, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <div style={{ color: "#6B7A88", fontSize: 15 }}>Opening Mike's Day Book…</div>
      </div>
    );
  }

  const day = data.days[viewDate] || emptyDay();
  const isToday = viewDate === todayStr();
  const isPast = viewDate < todayStr();
  const tasks = day.tasks;
  const doneCount = tasks.filter((t) => t.done).length;
  const openCount = tasks.length - doneCount;

  const updateDay = (ds, updater) => {
    const cur = data.days[ds] || emptyDay();
    const nextDay = updater(cur);
    persist({ ...data, days: { ...data.days, [ds]: nextDay } });
  };

  // ---------- reminders ----------
  const remindersOn = data.settings?.reminders !== false;
  const lastReminderAt = data.settings?.lastReminderAt || Date.now();
  const todayData = data.days[todayStr()];
  const pendingToday = todayData && !todayData.closed ? todayData.tasks.filter((t) => !t.done) : [];
  const msToNext = Math.max(0, REMIND_MS - (now - lastReminderAt));
  const nextIn = `${Math.floor(msToNext / 3600000)}h ${Math.floor((msToNext % 3600000) / 60000)}m`;

  const dismissReminder = () => {
    setShowReminder(false);
    persist({ ...data, settings: { ...(data.settings || {}), reminders: true, lastReminderAt: Date.now() } });
  };

  const toggleReminders = () => {
    if (!remindersOn) {
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
      } catch {}
    }
    setShowReminder(false);
    persist({ ...data, settings: { ...(data.settings || {}), reminders: !remindersOn, lastReminderAt: Date.now() } });
  };

  // ---------- recurring tasks ----------
  const addRecurring = () => {
    const t = rTitle.trim();
    if (!t || rDays.length === 0) return;
    persist({
      ...data,
      recurring: [...(data.recurring || []), { id: uid(), title: t, time: rTime, category: rCategory, high: rHigh, days: [...rDays].sort(), active: true }],
    });
    setRTitle(""); setRTime(""); setRHigh(false); setRDays([1, 2, 3, 4, 5]);
  };

  const toggleRecurringActive = (id) => {
    persist({ ...data, recurring: data.recurring.map((r) => (r.id === id ? { ...r, active: r.active === false } : r)) });
  };

  const deleteRecurring = (id) => {
    persist({ ...data, recurring: data.recurring.filter((r) => r.id !== id) });
  };

  const daysLabel = (days) => {
    const s = [...days].sort().join(",");
    if (s === "1,2,3,4,5") return "Mon–Fri";
    if (s === "0,1,2,3,4,5,6") return "Every day";
    if (s === "0,6") return "Weekends";
    return WEEK.filter((w) => days.includes(w.v)).map((w) => w.l).join(", ");
  };

  // ---------- end-of-day report (for the viewed day) ----------
  const buildReport = () => {
    const completed = tasks.filter((t) => t.done);
    const resched = day.summary ? day.summary.rescheduled : [];
    const dropped = day.summary ? day.summary.dropped : [];
    const stillPending = day.closed ? [] : tasks.filter((t) => !t.done);
    const total = completed.length + resched.length + dropped.length + stillPending.length;
    const pct = total ? Math.round((completed.length / total) * 100) : 0;
    const byCat = {};
    completed.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + 1; });
    return { completed, resched, dropped, stillPending, total, pct, byCat };
  };

  const reportText = () => {
    const r = buildReport();
    const lines = [];
    lines.push("MIKE'S DAY BOOK — DAILY REPORT");
    lines.push(prettyDate(viewDate) + (day.closed ? " (day closed)" : " (in progress)"));
    lines.push("");
    lines.push(`Score: ${r.completed.length}/${r.total} completed (${r.pct}%)`);
    if (r.completed.length) {
      lines.push("");
      lines.push("COMPLETED:");
      r.completed.forEach((t) => lines.push(`  ✓ ${t.title}${t.doneAt ? ` (${t.doneAt})` : ""}`));
    }
    if (r.resched.length) {
      lines.push("");
      lines.push("RESCHEDULED TO NEXT DAY:");
      r.resched.forEach((t) => lines.push(`  → ${t}`));
    }
    if (r.dropped.length) {
      lines.push("");
      lines.push("DROPPED:");
      r.dropped.forEach((t) => lines.push(`  ✕ ${t}`));
    }
    if (r.stillPending.length) {
      lines.push("");
      lines.push("STILL PENDING:");
      r.stillPending.forEach((t) => lines.push(`  • ${t.title}`));
    }
    const cats = Object.entries(r.byCat);
    if (cats.length) {
      lines.push("");
      lines.push("BY CATEGORY: " + cats.map(([c, n]) => `${c} ${n}`).join(" · "));
    }
    if (day.note && day.note.trim()) {
      lines.push("");
      lines.push("NOTES: " + day.note.trim());
    }
    return lines.join("\n");
  };

  const copyReport = async () => {
    const text = reportText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
      } catch {}
    }
    setTimeout(() => setCopied(false), 2000);
  };

  // ---------- actions ----------
  const addTask = () => {
    const t = title.trim();
    if (!t) return;
    updateDay(viewDate, (d) => ({
      ...d,
      tasks: [...d.tasks, { id: uid(), title: t, time: time || "", category, high: priority, done: false, doneAt: null, moves: 0 }],
    }));
    setTitle(""); setTime(""); setPriority(false);
  };

  const toggleDone = (id) => {
    updateDay(viewDate, (d) => ({
      ...d,
      tasks: d.tasks.map((t) =>
        t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null } : t
      ),
    }));
  };

  const deleteTask = (id) => {
    updateDay(viewDate, (d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) }));
  };

  const moveToTomorrow = (id) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const tomorrow = addDays(viewDate, 1);
    const next = { ...data, days: { ...data.days } };
    const curDay = next.days[viewDate] || emptyDay();
    next.days[viewDate] = { ...curDay, tasks: curDay.tasks.filter((t) => t.id !== id) };
    const tmDay = next.days[tomorrow] || emptyDay();
    next.days[tomorrow] = {
      ...tmDay,
      tasks: [...tmDay.tasks, { ...task, done: false, doneAt: null, moves: (task.moves || 0) + 1, movedFrom: viewDate }],
    };
    persist(next);
  };

  const setNote = (note) => updateDay(viewDate, (d) => ({ ...d, note }));

  // ---------- close the day ----------
  const openReview = () => {
    const choices = {};
    tasks.filter((t) => !t.done).forEach((t) => (choices[t.id] = "move"));
    setReviewChoices(choices);
    setShowReview(true);
  };

  const confirmClose = () => {
    const tomorrow = addDays(viewDate, 1);
    const next = { ...data, days: { ...data.days } };
    const curDay = next.days[viewDate] || emptyDay();
    const completed = curDay.tasks.filter((t) => t.done);
    const undone = curDay.tasks.filter((t) => !t.done);
    const moved = undone.filter((t) => reviewChoices[t.id] !== "drop");
    const dropped = undone.filter((t) => reviewChoices[t.id] === "drop");

    // keep completed + a record of what happened; remove moved/dropped from today’s list
    next.days[viewDate] = {
      ...curDay,
      tasks: completed,
      closed: true,
      summary: {
        completed: completed.map((t) => t.title),
        rescheduled: moved.map((t) => t.title),
        dropped: dropped.map((t) => t.title),
        closedAt: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      },
    };
    if (moved.length) {
      const tmDay = next.days[tomorrow] || emptyDay();
      next.days[tomorrow] = {
        ...tmDay,
        tasks: [...tmDay.tasks, ...moved.map((t) => ({ ...t, done: false, doneAt: null, moves: (t.moves || 0) + 1, movedFrom: viewDate }))],
      };
    }
    persist(next);
    setShowReview(false);
    setShowReport(true); // show the end-of-day report right after closing
  };

  const reopenDay = () => updateDay(viewDate, (d) => ({ ...d, closed: false, summary: d.summary }));

  // ---------- stats (last 7 days) ----------
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const ds = addDays(todayStr(), -i);
    const dd = data.days[ds];
    let done = 0, total = 0;
    if (dd) {
      if (dd.summary) {
        done = dd.summary.completed.length;
        total = done + dd.summary.rescheduled.length + dd.summary.dropped.length;
      } else {
        done = dd.tasks.filter((t) => t.done).length;
        total = dd.tasks.length;
      }
    }
    last7.push({ ds, done, total });
  }
  let streak = 0;
  for (let i = 0; ; i++) {
    const ds = addDays(todayStr(), -i);
    const dd = data.days[ds];
    const done = dd ? (dd.summary ? dd.summary.completed.length : dd.tasks.filter((t) => t.done).length) : 0;
    if (done > 0) streak++;
    else if (i === 0) { /* today may not be done yet — don’t break streak */ if (!dd) break; if (done === 0) { /* allow today */ } }
    else break;
    if (i > 365) break;
  }

  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.high !== b.high) return a.high ? -1 : 1;
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  });

  return (
    <div style={S.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button { cursor: pointer; font-family: inherit; }
        input, select, textarea { font-family: inherit; }
        input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid #0B6E4F; outline-offset: 1px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      {/* header */}
      <header style={S.header}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <button style={S.hamburger} onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
          <div>
          <div style={S.eyebrow}>MIKE'S DAY BOOK</div>
          <h1 style={S.h1}>{prettyDate(viewDate)}</h1>
          <div style={S.sub}>
            {isToday ? "Today" : isPast ? "Past day" : "Upcoming"} · {tasks.length} task{tasks.length !== 1 ? "s" : ""}
            {tasks.length > 0 && ` · ${doneCount} done`}
            {saveState === "saving" && " · saving…"}
            {saveState === "saved" && " · saved ✓"}
            {saveState === "error" && " · ⚠ could not save"}
          </div>
          <button style={{ ...S.togglePill, borderColor: remindersOn ? "#0B6E4F" : "#C9D3DB", color: remindersOn ? "#0B6E4F" : "#8A97A3" }} onClick={toggleReminders}>
            ⏰ 2-hour reminders: {remindersOn ? "On" : "Off"}
            {remindersOn && pendingToday.length > 0 && ` · next in ${nextIn}`}
          </button>
          </div>
        </div>
        <div style={S.nav}>
          <button style={S.navBtn} onClick={() => setViewDate(addDays(viewDate, -1))} aria-label="Previous day">‹</button>
          <button style={{ ...S.navBtn, width: "auto", padding: "0 12px", fontSize: 13 }} onClick={() => setViewDate(todayStr())}>Today</button>
          <button style={S.navBtn} onClick={() => setViewDate(addDays(viewDate, 1))} aria-label="Next day">›</button>
        </div>
      </header>

      {/* sidebar drawer */}
      {sidebarOpen && (
        <div style={S.overlay} onClick={() => setSidebarOpen(false)}>
          <aside style={S.sidebar} onClick={(e) => e.stopPropagation()} aria-label="Menu">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <div style={S.brandIcon}>✓</div>
              <div>
                <div style={{ ...S.eyebrow, fontSize: 12 }}>MIKE'S</div>
                <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 18, lineHeight: 1 }}>Day Book</div>
              </div>
            </div>

            <button style={S.sideItem} onClick={() => { setViewDate(todayStr()); setSidebarOpen(false); }}>
              📅 Today
              {pendingToday.length > 0 && <span style={S.sideBadge}>{pendingToday.length}</span>}
            </button>
            <button style={S.sideItem} onClick={() => { setShowRecurring(true); setSidebarOpen(false); }}>
              ↻ Recurring tasks
              {(data.recurring || []).filter((r) => r.active !== false).length > 0 && (
                <span style={S.sideBadge}>{data.recurring.filter((r) => r.active !== false).length}</span>
              )}
            </button>
            <button style={S.sideItem} onClick={() => { setShowReport(true); setSidebarOpen(false); }}>
              📋 Day report
            </button>
            <button style={S.sideItem} onClick={toggleReminders}>
              ⏰ Reminders <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: remindersOn ? "#0B6E4F" : "#8A97A3" }}>{remindersOn ? "ON" : "OFF"}</span>
            </button>

            <div style={S.sideDivider} />
            <div style={{ ...S.eyebrow, fontSize: 10, marginBottom: 6 }}>THIS WEEK</div>
            {last7.slice().reverse().map((d) => (
              <button key={d.ds} style={{ ...S.sideItem, padding: "7px 10px", fontSize: 13, background: d.ds === viewDate ? "#0B6E4F12" : "transparent" }}
                onClick={() => { setViewDate(d.ds); setSidebarOpen(false); }}>
                {d.ds === todayStr() ? "Today" : `${shortDay(d.ds)} ${d.ds.slice(8)}`}
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#6B7A88" }}>{d.total ? `${d.done}/${d.total}` : "—"}</span>
              </button>
            ))}

            <div style={S.sideDivider} />
            <div style={{ fontSize: 11.5, color: "#8A97A3", lineHeight: 1.5 }}>Your tasks stay on this device.</div>
          </aside>
        </div>
      )}

      {/* recurring tasks manager */}
      {showRecurring && (
        <div style={S.overlay} onClick={() => setShowRecurring(false)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.eyebrow}>RECURRING TASKS</div>
            <h2 style={{ ...S.h1, fontSize: 20, margin: "4px 0 4px" }}>Repeat on chosen days</h2>
            <p style={{ fontSize: 13, color: "#6B7A88", margin: "0 0 12px" }}>These are added to your list automatically on the days you pick.</p>

            <input style={S.input} placeholder="e.g. Review transaction monitoring alerts" value={rTitle}
              onChange={(e) => setRTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addRecurring()} />
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {WEEK.map((w) => (
                <button key={w.v}
                  style={{ ...S.dayChip, background: rDays.includes(w.v) ? "#0B6E4F" : "#fff", color: rDays.includes(w.v) ? "#fff" : "#16232E", borderColor: rDays.includes(w.v) ? "#0B6E4F" : "#D5DDE4" }}
                  onClick={() => setRDays(rDays.includes(w.v) ? rDays.filter((x) => x !== w.v) : [...rDays, w.v])}
                  aria-pressed={rDays.includes(w.v)}>
                  {w.l}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button style={{ ...S.chipBtn, fontSize: 12, borderColor: "#D5DDE4", color: "#16232E" }} onClick={() => setRDays([1, 2, 3, 4, 5])}>Mon–Fri</button>
              <button style={{ ...S.chipBtn, fontSize: 12, borderColor: "#D5DDE4", color: "#16232E" }} onClick={() => setRDays([0, 1, 2, 3, 4, 5, 6])}>Every day</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <input type="time" style={{ ...S.input, width: 110, flex: "none" }} value={rTime} onChange={(e) => setRTime(e.target.value)} aria-label="Time (optional)" />
              <select style={{ ...S.input, width: 130, flex: "none" }} value={rCategory} onChange={(e) => setRCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
              <button style={{ ...S.chipBtn, background: rHigh ? "#B3402E" : "#fff", color: rHigh ? "#fff" : "#B3402E", borderColor: "#B3402E" }} onClick={() => setRHigh(!rHigh)}>★</button>
              <button style={S.primaryBtn} onClick={addRecurring}>Add</button>
            </div>

            <div style={{ ...S.reviewSection, marginTop: 16 }}>
              <div style={S.reviewLabel}>Your recurring tasks ({(data.recurring || []).length})</div>
              {(data.recurring || []).length === 0 && <div style={S.reviewEmptyLine}>None yet — add your first above.</div>}
              {(data.recurring || []).map((r) => (
                <div key={r.id} style={{ ...S.reviewLine, display: "flex", alignItems: "center", gap: 8, opacity: r.active === false ? 0.5 : 1 }}>
                  <span style={{ flex: 1, minWidth: 120 }}>
                    {r.high && <span style={S.star}>★ </span>}{r.title}
                    <span style={{ display: "block", fontSize: 12, color: "#6B7A88" }}>{daysLabel(r.days || [])}{r.time ? ` · ${r.time}` : ""} · {r.category}</span>
                  </span>
                  <button style={{ ...S.chipBtn, fontSize: 12, borderColor: "#D5DDE4", color: "#16232E" }} onClick={() => toggleRecurringActive(r.id)}>
                    {r.active === false ? "Resume" : "Pause"}
                  </button>
                  <button style={{ ...S.iconBtn, color: "#B3402E" }} onClick={() => deleteRecurring(r.id)} aria-label="Delete recurring task">✕</button>
                </div>
              ))}
            </div>

            <button style={{ ...S.ghostBtn, width: "100%", marginTop: 14 }} onClick={() => setShowRecurring(false)}>Done</button>
          </div>
        </div>
      )}

      {/* 2-hour reminder banner */}
      {showReminder && remindersOn && pendingToday.length > 0 && (
        <div style={S.reminderBanner} role="alert">
          <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 14, letterSpacing: 0.5 }}>
            ⏰ REMINDER — {pendingToday.length} pending task{pendingToday.length > 1 ? "s" : ""} today
          </div>
          <div style={{ marginTop: 6 }}>
            {pendingToday.slice(0, 4).map((t) => (
              <div key={t.id} style={{ fontSize: 13.5, padding: "2px 0" }}>
                {t.high && <span style={{ color: "#FFD9A0" }}>★ </span>}{t.title}{t.time ? ` · ${t.time}` : ""}
              </div>
            ))}
            {pendingToday.length > 4 && <div style={{ fontSize: 12.5, opacity: 0.85 }}>…and {pendingToday.length - 4} more</div>}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {!isToday && (
              <button style={{ ...S.chipBtn, background: "#fff", color: "#16232E", borderColor: "#fff" }} onClick={() => { setViewDate(todayStr()); dismissReminder(); }}>
                Go to today
              </button>
            )}
            <button style={{ ...S.chipBtn, background: "transparent", color: "#fff", borderColor: "#ffffff88" }} onClick={dismissReminder}>
              Got it — remind me in 2 hrs
            </button>
          </div>
        </div>
      )}

      {/* closed-day stamp */}
      {day.closed && day.summary && (
        <div style={S.closedCard}>
          <div style={S.stamp}>DAY CLOSED · {day.summary.closedAt}</div>
          <SummaryBlock summary={day.summary} />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={S.ghostBtn} onClick={() => setShowReport(true)}>📋 View full report</button>
            <button style={S.ghostBtn} onClick={reopenDay}>Reopen this day</button>
          </div>
        </div>
      )}

      {/* end-of-day report modal */}
      {showReport && (() => {
        const r = buildReport();
        return (
          <div style={S.overlay} onClick={() => setShowReport(false)}>
            <div style={S.modal} onClick={(e) => e.stopPropagation()}>
              <div style={S.eyebrow}>END-OF-DAY REPORT</div>
              <h2 style={{ ...S.h1, fontSize: 21, margin: "4px 0 2px" }}>{prettyDate(viewDate)}</h2>
              <div style={{ fontSize: 12.5, color: "#6B7A88", marginBottom: 12 }}>{day.closed ? `Day closed${day.summary?.closedAt ? " at " + day.summary.closedAt : ""}` : "Day still in progress"}</div>

              {/* score ring */}
              <div style={{ display: "flex", alignItems: "center", gap: 14, background: "#F3F8F5", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 34, color: "#0B6E4F", lineHeight: 1 }}>{r.pct}%</div>
                <div style={{ fontSize: 13.5, color: "#16232E" }}>
                  <strong>{r.completed.length}</strong> of <strong>{r.total}</strong> tasks completed
                  {r.resched.length > 0 && <span style={{ color: "#C77D1F" }}> · {r.resched.length} rescheduled</span>}
                  {r.dropped.length > 0 && <span style={{ color: "#B3402E" }}> · {r.dropped.length} dropped</span>}
                  {r.stillPending.length > 0 && <span> · {r.stillPending.length} pending</span>}
                </div>
              </div>

              <div style={S.reviewSection}>
                <div style={S.reviewLabel}>✓ Completed ({r.completed.length})</div>
                {r.completed.length === 0 && <div style={S.reviewEmptyLine}>Nothing completed{day.closed ? "" : " yet"}.</div>}
                {r.completed.map((t) => (
                  <div key={t.id} style={S.reviewLine}>{t.title}{t.doneAt && <span style={{ color: "#8A97A3" }}> · {t.doneAt}</span>}</div>
                ))}
              </div>

              {r.resched.length > 0 && (
                <div style={S.reviewSection}>
                  <div style={{ ...S.reviewLabel, color: "#C77D1F" }}>→ Rescheduled to next day ({r.resched.length})</div>
                  {r.resched.map((t, i) => <div key={i} style={S.reviewLine}>{t}</div>)}
                </div>
              )}

              {r.dropped.length > 0 && (
                <div style={S.reviewSection}>
                  <div style={{ ...S.reviewLabel, color: "#B3402E" }}>✕ Dropped ({r.dropped.length})</div>
                  {r.dropped.map((t, i) => <div key={i} style={S.reviewLine}>{t}</div>)}
                </div>
              )}

              {r.stillPending.length > 0 && (
                <div style={S.reviewSection}>
                  <div style={{ ...S.reviewLabel, color: "#6B7A88" }}>• Still pending ({r.stillPending.length})</div>
                  {r.stillPending.map((t) => <div key={t.id} style={S.reviewLine}>{t.title}</div>)}
                </div>
              )}

              {Object.keys(r.byCat).length > 0 && (
                <div style={S.reviewSection}>
                  <div style={S.reviewLabel}>By category</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    {Object.entries(r.byCat).map(([c, n]) => (
                      <span key={c} style={{ ...S.catPill, background: (CAT_COLORS[c] || "#6B7A88") + "18", color: CAT_COLORS[c] || "#6B7A88" }}>{c} · {n}</span>
                    ))}
                  </div>
                </div>
              )}

              {day.note && day.note.trim() && (
                <div style={S.reviewSection}>
                  <div style={S.reviewLabel}>Notes</div>
                  <div style={{ ...S.reviewLine, whiteSpace: "pre-wrap" }}>{day.note.trim()}</div>
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button style={{ ...S.primaryBtn, flex: 1 }} onClick={copyReport}>{copied ? "Copied ✓" : "Copy report"}</button>
                <button style={{ ...S.ghostBtn, marginTop: 0 }} onClick={() => setShowReport(false)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* add task */}
      {!day.closed && (
        <div style={S.addCard}>
          <input
            style={S.input}
            placeholder={isToday ? "What needs doing today?" : "Add a task for this day…"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTask()}
          />
          <div style={S.addRow}>
            <input type="time" style={{ ...S.input, width: 120, flex: "none" }} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time (optional)" />
            <select style={{ ...S.input, width: 140, flex: "none" }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <button
              style={{ ...S.chipBtn, background: priority ? "#B3402E" : "#fff", color: priority ? "#fff" : "#B3402E", borderColor: "#B3402E" }}
              onClick={() => setPriority(!priority)}
              aria-pressed={priority}
            >★ Priority</button>
            <button style={S.primaryBtn} onClick={addTask}>Add task</button>
          </div>
        </div>
      )}

      {/* task list */}
      <div style={{ marginTop: 16 }}>
        {sorted.length === 0 && !day.closed && (
          <div style={S.empty}>Nothing scheduled yet. Add your first task above — anything you don’t finish can roll over to tomorrow.</div>
        )}
        {sorted.map((t) => (
          <div key={t.id} style={{ ...S.task, opacity: t.done ? 0.55 : 1 }}>
            <button
              style={{ ...S.check, background: t.done ? "#0B6E4F" : "#fff", borderColor: t.done ? "#0B6E4F" : "#B9C4CE" }}
              onClick={() => toggleDone(t.id)}
              aria-label={t.done ? "Mark as not done" : "Mark as done"}
            >{t.done ? "✓" : ""}</button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...S.taskTitle, textDecoration: t.done ? "line-through" : "none" }}>
                {t.high && <span style={S.star}>★ </span>}{t.title}
              </div>
              <div style={S.taskMeta}>
                {t.time && <span style={S.timePill}>{t.time}</span>}
                <span style={{ ...S.catPill, background: (CAT_COLORS[t.category] || "#6B7A88") + "18", color: CAT_COLORS[t.category] || "#6B7A88" }}>{t.category}</span>
                {t.recId && <span style={{ ...S.movedPill, color: "#0B6E4F", background: "#0B6E4F14" }}>↻ recurring</span>}
                {t.moves > 0 && <span style={S.movedPill}>moved {t.moves}×</span>}
                {t.done && t.doneAt && <span style={{ color: "#8A97A3", fontSize: 12 }}>done {t.doneAt}</span>}
              </div>
            </div>
            {!day.closed && !t.done && (
              <button style={S.iconBtn} title="Move to tomorrow" onClick={() => moveToTomorrow(t.id)}>→ Tmrw</button>
            )}
            {!day.closed && (
              <button style={{ ...S.iconBtn, color: "#B3402E" }} title="Delete task" onClick={() => deleteTask(t.id)}>✕</button>
            )}
          </div>
        ))}
      </div>

      {/* close-the-day */}
      {!day.closed && tasks.length > 0 && (
        <button style={S.closeDayBtn} onClick={openReview}>
          Close the day · review {openCount > 0 ? `${openCount} unfinished` : "your wins"}
        </button>
      )}

      {/* daily note */}
      {!day.closed && (
        <textarea
          style={S.note}
          placeholder="Notes for this day (follow-ups, reminders, context)…"
          value={day.note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
      )}

      {/* 7-day pulse */}
      <div style={S.statsCard}>
        <div style={S.statsHead}>
          <span style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>LAST 7 DAYS</span>
          <span style={{ fontSize: 13, color: "#6B7A88" }}>{streak > 0 ? `🔥 ${streak}-day streak` : "Complete a task to start a streak"}</span>
        </div>
        <div style={S.bars}>
          {last7.map((d) => {
            const pct = d.total ? d.done / d.total : 0;
            return (
              <button key={d.ds} style={S.barCol} onClick={() => setViewDate(d.ds)} title={`${d.ds}: ${d.done}/${d.total} done`}>
                <div style={S.barTrack}>
                  <div style={{ ...S.barFill, height: `${Math.max(pct * 100, d.total ? 6 : 0)}%` }} />
                </div>
                <div style={{ fontSize: 11, color: d.ds === viewDate ? "#0B6E4F" : "#8A97A3", fontWeight: d.ds === viewDate ? 700 : 400 }}>{shortDay(d.ds)}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* review modal */}
      {showReview && (
        <div style={S.overlay} onClick={() => setShowReview(false)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.eyebrow}>END-OF-DAY REVIEW</div>
            <h2 style={{ ...S.h1, fontSize: 22, margin: "4px 0 12px" }}>{prettyDate(viewDate)}</h2>

            <div style={S.reviewSection}>
              <div style={S.reviewLabel}>✓ Completed ({doneCount})</div>
              {doneCount === 0 && <div style={S.reviewEmptyLine}>No tasks completed.</div>}
              {tasks.filter((t) => t.done).map((t) => (
                <div key={t.id} style={S.reviewLine}>{t.title}{t.doneAt ? <span style={{ color: "#8A97A3" }}> · {t.doneAt}</span> : null}</div>
              ))}
            </div>

            {openCount > 0 && (
              <div style={S.reviewSection}>
                <div style={{ ...S.reviewLabel, color: "#C77D1F" }}>Unfinished ({openCount}) — choose what happens</div>
                {tasks.filter((t) => !t.done).map((t) => (
                  <div key={t.id} style={{ ...S.reviewLine, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ flex: 1, minWidth: 140 }}>{t.title}{t.moves > 0 && <span style={S.movedPill}> moved {t.moves}×</span>}</span>
                    <button
                      style={{ ...S.chipBtn, fontSize: 12, background: reviewChoices[t.id] !== "drop" ? "#0B6E4F" : "#fff", color: reviewChoices[t.id] !== "drop" ? "#fff" : "#0B6E4F", borderColor: "#0B6E4F" }}
                      onClick={() => setReviewChoices({ ...reviewChoices, [t.id]: "move" })}
                    >→ Tomorrow</button>
                    <button
                      style={{ ...S.chipBtn, fontSize: 12, background: reviewChoices[t.id] === "drop" ? "#B3402E" : "#fff", color: reviewChoices[t.id] === "drop" ? "#fff" : "#B3402E", borderColor: "#B3402E" }}
                      onClick={() => setReviewChoices({ ...reviewChoices, [t.id]: "drop" })}
                    >Drop</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button style={{ ...S.primaryBtn, flex: 1 }} onClick={confirmClose}>Close the day</button>
              <button style={S.ghostBtn} onClick={() => setShowReview(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryBlock({ summary }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={S.reviewLabel}>✓ Completed ({summary.completed.length})</div>
      {summary.completed.length === 0 && <div style={S.reviewEmptyLine}>None</div>}
      {summary.completed.map((t, i) => <div key={i} style={S.reviewLine}>{t}</div>)}
      {summary.rescheduled.length > 0 && (
        <>
          <div style={{ ...S.reviewLabel, color: "#C77D1F", marginTop: 10 }}>→ Rescheduled to next day ({summary.rescheduled.length})</div>
          {summary.rescheduled.map((t, i) => <div key={i} style={S.reviewLine}>{t}</div>)}
        </>
      )}
      {summary.dropped.length > 0 && (
        <>
          <div style={{ ...S.reviewLabel, color: "#B3402E", marginTop: 10 }}>✕ Dropped ({summary.dropped.length})</div>
          {summary.dropped.map((t, i) => <div key={i} style={S.reviewLine}>{t}</div>)}
        </>
      )}
    </div>
  );
}

// ---------- styles ----------
const S = {
  page: {
    fontFamily: "'Inter', system-ui, sans-serif",
    maxWidth: 680, margin: "0 auto", padding: "20px 16px 48px",
    color: "#16232E", background: "transparent",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" },
  eyebrow: { fontFamily: "'Archivo', sans-serif", fontSize: 11, fontWeight: 800, letterSpacing: 2.5, color: "#0B6E4F" },
  h1: { fontFamily: "'Archivo', sans-serif", fontSize: 26, fontWeight: 800, margin: "2px 0 4px", lineHeight: 1.15 },
  sub: { fontSize: 13, color: "#6B7A88" },
  nav: { display: "flex", gap: 6 },
  navBtn: {
    width: 36, height: 36, borderRadius: 8, border: "1px solid #D5DDE4",
    background: "#fff", fontSize: 18, color: "#16232E", display: "flex", alignItems: "center", justifyContent: "center",
  },
  addCard: { marginTop: 18, background: "#fff", border: "1px solid #E1E7EC", borderRadius: 12, padding: 12, boxShadow: "0 1px 3px rgba(22,35,46,0.05)" },
  addRow: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" },
  input: {
    flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 8, border: "1px solid #D5DDE4",
    fontSize: 14, background: "#FBFCFD", color: "#16232E",
  },
  chipBtn: { padding: "8px 12px", borderRadius: 8, border: "1.5px solid", fontSize: 13, fontWeight: 600, background: "#fff" },
  primaryBtn: {
    padding: "10px 18px", borderRadius: 8, border: "none", background: "#0B6E4F",
    color: "#fff", fontSize: 14, fontWeight: 600,
  },
  ghostBtn: { padding: "10px 14px", borderRadius: 8, border: "1px solid #D5DDE4", background: "#fff", fontSize: 13, color: "#16232E", marginTop: 8 },
  empty: { padding: "28px 16px", textAlign: "center", color: "#6B7A88", fontSize: 14, background: "#fff", border: "1px dashed #C9D3DB", borderRadius: 12 },
  task: {
    display: "flex", alignItems: "flex-start", gap: 10, background: "#fff",
    border: "1px solid #E1E7EC", borderRadius: 10, padding: "10px 12px", marginBottom: 8,
  },
  check: {
    width: 24, height: 24, borderRadius: 7, border: "2px solid", color: "#fff",
    fontSize: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1,
  },
  taskTitle: { fontSize: 14.5, fontWeight: 500, lineHeight: 1.35, wordBreak: "break-word" },
  star: { color: "#B3402E" },
  taskMeta: { display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" },
  timePill: { fontSize: 12, fontWeight: 600, color: "#16232E", background: "#EEF1F5", borderRadius: 5, padding: "1px 6px" },
  catPill: { fontSize: 12, fontWeight: 600, borderRadius: 5, padding: "1px 6px" },
  movedPill: { fontSize: 11.5, fontWeight: 600, color: "#C77D1F", background: "#C77D1F18", borderRadius: 5, padding: "1px 6px" },
  iconBtn: { border: "none", background: "transparent", fontSize: 12.5, fontWeight: 600, color: "#1F5FA8", padding: "4px 6px", flexShrink: 0 },
  closeDayBtn: {
    width: "100%", marginTop: 14, padding: "13px", borderRadius: 10, border: "none",
    background: "#16232E", color: "#fff", fontSize: 14.5, fontWeight: 600, fontFamily: "'Archivo', sans-serif", letterSpacing: 0.3,
  },
  note: {
    width: "100%", marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid #E1E7EC",
    fontSize: 13.5, resize: "vertical", background: "#FFFDF5", color: "#16232E",
  },
  statsCard: { marginTop: 20, background: "#fff", border: "1px solid #E1E7EC", borderRadius: 12, padding: "14px 16px" },
  statsHead: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 },
  bars: { display: "flex", gap: 8, marginTop: 12, alignItems: "flex-end" },
  barCol: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "transparent", border: "none", padding: 0 },
  barTrack: { width: "100%", maxWidth: 40, height: 64, background: "#EEF1F5", borderRadius: 6, display: "flex", flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" },
  barFill: { width: "100%", background: "#0B6E4F", borderRadius: "6px 6px 0 0", transition: "height .25s" },
  closedCard: { marginTop: 18, background: "#F3F8F5", border: "1.5px solid #0B6E4F55", borderRadius: 12, padding: 16 },
  stamp: {
    display: "inline-block", fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 12,
    letterSpacing: 2, color: "#0B6E4F", border: "2px solid #0B6E4F", borderRadius: 6,
    padding: "4px 10px", transform: "rotate(-1.5deg)",
  },
  overlay: {
    position: "fixed", inset: 0, background: "rgba(22,35,46,0.45)", display: "flex",
    alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50,
  },
  modal: { background: "#fff", borderRadius: 14, padding: "20px 20px 18px", width: "100%", maxWidth: 520, maxHeight: "85vh", overflowY: "auto" },
  reviewSection: { marginTop: 12, paddingTop: 10, borderTop: "1px solid #EEF1F5" },
  reviewLabel: { fontSize: 12.5, fontWeight: 700, color: "#0B6E4F", letterSpacing: 0.5, marginBottom: 6, textTransform: "uppercase" },
  reviewLine: { fontSize: 14, padding: "3px 0", color: "#16232E" },
  reviewEmptyLine: { fontSize: 13.5, color: "#8A97A3", fontStyle: "italic" },
  reminderBanner: {
    marginTop: 16, background: "#C77D1F", color: "#fff", borderRadius: 12,
    padding: "14px 16px", boxShadow: "0 4px 14px rgba(199,125,31,0.35)",
  },
  togglePill: {
    marginTop: 8, padding: "5px 10px", borderRadius: 20, border: "1.5px solid",
    background: "#fff", fontSize: 12, fontWeight: 600,
  },
  hamburger: {
    width: 38, height: 38, borderRadius: 9, border: "1px solid #D5DDE4", background: "#fff",
    fontSize: 17, color: "#16232E", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
  },
  sidebar: {
    position: "fixed", left: 0, top: 0, bottom: 0, width: 274, maxWidth: "82vw",
    background: "#fff", padding: "18px 14px", overflowY: "auto",
    boxShadow: "4px 0 24px rgba(22,35,46,0.18)", display: "flex", flexDirection: "column",
  },
  brandIcon: {
    width: 36, height: 36, borderRadius: 10, background: "#0B6E4F", color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800,
  },
  sideItem: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
    padding: "10px 10px", borderRadius: 9, border: "none", background: "transparent",
    fontSize: 14, fontWeight: 500, color: "#16232E", marginBottom: 2,
  },
  sideBadge: {
    marginLeft: "auto", background: "#0B6E4F", color: "#fff", borderRadius: 12,
    fontSize: 11.5, fontWeight: 700, padding: "1px 8px",
  },
  sideDivider: { height: 1, background: "#EEF1F5", margin: "12px 0" },
  dayChip: { padding: "7px 11px", borderRadius: 8, border: "1.5px solid", fontSize: 12.5, fontWeight: 700 },
};
