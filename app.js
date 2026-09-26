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
let SIDE_OPTIONS = [];          // shared library of side-dish names (Sides tab)
let mealFilter = "";            // search text on the Meals tab
let weekStart = mondayOf(new Date()); // Date of the Monday of the shown week
let plan = { entries: {}, days: {} }; // entries["day|slot"] = {...}; days["day"] = {is_out, note}
let editingMealId = null;       // for the meal editor
let effortTarget = 21; // total effort budget for a 7-night week; real value loaded in boot()

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

// Persist the latest live-rebalance to the database, but not on every drag tick.
let _rebalancePending = null, _rebalanceTimer = null;
function scheduleRebalancePersist(updates) {
  _rebalancePending = updates;
  clearTimeout(_rebalanceTimer);
  _rebalanceTimer = setTimeout(flushRebalance, 500);
}
async function flushRebalance() {
  clearTimeout(_rebalanceTimer);
  const updates = _rebalancePending;
  _rebalancePending = null;
  if (updates && updates.length) await saveEntries(updates);
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
// How soon (in days) counts as "expiring" for the meal-suggestion nudge.
const EXPIRY_SOON_DAYS = 7;
// How many days past the use-by date an item can still count toward the nudge.
const EXPIRY_GRACE_DAYS = 3;

// Recipe names of cupboard items due to run out within EXPIRY_SOON_DAYS.
// (Cupboard items carry an `ingredient_name` that matches a meal's ingredients.)
function expiringIngredientSet() {
  const set = new Set();
  (typeof CUPBOARD !== "undefined" ? CUPBOARD : []).forEach((it) => {
    const n = String(it.ingredient_name || "").toLowerCase().trim();
    if (n.length < 3) return; // ignore blanks / tiny words that match everything
    const days = cupDaysToExpiry(it.expiry_date);
    // Include items expiring soon and up to EXPIRY_GRACE_DAYS already past.
    if (days !== null && days >= -EXPIRY_GRACE_DAYS && days <= EXPIRY_SOON_DAYS) set.add(n);
  });
  return set;
}
// Does this meal use any ingredient that's expiring soon?
function mealUsesExpiringStock(meal, set) {
  const exp = set || expiringIngredientSet();
  if (!exp.size) return false;
  return (meal.ingredients || []).some((ing) => {
    const n = String(ing || "").toLowerCase().trim();
    if (!n) return false;
    for (const s of exp) { if (n === s || n.includes(s) || s.includes(n)) return true; }
    return false;
  });
}

// Pick a meal whose effort is closest to `want`. Effort still leads: we only
// look within a small tolerance of the ideal. As a gentle nudge, if any of
// those meals would use up soon-to-expire stock, we prefer one of them (and,
// when `usedNames` is given, one not already placed this week, so a whole
// week doesn't collapse onto the same dish).
function pickNearestDifficulty(pool, want, usedNames) {
  if (!pool.length) return null;
  let best = Infinity;
  pool.forEach((m) => { best = Math.min(best, Math.abs(mealDifficulty(m) - want)); });

  const TOL = 1.0;
  const exp = expiringIngredientSet();
  if (exp.size) {
    let near = pool.filter((m) =>
      Math.abs(mealDifficulty(m) - want) <= best + TOL && mealUsesExpiringStock(m, exp));
    if (usedNames) {
      const unused = near.filter((m) => !usedNames.has(m.name));
      if (unused.length) near = unused;
    }
    if (near.length) return rand(near);
  }

  // No expiring stock in play (or none usable): original behaviour — a random
  // pick from the meals whose effort ties for closest to the target.
  const ties = pool.filter((m) => Math.abs(Math.abs(mealDifficulty(m) - want) - best) < 1e-9);
  return rand(ties);
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
function makeEntry(meal, source) {
  const n = randInt(meal.min_sides, meal.max_sides);
  return {
    status: "planned",
    meal_name: meal.name,
    sides: pickSides(meal.sides || [], n),
    note: null,
    source: source || "manual",
    // Only home-cooked meals carry an effort cost; treats don't count.
    difficulty: meal.location === "Home" ? mealDifficulty(meal) : null,
  };
}
// Effort a planned night contributes: the number stored on the entry, or, for
// older entries saved before we stored it, looked up from the meal.
function entryDifficulty(entry) {
  if (!entry || !entry.meal_name || entry.status === "out") return 0;
  const d = parseInt(entry.difficulty, 10);
  if (d >= 1 && d <= 5) return d;
  const m = mealByName(entry.meal_name);
  return (m && m.location === "Home") ? mealDifficulty(m) : 0;
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

async function loadSideOptions() {
  const { data, error } = await sb.from("side_options").select("*").eq("household_id", HOUSEHOLD_ID).order("name");
  if (error) { console.error(error); SIDE_OPTIONS = []; return; }
  SIDE_OPTIONS = data || [];
}

async function addSideOption(name) {
  const clean = (name || "").trim();
  if (!clean) return;
  if (SIDE_OPTIONS.some((s) => s.name.toLowerCase() === clean.toLowerCase())) { flash("That side is already in the list."); return; }
  const { error } = await sb.from("side_options").insert({ household_id: HOUSEHOLD_ID, user_id: USER_ID, name: clean });
  if (error) { flash("Couldn't add side."); console.error(error); return; }
  await loadSideOptions();
  renderSidesList();
}

async function deleteSideOption(id) {
  const { error } = await sb.from("side_options").delete().eq("id", id);
  if (error) { flash("Couldn't remove side."); console.error(error); return; }
  await loadSideOptions();
  renderSidesList();
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

  // Seed the sides library from every distinct side the starter meals use.
  const names = new Set();
  (window.DEFAULT_MEALS || []).forEach((m) => (m.sides || []).forEach((s) => {
    const n = (s || "").trim();
    if (n) names.add(n);
  }));
  const sideRows = [...names].map((name) => ({ household_id: HOUSEHOLD_ID, user_id: USER_ID, name }));
  if (sideRows.length) {
    const { error } = await sb.from("side_options").insert(sideRows);
    if (error) console.error("side seed error", error); // non-fatal (e.g. already seeded)
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

// Build the database row for one planned night. `difficulty` snapshots the
// effort of the meal at the moment it's planned (home meals only), and
// `source` records whether it was auto-filled or chosen by a person.
function entryRow(dayKey, slot, entry) {
  return {
    user_id: USER_ID,
    household_id: HOUSEHOLD_ID,
    week_start: isoDate(weekStart),
    day: dayKey,
    slot,
    status: entry.status || "planned",
    meal_name: entry.meal_name || null,
    sides: entry.sides || [],
    note: entry.note || null,
    difficulty: (entry.difficulty === undefined ? null : entry.difficulty),
    source: entry.source || null,
    updated_at: new Date().toISOString(),
  };
}

async function saveEntry(dayKey, slot, entry) {
  const row = entryRow(dayKey, slot, entry);
  plan.entries[ekey(dayKey, slot)] = row;
  const { error } = await sb.from("plan_entries").upsert(row, { onConflict: "household_id,week_start,day,slot" });
  if (error) { flash("Couldn't save."); console.error(error); }
}

async function saveEntries(list) {
  // list: [{day, slot, entry}]
  const rows = list.map(({ day, slot, entry }) => entryRow(day, slot, entry));
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

// A night's lock state, from the `source` recorded on its entry.
//   manual → locked ("your pick"); auto → rolled. Empty / night-off → neither.
function isLocked(e) { return !!(e && e.meal_name && e.status !== "out" && e.source === "manual"); }
function isRolled(e) { return !!(e && e.meal_name && e.status !== "out" && e.source === "auto"); }

// Roll only the empty nights (leave locked picks, rolled meals and nights off).
async function rollEmptyNights() {
  const updates = [];
  DAYS.forEach((d) => {
    if (!eligible(d.key, SLOTS[0])) return;
    const e = plan.entries[ekey(d.key, SLOTS[0])];
    if (e && e.meal_name && e.status !== "out") return; // already has something
    const pool = candidates(SLOTS[0], d.key, { treat: false });
    if (pool.length) updates.push({ day: d.key, slot: SLOTS[0], entry: makeEntry(rand(pool), "auto") });
  });
  if (!updates.length) { flash("No empty nights to roll."); return; }
  await saveEntries(updates);
  render();
}

// Re-roll every night that isn't locked (empty nights and previously-rolled
// ones), leaving your own picks and nights off untouched.
async function reRollUnlocked() {
  const updates = [];
  DAYS.forEach((d) => {
    if (!eligible(d.key, SLOTS[0])) return;
    const e = plan.entries[ekey(d.key, SLOTS[0])];
    if (isLocked(e)) return; // your pick — leave it
    const pool = candidates(SLOTS[0], d.key, { treat: false });
    if (pool.length) updates.push({ day: d.key, slot: SLOTS[0], entry: makeEntry(rand(pool), "auto") });
  });
  if (!updates.length) { flash("Nothing to re-roll — lock or add a meal first."); return; }
  await saveEntries(updates);
  render();
}

// Clear only the rolled (unlocked) nights; keep your own picks and nights off.
async function clearUnlocked() {
  const days = DAYS.filter((d) => isRolled(plan.entries[ekey(d.key, SLOTS[0])])).map((d) => d.key);
  if (!days.length) { flash("No rolled nights to clear."); return; }
  for (const day of days) await deleteEntry(day, SLOTS[0]);
  render();
}

// Fill one night with a random matching meal. `lock` marks it as your pick.
async function fillCell(dayKey, slot, { treat = false, lock = false } = {}) {
  let pool = candidates(slot, dayKey, { treat });
  if (treat && pool.length === 0) pool = MEALS.filter((m) => m.location !== "Home");
  if (pool.length === 0) { flash("No matching meals — add some in the Meals tab."); return; }
  await saveEntry(dayKey, slot, makeEntry(rand(pool), lock ? "manual" : "auto"));
  render();
}

// Per-night buttons on the planner rows.
async function rollNight(dayKey) { await fillCell(dayKey, SLOTS[0], { treat: false, lock: false }); }
async function treatNight(dayKey) { await fillCell(dayKey, SLOTS[0], { treat: true, lock: true }); }

// Flip a night between locked (your pick) and rolled, keeping the same meal.
async function toggleLock(dayKey) {
  const e = plan.entries[ekey(dayKey, SLOTS[0])];
  if (!e || !e.meal_name || e.status === "out") return;
  await saveEntry(dayKey, SLOTS[0], { ...e, source: e.source === "manual" ? "auto" : "manual" });
  render();
}

async function clearNight(dayKey) { await deleteEntry(dayKey, SLOTS[0]); render(); }

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
  renderStats();
  renderGrid();
  renderShopping();
}

// Summary chips in the planner hero: how many nights are locked (your picks),
// rolled (auto-filled), empty, or a night off.
function renderStats() {
  const box = $("week-stats");
  if (!box) return;
  let locked = 0, rolled = 0, empty = 0, off = 0;
  DAYS.forEach((d) => {
    const st = cellState(d.key, SLOTS[0]);
    if (st.out) { off += 1; return; }
    const e = st.entry;
    if (!e || !e.meal_name) { empty += 1; return; }
    if (e.source === "manual") locked += 1; else rolled += 1;
  });
  const chips = [];
  if (locked) chips.push(`<span class="stat-chip locked">🔒 ${locked} locked</span>`);
  if (rolled) chips.push(`<span class="stat-chip">🎲 ${rolled} rolled</span>`);
  if (empty)  chips.push(`<span class="stat-chip">${empty} empty</span>`);
  if (off)    chips.push(`<span class="stat-chip">${off} night${off === 1 ? "" : "s"} off</span>`);
  box.innerHTML = chips.join("");
}

function renderWeekNav() { $("week-title").textContent = weekTitle(); }

// A small inline-SVG-free action button for a planner row.
function dayActionBtn(icon, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "day-act";
  b.textContent = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
  return b;
}

function renderGrid() {
  const list = $("grid-body");
  list.innerHTML = "";
  const slot = SLOTS[0]; // only "Dinner" now
  const todayIso = isoDate(new Date());

  DAYS.forEach((d) => {
    const dateObj = dateForDay(d.key);
    const dayOut = plan.days[d.key] && plan.days[d.key].is_out;

    const row = document.createElement("div");
    row.className = "day-row";
    if (isoDate(dateObj) === todayIso) row.classList.add("is-today");

    // left marker: short day name + date
    const date = document.createElement("div");
    date.className = "day-date";
    date.innerHTML =
      `<span class="d-name">${d.label.slice(0, 3).toUpperCase()}</span>` +
      `<span class="d-num">${dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>`;
    row.appendChild(date);

    const st = cellState(d.key, slot);

    // ---- whole day marked out of the planner ----
    if (dayOut) {
      row.classList.add("is-off");
      const note = plan.days[d.key].note;
      const main = document.createElement("div");
      main.className = "day-main day-off-label";
      main.innerHTML =
        `<span class="off-title">Night off</span>` +
        `<span class="off-note">${note ? escapeHtml(note) : "Skipped by rolls and left off the shopping list."}</span>`;
      row.appendChild(main);
      const back = dayActionBtn("↩", "Bring this day back into the planner", () => toggleDayOut(d.key));
      row.appendChild(back);
      row.addEventListener("click", () => toggleDayOut(d.key));
      list.appendChild(row);
      return;
    }

    const entry = st.entry;
    const meal = entry && entry.meal_name ? mealByName(entry.meal_name) : null;
    const isTreat = meal && meal.location !== "Home";
    const outCell = st.out; // slot-level "eating out" marker

    const main = document.createElement("div");
    main.className = "day-main";

    if (outCell) {
      row.classList.add("is-off");
      main.classList.add("day-off-label");
      main.innerHTML =
        `<span class="off-title">Night off</span>` +
        `<span class="off-note">${st.note ? escapeHtml(st.note) : "Eating out — left off the shopping list."}</span>`;
    } else if (entry && entry.meal_name) {
      if (isTreat) row.classList.add("is-treat");
      const title = document.createElement("div");
      title.className = "day-meal";
      title.textContent = entry.meal_name;
      main.appendChild(title);

      const tags = document.createElement("div");
      tags.className = "day-tags";
      if (isTreat) {
        tags.innerHTML = `<span class="tag treat">✨ ${meal.location === "Takeaway" ? "Takeaway" : "Eating out"}</span>`;
      } else {
        const bits = [`<span class="tag">Home</span>`];
        if (meal) bits.push(`<span class="tag">${escapeHtml(effortLabel(mealDifficulty(meal)))}</span>`);
        if (entry.sides && entry.sides.length) bits.push(`<span class="tag">With ${escapeHtml(entry.sides.join(", "))}</span>`);
        if (meal && mealUsesExpiringStock(meal)) bits.push(`<span class="tag expiring">🕒 use soon</span>`);
        tags.innerHTML = bits.join("");
      }
      main.appendChild(tags);
    } else {
      row.classList.add("is-empty");
      main.innerHTML =
        `<div class="day-meal dim">Nothing planned</div>` +
        `<div class="day-hint">Pick something, or let the dice decide.</div>`;
    }
    row.appendChild(main);

    // ---- lock pill / pick button ----
    if (entry && entry.meal_name && !outCell) {
      const lock = document.createElement("button");
      lock.type = "button";
      lock.className = "lock-btn" + (isLocked(entry) ? " locked" : "");
      lock.textContent = isLocked(entry) ? "🔒 Your pick" : "🎲 Rolled · keep";
      lock.title = isLocked(entry) ? "Locked — unlock to let rolls change it" : "Rolled — lock it as your pick";
      lock.addEventListener("click", (ev) => { ev.stopPropagation(); toggleLock(d.key); });
      row.appendChild(lock);
    } else if (!outCell) {
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "pick-btn";
      pick.textContent = "Pick a meal";
      pick.addEventListener("click", (ev) => { ev.stopPropagation(); openPicker(d.key, slot); });
      row.appendChild(pick);
    }

    // ---- action cluster (desktop) ----
    const actions = document.createElement("div");
    actions.className = "day-actions";
    actions.appendChild(dayActionBtn("🎲", `Roll ${d.label}`, () => rollNight(d.key)));
    actions.appendChild(dayActionBtn("✨", `Make ${d.label} a treat`, () => treatNight(d.key)));
    actions.appendChild(dayActionBtn("🚫", `Mark ${d.label} as a night off`, () => toggleDayOut(d.key)));
    if (entry && entry.meal_name)
      actions.appendChild(dayActionBtn("✕", `Clear ${d.label}`, () => clearNight(d.key)));
    row.appendChild(actions);

    // Tap the row to open the plan-a-night sheet.
    row.addEventListener("click", () => openPicker(d.key, slot));
    list.appendChild(row);
  });
}

/* The "got it" ticks and any extra items are remembered per week on this
 * device (no login needed, no database change). */
function shopStateKey() { return "dp-shop-" + isoDate(weekStart); }
function loadShopState() {
  try { const s = JSON.parse(localStorage.getItem(shopStateKey())); return s && typeof s === "object" ? s : {}; }
  catch (_) { return {}; }
}
function saveShopState(s) { try { localStorage.setItem(shopStateKey(), JSON.stringify(s)); } catch (_) {} }
function shopExtras() { const s = loadShopState(); return Array.isArray(s.extras) ? s.extras : []; }
function shopDoneSet() { const s = loadShopState(); return new Set(Array.isArray(s.done) ? s.done : []); }

function addShopExtra(label) {
  const clean = (label || "").trim();
  if (!clean) return;
  const s = loadShopState();
  s.extras = shopExtras();
  if (!s.extras.some((x) => x.toLowerCase() === clean.toLowerCase())) s.extras.push(clean);
  saveShopState(s);
  renderShopping();
}
function removeShopExtra(label) {
  const s = loadShopState();
  s.extras = shopExtras().filter((x) => x !== label);
  saveShopState(s);
  renderShopping();
}
function toggleShopDone(key) {
  const s = loadShopState();
  const done = shopDoneSet();
  if (done.has(key)) done.delete(key); else done.add(key);
  s.done = [...done];
  saveShopState(s);
  renderShopping();
}
function untickAllShop() {
  const s = loadShopState();
  s.done = [];
  saveShopState(s);
  renderShopping();
}

// The full list of shopping rows for the week: meal ingredients + your extras.
function shoppingRows() {
  const rows = buildShoppingList().map((it) => ({
    key: "m:" + it.label.toLowerCase(),
    label: cap(it.label),
    qty: it.count > 1 ? "×" + it.count : "",
    sub: [...it.meals].join(", "),
    extra: false,
  }));
  shopExtras().forEach((label) => rows.push({
    key: "x:" + label.toLowerCase(), label: cap(label), qty: "", sub: "Added by you", extra: true,
  }));
  return rows;
}

function renderShopping() {
  const box = $("shopping-body");
  const count = $("shopping-count");
  const progWrap = $("shopping-progress-wrap");
  if (!box) return;

  const rows = shoppingRows();
  const done = shopDoneSet();

  if (rows.length === 0) {
    box.innerHTML = '<p class="muted empty-note">Your shopping list will appear here once there are meals in the week.</p>';
    if (count) count.textContent = weekTitle();
    if (progWrap) progWrap.hidden = true;
    return;
  }

  const gotCount = rows.filter((r) => done.has(r.key)).length;
  if (count) count.textContent = `${weekTitle()} · ${rows.length} item${rows.length === 1 ? "" : "s"}`;

  if (progWrap) {
    progWrap.hidden = false;
    $("shop-progress-label").textContent = `${gotCount} of ${rows.length} in the basket`;
    $("shop-progress-bar").style.width = Math.round((gotCount / rows.length) * 100) + "%";
  }

  const toGet = rows.filter((r) => !done.has(r.key));
  const got = rows.filter((r) => done.has(r.key));

  const rowHtml = (r) => `
    <div class="shop-row${done.has(r.key) ? " is-done" : ""}" data-key="${escapeHtml(r.key)}">
      <span class="shop-check">✓</span>
      <span class="shop-main">
        <span class="shop-name">${escapeHtml(r.label)}</span>
        ${r.sub ? `<span class="shop-meal">${escapeHtml(r.sub)}</span>` : ""}
      </span>
      ${r.qty ? `<span class="shop-qty">${escapeHtml(r.qty)}</span>` : ""}
      ${r.extra ? `<button class="icon-btn shop-del" data-del="${escapeHtml(r.label)}" aria-label="Remove ${escapeHtml(r.label)}">🗑</button>` : ""}
    </div>`;

  let html = "";
  if (toGet.length) {
    html += `<div class="shop-group"><div class="shop-group-head">To get</div>${toGet.map(rowHtml).join("")}</div>`;
  }
  if (got.length) {
    html += `<div class="shop-group"><div class="shop-group-head done">Got it · ${got.length}</div>${got.map(rowHtml).join("")}</div>`;
  }
  box.innerHTML = html;
}

// Copy the still-to-get items to the clipboard as a plain text list.
async function copyShoppingList() {
  const done = shopDoneSet();
  const lines = shoppingRows()
    .filter((r) => !done.has(r.key))
    .map((r) => "• " + r.label + (r.qty ? " " + r.qty : ""));
  if (!lines.length) { flash("Nothing left to get."); return; }
  const text = `Shopping — ${weekTitle()}\n` + lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    flash("List copied.");
  } catch (_) {
    flash("Couldn't copy — try Print instead.");
  }
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
  const meal = mealByName(name);
  await saveEntry(picking.day, picking.slot, {
    status: "planned", meal_name: name, sides: chosen, note: null,
    source: "manual",
    difficulty: meal && meal.location === "Home" ? mealDifficulty(meal) : null,
  });
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

// Tick-boxes for which library sides go with this meal. Any side already on
// the meal but missing from the library is still shown (and kept) so editing
// an older meal never silently drops its sides.
function renderMealSideCheckboxes(chosen) {
  const box = $("m-sides-box");
  if (!box) return;
  box.innerHTML = "";
  const chosenSet = new Set(chosen || []);
  const names = SIDE_OPTIONS.map((s) => s.name);
  (chosen || []).forEach((c) => { if (!names.some((n) => n.toLowerCase() === c.toLowerCase())) names.push(c); });
  if (!names.length) {
    box.innerHTML = '<p class="muted empty-note">No sides yet — add some on the Sides tab.</p>';
    return;
  }
  names.sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const label = document.createElement("label");
    label.className = "side-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = name;
    if (chosenSet.has(name)) cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + name));
    box.appendChild(label);
  });
}

function openMealEditor(meal) {
  editingMealId = meal ? meal.id : null;
  $("meal-modal-title").textContent = meal ? "Edit meal" : "Add meal";
  $("m-name").value = meal ? meal.name : "";
  $("m-location").value = meal ? meal.location : "Home";
  $("m-effort").value = String(meal ? mealDifficulty(meal) : DEFAULT_DIFFICULTY);
  renderMealSideCheckboxes(meal ? (meal.sides || []) : []);
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
    sides: [...document.querySelectorAll("#m-sides-box input:checked")].map((c) => c.value),
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

let mealTypeFilter = "all"; // all | home | treat

function renderMealsList() {
  const box = $("meals-list");
  box.innerHTML = "";
  if (!MEALS.length) { box.innerHTML = '<p class="muted empty-note">No meals yet — add your first one.</p>'; return; }
  const q = mealFilter.trim().toLowerCase();
  const shown = MEALS.slice().sort(byName).filter((m) => {
    if (q && !m.name.toLowerCase().includes(q)) return false;
    if (mealTypeFilter === "home" && m.location !== "Home") return false;
    if (mealTypeFilter === "treat" && m.location === "Home") return false;
    return true;
  });
  if (!shown.length) { box.innerHTML = '<p class="muted empty-note">No meals match.</p>'; return; }
  shown.forEach((m) => {
    const row = document.createElement("button");
    row.className = "meal-row";
    row.type = "button";
    const treat = m.location !== "Home";
    const tags = [];
    if (treat) tags.push(`<span class="tag treat">✨ ${escapeHtml(m.location)}</span>`);
    else {
      tags.push(`<span class="tag">Home</span>`);
      tags.push(`<span class="tag">${escapeHtml(effortLabel(mealDifficulty(m)))}</span>`);
    }
    if (m.sides && m.sides.length) tags.push(`<span class="tag">${m.sides.length} side${m.sides.length === 1 ? "" : "s"}</span>`);
    row.innerHTML =
      `<span class="meal-row-name">${escapeHtml(m.name)}</span>` +
      `<span class="meal-row-tags">${tags.join("")}</span>`;
    row.addEventListener("click", () => openMealEditor(m));
    box.appendChild(row);
  });
}

function renderSidesList() {
  const box = $("sides-list");
  if (!box) return;
  box.innerHTML = "";
  if (!SIDE_OPTIONS.length) {
    box.innerHTML = '<p class="muted empty-note">No sides yet — add your first one above.</p>';
    return;
  }
  SIDE_OPTIONS.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((s) => {
    const row = document.createElement("div");
    row.className = "side-row";
    const nm = document.createElement("span");
    nm.className = "side-row-name";
    nm.textContent = s.name;
    row.appendChild(nm);
    const del = document.createElement("button");
    del.className = "icon-btn side-row-del";
    del.type = "button";
    del.setAttribute("aria-label", `Remove ${s.name}`);
    del.textContent = "🗑";
    del.addEventListener("click", () => {
      if (!confirm(`Remove "${s.name}" from the sides list?\n\nMeals that already use it will keep it.`)) return;
      deleteSideOption(s.id);
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

/* ============================================================
 *  Cupboard (barcode scanning -> cupboard_items)
 * ============================================================ */
let CUPBOARD = [];
let cupFilter = "";
let cupLocFilter = "all"; // all | Fridge | Freezer | Cupboard
let cupScanner = null, cupScanning = false, cupPaused = false;
let cupLastCode = null, cupLastTime = 0, cupAudio = null;

const CUP_FULLNESS = ["", "Full", "3/4", "1/2", "1/4", "Nearly empty"];
// Where an item lives. Scans default to "Cupboard"; the list groups by this,
// and each item has a picker to move it. Order here sets the section order.
const CUP_LOCATIONS = ["Cupboard", "Fridge", "Freezer"];
const CUP_FULL_PCT = { "Full": 100, "3/4": 75, "1/2": 50, "1/4": 25, "Nearly empty": 10 };

/* ---- data layer ---- */
async function loadCupboard() {
  const { data, error } = await sb.from("cupboard_items").select("*")
    .eq("household_id", HOUSEHOLD_ID).order("created_at", { ascending: false });
  if (error) { console.error(error); CUPBOARD = []; return; }
  CUPBOARD = data || [];
}
async function insertCupboardItem(row) {
  const { data, error } = await sb.from("cupboard_items")
    .insert({ ...row, household_id: HOUSEHOLD_ID, user_id: USER_ID, source: "cupboard-scanner" })
    .select().single();
  if (error) { flash("Couldn't save item."); console.error(error); return null; }
  CUPBOARD.unshift(data);
  return data;
}
async function updateCupboardItem(id, patch) {
  const { data, error } = await sb.from("cupboard_items")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error) { flash("Couldn't update."); console.error(error); return; }
  const i = CUPBOARD.findIndex((x) => x.id === id);
  if (i >= 0 && data) CUPBOARD[i] = data;
}
async function deleteCupboardItem(id) {
  const { error } = await sb.from("cupboard_items").delete().eq("id", id);
  if (error) { flash("Couldn't delete."); console.error(error); return; }
  CUPBOARD = CUPBOARD.filter((x) => x.id !== id);
}

/* ---- helpers ---- */
function cupParseSize(s) {
  if (!s) return { value: null, unit: null };
  const m = String(s).match(/([\d]+(?:\.[\d]+)?)\s*(kg|g|ml|l|pcs)\b/i);
  if (!m) return { value: null, unit: null };
  let v = parseFloat(m[1]); let u = m[2].toLowerCase();
  if (u === "kg") { v *= 1000; u = "g"; } else if (u === "l") { v *= 1000; u = "ml"; }
  return { value: v, unit: u };
}
function cupFullnessPatch(v) {
  return {
    fullness: v || null,
    fullness_pct: (v in CUP_FULL_PCT) ? CUP_FULL_PCT[v] : null,
    opened: v ? (v !== "Full") : null,
    low_stock: v ? (v === "1/4" || v === "Nearly empty") : null,
  };
}
function cupLookup(code) {
  const url = "https://world.openfoodfacts.org/api/v2/product/" +
    encodeURIComponent(code) + ".json?fields=product_name,brands,quantity";
  return fetch(url).then((r) => r.json()).then((d) => {
    if (d && d.status === 1 && d.product) {
      return {
        name: (d.product.product_name || "").trim(),
        brand: (d.product.brands || "").split(",")[0].trim(),
        size: (d.product.quantity || "").trim(),
      };
    }
    return null;
  }).catch(() => null);
}
// Days until a YYYY-MM-DD date (negative = already past). null if no date.
function cupDaysToExpiry(d) {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(d + "T00:00:00");
  return Math.round((exp - today) / 864e5);
}

/* ---- feedback (beep + flash) ---- */
function cupEnsureAudio() {
  try {
    if (!cupAudio) cupAudio = new (window.AudioContext || window.webkitAudioContext)();
    if (cupAudio.state === "suspended") cupAudio.resume();
  } catch (_) {}
}
function cupBeep() {
  if (!cupAudio) return;
  try {
    const t = cupAudio.currentTime;
    const o = cupAudio.createOscillator(), g = cupAudio.createGain();
    o.type = "square"; o.connect(g); g.connect(cupAudio.destination);
    o.frequency.setValueAtTime(1046, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t); o.stop(t + 0.27);
  } catch (_) {}
}
function cupFlashScreen() {
  const f = $("cup-flash");
  if (!f) return;
  f.classList.remove("show"); void f.offsetWidth; f.classList.add("show");
}
function cupFeedback() {
  try { if (navigator.vibrate) navigator.vibrate([40, 30, 40]); } catch (_) {}
  cupBeep(); cupFlashScreen();
}
function cupSetStatus(msg, cls) {
  const el = $("cup-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "cup-status" + (cls ? " " + cls : " muted");
}

/* ---- scanning ---- */
function cupStartScan() {
  if (cupScanning) { cupStopScan(); return; }
  cupEnsureAudio();
  cupLastCode = null; cupPaused = false;
  if (typeof Html5Qrcode === "undefined") {
    cupSetStatus("Scanner didn't load — check your connection and reload.", "err");
    return;
  }
  cupScanner = new Html5Qrcode("cup-reader", {
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
    ],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
  const qrbox = (vw, vh) => ({ width: Math.floor(vw * 0.9), height: Math.floor(vh * 0.72) });
  const config = {
    fps: 15, qrbox,
    videoConstraints: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
  };
  cupScanner.start({ facingMode: "environment" }, config,
    (text) => cupOnDecode(text.trim()), () => {}
  ).then(() => {
    cupScanning = true;
    $("cup-scan").textContent = "■ Stop scanning";
    cupSetStatus("Point at a barcode — it scans automatically.");
  }).catch((err) => {
    cupSetStatus("Couldn't start the camera: " + err + ". Allow camera access and use the https link.", "err");
  });
}
function cupStopScan() {
  if (cupScanner && cupScanning) {
    cupScanner.stop().then(() => cupScanner.clear()).catch(() => {});
  }
  cupScanning = false;
  const b = $("cup-scan"); if (b) b.textContent = "📷 Start scanning";
}
function cupPauseBriefly() {
  if (!cupScanner || !cupScanning) return;
  try {
    cupScanner.pause(true);
    cupPaused = true;
    setTimeout(() => {
      cupPaused = false;
      if (cupScanner && cupScanning) { try { cupScanner.resume(); } catch (_) {} }
    }, 1600);
  } catch (_) {}
}
function cupOnDecode(code) {
  if (cupPaused) return;
  const now = Date.now();
  if (code === cupLastCode && now - cupLastTime < 3500) return;
  cupLastCode = code; cupLastTime = now;
  cupCommit(code);
  cupPauseBriefly();
}
function cupDecodePhoto(file) {
  if (!file) return;
  cupEnsureAudio();
  if (typeof Html5Qrcode === "undefined") { cupSetStatus("Scanner didn't load — reload the page.", "err"); return; }
  cupSetStatus("Reading photo…");
  const fs = new Html5Qrcode("cup-filescan", {
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
    ],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
  const done = () => { try { fs.clear(); } catch (_) {} };
  fs.scanFileV2(file, false).then((res) => {
    const code = (res && res.decodedText ? res.decodedText : "").trim();
    done();
    if (code) cupCommit(code);
    else cupSetStatus("No barcode found — try again, filling the frame with just the barcode.", "err");
  }).catch(() => { done(); cupSetStatus("No barcode found — get closer, straight on, in focus.", "err"); });
}
// Add one scanned container as its own row, then fill in details from the database.
async function cupCommit(code) {
  const known = CUPBOARD.find((x) => x.barcode === code && x.product_name);
  cupFeedback();
  const row = await insertCupboardItem({
    barcode: code,
    product_name: known ? known.product_name : null,
    brand: known ? known.brand : null,
    ingredient_name: known ? known.ingredient_name : null,
    category: known ? known.category : null,
    size_text: known ? known.size_text : null,
    size_value: known ? known.size_value : null,
    size_unit: known ? known.size_unit : null,
    quantity: 1,
    location: "Cupboard",
  });
  renderCupboard();
  if (!row) return;
  if (known) { cupSetStatus("Added another " + (known.product_name || code), "ok"); return; }
  cupSetStatus("Added " + code + " — looking up…");
  const info = await cupLookup(code);
  if (info && info.name) {
    const sz = cupParseSize(info.size);
    await updateCupboardItem(row.id, {
      product_name: info.name, brand: info.brand || null,
      ingredient_name: info.name.toLowerCase(),
      size_text: info.size || null, size_value: sz.value, size_unit: sz.unit,
    });
    renderCupboard();
    cupSetStatus("Found: " + info.name + (info.size ? " (" + info.size + ")" : ""), "ok");
  } else {
    cupSetStatus("Added " + code + " — not in the database. Add a name and recipe name below.", "");
  }
}

/* ---- rendering ---- */
function renderCupboard() {
  const box = $("cup-list");
  const count = $("cup-count");
  if (!box) return;
  const q = cupFilter.trim().toLowerCase();
  const match = (it) => !q || [it.product_name, it.ingredient_name, it.brand, it.barcode]
    .some((v) => (v || "").toLowerCase().includes(q));
  const locMatch = (it) => cupLocFilter === "all" || (it.location || "Cupboard") === cupLocFilter;
  const items = CUPBOARD.filter((it) => match(it) && locMatch(it));

  const totalUnits = CUPBOARD.reduce((s, it) => s + (it.quantity || 0), 0);
  if (count) count.textContent = CUPBOARD.length
    ? `${CUPBOARD.length} item${CUPBOARD.length === 1 ? "" : "s"} · ${totalUnits} in stock` : "";

  if (!CUPBOARD.length) {
    box.innerHTML = '<p class="muted empty-note">Nothing here yet — tap “Start scanning” to add your first item.</p>';
    return;
  }
  if (!items.length) { box.innerHTML = '<p class="muted empty-note">No cupboard items match your search.</p>'; return; }

  // Group by location (main grouping), then sort items inside each group by
  // expiry (soonest first), then name.
  const byExpiryThenName = (a, b) => {
    const da = cupDaysToExpiry(a.expiry_date), db = cupDaysToExpiry(b.expiry_date);
    if (da !== null && db !== null && da !== db) return da - db;
    if (da !== null && db === null) return -1;
    if (da === null && db !== null) return 1;
    return (a.product_name || "").localeCompare(b.product_name || "");
  };
  const groups = new Map();
  items.forEach((it) => {
    const loc = it.location || "Cupboard";
    if (!groups.has(loc)) groups.set(loc, []);
    groups.get(loc).push(it);
  });
  // Known locations first (in CUP_LOCATIONS order), then any others A–Z.
  const groupOrder = [...groups.keys()].sort((a, b) => {
    const ia = CUP_LOCATIONS.indexOf(a), ib = CUP_LOCATIONS.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const LOC_ICON = { Cupboard: "🗄️", Fridge: "🧊", Freezer: "❄️" };
  box.innerHTML = groupOrder.map((loc) => {
    const rows = groups.get(loc).slice().sort(byExpiryThenName);
    const header = `<div class="cup-group-head">
      <h3>${LOC_ICON[loc] || "📦"} ${escapeHtml(loc)}</h3>
      <span class="cup-group-count">${rows.length}</span>
    </div>`;
    return header + rows.map(cupItemHtml).join("");
  }).join("");
}

// One cupboard-item card.
function cupItemHtml(it) {
  const days = cupDaysToExpiry(it.expiry_date);
  let expTag = "";
  if (days !== null) {
    if (days < 0) expTag = '<span class="cup-badge past">Expired</span>';
    else if (days <= 14) expTag = `<span class="cup-badge soon">${days === 0 ? "Today" : days + "d left"}</span>`;
  }
  const subBits = [it.brand, it.size_text].filter(Boolean).map(escapeHtml);
  if (it.category) subBits.push(`<span class="cup-cat-chip">${escapeHtml(it.category)}</span>`);
  const sub = subBits.join(" · ");
  const fullSel = CUP_FULLNESS.map((o) =>
    `<option value="${o}"${it.fullness === o ? " selected" : ""}>${o || "How full?"}</option>`).join("");
  const cur = it.location || "Cupboard";
  const locOpts = CUP_LOCATIONS.map((o) =>
    `<option value="${o}"${cur === o ? " selected" : ""}>${o}</option>`).join("") +
    (CUP_LOCATIONS.includes(cur) ? "" : `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>`);
  return `<div class="cup-item" data-id="${it.id}">
      <div class="cup-item-top">
        <input class="cup-name select" data-field="product_name" value="${escapeHtml(it.product_name || "")}" placeholder="Product name" />
        <button class="icon-btn cup-del" data-act="del" aria-label="Delete">🗑</button>
      </div>
      <label class="cup-lbl">Recipe name <span class="hint-inline">(matches your meals)</span></label>
      <input class="cup-ing select" data-field="ingredient_name" value="${escapeHtml(it.ingredient_name || "")}" placeholder="e.g. curry sauce" />
      <div class="cup-sub">${sub || `<span class="muted">${escapeHtml(it.barcode || "no barcode")}</span>`}${expTag}</div>
      <div class="cup-controls">
        <div class="cup-qty" aria-label="Quantity">
          <button data-act="dec" aria-label="One fewer">−</button>
          <b>${it.quantity || 0}</b>
          <button data-act="inc" aria-label="One more">＋</button>
        </div>
        <div class="cup-field">
          <label class="cup-lbl">Where</label>
          <select class="select" data-field="location">${locOpts}</select>
        </div>
        <div class="cup-field">
          <label class="cup-lbl">How full</label>
          <select class="select" data-field="fullness">${fullSel}</select>
        </div>
        <div class="cup-field">
          <label class="cup-lbl">Use by</label>
          <input class="select" type="date" data-field="expiry_date" value="${escapeHtml(it.expiry_date || "")}" />
        </div>
        <div class="cup-field cup-field-cat">
          <label class="cup-lbl">Category</label>
          <input class="select" data-field="category" value="${escapeHtml(it.category || "")}" placeholder="e.g. Tins" />
        </div>
      </div>
    </div>`;
}

function cupItemId(el) {
  const wrap = el.closest(".cup-item");
  return wrap ? wrap.getAttribute("data-id") : null;
}
async function cupOnListChange(e) {
  const el = e.target;
  const field = el.getAttribute("data-field");
  if (!field) return;
  const id = cupItemId(el);
  if (!id) return;
  if (field === "fullness") {
    await updateCupboardItem(id, cupFullnessPatch(el.value));
    renderCupboard();
  } else if (field === "expiry_date") {
    await updateCupboardItem(id, { expiry_date: el.value || null });
    renderCupboard();
  } else if (field === "location") {
    // Re-render: the item moves to a different location group.
    await updateCupboardItem(id, { location: el.value || "Cupboard" });
    renderCupboard();
  } else if (field === "category") {
    // Re-render so the category chip updates (change fires on blur).
    await updateCupboardItem(id, { category: el.value.trim() || null });
    renderCupboard();
  } else if (field === "product_name" || field === "ingredient_name") {
    // Persist text without re-rendering (keeps focus/caret).
    await updateCupboardItem(id, { [field]: el.value.trim() || null });
  }
}
async function cupOnListClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = cupItemId(btn);
  if (!id) return;
  const it = CUPBOARD.find((x) => x.id === id);
  if (!it) return;
  const act = btn.getAttribute("data-act");
  if (act === "inc") { await updateCupboardItem(id, { quantity: (it.quantity || 0) + 1 }); renderCupboard(); }
  else if (act === "dec") { await updateCupboardItem(id, { quantity: Math.max(1, (it.quantity || 1) - 1) }); renderCupboard(); }
  else if (act === "del") {
    if (!confirm("Remove this item from the cupboard?")) return;
    await deleteCupboardItem(id); renderCupboard();
  }
}

/* ============================================================
 *  Tabs & week navigation
 * ============================================================ */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  $("tab-planner").hidden = name !== "planner";
  $("tab-shopping").hidden = name !== "shopping";
  $("tab-meals").hidden = name !== "meals";
  $("tab-sides").hidden = name !== "sides";
  $("tab-cupboard").hidden = name !== "cupboard";
  if (name !== "cupboard") cupStopScan(); // never leave the camera running in the background
  window.scrollTo(0, 0);
  if (name === "shopping") renderShopping();
  if (name === "meals") renderMealsList();
  if (name === "sides") renderSidesList();
  if (name === "cupboard") renderCupboard();
}

async function gotoWeek(newStart) {
  weekStart = newStart;
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
  // The bottom nav only belongs to the signed-in app.
  const bn = $("bottom-nav");
  if (bn) bn.hidden = which !== "app";
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
  await loadSideOptions();
  await loadCupboard();
  await loadPlan();
  render();
  switchTab("planner");
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

  // Meals-tab search + type filter pills
  const mealSearch = $("meals-search");
  if (mealSearch) mealSearch.addEventListener("input", () => { mealFilter = mealSearch.value; renderMealsList(); });
  const mealsFilter = $("meals-filter");
  if (mealsFilter) mealsFilter.addEventListener("click", (e) => {
    const pill = e.target.closest("[data-mfilter]");
    if (!pill) return;
    mealTypeFilter = pill.dataset.mfilter;
    mealsFilter.querySelectorAll(".pill").forEach((p) => p.classList.toggle("is-active", p === pill));
    renderMealsList();
  });

  // Sides tab — add a side
  const sideForm = $("side-add-form");
  if (sideForm) sideForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("side-add-input");
    await addSideOption(input.value);
    input.value = "";
    input.focus();
  });

  // Cupboard
  const cupScanBtn = $("cup-scan");
  if (cupScanBtn) {
    cupScanBtn.addEventListener("click", cupStartScan);
    $("cup-photo").addEventListener("click", () => $("cup-photo-input").click());
    $("cup-photo-input").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      cupDecodePhoto(f);
      e.target.value = "";
    });
    const cupSearch = $("cup-search");
    if (cupSearch) cupSearch.addEventListener("input", () => { cupFilter = cupSearch.value; renderCupboard(); });
    $("cup-list").addEventListener("change", cupOnListChange);
    $("cup-list").addEventListener("click", cupOnListClick);
    const cupTabs = $("cup-loc-tabs");
    if (cupTabs) cupTabs.addEventListener("click", (e) => {
      const pill = e.target.closest("[data-loc]");
      if (!pill) return;
      cupLocFilter = pill.dataset.loc;
      cupTabs.querySelectorAll(".pill").forEach((p) => p.classList.toggle("is-active", p === pill));
      renderCupboard();
    });
  }

  // Week nav
  $("week-prev").addEventListener("click", () => gotoWeek(addDays(weekStart, -7)));
  $("week-next").addEventListener("click", () => gotoWeek(addDays(weekStart, 7)));
  $("week-today").addEventListener("click", () => gotoWeek(mondayOf(new Date())));

  // Planner actions (lock / roll)
  $("btn-roll-empty").addEventListener("click", rollEmptyNights);
  $("btn-reroll").addEventListener("click", reRollUnlocked);
  $("btn-clear").addEventListener("click", clearUnlocked);

  // Shopping list — check-off, extras, copy, print
  $("btn-print").addEventListener("click", () => window.print());
  const untick = $("btn-untick");
  if (untick) untick.addEventListener("click", untickAllShop);
  const copyBtn = $("btn-copy");
  if (copyBtn) copyBtn.addEventListener("click", copyShoppingList);
  const extraForm = $("extra-add-form");
  if (extraForm) extraForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("extra-add-input");
    addShopExtra(input.value);
    input.value = "";
    input.focus();
  });
  const shopBody = $("shopping-body");
  if (shopBody) shopBody.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); removeShopExtra(del.dataset.del); return; }
    const row = e.target.closest(".shop-row");
    if (row && row.dataset.key) toggleShopDone(row.dataset.key);
  });

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
