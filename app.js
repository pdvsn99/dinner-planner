/* ============================================================
 *  Dinner Planner — app logic (Supabase-backed)
 * ============================================================ */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const sb = createClient(window.SUPABASE_URL, window.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const DAYS = [
  { key: "mon",   label: "Monday" },
  { key: "tue",   label: "Tuesday" },
  { key: "wed",   label: "Wednesday" },
  { key: "thurs", label: "Thursday" },
  { key: "fri",   label: "Friday" },
  { key: "sat",   label: "Saturday" },
  { key: "sun",   label: "Sunday" },
];
// Lunch was removed — the planner now plans one dinner per day.
// We keep a single "Dinner" slot so stored plan entries stay consistent.
const SLOTS = ["Dinner"];

/* ---------- state ---------- */
let USER_ID = null;
let USER_EMAIL = null;
let HOUSEHOLD_ID = null;        // the shared household this account belongs to
let MEALS = [];                 // meals loaded from the database
let weekStart = mondayOf(new Date()); // Date of the Monday of the shown week
let plan = { entries: {}, days: {} }; // entries["day|slot"] = {...}; days["day"] = {is_out, note}
let selected = null;            // { day, slot }
let editingMealId = null;       // for the meal editor
let effortTarget = loadEffortTarget(); // total effort budget for a 7-night week

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ekey = (day, slot) => `${day}|${slot}`;

function randInt(min, max) {
  if (max < min) max = min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pickSides(pool, n) {
  const copy = pool.slice();
  const out = [];
  n = Math.min(n, copy.length);
  for (let i = 0; i < n; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}
function mealByName(name) { return MEALS.find((m) => m.name === name); }

/* ---------- effort / difficulty ----------
 * Every meal has a difficulty of 1..5, stored as a number in the database
 * but shown to people as words. Old meals only had a text "ease" field
 * (Easy/Medium/Hard), so we fall back to that when no number is set.       */
const EFFORT_LEVELS = [
  { n: 1, label: "Very easy" },
  { n: 2, label: "Easy" },
  { n: 3, label: "Medium" },
  { n: 4, label: "Hard" },
  { n: 5, label: "Very hard" },
];
const EASE_TO_DIFFICULTY = { easy: 2, medium: 3, hard: 4 };
const DEFAULT_DIFFICULTY = 3;

function mealDifficulty(m) {
  if (!m) return DEFAULT_DIFFICULTY;
  const d = parseInt(m.difficulty, 10);
  if (d >= 1 && d <= 5) return d;
  return EASE_TO_DIFFICULTY[(m.ease || "").toLowerCase()] || DEFAULT_DIFFICULTY;
}
function effortLabel(n) {
  const lvl = EFFORT_LEVELS.find((l) => l.n === n);
  return lvl ? lvl.label : "Medium";
}

/* The weekly effort budget is remembered on this device (no login needed). */
const EFFORT_MIN = 7, EFFORT_MAX = 35, EFFORT_DEFAULT = 21;
function loadEffortTarget() {
  let v;
  try { v = parseInt(localStorage.getItem("dp-effort-target"), 10); } catch (_) {}
  return (v >= EFFORT_MIN && v <= EFFORT_MAX) ? v : EFFORT_DEFAULT;
}
function saveEffortTarget(v) {
  effortTarget = Math.min(EFFORT_MAX, Math.max(EFFORT_MIN, v | 0));
  try { localStorage.setItem("dp-effort-target", String(effortTarget)); } catch (_) {}
}
// A friendly name for how intense a target feels, per night (over 7 nights).
function effortDescriptor(target) {
  const avg = target / 7;
  if (avg < 1.8) return "Chill";
  if (avg < 2.6) return "Easy-going";
  if (avg < 3.4) return "Balanced";
  if (avg < 4.2) return "Ambitious";
  return "Full-on";
}
// Shuffle a copy of an array (Fisher–Yates).
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// From a pool, pick a meal whose difficulty is closest to `want`.
// Ties are broken at random so repeated Generates still feel fresh.
function pickNearestDifficulty(pool, want) {
  let best = Infinity, group = [];
  pool.forEach((m) => {
    const dist = Math.abs(mealDifficulty(m) - want);
    if (dist < best - 1e-9) { best = dist; group = [m]; }
    else if (Math.abs(dist - best) < 1e-9) group.push(m);
  });
  return rand(group);
}

/* ---------- dates ---------- */
function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dateForDay(dayKey) { return addDays(weekStart, DAYS.findIndex((x) => x.key === dayKey)); }

function weekTitle() {
  const thisMon = mondayOf(new Date());
  const diff = Math.round((weekStart - thisMon) / (7 * 864e5));
  const opts = { day: "numeric", month: "short" };
  const label = weekStart.toLocaleDateString("en-GB", opts);
  let rel = `w/c ${label}`;
  if (diff === 0) rel = `This week · ${label}`;
  else if (diff === 1) rel = `Next week · ${label}`;
  else if (diff === -1) rel = `Last week · ${label}`;
  return rel;
}

/* ---------- meal rules ---------- */
function candidates(slot, dayKey, { treat } = { treat: false }) {
  // No more Lunch/Dinner split — every meal is a candidate, subject only to
  // whether it's a treat (takeaway / eating out) and which days it's allowed on.
  return MEALS.filter((m) => {
    const isTreat = m.location !== "Home";
    if (treat !== isTreat) return false;
    return (m.days || []).includes(dayKey);
  });
}
function makeEntry(meal) {
  const n = randInt(meal.min_sides, meal.max_sides);
  return { status: "planned", meal_name: meal.name, sides: pickSides(meal.sides || [], n), note: null };
}
function entryText(entry) {
  if (!entry || !entry.meal_name) return "";
  const s = entry.sides || [];
  if (s.length === 0) return entry.meal_name;
  if (s.length === 1) return `${entry.meal_name} with ${s[0]}`;
  return `${entry.meal_name} with ${s.slice(0, -1).join(", ")} & ${s[s.length - 1]}`;
}
// The effective state of a cell, accounting for whole-day-out.
function cellState(dayKey, slot) {
  if (plan.days[dayKey] && plan.days[dayKey].is_out) {
    return { out: true, dayOut: true, note: plan.days[dayKey].note, entry: null };
  }
  const e = plan.entries[ekey(dayKey, slot)];
  if (e && e.status === "out") return { out: true, dayOut: false, note: e.note, entry: e };
  return { out: false, dayOut: false, entry: e || null };
}

/* ============================================================
 *  Database layer
 * ============================================================ */

// Find (or create) the household this signed-in person belongs to.
async function resolveHousehold() {
  const { data: mem, error } = await sb.from("household_members").select("*");
  if (error) { console.error(error); }
  if (mem && mem.length) {
    const mine = mem.find((m) => m.user_id === USER_ID)
      || mem.find((m) => (m.email || "").toLowerCase() === (USER_EMAIL || "").toLowerCase());
    if (mine) {
      HOUSEHOLD_ID = mine.household_id;
      if (!mine.user_id) await sb.from("household_members").update({ user_id: USER_ID }).eq("id", mine.id);
      return;
    }
  }
  // Brand-new person with no invite → give them their own household.
  const { data: h, error: he } = await sb.from("households").insert({ name: "My household" }).select().single();
  if (he) { console.error(he); return; }
  HOUSEHOLD_ID = h.id;
  await sb.from("household_members").insert({ household_id: HOUSEHOLD_ID, user_id: USER_ID, email: USER_EMAIL });
}

async function loadMeals() {
  const { data, error } = await sb.from("meals").select("*").eq("household_id", HOUSEHOLD_ID).order("name");
  if (error) { flash("Couldn't load meals."); console.error(error); return; }
  if (!data || data.length === 0) {
    await seedMeals();
    const again = await sb.from("meals").select("*").eq("household_id", HOUSEHOLD_ID).order("name");
    MEALS = again.data || [];
    return;
  }
  MEALS = data;
}

async function seedMeals() {
  const rows = (window.DEFAULT_MEALS || []).map((m) => ({
    user_id: USER_ID,
    household_id: HOUSEHOLD_ID,
    name: m.name,
    category: m.category,
    location: m.location || "Home",
    ease: m.ease || null,
    difficulty: EASE_TO_DIFFICULTY[(m.ease || "").toLowerCase()] || DEFAULT_DIFFICULTY,
    sides: m.sides || [],
    min_sides: m.min || 0,
    max_sides: m.max || 0,
    days: m.days || [],
    ingredients: m.ingredients || [],
  }));
  if (rows.length) {
    // upsert + ignoreDuplicates so seeding twice (e.g. two tabs/devices on a
    // brand-new account) can never create duplicate meals. Backed by the
    // (household_id, name) unique index in the database.
    const { error } = await sb.from("meals").upsert(rows, {
      onConflict: "household_id,name",
      ignoreDuplicates: true,
    });
    if (error) console.error("seed error", error);
  }
}

async function loadPlan() {
  const ws = isoDate(weekStart);
  plan = { entries: {}, days: {} };
  const [{ data: entries }, { data: days }] = await Promise.all([
    sb.from("plan_entries").select("*").eq("household_id", HOUSEHOLD_ID).eq("week_start", ws),
    sb.from("plan_days").select("*").eq("household_id", HOUSEHOLD_ID).eq("week_start", ws),
  ]);
  (entries || []).forEach((e) => { plan.entries[ekey(e.day, e.slot)] = e; });
  (days || []).forEach((d) => { plan.days[d.day] = d; });
}

async function saveEntry(dayKey, slot, entry) {
  const row = {
    user_id: USER_ID,
    household_id: HOUSEHOLD_ID,
    week_start: isoDate(weekStart),
    day: dayKey,
    slot,
    status: entry.status || "planned",
    meal_name: entry.meal_name || null,
    sides: entry.sides || [],
    note: entry.note || null,
    updated_at: new Date().toISOString(),
  };
  plan.entries[ekey(dayKey, slot)] = row;
  const { error } = await sb.from("plan_entries").upsert(row, { onConflict: "household_id,week_start,day,slot" });
  if (error) { flash("Couldn't save."); console.error(error); }
}

async function saveEntries(list) {
  // list: [{day, slot, entry}]
  const rows = list.map(({ day, slot, entry }) => ({
    user_id: USER_ID,
    household_id: HOUSEHOLD_ID,
    week_start: isoDate(weekStart),
    day, slot,
    status: entry.status || "planned",
    meal_name: entry.meal_name || null,
    sides: entry.sides || [],
    note: entry.note || null,
    updated_at: new Date().toISOString(),
  }));
  rows.forEach((r) => { plan.entries[ekey(r.day, r.slot)] = r; });
  if (rows.length) {
    const { error } = await sb.from("plan_entries").upsert(rows, { onConflict: "household_id,week_start,day,slot" });
    if (error) { flash("Couldn't save."); console.error(error); }
  }
}

async function deleteEntry(dayKey, slot) {
  delete plan.entries[ekey(dayKey, slot)];
  const { error } = await sb.from("plan_entries")
    .delete().eq("household_id", HOUSEHOLD_ID).eq("week_start", isoDate(weekStart)).eq("day", dayKey).eq("slot", slot);
  if (error) console.error(error);
}

async function setDayOut(dayKey, isOut, note) {
  const ws = isoDate(weekStart);
  if (isOut) {
    const row = { user_id: USER_ID, household_id: HOUSEHOLD_ID, week_start: ws, day: dayKey, is_out: true, note: note || null, updated_at: new Date().toISOString() };
    plan.days[dayKey] = row;
    const { error } = await sb.from("plan_days").upsert(row, { onConflict: "household_id,week_start,day" });
    if (error) console.error(error);
  } else {
    delete plan.days[dayKey];
    const { error } = await sb.from("plan_days").delete().eq("household_id", HOUSEHOLD_ID).eq("week_start", ws).eq("day", dayKey);
    if (error) console.error(error);
  }
}

async function clearWeekData() {
  const ws = isoDate(weekStart);
  plan = { entries: {}, days: {} };
  await Promise.all([
    sb.from("plan_entries").delete().eq("household_id", HOUSEHOLD_ID).eq("week_start", ws),
    sb.from("plan_days").delete().eq("household_id", HOUSEHOLD_ID).eq("week_start", ws),
  ]);
}

/* ============================================================
 *  Planner actions
 * ============================================================ */

function eligible(dayKey, slot) {
  // A slot can be filled only if it isn't out (day-level or slot-level).
  const st = cellState(dayKey, slot);
  return !st.out;
}

async function generateWeek() {
  // Collect the nights we actually need to fill (skipping days marked out
  // and days no home meal is allowed on).
  const slots = [];
  DAYS.forEach((d) => {
    SLOTS.forEach((slot) => {
      if (!eligible(d.key, slot)) return;
      const pool = candidates(slot, d.key, { treat: false });
      if (pool.length) slots.push({ day: d.key, slot, pool });
    });
  });

  // The slider is a budget for a full 7-night week, so scale it to however
  // many nights are being cooked — that keeps the *intensity* steady when
  // some days are marked out.
  let remainingBudget = effortTarget * (slots.length / DAYS.length);
  let remainingSlots = slots.length;

  // Work through the nights in random order. Each one aims for the average
  // effort still left to spend (budget ÷ nights remaining), then we pick the
  // closest meal and subtract what it actually cost. Easy nights leave more
  // room for a hard one later, and vice-versa.
  const updates = [];
  shuffled(slots).forEach((s) => {
    const avg = remainingSlots > 0 ? remainingBudget / remainingSlots : DEFAULT_DIFFICULTY;
    // Swing each night a little around the running average so a week isn't
    // seven identical nights. Because we always aim at the budget still
    // *left*, an easy night frees up a harder one later — so the total
    // still lands near your target.
    const aim = avg + (Math.random() * 2 - 1) * 1.3;
    const meal = pickNearestDifficulty(s.pool, aim);
    updates.push({ day: s.day, slot: s.slot, entry: makeEntry(meal) });
    remainingBudget -= mealDifficulty(meal);
    remainingSlots -= 1;
  });
  await saveEntries(updates);
  render();
}

async function treatWeek() {
  const updates = [];
  DAYS.forEach((d) => {
    SLOTS.forEach((slot) => {
      if (!eligible(d.key, slot)) return;
      let pool = candidates(slot, d.key, { treat: true });
      if (pool.length === 0) pool = MEALS.filter((m) => m.location !== "Home");
      if (pool.length === 0) pool = candidates(slot, d.key, { treat: false });
      if (pool.length) updates.push({ day: d.key, slot, entry: makeEntry(rand(pool)) });
    });
  });
  await saveEntries(updates);
  render();
}

async function fillCell(dayKey, slot, { treat }) {
  let pool = candidates(slot, dayKey, { treat });
  if (treat && pool.length === 0) pool = MEALS.filter((m) => m.location !== "Home");
  if (pool.length === 0) { flash("No matching meals — add some in the Meals tab."); return; }
  await saveEntry(dayKey, slot, makeEntry(rand(pool)));
  render();
}

function requireSelection() {
  if (!selected) { flash("Tap a day first."); return false; }
  return true;
}
async function swapSelected() { if (requireSelection()) await fillCell(selected.day, selected.slot, { treat: false }); }
async function treatSelected() { if (requireSelection()) await fillCell(selected.day, selected.slot, { treat: true }); }
function editSelected() { if (requireSelection()) openPicker(selected.day, selected.slot); }

async function clearWeek() {
  if (!confirm("Clear all meals and 'out' marks for this week?")) return;
  await clearWeekData();
  render();
}

async function toggleDayOut(dayKey) {
  const current = plan.days[dayKey] && plan.days[dayKey].is_out;
  if (current) {
    await setDayOut(dayKey, false);
  } else {
    const note = prompt(`Mark ${DAYS.find((x) => x.key === dayKey).label} as OUT of the planner (away, eating out, etc.).\n\nAdd a short note (optional):`, "");
    if (note === null) return; // cancelled
    await setDayOut(dayKey, true, note.trim());
  }
  render();
}

/* ============================================================
 *  Shopping list
 * ============================================================ */
function buildShoppingList() {
  const items = {};
  DAYS.forEach((d) => {
    if (plan.days[d.key] && plan.days[d.key].is_out) return;
    SLOTS.forEach((slot) => {
      const st = cellState(d.key, slot);
      if (st.out || !st.entry || !st.entry.meal_name) return;
      const meal = mealByName(st.entry.meal_name);
      const parts = [...((meal && meal.ingredients) || []), ...(st.entry.sides || [])];
      parts.forEach((p) => {
        const key = (p || "").trim().toLowerCase();
        if (!key) return;
        if (!items[key]) items[key] = { label: p.trim(), count: 0, meals: new Set() };
        items[key].count += 1;
        items[key].meals.add(st.entry.meal_name);
      });
    });
  });
  return Object.values(items).sort((a, b) => a.label.localeCompare(b.label));
}

/* ============================================================
 *  Rendering
 * ============================================================ */
function render() {
  renderWeekNav();
  renderEffort();
  renderGrid();
  renderShopping();
}

// Update the weekly-effort control: slider position, target label, and the
// actual effort already planned into the visible week.
function renderEffort() {
  const slider = $("effort-slider");
  const readout = $("effort-readout");
  if (!slider || !readout) return;
  slider.value = effortTarget;

  let planned = 0, plannedNights = 0;
  DAYS.forEach((d) => {
    const st = cellState(d.key, SLOTS[0]);
    if (st.out || !st.entry || !st.entry.meal_name) return;
    const m = mealByName(st.entry.meal_name);
    if (m && m.location === "Home") { planned += mealDifficulty(m); plannedNights += 1; }
  });

  let txt = `Target ${effortTarget} · ${effortDescriptor(effortTarget)}`;
  if (plannedNights) txt += ` · this week ${planned}`;
  readout.textContent = txt;
}

function renderWeekNav() { $("week-title").textContent = weekTitle(); }

function renderGrid() {
  const list = $("grid-body");
  list.innerHTML = "";
  const slot = SLOTS[0]; // only "Dinner" now
  const todayIso = isoDate(new Date());

  DAYS.forEach((d) => {
    const dayOut = plan.days[d.key] && plan.days[d.key].is_out;

    const card = document.createElement("div");
    card.className = "day-card";
    if (isoDate(dateForDay(d.key)) === todayIso) card.classList.add("is-today");

    // --- left marker: short day name + date ---
    const dateObj = dateForDay(d.key);
    const tab = document.createElement("div");
    tab.className = "day-tab";
    tab.innerHTML =
      `<span class="day-name">${d.label.slice(0, 3)}</span>` +
      `<span class="day-date">${dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>`;
    card.appendChild(tab);

    // --- meal cell ---
    const cell = document.createElement("div");
    cell.className = "cell day-meal";

    // whole day marked out of the planner
    if (dayOut) {
      const note = plan.days[d.key].note;
      cell.classList.add("cell-out", "day-out");
      const body = document.createElement("div");
      body.className = "cell-body";
      body.innerHTML = `<span class="out-label">🚫 Out of the planner</span>${note ? `<span class="out-note">${escapeHtml(note)}</span>` : ""}`;
      cell.appendChild(body);
      const back = document.createElement("button");
      back.className = "day-out-btn";
      back.type = "button";
      back.title = "Bring this day back into the planner";
      back.setAttribute("aria-label", back.title);
      back.textContent = "↩";
      back.addEventListener("click", (ev) => { ev.stopPropagation(); toggleDayOut(d.key); });
      cell.appendChild(back);
      card.appendChild(cell);
      list.appendChild(card);
      return;
    }

    const st = cellState(d.key, slot);
    const meal = st.entry && st.entry.meal_name ? mealByName(st.entry.meal_name) : null;
    const isTreat = meal && meal.location !== "Home";
    if (isTreat) cell.classList.add("is-treat");
    if (st.out) cell.classList.add("cell-out");
    if (selected && selected.day === d.key && selected.slot === slot) cell.classList.add("is-selected");

    const body = document.createElement("div");
    body.className = "cell-body";
    if (st.out) {
      body.innerHTML = `<span class="out-label">🚫 Eating out</span>${st.note ? `<span class="out-note">${escapeHtml(st.note)}</span>` : ""}`;
    } else if (st.entry && st.entry.meal_name) {
      const txt = document.createElement("span");
      txt.className = "cell-text";
      txt.textContent = entryText(st.entry);
      body.appendChild(txt);
      if (isTreat) {
        const tag = document.createElement("span");
        tag.className = "badge";
        tag.textContent = meal.location === "Takeaway" ? "Takeaway" : "Eating out";
        body.appendChild(tag);
      }
    } else {
      cell.classList.add("empty");
      body.innerHTML = '<span class="cell-text muted">＋ add a meal</span>';
    }
    cell.appendChild(body);

    // right-side actions: pencil (pick exactly) + ⋯ (mark whole day out)
    const actions = document.createElement("div");
    actions.className = "cell-actions";

    const edit = document.createElement("button");
    edit.className = "cell-edit";
    edit.type = "button";
    edit.setAttribute("aria-label", `Choose ${d.label} dinner`);
    edit.textContent = "✏️";
    edit.addEventListener("click", (ev) => { ev.stopPropagation(); selected = { day: d.key, slot }; openPicker(d.key, slot); });
    actions.appendChild(edit);

    const outBtn = document.createElement("button");
    outBtn.className = "day-out-btn";
    outBtn.type = "button";
    outBtn.title = "Mark this day out (away / eating out)";
    outBtn.setAttribute("aria-label", outBtn.title);
    outBtn.textContent = "⋯";
    outBtn.addEventListener("click", (ev) => { ev.stopPropagation(); toggleDayOut(d.key); });
    actions.appendChild(outBtn);

    cell.appendChild(actions);

    // Tap the meal to select the day (tap again to deselect).
    cell.addEventListener("click", () => {
      const same = selected && selected.day === d.key && selected.slot === slot;
      selected = same ? null : { day: d.key, slot };
      render();
    });
    card.appendChild(cell);
    list.appendChild(card);
  });

  renderActionBar();
}

// Swap the bottom bar between whole-week actions and the selected day's actions.
function renderActionBar() {
  const barWeek = $("bar-week");
  const barDay = $("bar-day");
  if (!barWeek || !barDay) return;
  if (selected) {
    const dayLabel = DAYS.find((x) => x.key === selected.day).label;
    $("bar-day-label").textContent = dayLabel;
    barWeek.hidden = true;
    barDay.hidden = false;
  } else {
    barWeek.hidden = false;
    barDay.hidden = true;
  }
}

function renderShopping() {
  const list = buildShoppingList();
  const box = $("shopping-body");
  const count = $("shopping-count");
  box.innerHTML = "";
  if (list.length === 0) {
    box.innerHTML = '<p class="muted empty-note">Your shopping list will appear here once there are meals in the week.</p>';
    count.textContent = "";
    return;
  }
  count.textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;
  list.forEach((it) => {
    const row = document.createElement("div");
    row.className = "shop-row";
    row.innerHTML =
      `<span class="shop-name">${escapeHtml(cap(it.label))}</span>` +
      `<span class="shop-qty">×${it.count}</span>` +
      `<span class="shop-meal">${escapeHtml([...it.meals].join(", "))}</span>`;
    box.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============================================================
 *  Meal picker
 * ============================================================ */
let picking = null;
const byName = (a, b) => a.name.localeCompare(b.name);

// Build the grouped list of meals shown in the searchable dropdown,
// optionally filtered by what the person has typed.
function comboGroups(query) {
  const q = (query || "").trim().toLowerCase();
  const match = (m) => !q || m.name.toLowerCase().includes(q);
  return [
    { label: "Home meals", items: MEALS.filter((m) => m.location === "Home" && match(m)).sort(byName) },
    { label: "Treats (takeaway / eating out)", items: MEALS.filter((m) => m.location !== "Home" && match(m)).sort(byName) },
  ].filter((g) => g.items.length);
}

// (Re)draw the dropdown panel. `query` filters; nothing shown = "no matches".
function renderComboList(query) {
  const list = $("pick-list");
  const current = $("pick-meal").value;
  list.innerHTML = "";
  const groups = comboGroups(query);
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "combo-empty";
    empty.textContent = "No meals match";
    list.appendChild(empty);
    return;
  }
  groups.forEach((g) => {
    const head = document.createElement("div");
    head.className = "combo-group";
    head.textContent = g.label;
    list.appendChild(head);
    g.items.forEach((m) => {
      const opt = document.createElement("div");
      opt.className = "combo-option" + (m.name === current ? " is-current" : "");
      opt.setAttribute("role", "option");
      opt.textContent = m.name;
      opt.addEventListener("mousedown", (ev) => {
        // mousedown (not click) so it fires before the input's blur closes the list
        ev.preventDefault();
        chooseComboMeal(m.name);
      });
      list.appendChild(opt);
    });
  });
}

function openComboList() {
  renderComboList($("pick-search").value === $("pick-meal").dataset.label ? "" : $("pick-search").value);
  $("pick-list").hidden = false;
  $("pick-search").setAttribute("aria-expanded", "true");
}
function closeComboList() {
  $("pick-list").hidden = true;
  $("pick-search").setAttribute("aria-expanded", "false");
}

// Commit a chosen meal: store its name, show it in the box, refresh sides.
function chooseComboMeal(name) {
  const hidden = $("pick-meal");
  hidden.value = name;
  hidden.dataset.label = name;
  $("pick-search").value = name;
  closeComboList();
  renderSideChoices(name, []);
}

function openPicker(dayKey, slot) {
  picking = { day: dayKey, slot };
  const dayLabel = DAYS.find((x) => x.key === dayKey).label;
  $("modal-title").textContent = `${dayLabel} dinner`;
  const cur = plan.entries[ekey(dayKey, slot)];
  const curName = cur && cur.status !== "out" ? cur.meal_name : "";
  const hidden = $("pick-meal");
  hidden.value = curName || "";
  hidden.dataset.label = curName || "";
  $("pick-search").value = curName || "";
  closeComboList();
  renderSideChoices(curName || "", cur ? cur.sides : []);
  $("modal").hidden = false;
}
function closePicker() { $("modal").hidden = true; closeComboList(); picking = null; }

function renderSideChoices(mealName, chosen) {
  const wrap = $("pick-sides-wrap");
  const box = $("pick-sides");
  const hint = $("pick-hint");
  box.innerHTML = "";
  const meal = mealByName(mealName);
  if (!meal || !meal.sides || !meal.sides.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  hint.textContent = meal.min_sides === meal.max_sides
    ? (meal.max_sides === 0 ? "" : `(usually ${meal.max_sides})`)
    : `(usually ${meal.min_sides}–${meal.max_sides})`;
  const set = new Set(chosen || []);
  meal.sides.forEach((s) => {
    const label = document.createElement("label");
    label.className = "side-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = s;
    if (set.has(s)) cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + s));
    box.appendChild(label);
  });
}

async function savePicker() {
  if (!picking) return;
  const name = $("pick-meal").value;
  if (!name) { flash("Pick a meal, or use one of the buttons."); return; }
  const chosen = [...document.querySelectorAll("#pick-sides input:checked")].map((c) => c.value);
  await saveEntry(picking.day, picking.slot, { status: "planned", meal_name: name, sides: chosen, note: null });
  closePicker();
  render();
}

/* ============================================================
 *  Meal editor
 * ============================================================ */
function renderDayCheckboxes(selectedDays) {
  const box = $("m-days");
  box.innerHTML = "";
  const set = new Set(selectedDays || []);
  DAYS.forEach((d) => {
    const label = document.createElement("label");
    label.className = "side-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = d.key;
    if (set.has(d.key)) cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + d.label.slice(0, 3)));
    box.appendChild(label);
  });
}

function openMealEditor(meal) {
  editingMealId = meal ? meal.id : null;
  $("meal-modal-title").textContent = meal ? "Edit meal" : "Add meal";
  $("m-name").value = meal ? meal.name : "";
  $("m-location").value = meal ? meal.location : "Home";
  $("m-effort").value = String(meal ? mealDifficulty(meal) : DEFAULT_DIFFICULTY);
  $("m-sides").value = meal ? (meal.sides || []).join(", ") : "";
  $("m-min").value = meal ? meal.min_sides : 0;
  $("m-max").value = meal ? meal.max_sides : 0;
  $("m-ingredients").value = meal ? (meal.ingredients || []).join(", ") : "";
  renderDayCheckboxes(meal ? meal.days : DAYS.map((d) => d.key));
  $("meal-delete").hidden = !meal;
  $("meal-modal").hidden = false;
  $("m-name").focus();
}
function closeMealEditor() { $("meal-modal").hidden = true; editingMealId = null; }

function splitList(v) { return (v || "").split(",").map((s) => s.trim()).filter(Boolean); }

async function saveMeal() {
  const name = $("m-name").value.trim();
  if (!name) { flash("Give the meal a name."); return; }
  const min = Math.max(0, parseInt($("m-min").value, 10) || 0);
  let max = Math.max(0, parseInt($("m-max").value, 10) || 0);
  if (max < min) max = min;
  const row = {
    name,
    category: "Dinner", // kept for the database column; lunch no longer exists
    location: $("m-location").value,
    difficulty: parseInt($("m-effort").value, 10) || DEFAULT_DIFFICULTY,
    sides: splitList($("m-sides").value),
    min_sides: min,
    max_sides: max,
    days: [...document.querySelectorAll("#m-days input:checked")].map((c) => c.value),
    ingredients: splitList($("m-ingredients").value),
  };
  let error;
  if (editingMealId) {
    ({ error } = await sb.from("meals").update(row).eq("id", editingMealId));
  } else {
    ({ error } = await sb.from("meals").insert({ ...row, user_id: USER_ID, household_id: HOUSEHOLD_ID }));
  }
  if (error) { flash("Couldn't save meal."); console.error(error); return; }
  closeMealEditor();
  await loadMeals();
  renderMealsList();
  flash("Meal saved.");
}

async function deleteMeal() {
  if (!editingMealId) return;
  if (!confirm("Delete this meal? It won't remove it from weeks you've already planned.")) return;
  const { error } = await sb.from("meals").delete().eq("id", editingMealId);
  if (error) { flash("Couldn't delete."); console.error(error); return; }
  closeMealEditor();
  await loadMeals();
  renderMealsList();
}

function renderMealsList() {
  const box = $("meals-list");
  box.innerHTML = "";
  if (!MEALS.length) { box.innerHTML = '<p class="muted empty-note">No meals yet — add your first one.</p>'; return; }
  MEALS.slice().sort(byName).forEach((m) => {
    const row = document.createElement("button");
    row.className = "meal-row";
    row.type = "button";
    const treat = m.location !== "Home";
    const bits = [];
    if (treat) bits.push(escapeHtml(m.location));
    else bits.push("Home");
    if (!treat) bits.push(escapeHtml(effortLabel(mealDifficulty(m))));
    if (m.sides && m.sides.length) bits.push(m.sides.length + " side" + (m.sides.length === 1 ? "" : "s"));
    row.innerHTML =
      `<span class="meal-row-main"><span class="meal-row-name">${escapeHtml(m.name)}</span>` +
      `<span class="meal-row-sub">${bits.join(" · ")}</span></span>` +
      `<span class="meal-row-edit">✏️</span>`;
    row.addEventListener("click", () => openMealEditor(m));
    box.appendChild(row);
  });
}

/* ============================================================
 *  Tabs & week navigation
 * ============================================================ */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  $("tab-planner").hidden = name !== "planner";
  $("tab-shopping").hidden = name !== "shopping";
  $("tab-meals").hidden = name !== "meals";
  // The bottom action bar belongs to the planner only.
  $("action-bar").hidden = name !== "planner";
  document.body.classList.toggle("bar-open", name === "planner");
  if (name === "shopping") renderShopping();
  if (name === "meals") renderMealsList();
}

async function gotoWeek(newStart) {
  weekStart = newStart;
  selected = null;
  await loadPlan();
  render();
}

/* ============================================================
 *  Auth & boot
 * ============================================================ */
function showView(which) {
  $("view-loading").hidden = which !== "loading";
  $("view-auth").hidden = which !== "auth";
  $("view-app").hidden = which !== "app";
  $("account").hidden = which !== "app";
  // The fixed action bar must never hang over the loading or sign-in screens.
  if (which !== "app") {
    $("action-bar").hidden = true;
    document.body.classList.remove("bar-open");
  }
}

async function handleSession(session) {
  if (session && session.user) {
    USER_ID = session.user.id;
    USER_EMAIL = session.user.email || "";
    $("account-email").textContent = USER_EMAIL;
    showView("app");
    await boot();
  } else {
    USER_ID = null;
    showView("auth");
  }
}

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  await resolveHousehold();
  await loadMeals();
  await loadPlan();
  render();
  switchTab("planner"); // reveal the planner's bottom action bar
}

function wireUp() {
  // Auth
  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    if (!email) return;
    $("auth-submit").disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split("#")[0] } });
    $("auth-submit").disabled = false;
    const msg = $("auth-msg");
    msg.hidden = false;
    if (error) { msg.textContent = "Something went wrong: " + error.message; msg.className = "auth-msg error"; }
    else { msg.textContent = "Check your email for a login link, then come back to this page."; msg.className = "auth-msg ok"; }
  });
  $("btn-signout").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

  // Tabs
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  // Week nav
  $("week-prev").addEventListener("click", () => gotoWeek(addDays(weekStart, -7)));
  $("week-next").addEventListener("click", () => gotoWeek(addDays(weekStart, 7)));
  $("week-today").addEventListener("click", () => gotoWeek(mondayOf(new Date())));

  // Weekly effort slider — live label while dragging, save on release.
  const effortSlider = $("effort-slider");
  if (effortSlider) {
    effortSlider.min = String(EFFORT_MIN);
    effortSlider.max = String(EFFORT_MAX);
    effortSlider.addEventListener("input", () => { saveEffortTarget(parseInt(effortSlider.value, 10)); renderEffort(); });
  }

  // Planner actions
  $("btn-generate").addEventListener("click", generateWeek);
  $("btn-swap").addEventListener("click", swapSelected);
  $("btn-treat-cell").addEventListener("click", treatSelected);
  $("btn-treat-week").addEventListener("click", treatWeek);
  $("btn-edit").addEventListener("click", editSelected);
  $("btn-print").addEventListener("click", () => window.print());
  $("btn-clear").addEventListener("click", clearWeek);
  $("bar-deselect").addEventListener("click", () => { selected = null; render(); });

  // Picker — searchable meal dropdown
  const search = $("pick-search");
  search.addEventListener("focus", openComboList);
  search.addEventListener("input", () => { renderComboList(search.value); $("pick-list").hidden = false; });
  search.addEventListener("blur", () => setTimeout(closeComboList, 120));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeComboList(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const first = $("pick-list").querySelector(".combo-option");
      if (first) chooseComboMeal(first.textContent);
    } else if (e.key === "ArrowDown" && $("pick-list").hidden) {
      openComboList();
    }
  });
  $("pick-save").addEventListener("click", savePicker);
  $("pick-cancel").addEventListener("click", closePicker);
  $("modal-close").addEventListener("click", closePicker);
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closePicker(); });
  $("pick-random").addEventListener("click", async () => { if (picking) { await fillCell(picking.day, picking.slot, { treat: false }); closePicker(); } });
  $("pick-treat").addEventListener("click", async () => { if (picking) { await fillCell(picking.day, picking.slot, { treat: true }); closePicker(); } });
  $("pick-out").addEventListener("click", async () => {
    if (!picking) return;
    const note = prompt("Mark this meal as OUT (eating out, skipping, etc.).\n\nAdd a short note (optional):", "");
    if (note === null) return;
    await saveEntry(picking.day, picking.slot, { status: "out", meal_name: null, sides: [], note: note.trim() });
    closePicker(); render();
  });
  $("pick-clear").addEventListener("click", async () => { if (picking) { await deleteEntry(picking.day, picking.slot); closePicker(); render(); } });

  // Meal editor
  $("btn-add-meal").addEventListener("click", () => openMealEditor(null));
  $("meal-save").addEventListener("click", saveMeal);
  $("meal-cancel").addEventListener("click", closeMealEditor);
  $("meal-modal-close").addEventListener("click", closeMealEditor);
  $("meal-delete").addEventListener("click", deleteMeal);
  $("meal-modal").addEventListener("click", (e) => { if (e.target.id === "meal-modal") closeMealEditor(); });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("modal").hidden) closePicker();
    if (!$("meal-modal").hidden) closeMealEditor();
  });
}

function flash(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ---------- start ---------- */
async function start() {
  if (!window.SUPABASE_URL || !window.SUPABASE_KEY) {
    showView("auth");
    $("auth-msg").hidden = false;
    $("auth-msg").textContent = "Missing Supabase settings in config.js.";
    return;
  }
  wireUp();
  showView("loading");
  const { data } = await sb.auth.getSession();
  await handleSession(data.session);
  sb.auth.onAuthStateChange((_event, session) => {
    // Only react to real sign-in/out changes.
    if (session && !USER_ID) handleSession(session);
    if (!session && USER_ID) { USER_ID = null; showView("auth"); }
  });
}

start();
