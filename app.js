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

function mealByName(name) { return MEALS.find((m) => m.name === name); }
// A meal's sides come in two kinds: "always" sides that come with it every
// time (mash for bangers and mash), and "maybe" sides the planner picks a few
// of at random. Older meals only have the "maybe" list.
function alwaysSides(meal) { return (meal && meal.always_sides) || []; }
function maybeSides(meal) {
  const always = new Set(alwaysSides(meal));
  return ((meal && meal.sides) || []).filter((s) => !always.has(s));
}
function sideByName(name) {
  const k = (name || "").trim().toLowerCase();
  return SIDE_OPTIONS.find((s) => s.name.toLowerCase() === k);
}
// What to buy for a side: its own ingredients, or just its name if none set.
function sideShopping(name) {
  const side = sideByName(name);
  return side && side.ingredients && side.ingredients.length ? side.ingredients : [name];
}

/* ---------- effort / difficulty ----------
 * Every meal has a difficulty of 1..5, stored as a number in the database
 * but shown to people as Quick / Normal / Big cook. Old meals only had a text "ease" field
 * (Easy/Medium/Hard), so we fall back to that when no number is set.       */
const EASE_TO_DIFFICULTY = { easy: 2, medium: 3, hard: 4 };
const DEFAULT_DIFFICULTY = 3;

function mealDifficulty(m) {
  if (!m) return DEFAULT_DIFFICULTY;
  const d = parseInt(m.difficulty, 10);
  if (d >= 1 && d <= 5) return d;
  return EASE_TO_DIFFICULTY[(m.ease || "").toLowerCase()] || DEFAULT_DIFFICULTY;
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
  return [...(meal.ingredients || []), ...alwaysSides(meal).flatMap(sideShopping)].some((ing) => {
    const n = String(ing || "").toLowerCase().trim();
    if (!n) return false;
    for (const s of exp) { if (n === s || n.includes(s) || s.includes(n)) return true; }
    return false;
  });
}

/* ---------- smart auto-planning ----------
 * When the dice fill a night we don't pick purely at random any more. Each
 * allowed meal gets a score and we pick at random *weighted* by that score, so
 * good fits come up far more often but the week still feels fresh:
 *   - "never suggest" meals are skipped, and nothing repeats within a week
 *   - meals eaten in the last few weeks are pushed down (last week the most)
 *   - favourites are pushed up
 *   - meals that use up soon-to-expire cupboard stock are pushed up
 *   - the same main (sausages, chicken…) two nights running is pushed down
 *   - hard meals are pushed down on Mon–Thu                                  */
const WEEKNIGHTS = ["mon", "tue", "wed", "thurs"];
const MAINS = [
  ["chicken", ["chicken"]], ["beef", ["beef", "steak", "mince"]], ["pork", ["pork", "gammon", "ham", "bacon", "pancetta"]],
  ["sausage", ["sausage"]], ["lamb", ["lamb"]], ["turkey", ["turkey"]], ["duck", ["duck"]],
  ["fish", ["fish", "tuna", "salmon", "cod", "prawn"]], ["egg", ["egg"]],
];
// The main proteins in a meal, e.g. ["sausage"] for bangers and mash.
function mealMains(meal) {
  const text = [meal.name, ...(meal.ingredients || [])].join(" ").toLowerCase();
  return MAINS.filter(([, words]) => words.some((w) => text.includes(w))).map(([k]) => k);
}
function dayIndex(dayKey) { return DAYS.findIndex((d) => d.key === dayKey); }

// Everything the scorer needs about the week being planned. `chosen` maps
// dayKey → meal name for nights already filled (including earlier picks in
// this same roll); `avoid` maps dayKey → a meal we're re-rolling away from.
function planContext(chosen, avoid) {
  return { chosen, avoid: avoid || {}, expiring: expiringIngredientSet() };
}
function mealScore(meal, dayKey, ctx) {
  if ((meal.rating | 0) < 0) return 0;
  const otherNights = Object.entries(ctx.chosen).filter(([d]) => d !== dayKey);
  if (otherNights.some(([, n]) => n === meal.name)) return 0;
  if (ctx.avoid[dayKey] === meal.name) return 0;
  let score = 10;
  const ago = daysSinceEaten(meal.name, dayKey);
  if (ago !== null) score -= ago <= 7 ? 7 : ago <= 14 ? 4 : 2;
  if ((meal.rating | 0) > 0) score += 4;
  if (mealUsesExpiringStock(meal, ctx.expiring)) score += 5;
  if (WEEKNIGHTS.includes(dayKey) && mealDifficulty(meal) >= 4) score -= 6;
  const i = dayIndex(dayKey);
  const mains = mealMains(meal);
  const neighbours = otherNights.filter(([d]) => Math.abs(dayIndex(d) - i) === 1)
    .map(([, n]) => mealByName(n)).filter(Boolean);
  if (mains.length && neighbours.some((m) => mealMains(m).some((x) => mains.includes(x)))) score -= 5;
  return Math.max(score, 0.5);
}
// Weighted random pick. If everything scores 0 (e.g. only one meal allowed
// that night and it's already used), fall back to any meal not marked "never".
function smartPick(pool, dayKey, ctx) {
  if (!pool.length) return null;
  const scored = pool.map((m) => ({ m, w: mealScore(m, dayKey, ctx) ** 2 })).filter((x) => x.w > 0);
  if (!scored.length) {
    const ok = pool.filter((m) => (m.rating | 0) >= 0);
    return ok.length ? rand(ok) : null;
  }
  let r = Math.random() * scored.reduce((t, x) => t + x.w, 0);
  for (const x of scored) { r -= x.w; if (r <= 0) return x.m; }
  return scored[scored.length - 1].m;
}

// Meals eaten in the few weeks before the shown week: name → latest date.
let HISTORY = new Map();
const HISTORY_WEEKS = 4;
async function loadHistory() {
  const from = isoDate(addDays(weekStart, -7 * HISTORY_WEEKS));
  const { data, error } = await sb.from("plan_entries").select("week_start,day,meal_name,status")
    .eq("household_id", HOUSEHOLD_ID).gte("week_start", from).lt("week_start", isoDate(weekStart));
  HISTORY = new Map();
  if (error) { console.error(error); return; }
  (data || []).forEach((e) => {
    if (!e.meal_name || e.status === "out") return;
    const [y, mo, da] = e.week_start.split("-").map(Number);
    const when = addDays(new Date(y, mo - 1, da), Math.max(0, dayIndex(e.day)));
    const prev = HISTORY.get(e.meal_name);
    if (!prev || when > prev) HISTORY.set(e.meal_name, when);
  });
}
function daysSinceEaten(name, dayKey) {
  const when = HISTORY.get(name);
  return when ? Math.round((dateForDay(dayKey) - when) / 864e5) : null;
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
// A planned night for `meal`. It comes with its usual ("always") sides only;
// extras are added by ticking them on the night.
function makeEntry(meal, source) {
  return {
    status: "planned",
    meal_name: meal.name,
    sides: alwaysSides(meal),
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

async function saveSideIngredients(side, text) {
  const ingredients = splitList(text);
  if (ingredients.join(",") === (side.ingredients || []).join(",")) return;
  const { error } = await sb.from("side_options").update({ ingredients }).eq("id", side.id);
  if (error) { flash("Couldn't save side."); console.error(error); return; }
  side.ingredients = ingredients;
  flash(`Saved what to buy for ${side.name}.`);
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
    category: "Dinner", // kept for the database column; lunch no longer exists
    location: m.location || "Home",
    difficulty: m.difficulty || DEFAULT_DIFFICULTY,
    sides: m.sides || [],
    always_sides: m.always || [],
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

  // Seed the sides library from every distinct side the starter meals use,
  // with what to buy for each one from DEFAULT_SIDES.
  const names = new Set();
  (window.DEFAULT_MEALS || []).forEach((m) => [...(m.sides || []), ...(m.always || [])].forEach((s) => {
    const n = (s || "").trim();
    if (n) names.add(n);
  }));
  const sideIngredients = window.DEFAULT_SIDES || {};
  const sideRows = [...names].map((name) => ({
    household_id: HOUSEHOLD_ID, user_id: USER_ID, name, ingredients: sideIngredients[name] || [],
  }));
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
    loadHistory(),
    loadShopItems(),
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
 * ============================================================
 * A night is either empty, a suggestion (source "auto"), something you chose
 * or changed yourself (source "manual"), or a night off. "Suggest week" only
 * ever refills empty nights and suggestions, so anything you touched stays. */

function eligible(dayKey, slot) {
  // A slot can be filled only if it isn't out (day-level or slot-level).
  const st = cellState(dayKey, slot);
  return !st.out;
}
function isChosen(e) { return !!(e && e.meal_name && e.status !== "out" && e.source === "manual"); }

// Smart-fill the given nights, one at a time, so each pick knows about the
// nights around it (including ones picked earlier in this same go).
function smartUpdates(dayKeys, source) {
  const chosen = {}, avoid = {};
  DAYS.forEach((d) => {
    const e = plan.entries[ekey(d.key, SLOTS[0])];
    if (!e || !e.meal_name || e.status === "out") return;
    if (dayKeys.includes(d.key)) avoid[d.key] = e.meal_name; // replacing it: try something else
    else chosen[d.key] = e.meal_name;
  });
  const ctx = planContext(chosen, avoid);
  const updates = [];
  dayKeys.forEach((day) => {
    const meal = smartPick(candidates(SLOTS[0], day, { treat: false }), day, ctx);
    if (!meal) return;
    chosen[day] = meal.name;
    updates.push({ day, slot: SLOTS[0], entry: makeEntry(meal, source || "auto") });
  });
  return updates;
}

// Fill every night that's empty or still a suggestion.
async function suggestWeek() {
  const days = DAYS.map((d) => d.key)
    .filter((day) => eligible(day, SLOTS[0]) && !isChosen(plan.entries[ekey(day, SLOTS[0])]));
  if (!days.length) { flash("Every night is already chosen. Use ⇄ on a night to change it."); return; }
  const updates = smartUpdates(days, "auto");
  if (!updates.length) { flash("No meals to suggest — add some in the Meals tab."); return; }
  await saveEntries(updates);
  render();
}

// Wipe the whole week (meals and nights off) for a fresh start.
async function startWeekAgain() {
  if (!confirm("Start this week again?\n\nThis clears every night, including ones you chose and nights off.")) return;
  await clearWeekData();
  render();
}

// "Something else" for one night. The new meal counts as your choice.
async function swapNight(dayKey) {
  const [u] = smartUpdates([dayKey], "manual");
  if (!u) { flash("No other meals fit this night."); return; }
  await saveEntry(dayKey, SLOTS[0], u.entry);
  render();
}

// Put a specific meal on a night (from the meal list, or a takeaway).
async function setNightMeal(dayKey, meal) {
  if (plan.days[dayKey] && plan.days[dayKey].is_out) await setDayOut(dayKey, false);
  await saveEntry(dayKey, SLOTS[0], makeEntry(meal, "manual"));
  render();
}

async function clearNight(dayKey) { await deleteEntry(dayKey, SLOTS[0]); render(); }

async function setNotCooking(dayKey, isOut) {
  await setDayOut(dayKey, isOut, null);
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
      const parts = [...((meal && meal.ingredients) || []), ...(st.entry.sides || []).flatMap(sideShopping)];
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

// Summary line in the planner hero, e.g. "5 dinners planned · 1 night off".
function renderStats() {
  const box = $("week-stats");
  if (!box) return;
  let planned = 0, empty = 0, off = 0;
  DAYS.forEach((d) => {
    const st = cellState(d.key, SLOTS[0]);
    if (st.out) off += 1;
    else if (st.entry && st.entry.meal_name) planned += 1;
    else empty += 1;
  });
  const chips = [];
  if (planned) chips.push(`<span class="stat-chip">${planned} dinner${planned === 1 ? "" : "s"} planned</span>`);
  if (empty)   chips.push(`<span class="stat-chip">${empty} to plan</span>`);
  if (off)     chips.push(`<span class="stat-chip">${off} night${off === 1 ? "" : "s"} off</span>`);
  box.innerHTML = chips.join("");
}

function renderWeekNav() { $("week-title").textContent = weekTitle(); }

function renderGrid() {
  const list = $("grid-body");
  list.innerHTML = "";
  const slot = SLOTS[0]; // only "Dinner" now
  const todayIso = isoDate(new Date());

  DAYS.forEach((d) => {
    const dateObj = dateForDay(d.key);
    const st = cellState(d.key, slot);
    const entry = st.out ? null : st.entry;
    const meal = entry && entry.meal_name ? mealByName(entry.meal_name) : null;

    const row = document.createElement("div");
    row.className = "day-row";
    if (isoDate(dateObj) === todayIso) row.classList.add("is-today");
    row.innerHTML =
      `<div class="day-date"><span class="d-name">${d.label.slice(0, 3).toUpperCase()}</span>` +
      `<span class="d-num">${dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></div>`;

    const main = document.createElement("div");
    main.className = "day-main";
    if (st.out) {
      row.classList.add("is-off");
      main.innerHTML = `<div class="day-meal dim">Not cooking</div>` +
        (st.note ? `<div class="day-hint">${escapeHtml(st.note)}</div>` : "");
    } else if (entry && entry.meal_name) {
      const isTreat = meal && meal.location !== "Home";
      if (isTreat) row.classList.add("is-treat");
      const tags = [];
      if (isTreat) tags.push(`<span class="tag treat">✨ ${meal.location === "Takeaway" ? "Takeaway" : "Eating out"}</span>`);
      if (meal && (meal.rating | 0) > 0) tags.push(`<span class="tag">❤️</span>`);
      if (meal && !isTreat && mealUsesExpiringStock(meal)) tags.push(`<span class="tag expiring">🕒 uses up food</span>`);
      main.innerHTML = `<div class="day-meal">${escapeHtml(entry.meal_name)}</div>` +
        (tags.length ? `<div class="day-tags">${tags.join("")}</div>` : "");
    } else {
      row.classList.add("is-empty");
      main.innerHTML = `<div class="day-meal dim">Nothing yet</div>`;
    }
    row.appendChild(main);

    // ⇄ on planned/empty nights: give me something else (or a first idea).
    if (!st.out) {
      const swap = document.createElement("button");
      swap.type = "button";
      swap.className = "swap-btn";
      swap.textContent = "⇄";
      swap.title = entry && entry.meal_name ? "Something else" : "Suggest something";
      swap.setAttribute("aria-label", `${swap.title} for ${d.label}`);
      swap.addEventListener("click", (ev) => { ev.stopPropagation(); swapNight(d.key); });
      row.appendChild(swap);
    }

    row.addEventListener("click", () => openNight(d.key));
    list.appendChild(row);
  });
}

/* The "got it" ticks and any extra items are shared by the household: each
 * one is a row in `shopping_items` for that week, so ticking something on one
 * phone shows on the other. (Ticks used to live on each device only; any left
 * over from then are uploaded once, the first time a week is opened.)       */
let SHOP = { done: new Set(), extras: [] };
let _shopPoll = null;
function legacyShopKey() { return "dp-shop-" + isoDate(weekStart); }

async function loadShopItems() {
  const ws = isoDate(weekStart);
  const { data, error } = await sb.from("shopping_items").select("kind,key,label")
    .eq("household_id", HOUSEHOLD_ID).eq("week_start", ws).order("created_at");
  if (error) { console.error(error); return false; }
  const next = { done: new Set(), extras: [] };
  (data || []).forEach((r) => { if (r.kind === "done") next.done.add(r.key); else next.extras.push(r.label); });
  const changed = [...next.done].sort().join("|") !== [...SHOP.done].sort().join("|")
    || next.extras.join("|") !== SHOP.extras.join("|");
  SHOP = next;
  await uploadLegacyShopState(ws);
  return changed;
}
async function uploadLegacyShopState(ws) {
  let old = null;
  try { old = JSON.parse(localStorage.getItem(legacyShopKey())); } catch (_) {}
  if (!old || typeof old !== "object") return;
  const rows = [
    ...(Array.isArray(old.done) ? old.done : []).map((key) => ({ kind: "done", key, label: key })),
    ...(Array.isArray(old.extras) ? old.extras : []).map((label) => ({ kind: "extra", key: label.toLowerCase(), label })),
  ].map((r) => ({ ...r, household_id: HOUSEHOLD_ID, user_id: USER_ID, week_start: ws }));
  if (rows.length) {
    const { error } = await sb.from("shopping_items")
      .upsert(rows, { onConflict: "household_id,week_start,kind,key", ignoreDuplicates: true });
    if (error) { console.error(error); return; }
    rows.forEach((r) => { if (r.kind === "done") SHOP.done.add(r.key); else if (!SHOP.extras.includes(r.label)) SHOP.extras.push(r.label); });
  }
  try { localStorage.removeItem(legacyShopKey()); } catch (_) {}
}
async function addShopRow(kind, key, label) {
  const { error } = await sb.from("shopping_items").upsert(
    { household_id: HOUSEHOLD_ID, user_id: USER_ID, week_start: isoDate(weekStart), kind, key, label },
    { onConflict: "household_id,week_start,kind,key", ignoreDuplicates: true });
  if (error) { flash("Couldn't save — check your connection."); console.error(error); }
}
async function removeShopRows(kind, keys) {
  if (!keys.length) return;
  const { error } = await sb.from("shopping_items").delete().eq("household_id", HOUSEHOLD_ID)
    .eq("week_start", isoDate(weekStart)).eq("kind", kind).in("key", keys);
  if (error) { flash("Couldn't save — check your connection."); console.error(error); }
}

// While the Shopping tab is open, check for the other person's ticks.
function startShopPolling() {
  stopShopPolling();
  _shopPoll = setInterval(async () => {
    if (document.hidden) return;
    if (await loadShopItems()) renderShopping();
  }, 8000);
}
function stopShopPolling() { clearInterval(_shopPoll); _shopPoll = null; }

function addShopExtra(label) {
  const clean = (label || "").trim();
  if (!clean) return;
  if (SHOP.extras.some((x) => x.toLowerCase() === clean.toLowerCase())) return;
  SHOP.extras.push(clean);
  renderShopping();
  addShopRow("extra", clean.toLowerCase(), clean);
}
function removeShopExtra(label) {
  SHOP.extras = SHOP.extras.filter((x) => x !== label);
  SHOP.done.delete("x:" + label.toLowerCase());
  renderShopping();
  removeShopRows("extra", [label.toLowerCase()]);
  removeShopRows("done", ["x:" + label.toLowerCase()]);
}
function toggleShopDone(key) {
  const had = SHOP.done.has(key);
  if (had) SHOP.done.delete(key); else SHOP.done.add(key);
  renderShopping();
  if (had) removeShopRows("done", [key]); else addShopRow("done", key, key);
}
function untickAllShop() {
  const keys = [...SHOP.done];
  SHOP.done.clear();
  renderShopping();
  removeShopRows("done", keys);
}

/* ---------- aisles ----------
 * Rows are grouped roughly in the order you walk round Aldi. The first group
 * whose words appear in an item wins, so the more specific groups (frozen,
 * jars and tins) are checked before the general ones.                        */
const AISLES = [
  ["Frozen", ["frozen", "oven chips", "fries", "wedges", "hash brown", "yorkshire", "onion rings", "dinosaur",
    "fish burger", "breaded", "southern fried", "chicken bites", "chicken burgers", "ice cream"]],
  ["Tins, jars & dry", ["sauce", "tin", "chopped tomatoes", "plum tomatoes", "purée", "puree", "passata", "baked beans",
    "kidney beans", "mushy peas", "pasta", "spaghetti", "macaroni", "pappardelle", "lasagne", "noodle", "rice", "stock",
    "gravy", "stuffing", "flour", "pesto", "mayo", "salsa", "oil", "seasoning", "spice", "tortilla chips", "crackers",
    "popadoms", "kit", "taco", "gherkins", "croutons", "dressing", "crispy onions", "sweetcorn", "jalapeño", "jalapeno"]],
  ["Meat & fish", ["chicken", "beef", "mince", "steak", "pork", "sausage", "bacon", "ham", "lamb", "turkey", "duck",
    "fish", "salmon", "cod", "prawn", "pancetta", "pepperoni", "kebab", "meatballs"]],
  ["Fridge", ["milk", "cheese", "butter", "cream", "egg", "yoghurt", "yogurt", "mozzarella", "parmesan", "pecorino",
    "houmous", "hummus", "coleslaw", "pizza dough", "guacamole"]],
  ["Bread", ["bread", "bun", "rolls", "wraps", "tortilla", "naan", "panini", "bagel", "pancakes", "toast"]],
  ["Fruit & veg", ["potato", "carrot", "onion", "pepper", "tomato", "lettuce", "cucumber", "mushroom", "garlic",
    "broccoli", "cauliflower", "parsnip", "green beans", "rocket", "salad", "lemon", "lime", "avocado", "apple", "banana"]],
];
const AISLE_ICON = { "Fruit & veg": "🥕", "Bread": "🍞", "Meat & fish": "🥩", "Fridge": "🧀", "Tins, jars & dry": "🥫", "Frozen": "❄️", "Other": "🛒" };
const AISLE_ORDER = ["Fruit & veg", "Bread", "Meat & fish", "Fridge", "Tins, jars & dry", "Frozen", "Other"];
function shopAisle(label) {
  const t = (label || "").toLowerCase();
  const hit = AISLES.find(([, words]) => words.some((w) => t.includes(w)));
  return hit ? hit[0] : "Other";
}

/* ---------- cupboard check ----------
 * An item counts as "probably in the cupboard" when the two names are the
 * same once plurals and describing words are ignored, e.g. "rice" = "basmati
 * rice", "eggs" = "free range eggs", "beef stock cubes" = "beef stock". Any
 * other extra word means a different thing: "chicken" ≠ "chicken stock",
 * "peppers" ≠ "black pepper", "tomatoes" ≠ "peeled tomatoes".               */
const stem = (w) => w.replace(/(es|s)$/, "");
const DESCRIBING_WORDS = new Set([
  "light", "plain", "whole", "free", "range", "scottish", "british", "slightly", "salted", "unsalted", "spreadable",
  "seeded", "brioche", "cooked", "basmati", "long", "grain", "jasmine", "fresh", "large", "small", "extra", "mature",
  "mild", "organic", "original", "classic", "reduced", "fat", "low", "cubes", "granules", "pouch", "tin", "tinned",
  "jar", "pack", "frozen",
].map(stem));
function nameWords(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1).map(stem)
    .filter((w) => !DESCRIBING_WORDS.has(w));
}
function cupboardHas(label) {
  const want = [...new Set(nameWords(label))].sort().join(" ");
  if (!want) return null;
  return CUPBOARD.find((it) => (it.quantity || 0) > 0
    && [...new Set(nameWords(it.ingredient_name))].sort().join(" ") === want) || null;
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
  SHOP.extras.forEach((label) => rows.push({
    key: "x:" + label.toLowerCase(), label: cap(label), qty: "", sub: "Added by you", extra: true,
  }));
  rows.forEach((r) => {
    r.aisle = shopAisle(r.label);
    r.inCupboard = r.extra ? null : cupboardHas(r.label);
  });
  return rows;
}

function renderShopping() {
  const box = $("shopping-body");
  const count = $("shopping-count");
  const progWrap = $("shopping-progress-wrap");
  if (!box) return;

  const rows = shoppingRows();
  const done = SHOP.done;

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

  const toGet = rows.filter((r) => !done.has(r.key) && !r.inCupboard);
  const maybeGot = rows.filter((r) => !done.has(r.key) && r.inCupboard);
  const got = rows.filter((r) => done.has(r.key));

  const rowHtml = (r) => `
    <div class="shop-row${done.has(r.key) ? " is-done" : ""}" data-key="${escapeHtml(r.key)}">
      <span class="shop-check">✓</span>
      <span class="shop-main">
        <span class="shop-name">${escapeHtml(r.label)}</span>
        ${r.sub ? `<span class="shop-meal">${escapeHtml(r.sub)}</span>` : ""}
        ${r.inCupboard && !done.has(r.key) ? `<span class="shop-meal shop-have">🗄️ You have: ${escapeHtml(r.inCupboard.product_name || r.inCupboard.ingredient_name)}${r.inCupboard.quantity > 1 ? " ×" + r.inCupboard.quantity : ""}${r.inCupboard.fullness ? " (" + escapeHtml(r.inCupboard.fullness) + ")" : ""}</span>` : ""}
      </span>
      ${r.qty ? `<span class="shop-qty">${escapeHtml(r.qty)}</span>` : ""}
      ${r.extra ? `<button class="icon-btn shop-del" data-del="${escapeHtml(r.label)}" aria-label="Remove ${escapeHtml(r.label)}">🗑</button>` : ""}
    </div>`;

  let html = "";
  AISLE_ORDER.forEach((aisle) => {
    const inAisle = toGet.filter((r) => r.aisle === aisle).sort((a, b) => a.label.localeCompare(b.label));
    if (!inAisle.length) return;
    html += `<div class="shop-group"><div class="shop-group-head">${AISLE_ICON[aisle]} ${aisle}</div>${inAisle.map(rowHtml).join("")}</div>`;
  });
  if (maybeGot.length) {
    html += `<div class="shop-group"><div class="shop-group-head have">🗄️ Check the cupboard first · ${maybeGot.length}</div>` +
      `<p class="shop-group-note">Your cupboard says you've got these. Tap one if you've checked and you're sorted.</p>` +
      `${maybeGot.map(rowHtml).join("")}</div>`;
  }
  if (got.length) {
    html += `<div class="shop-group"><div class="shop-group-head done">Got it · ${got.length}</div>${got.map(rowHtml).join("")}</div>`;
  }
  box.innerHTML = html;
}

// Copy the still-to-get items to the clipboard as a plain text list, by aisle.
async function copyShoppingList() {
  const rows = shoppingRows().filter((r) => !SHOP.done.has(r.key) && !r.inCupboard);
  if (!rows.length) { flash("Nothing left to get."); return; }
  const lines = [];
  AISLE_ORDER.forEach((aisle) => {
    const inAisle = rows.filter((r) => r.aisle === aisle).sort((a, b) => a.label.localeCompare(b.label));
    if (!inAisle.length) return;
    lines.push("", aisle.toUpperCase());
    inAisle.forEach((r) => lines.push("• " + r.label + (r.qty ? " " + r.qty : "")));
  });
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
let nightDay = null;       // the night the sheet is open for
let chooseMode = "all";    // "all" meals, or only "treat"s
const byName = (a, b) => a.name.localeCompare(b.name);

function openNight(dayKey) {
  nightDay = dayKey;
  showNightView();
  $("modal").hidden = false;
}
function closeNight() { $("modal").hidden = true; nightDay = null; }

function showNightView() {
  $("choose-view").hidden = true;
  $("night-view").hidden = false;
  renderNight();
}

// The night sheet: what's on, what it comes with, extras to tick, and actions.
function renderNight() {
  if (!nightDay) return;
  const d = DAYS.find((x) => x.key === nightDay);
  $("modal-title").textContent = `${d.label} ${dateForDay(nightDay).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  const st = cellState(nightDay, SLOTS[0]);
  const entry = st.out ? null : st.entry;
  const meal = entry && entry.meal_name ? mealByName(entry.meal_name) : null;
  const isHome = !!meal && meal.location === "Home";

  $("night-meal").textContent = st.out ? "Not cooking tonight" : (entry && entry.meal_name) || "Nothing planned yet";
  $("night-meal").classList.toggle("dim", st.out || !(entry && entry.meal_name));

  const always = alwaysSides(meal);
  $("night-comes").innerHTML = always.length && entry
    ? `Comes with <strong>${always.map(escapeHtml).join(" · ")}</strong>` : "";

  // Extras: tick to add, tick again to take off. Saved straight away.
  const extras = maybeSides(meal);
  $("night-extras-wrap").hidden = !entry || !extras.length;
  const box = $("night-extras");
  box.innerHTML = "";
  const have = new Set((entry && entry.sides) || []);
  extras.forEach((name) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "side-item" + (have.has(name) ? " is-on" : "");
    chip.textContent = (have.has(name) ? "✓ " : "+ ") + name;
    chip.addEventListener("click", () => toggleExtra(name));
    box.appendChild(chip);
  });

  $("night-rating").hidden = !isHome;
  if (isHome) {
    $("night-rating").querySelectorAll("button[data-rating]").forEach((b) => {
      b.classList.toggle("is-on", (meal.rating | 0) === parseInt(b.dataset.rating, 10));
    });
  }

  $("night-swap").textContent = entry && entry.meal_name ? "⇄ Something else" : "⇄ Suggest something";
  $("night-swap").hidden = st.out;
  $("night-off").textContent = st.out ? "↩ Cooking after all" : "🚫 Not cooking tonight";
  $("night-clear").hidden = !(entry && entry.meal_name);
}

async function toggleExtra(name) {
  const e = plan.entries[ekey(nightDay, SLOTS[0])];
  if (!e) return;
  const sides = (e.sides || []).includes(name) ? e.sides.filter((x) => x !== name) : [...(e.sides || []), name];
  await saveEntry(nightDay, SLOTS[0], { ...e, sides, source: "manual" });
  renderNight();
  render();
}

async function setMealRating(meal, rating) {
  const next = (meal.rating | 0) === rating ? 0 : rating; // tap again to undo
  const { error } = await sb.from("meals").update({ rating: next }).eq("id", meal.id);
  if (error) { flash("Couldn't save."); console.error(error); return; }
  meal.rating = next;
  renderNight();
  render();
  flash(next > 0 ? `❤️ ${meal.name} will come up more.` : next < 0 ? `👎 ${meal.name} won't be suggested.` : "Back to normal.");
}

/* ---------- choosing a meal for the night ---------- */
function openChooser(mode) {
  chooseMode = mode;
  $("night-view").hidden = true;
  $("choose-view").hidden = false;
  $("choose-title").textContent = mode === "treat" ? "Takeaway or eating out" : "Choose a meal";
  $("choose-search").value = "";
  renderChooseList("");
  if (mode !== "treat") $("choose-search").focus();
}
function chooseGroups(query) {
  const q = (query || "").trim().toLowerCase();
  const match = (m) => !q || m.name.toLowerCase().includes(q);
  const home = { label: "Home cooked", items: MEALS.filter((m) => m.location === "Home" && match(m)).sort(byName) };
  const treats = { label: "Takeaway & eating out", items: MEALS.filter((m) => m.location !== "Home" && match(m)).sort(byName) };
  return (chooseMode === "treat" ? [treats] : [home, treats]).filter((g) => g.items.length);
}
function renderChooseList(query) {
  const list = $("choose-list");
  list.innerHTML = "";
  const groups = chooseGroups(query);
  if (!groups.length) { list.innerHTML = '<p class="muted empty-note">No meals match.</p>'; return; }
  const current = (plan.entries[ekey(nightDay, SLOTS[0])] || {}).meal_name;
  groups.forEach((g) => {
    if (chooseMode !== "treat") {
      const head = document.createElement("div");
      head.className = "combo-group";
      head.textContent = g.label;
      list.appendChild(head);
    }
    g.items.forEach((m) => {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "choose-option" + (m.name === current ? " is-current" : "");
      const with_ = alwaysSides(m);
      opt.innerHTML = `<span>${escapeHtml(m.name)}</span>` +
        (with_.length ? `<span class="choose-sub">with ${escapeHtml(with_.join(" & "))}</span>` : "");
      opt.addEventListener("click", async () => {
        await setNightMeal(nightDay, m);
        showNightView();
      });
      list.appendChild(opt);
    });
  });
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
    cb.addEventListener("change", renderDaysSummary);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + d.label.slice(0, 3)));
    box.appendChild(label);
  });
  renderDaysSummary();
}
function editorDays() { return [...document.querySelectorAll("#m-days input:checked")].map((c) => c.value); }
function renderDaysSummary() {
  const days = editorDays();
  $("m-days-summary").textContent = days.length === DAYS.length ? "(every night)"
    : days.length ? "(" + DAYS.filter((d) => days.includes(d.key)).map((d) => d.label.slice(0, 3)).join(", ") + ")"
    : "(no nights — it won't be suggested)";
}

/* ---------- chip editor ----------
 * A list you build by typing: each item is a chip with ✕; type and press
 * Enter (or a comma) to add. Used for what to buy, and for sides.          */
function chipEditor(boxId, values) {
  const box = $(boxId);
  box.innerHTML = "";
  const input = document.createElement("input");
  input.className = "chip-input";
  input.type = "text";
  input.placeholder = box.dataset.placeholder || "Add…";
  if (box.dataset.sides) input.setAttribute("list", "side-names");
  const addChip = (text) => {
    const v = (text || "").trim();
    if (!v || chipValues(boxId).some((x) => x.toLowerCase() === v.toLowerCase())) return;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.dataset.value = v;
    chip.textContent = v;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chip-x";
    x.setAttribute("aria-label", `Remove ${v}`);
    x.textContent = "✕";
    x.addEventListener("click", () => chip.remove());
    chip.appendChild(x);
    box.insertBefore(chip, input);
  };
  const commit = () => { const typed = input.value; input.value = ""; typed.split(",").forEach(addChip); };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    else if (e.key === "Backspace" && !input.value) { const last = box.querySelectorAll(".chip"); if (last.length) last[last.length - 1].remove(); }
  });
  input.addEventListener("change", commit); // picking from the suggestions list
  input.addEventListener("blur", commit);
  box.appendChild(input);
  (values || []).forEach(addChip);
  box.addEventListener("click", (e) => { if (e.target === box) input.focus(); });
}
function chipValues(boxId) {
  const box = $(boxId);
  const typed = box.querySelector(".chip-input");
  const vals = [...box.querySelectorAll(".chip")].map((c) => c.dataset.value);
  // Anything typed but not yet turned into a chip still counts.
  if (typed && typed.value.trim()) typed.value.split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => vals.push(t));
  return vals;
}

// "How long" is three choices; stored as the 1–5 effort number underneath.
const EFFORT_BUCKETS = { quick: 2, normal: 3, big: 4 };
function effortBucket(n) { return n <= 2 ? "quick" : n === 3 ? "normal" : "big"; }
function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === String(value); });
}
function getRadio(name) { const r = document.querySelector(`input[name="${name}"]:checked`); return r ? r.value : null; }
function syncHomeOnly() {
  const home = getRadio("m-loc") === "Home";
  document.querySelectorAll("#meal-modal .home-only").forEach((el) => { el.hidden = !home; });
}

let editingMealDifficulty = null;
function openMealEditor(meal) {
  editingMealId = meal ? meal.id : null;
  editingMealDifficulty = meal ? mealDifficulty(meal) : null;
  $("meal-modal-title").textContent = meal ? "Edit meal" : "Add meal";
  $("m-name").value = meal ? meal.name : "";
  setRadio("m-loc", meal ? meal.location : "Home");
  setRadio("m-effort", effortBucket(meal ? mealDifficulty(meal) : DEFAULT_DIFFICULTY));
  setRadio("m-rating", meal ? Math.sign(meal.rating | 0) : 0);
  $("side-names").innerHTML = SIDE_OPTIONS.map((x) => `<option value="${escapeHtml(x.name)}"></option>`).join("");
  chipEditor("m-buy", meal ? meal.ingredients : []);
  chipEditor("m-always", alwaysSides(meal));
  chipEditor("m-extras", maybeSides(meal));
  const days = meal ? meal.days : DAYS.map((d) => d.key);
  renderDayCheckboxes(days);
  $("m-days-wrap").open = (days || []).length !== DAYS.length;
  syncHomeOnly();
  $("meal-delete").hidden = !meal;
  $("meal-modal").hidden = false;
  if (!meal) $("m-name").focus();
}
function closeMealEditor() { $("meal-modal").hidden = true; editingMealId = null; }

function splitList(v) { return (v || "").split(",").map((s) => s.trim()).filter(Boolean); }

async function saveMeal() {
  const name = $("m-name").value.trim();
  if (!name) { flash("Give the meal a name."); return; }
  const location = getRadio("m-loc") || "Home";
  const bucket = getRadio("m-effort") || "normal";
  // Keep the exact old number if the bucket didn't change (e.g. a 1 stays a 1).
  const difficulty = editingMealDifficulty && effortBucket(editingMealDifficulty) === bucket
    ? editingMealDifficulty : EFFORT_BUCKETS[bucket];
  const always = location === "Home" ? chipValues("m-always") : [];
  const extras = location === "Home" ? chipValues("m-extras").filter((x) => !always.includes(x)) : [];
  const row = {
    name,
    category: "Dinner", // kept for the database column; lunch no longer exists
    location,
    difficulty,
    rating: location === "Home" ? (parseInt(getRadio("m-rating"), 10) || 0) : 0,
    always_sides: always,
    sides: extras,
    min_sides: 0,
    max_sides: 0,
    days: editorDays(),
    ingredients: location === "Home" ? chipValues("m-buy") : [],
  };
  let error;
  if (editingMealId) {
    ({ error } = await sb.from("meals").update(row).eq("id", editingMealId));
  } else {
    ({ error } = await sb.from("meals").insert({ ...row, user_id: USER_ID, household_id: HOUSEHOLD_ID }));
  }
  if (error) { flash(error.code === "23505" ? "There's already a meal with that name." : "Couldn't save meal."); console.error(error); return; }
  // Any side typed here that isn't in the Sides list yet gets added to it.
  const newSides = [...always, ...extras].filter((x) => !sideByName(x));
  if (newSides.length) {
    const { error: se } = await sb.from("side_options").insert(newSides.map((n) => ({ household_id: HOUSEHOLD_ID, user_id: USER_ID, name: n })));
    if (se) console.error(se);
    await loadSideOptions();
  }
  closeMealEditor();
  await loadMeals();
  renderMealsList();
  render();
  flash(newSides.length ? `Meal saved. Add what to buy for ${newSides.join(", ")} on the Sides tab.` : "Meal saved.");
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
      tags.push(`<span class="tag">${({ quick: "Quick", normal: "Normal", big: "Big cook" })[effortBucket(mealDifficulty(m))]}</span>`);
    }
    if ((m.rating | 0) > 0) tags.push(`<span class="tag">❤️ Favourite</span>`);
    if ((m.rating | 0) < 0) tags.push(`<span class="tag">👎 Not suggested</span>`);
    const always = alwaysSides(m), maybe = maybeSides(m);
    if (always.length) tags.push(`<span class="tag">With ${escapeHtml(always.join(" & "))}</span>`);
    if (maybe.length) tags.push(`<span class="tag">+${maybe.length} extra${maybe.length === 1 ? "" : "s"}</span>`);
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
    const info = document.createElement("div");
    info.className = "side-row-info";
    const nm = document.createElement("span");
    nm.className = "side-row-name";
    nm.textContent = s.name;
    info.appendChild(nm);
    const buy = document.createElement("input");
    buy.className = "input side-row-buy";
    buy.type = "text";
    buy.placeholder = "What to buy, e.g. potatoes, butter, milk";
    buy.setAttribute("aria-label", `What to buy for ${s.name}`);
    buy.value = (s.ingredients || []).join(", ");
    buy.addEventListener("change", () => saveSideIngredients(s, buy.value));
    buy.addEventListener("keydown", (e) => { if (e.key === "Enter") buy.blur(); });
    info.appendChild(buy);
    row.appendChild(info);
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
      <div class="cup-quick">
        <button class="btn btn-outline btn-sm" data-act="some">🥄 Used some</button>
        <button class="btn btn-outline btn-sm" data-act="all">${(it.quantity || 1) > 1 ? "✅ Used one" : "✅ Used it up"}</button>
      </div>
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
// "Used some": step the fullness down one notch (Full → 3/4 → … → Nearly empty).
const CUP_STEPS = ["Full", "3/4", "1/2", "1/4", "Nearly empty"];
async function cupUseSome(it) {
  const i = CUP_STEPS.indexOf(it.fullness || "Full");
  if (i >= CUP_STEPS.length - 1) { flash("Nearly empty already — tap “Used it up” when it's gone."); return; }
  const next = CUP_STEPS[i + 1];
  await updateCupboardItem(it.id, cupFullnessPatch(next));
  renderCupboard();
  flash(`${it.product_name || "Item"}: ${next.toLowerCase()} left.`);
}
// "Used it up" / "−": one fewer; the last one removes the item (with undo).
async function cupUseOne(it) {
  if ((it.quantity || 1) > 1) {
    await updateCupboardItem(it.id, { quantity: it.quantity - 1, ...cupFullnessPatch("") });
    renderCupboard();
    flash(`${it.product_name || "Item"}: ${it.quantity} left.`);
    return;
  }
  const saved = { ...it };
  await deleteCupboardItem(it.id);
  renderCupboard();
  flashUndo(`${it.product_name || "Item"} used up and removed.`, async () => {
    const { data, error } = await sb.from("cupboard_items").insert(saved).select().single();
    if (error) { flash("Couldn't put it back."); console.error(error); return; }
    CUPBOARD.unshift(data);
    renderCupboard();
    flash("Put back.");
  });
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
  else if (act === "dec" || act === "all") await cupUseOne(it);
  else if (act === "some") await cupUseSome(it);
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
  if (name === "shopping") {
    renderShopping();
    loadShopItems().then((changed) => { if (changed) renderShopping(); });
    startShopPolling();
  } else stopShopPolling();
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
  $("btn-suggest").addEventListener("click", suggestWeek);
  $("btn-start-again").addEventListener("click", startWeekAgain);

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
  // Night sheet
  $("modal-close").addEventListener("click", closeNight);
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeNight(); });
  $("night-swap").addEventListener("click", async () => { if (nightDay) { await swapNight(nightDay); renderNight(); } });
  $("night-choose").addEventListener("click", () => openChooser("all"));
  $("night-treat").addEventListener("click", () => openChooser("treat"));
  $("night-off").addEventListener("click", async () => {
    if (!nightDay) return;
    const out = !!(plan.days[nightDay] && plan.days[nightDay].is_out);
    await setNotCooking(nightDay, !out);
    if (out) renderNight(); else closeNight();
  });
  $("night-clear").addEventListener("click", async () => { if (nightDay) { await clearNight(nightDay); renderNight(); } });
  $("night-rating").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rating]");
    const e2 = nightDay && plan.entries[ekey(nightDay, SLOTS[0])];
    const meal = b && e2 && mealByName(e2.meal_name);
    if (meal) setMealRating(meal, parseInt(b.dataset.rating, 10));
  });
  $("choose-back").addEventListener("click", showNightView);
  $("choose-search").addEventListener("input", (e) => renderChooseList(e.target.value));

  $("btn-add-meal").addEventListener("click", () => openMealEditor(null));
  $("m-loc").addEventListener("change", syncHomeOnly);
  $("meal-save").addEventListener("click", saveMeal);
  $("meal-cancel").addEventListener("click", closeMealEditor);
  $("meal-modal-close").addEventListener("click", closeMealEditor);
  $("meal-delete").addEventListener("click", deleteMeal);
  $("meal-modal").addEventListener("click", (e) => { if (e.target.id === "meal-modal") closeMealEditor(); });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("modal").hidden) closeNight();
    if (!$("meal-modal").hidden) closeMealEditor();
  });
}

function flash(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("has-action");
  el.classList.add("show");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove("show"), 2600);
}

// A toast with an Undo button, shown a little longer than a plain flash.
function flashUndo(msg, undo) {
  const el = $("toast");
  el.textContent = msg + " ";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "toast-btn";
  b.textContent = "Undo";
  b.addEventListener("click", () => { el.classList.remove("show", "has-action"); undo(); }, { once: true });
  el.appendChild(b);
  el.classList.add("show", "has-action");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove("show", "has-action"), 6000);
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
