// ---- 定数 -----------------------------------------------------------
const COLORS = ["#4f8cff","#3ecf8e","#f5a623","#ef5a5a","#b06cff","#25c2c2","#ff7ab6","#c9d34c"];

const MIN_SESSION_MS = 10 * 1000;              // FR-5.2-8
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;    // FR-5.2-7
const HEARTBEAT_INTERVAL_MS = 30 * 1000;       // FR-5.2-5
const RECOVERY_THRESHOLD_MS = 5 * 60 * 1000;   // FR-5.2-6
const HISTORY_RECENT_DAYS = 7;                 // FR-5.3-3
const SAVE_DEBOUNCE_MS = 500;                  // FR-5.5-3

// ---- 状態（AppState, SPEC.md §7） ------------------------------------
/** @type {{schemaVersion:1, projects:object[], sessions:object[], activeTimer:object|null}} */
let state = { schemaVersion: 1, projects: [], sessions: [], activeTimer: null };
let expandedHistory = new Set();
let expandedOlder = new Set();
let editingSessionId = null;
let openMenuProjectId = null;
let showArchived = false;
let saveTimer = null;
let viewedMonthKey = monthKeyOf(Date.now()); // FR-5.8-1: 既定値は現在の月

// ---- 永続化（ADR-1/2, §8: メインプロセス経由でファイルに保存） -----------
async function persistNow() {
  try {
    await window.koyomi.saveState(state);
  } catch (e) {
    console.error("save failed", e);
    showToast("保存に失敗しました", "warn");
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, SAVE_DEBOUNCE_MS);
}

// ---- ユーティリティ ---------------------------------------------------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getProject(id) {
  return state.projects.find(p => p.id === id);
}

function pickColor() {
  return COLORS[state.projects.length % COLORS.length];
}

function formatDuration(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function toDatetimeLocalValue(ts) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(value) {
  return new Date(value).getTime();
}

function localDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---- 月ユーティリティ（FR-5.8, ADR-11） --------------------------------
function monthKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function startOfMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).getTime();
}

function endOfMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m, 1).getTime(); // 翌月1日0時
}

function shiftMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split("-").map(Number);
  return monthKeyOf(new Date(y, m - 1 + delta, 1).getTime());
}

function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${y}年${m}月`;
}

// ---- 純粋関数: 時間計算（SPEC.md §10.1） ------------------------------
function overlapMs(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

function activeElapsedMs(now) {
  if (!state.activeTimer) return 0;
  return Math.max(0, now - state.activeTimer.startedAt);
}

// FR-5.4-7: 集計対象は status:"approved" のセッションのみ
function isCounted(session) {
  return session.status === "approved";
}

function totalDurationMs(sessions, projectId, now) {
  let total = 0;
  for (const s of sessions) {
    if (projectId && s.projectId !== projectId) continue;
    if (!isCounted(s)) continue;
    total += Math.max(0, s.end - s.start);
  }
  if (state.activeTimer && (!projectId || state.activeTimer.projectId === projectId)) {
    total += activeElapsedMs(now);
  }
  return total;
}

function todayDurationMs(sessions, projectId, now) {
  const dayStart = startOfLocalDay(now);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  let total = 0;
  for (const s of sessions) {
    if (projectId && s.projectId !== projectId) continue;
    if (!isCounted(s)) continue;
    total += overlapMs(s.start, s.end, dayStart, dayEnd);
  }
  if (state.activeTimer && (!projectId || state.activeTimer.projectId === projectId)) {
    total += overlapMs(state.activeTimer.startedAt, now, dayStart, dayEnd);
  }
  return total;
}

// FR-5.8-1/6: 閲覧中の月の合計。sessions は移動しないので、都度タイムスタンプから算出する
function monthDurationMs(sessions, projectId, monthKey, now) {
  const monthStart = startOfMonth(monthKey);
  const monthEnd = endOfMonth(monthKey);
  let total = 0;
  for (const s of sessions) {
    if (projectId && s.projectId !== projectId) continue;
    if (!isCounted(s)) continue;
    total += overlapMs(s.start, s.end, monthStart, monthEnd);
  }
  if (state.activeTimer && (!projectId || state.activeTimer.projectId === projectId)) {
    total += overlapMs(state.activeTimer.startedAt, now, monthStart, monthEnd);
  }
  return total;
}

function groupSessionsByDate(sessions) {
  const groups = new Map();
  const sorted = [...sessions].sort((a, b) => b.start - a.start);
  for (const s of sorted) {
    const key = localDateKey(s.start);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()]; // [[dateKey, sessions[]], ...] は start 降順
}

// ---- タイマー操作（FR-5.2） --------------------------------------------
function stopActiveTimer(reason) {
  if (!state.activeTimer) return { discarded: false, session: null, project: null };
  const { projectId, startedAt } = state.activeTimer;
  const project = getProject(projectId);
  const end = Date.now();
  const duration = end - startedAt;
  state.activeTimer = null;

  if (duration < MIN_SESSION_MS) {
    scheduleSave();
    return { discarded: true, session: null, project, duration };
  }
  const session = { id: uid(), projectId, start: startedAt, end, source: "timer", status: "approved" };
  state.sessions.push(session);
  scheduleSave();
  return { discarded: false, session, project, duration };
}

function startTimer(projectId) {
  if (state.activeTimer && state.activeTimer.projectId !== projectId) {
    const result = stopActiveTimer("switched");
    if (result.project) {
      if (result.discarded) {
        showToast(`${result.project.name} の計測を破棄しました（${formatDuration(result.duration)} 未満）`);
      } else {
        showToast(`${result.project.name} を停止しました（${formatDuration(result.session.end - result.session.start)}）`);
      }
    }
  } else if (state.activeTimer && state.activeTimer.projectId === projectId) {
    return; // already running this project
  }
  state.activeTimer = { projectId, startedAt: Date.now(), lastHeartbeat: Date.now() };
  scheduleSave();
  render();
}

function stopTimerManual(projectId) {
  if (!state.activeTimer || state.activeTimer.projectId !== projectId) return;
  const result = stopActiveTimer("manual");
  if (result.discarded) {
    showToast(`${result.project.name} の計測を破棄しました（${formatDuration(result.duration)} 未満のため）`);
  }
  render();
}

function checkMaxSessionLength() {
  if (!state.activeTimer) return false;
  if (activeElapsedMs(Date.now()) <= MAX_SESSION_MS) return false;
  const result = stopActiveTimer("max-length");
  if (result.project) {
    showToast(`${result.project.name} は${MAX_SESSION_MS / 3600000}時間を超えたため自動停止しました`, "warn");
  }
  return true;
}

function runHeartbeat() {
  if (!state.activeTimer) return;
  state.activeTimer.lastHeartbeat = Date.now();
  scheduleSave();
}

// ---- 起動時の復帰確認（FR-5.2-6） --------------------------------------
function checkRecoveryOnLoad() {
  if (!state.activeTimer) return;
  const idle = Date.now() - state.activeTimer.lastHeartbeat;
  if (idle <= RECOVERY_THRESHOLD_MS) return;
  showRecoveryDialog();
}

function showRecoveryDialog() {
  const project = getProject(state.activeTimer.projectId);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "recoveryOverlay";
  const lastSeen = formatDateTime(state.activeTimer.lastHeartbeat);
  overlay.innerHTML = `
    <div class="modal">
      <h2>停止し忘れの可能性があります</h2>
      <p>「${escapeHtml(project ? project.name : "不明なプロジェクト")}」のタイマーが稼働中のまま、最終確認（${lastSeen}）から時間が経過しています。どう扱いますか？</p>
      <div class="modal-actions">
        <button class="recommended" data-action="stop-at-heartbeat">最終確認時刻（${lastSeen}）で停止する（推奨）</button>
        <button data-action="continue">そのまま現在時刻まで継続する</button>
        <button data-action="discard">このセッションを破棄する</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => resolveRecovery(btn.dataset.action));
  });
}

function resolveRecovery(action) {
  const { projectId, startedAt, lastHeartbeat } = state.activeTimer;
  if (action === "stop-at-heartbeat") {
    state.activeTimer = null;
    const duration = lastHeartbeat - startedAt;
    if (duration >= MIN_SESSION_MS) {
      state.sessions.push({ id: uid(), projectId, start: startedAt, end: lastHeartbeat, source: "timer", status: "approved" });
    }
  } else if (action === "continue") {
    state.activeTimer.lastHeartbeat = Date.now();
  } else if (action === "discard") {
    state.activeTimer = null;
  }
  scheduleSave();
  const overlay = document.getElementById("recoveryOverlay");
  if (overlay) overlay.remove();
  render();
}

// ---- プロジェクト操作（FR-5.1） ----------------------------------------
function addProject(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  state.projects.push({
    id: uid(), name: trimmed, color: pickColor(), createdAt: Date.now(), archived: false
  });
  scheduleSave();
  render();
}

function renameProject(id, newName) {
  const p = getProject(id);
  if (!p) return;
  const trimmed = newName.trim();
  if (trimmed) p.name = trimmed;
  scheduleSave();
  render();
}

function archiveProject(id) {
  const p = getProject(id);
  if (!p) return;
  if (state.activeTimer && state.activeTimer.projectId === id) {
    stopActiveTimer("archived");
  }
  p.archived = true;
  scheduleSave();
  render();
}

function unarchiveProject(id) {
  const p = getProject(id);
  if (!p) return;
  p.archived = false;
  scheduleSave();
  render();
}

function deleteProjectPermanently(id) {
  const p = getProject(id);
  if (!p || !p.archived) return;
  if (!confirm(`「${p.name}」を完全に削除しますか？関連する記録もすべて削除され、元に戻せません。`)) return;
  state.projects = state.projects.filter(pr => pr.id !== id);
  state.sessions = state.sessions.filter(s => s.projectId !== id);
  scheduleSave();
  render();
}

// ---- セッション編集（FR-5.3-4） -----------------------------------------
function deleteSession(id) {
  state.sessions = state.sessions.filter(s => s.id !== id);
  scheduleSave();
  render();
}

function saveSessionEdit(id, endValue, note) {
  const s = state.sessions.find(s => s.id === id);
  if (!s) return;
  const newEnd = fromDatetimeLocalValue(endValue);
  if (!isNaN(newEnd) && newEnd > s.start) {
    s.end = newEnd;
  }
  s.note = note.trim() || undefined;
  editingSessionId = null;
  scheduleSave();
  render();
}

// ---- 手動申請・承認（FR-5.7） --------------------------------------------
function requestManualSession(projectId, startValue, endValue, note) {
  const start = fromDatetimeLocalValue(startValue);
  const end = fromDatetimeLocalValue(endValue);
  if (isNaN(start) || isNaN(end) || end <= start) {
    showToast("終了日時は開始日時より後にしてください", "warn");
    return false;
  }
  if (end - start > 24 * 60 * 60 * 1000) {
    showToast("1件の申請は24時間以内にしてください", "warn");
    return false;
  }
  state.sessions.push({
    id: uid(), projectId, start, end,
    note: note.trim() || undefined,
    source: "manual", status: "pending",
  });
  scheduleSave();
  showToast("申請を作成しました（承認待ち）");
  render();
  return true;
}

function approveSession(id) {
  const s = state.sessions.find(s => s.id === id);
  if (!s || s.status !== "pending") return;
  s.status = "approved";
  scheduleSave();
  render();
}

function rejectSession(id) {
  const s = state.sessions.find(s => s.id === id);
  if (!s || s.status !== "pending") return;
  s.status = "rejected";
  scheduleSave();
  render();
}

function openManualRequestModal(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "manualRequestOverlay";
  const defaultStart = toDatetimeLocalValue(Date.now() - 60 * 60 * 1000);
  const defaultEnd = toDatetimeLocalValue(Date.now());
  overlay.innerHTML = `
    <div class="modal">
      <h2>作業時間を申請</h2>
      <p>「${escapeHtml(project.name)}」の作業時間を手動で申請します。承認するまで集計には含まれません。</p>
      <div class="modal-form">
        <label for="manualStartInput">開始日時</label>
        <input type="datetime-local" id="manualStartInput" value="${defaultStart}">
        <label for="manualEndInput">終了日時</label>
        <input type="datetime-local" id="manualEndInput" value="${defaultEnd}">
        <label for="manualNoteInput">メモ</label>
        <input type="text" id="manualNoteInput" maxlength="200" placeholder="何をしていたか（任意）">
      </div>
      <div class="modal-actions">
        <button class="recommended" data-action="submit">申請する</button>
        <button data-action="cancel">キャンセル</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => overlay.remove());
  overlay.querySelector('[data-action="submit"]').addEventListener("click", () => {
    const startVal = document.getElementById("manualStartInput").value;
    const endVal = document.getElementById("manualEndInput").value;
    const note = document.getElementById("manualNoteInput").value;
    const ok = requestManualSession(projectId, startVal, endVal, note);
    if (ok) overlay.remove();
  });
}

// ---- エクスポート（FR-5.5-4/5） -----------------------------------------
function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  downloadBlob(`koyomi-export-${localDateKey(Date.now())}.json`, JSON.stringify(state, null, 2), "application/json");
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function exportCsv() {
  const header = ["id", "projectId", "projectName", "start_iso", "end_iso", "duration_sec", "note"];
  const rows = [header.join(",")];
  for (const s of state.sessions) {
    const project = getProject(s.projectId);
    rows.push([
      s.id, s.projectId, project ? project.name : "",
      new Date(s.start).toISOString(), new Date(s.end).toISOString(),
      Math.round((s.end - s.start) / 1000), s.note || ""
    ].map(csvEscape).join(","));
  }
  downloadBlob(`koyomi-sessions-${localDateKey(Date.now())}.csv`, rows.join("\n"), "text/csv");
}

// ---- トースト（FR-5.2-4/7, FR-5.6-1） -----------------------------------
function showToast(message, kind) {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = "toast" + (kind === "warn" ? " warn" : "");
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// ---- 描画 --------------------------------------------------------------
function render() {
  const list = document.getElementById("projectList");
  const empty = document.getElementById("emptyState");
  list.innerHTML = "";

  const visibleProjects = state.projects.filter(p => showArchived || !p.archived);
  empty.style.display = state.projects.length === 0 ? "block" : "none";

  const now = Date.now();
  let runningCount = 0;
  for (const p of state.projects) {
    if (state.activeTimer && state.activeTimer.projectId === p.id) runningCount++;
  }

  for (const p of visibleProjects) {
    list.appendChild(renderProjectCard(p, now));
  }

  document.getElementById("totalMonth").textContent = formatDuration(monthDurationMs(state.sessions, null, viewedMonthKey, now));
  document.getElementById("totalToday").textContent = formatDuration(todayDurationMs(state.sessions, null, now));
  document.getElementById("runningCount").textContent = String(runningCount);

  // FR-5.8-2/3: 月ナビゲーション表示
  document.getElementById("monthLabel").textContent = formatMonthLabel(viewedMonthKey);
  document.getElementById("nextMonthBtn").disabled = viewedMonthKey === monthKeyOf(now);
}

function renderProjectCard(p, now) {
  const isRunning = !!(state.activeTimer && state.activeTimer.projectId === p.id);
  const isCurrentMonth = viewedMonthKey === monthKeyOf(now); // FR-5.8-4
  const projectSessions = state.sessions.filter(s => s.projectId === p.id);
  const monthStart = startOfMonth(viewedMonthKey);
  const monthEnd = endOfMonth(viewedMonthKey);
  const sessionsInMonth = projectSessions.filter(s => overlapMs(s.start, s.end, monthStart, monthEnd) > 0);

  const cardWrap = document.createElement("div");
  cardWrap.className = "project-wrap" + (isRunning ? " running" : "") + (p.archived ? " archived" : "");

  const card = document.createElement("div");
  card.className = "project-card";

  const colorDot = document.createElement("div");
  colorDot.className = "project-color";
  colorDot.style.background = p.color;

  const info = document.createElement("div");
  info.className = "project-info";
  const nameEl = document.createElement("div");
  nameEl.className = "project-name";
  nameEl.textContent = p.name;
  if (!p.archived) {
    nameEl.title = "クリックで編集";
    nameEl.addEventListener("click", () => startRename(p.id, nameEl));
  }

  const metaEl = document.createElement("div");
  metaEl.className = "project-meta";
  const approvedCount = sessionsInMonth.filter(isCounted).length + (isRunning && isCurrentMonth ? 1 : 0);
  const pendingCount = sessionsInMonth.filter(s => s.status === "pending").length;
  const todayPart = isCurrentMonth ? `本日 ${formatDuration(todayDurationMs(state.sessions, p.id, now))} ・ ` : "";
  metaEl.textContent = todayPart + `セッション ${approvedCount}件`
    + (pendingCount > 0 ? ` ・ 承認待ち ${pendingCount}件` : "")
    + (p.archived ? " ・ アーカイブ済み" : "");

  info.appendChild(nameEl);
  info.appendChild(metaEl);

  const timerEl = document.createElement("div");
  timerEl.className = "project-timer";
  timerEl.dataset.projectId = p.id;
  timerEl.textContent = formatDuration(monthDurationMs(state.sessions, p.id, viewedMonthKey, now));

  const actions = document.createElement("div");
  actions.className = "project-actions";

  if (!p.archived && isCurrentMonth) {
    const toggleTimerBtn = document.createElement("button");
    toggleTimerBtn.className = "btn " + (isRunning ? "stop" : "start");
    toggleTimerBtn.textContent = isRunning ? "⏸" : "▶";
    toggleTimerBtn.title = isRunning ? "停止" : "開始";
    toggleTimerBtn.addEventListener("click", () => isRunning ? stopTimerManual(p.id) : startTimer(p.id));
    actions.appendChild(toggleTimerBtn);
  }

  const menuWrap = document.createElement("div");
  menuWrap.className = "menu-wrap";
  const menuBtn = document.createElement("button");
  menuBtn.className = "btn";
  menuBtn.textContent = "⋮";
  menuBtn.title = "メニュー";
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenuProjectId = openMenuProjectId === p.id ? null : p.id;
    render();
  });
  menuWrap.appendChild(menuBtn);

  if (openMenuProjectId === p.id) {
    const dropdown = document.createElement("div");
    dropdown.className = "menu-dropdown";
    if (!p.archived) {
      const requestBtn = document.createElement("button");
      requestBtn.textContent = "時間を申請";
      requestBtn.addEventListener("click", () => { openMenuProjectId = null; openManualRequestModal(p.id); });
      dropdown.appendChild(requestBtn);

      const archiveBtn = document.createElement("button");
      archiveBtn.textContent = "アーカイブ";
      archiveBtn.addEventListener("click", () => { openMenuProjectId = null; archiveProject(p.id); });
      dropdown.appendChild(archiveBtn);
    } else {
      const restoreBtn = document.createElement("button");
      restoreBtn.textContent = "復元";
      restoreBtn.addEventListener("click", () => { openMenuProjectId = null; unarchiveProject(p.id); });
      dropdown.appendChild(restoreBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "danger";
      deleteBtn.textContent = "完全削除";
      deleteBtn.addEventListener("click", () => { openMenuProjectId = null; deleteProjectPermanently(p.id); });
      dropdown.appendChild(deleteBtn);
    }
    menuWrap.appendChild(dropdown);
  }
  actions.appendChild(menuWrap);

  card.appendChild(colorDot);
  card.appendChild(info);
  card.appendChild(timerEl);
  card.appendChild(actions);

  cardWrap.appendChild(card);
  cardWrap.appendChild(renderHistorySection(p, projectSessions));

  return cardWrap;
}

function renderHistorySection(p, projectSessions) {
  const historyWrap = document.createElement("div");
  historyWrap.className = "history";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "history-toggle";
  const isExpanded = expandedHistory.has(p.id);
  toggleBtn.textContent = isExpanded ? "履歴を隠す ▲" : `履歴を見る (${projectSessions.length}) ▼`;
  toggleBtn.addEventListener("click", () => {
    if (expandedHistory.has(p.id)) expandedHistory.delete(p.id);
    else expandedHistory.add(p.id);
    render();
  });
  historyWrap.appendChild(toggleBtn);

  if (!isExpanded) return historyWrap;

  const groupsWrap = document.createElement("div");
  groupsWrap.className = "history-groups";

  if (projectSessions.length === 0) {
    const none = document.createElement("div");
    none.className = "history-list";
    none.textContent = "まだ記録がありません";
    groupsWrap.appendChild(none);
    historyWrap.appendChild(groupsWrap);
    return historyWrap;
  }

  const groups = groupSessionsByDate(projectSessions);
  const recentCutoff = startOfLocalDay(Date.now()) - (HISTORY_RECENT_DAYS - 1) * 86400000;
  const recentGroups = groups.filter(([key]) => new Date(key).getTime() >= recentCutoff);
  const olderGroups = groups.filter(([key]) => new Date(key).getTime() < recentCutoff);
  const olderExpanded = expandedOlder.has(p.id);
  const groupsToShow = olderExpanded ? groups : recentGroups;

  for (const [dateKey, sessions] of groupsToShow) {
    const groupEl = document.createElement("div");
    const titleEl = document.createElement("div");
    titleEl.className = "history-group-title";
    titleEl.textContent = dateKey;
    groupEl.appendChild(titleEl);

    const listEl = document.createElement("div");
    listEl.className = "history-list";
    for (const s of sessions) {
      listEl.appendChild(renderSessionRow(p, s));
    }
    groupEl.appendChild(listEl);
    groupsWrap.appendChild(groupEl);
  }

  if (!olderExpanded && olderGroups.length > 0) {
    const moreBtn = document.createElement("button");
    moreBtn.className = "show-more-btn";
    moreBtn.textContent = `もっと見る（${olderGroups.length}日分）`;
    moreBtn.addEventListener("click", () => { expandedOlder.add(p.id); render(); });
    groupsWrap.appendChild(moreBtn);
  }

  historyWrap.appendChild(groupsWrap);
  return historyWrap;
}

function renderSessionRow(project, session) {
  if (editingSessionId === session.id) {
    const editWrap = document.createElement("div");
    editWrap.className = "session-edit";

    const endLabel = document.createElement("label");
    endLabel.textContent = "終了時刻";
    const endInput = document.createElement("input");
    endInput.type = "datetime-local";
    endInput.value = toDatetimeLocalValue(session.end);

    const noteLabel = document.createElement("label");
    noteLabel.textContent = "メモ";
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.maxLength = 200;
    noteInput.value = session.note || "";
    noteInput.placeholder = "何をしていたか（任意）";

    const actionsRow = document.createElement("div");
    actionsRow.className = "session-edit-actions";
    const saveBtn = document.createElement("button");
    saveBtn.className = "primary";
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", () => saveSessionEdit(session.id, endInput.value, noteInput.value));
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "キャンセル";
    cancelBtn.addEventListener("click", () => { editingSessionId = null; render(); });
    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(saveBtn);

    editWrap.appendChild(endLabel);
    editWrap.appendChild(endInput);
    editWrap.appendChild(noteLabel);
    editWrap.appendChild(noteInput);
    editWrap.appendChild(actionsRow);
    return editWrap;
  }

  const row = document.createElement("div");
  row.className = "history-row";

  const left = document.createElement("div");
  left.className = "left";
  const timeLabel = document.createElement("span");
  timeLabel.textContent = `${formatDateTime(session.start)} 〜 ${formatDateTime(session.end)}`;
  left.appendChild(timeLabel);

  const pills = document.createElement("span");
  pills.className = "pill-row";
  if (session.source === "manual") {
    const manualPill = document.createElement("span");
    manualPill.className = "status-pill manual";
    manualPill.textContent = "手動";
    pills.appendChild(manualPill);
  }
  if (session.status === "pending") {
    const pendingPill = document.createElement("span");
    pendingPill.className = "status-pill pending";
    pendingPill.textContent = "承認待ち";
    pills.appendChild(pendingPill);
  } else if (session.status === "rejected") {
    const rejectedPill = document.createElement("span");
    rejectedPill.className = "status-pill rejected";
    rejectedPill.textContent = "却下済み";
    pills.appendChild(rejectedPill);
  }
  if (pills.childNodes.length > 0) left.appendChild(pills);

  if (session.note) {
    const noteEl = document.createElement("span");
    noteEl.className = "note";
    noteEl.textContent = session.note;
    left.appendChild(noteEl);
  }
  row.addEventListener("click", (e) => {
    if (e.target.closest(".del") || e.target.closest(".approve") || e.target.closest(".reject")) return;
    editingSessionId = session.id;
    render();
  });

  const dur = document.createElement("span");
  dur.className = "dur";
  dur.textContent = formatDuration(session.end - session.start);

  const delBtn = document.createElement("button");
  delBtn.className = "del";
  delBtn.textContent = "✕";
  delBtn.title = "削除";
  delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteSession(session.id); });

  row.appendChild(left);
  if (session.status === "pending") {
    const approveBtn = document.createElement("button");
    approveBtn.className = "approve";
    approveBtn.textContent = "承認";
    approveBtn.title = "承認して集計に含める";
    approveBtn.addEventListener("click", (e) => { e.stopPropagation(); approveSession(session.id); });

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "reject";
    rejectBtn.textContent = "却下";
    rejectBtn.title = "却下する（集計に含めない）";
    rejectBtn.addEventListener("click", (e) => { e.stopPropagation(); rejectSession(session.id); });

    row.appendChild(approveBtn);
    row.appendChild(rejectBtn);
  }
  row.appendChild(dur);
  row.appendChild(delBtn);
  return row;
}

function startRename(id, nameEl) {
  const p = getProject(id);
  if (!p) return;
  const input = document.createElement("input");
  input.type = "text";
  input.value = p.name;
  input.maxLength = 60;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => renameProject(id, input.value);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = p.name; input.blur(); }
  });
}

// ---- ライブ更新（保存を伴わない再計算のみ, FR-5.2-2） --------------------
setInterval(() => {
  if (checkMaxSessionLength()) { render(); return; }
  const now = Date.now();
  document.querySelectorAll(".project-timer").forEach(el => {
    const p = getProject(el.dataset.projectId);
    if (p) el.textContent = formatDuration(monthDurationMs(state.sessions, p.id, viewedMonthKey, now));
  });
  if (state.activeTimer) {
    document.getElementById("totalMonth").textContent = formatDuration(monthDurationMs(state.sessions, null, viewedMonthKey, now));
    document.getElementById("totalToday").textContent = formatDuration(todayDurationMs(state.sessions, null, now));
  }
}, 1000);

setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);

// ---- イベント配線 --------------------------------------------------------
document.getElementById("addProjectBtn").addEventListener("click", () => {
  const input = document.getElementById("newProjectInput");
  addProject(input.value);
  input.value = "";
  input.focus();
});
document.getElementById("newProjectInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addProjectBtn").click();
});
document.getElementById("showArchivedToggle").addEventListener("change", (e) => {
  showArchived = e.target.checked;
  render();
});
document.getElementById("exportJsonBtn").addEventListener("click", exportJson);
document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
document.getElementById("prevMonthBtn").addEventListener("click", () => {
  viewedMonthKey = shiftMonthKey(viewedMonthKey, -1);
  render();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  if (viewedMonthKey === monthKeyOf(Date.now())) return; // FR-5.8-3: 未来へは進めない
  viewedMonthKey = shiftMonthKey(viewedMonthKey, 1);
  render();
});
document.addEventListener("click", () => {
  if (openMenuProjectId !== null) { openMenuProjectId = null; render(); }
});

// ---- 起動 ----------------------------------------------------------------
// FR-5.7-2 追加前の旧データには source/status が無いため、実測扱いとして補完する
function normalizeState(s) {
  for (const session of s.sessions) {
    if (!session.source) session.source = "timer";
    if (!session.status) session.status = "approved";
  }
  return s;
}

async function init() {
  state = normalizeState(await window.koyomi.loadState());
  render();
  checkRecoveryOnLoad();
}
init();
