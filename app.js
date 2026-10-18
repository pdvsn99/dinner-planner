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
// Each day has a lunch and a dinner. A meal is for one or the other, or
// "Both" (stored in meals.category).
const SLOTS = ["Lunch", "Dinner"];
const MEAL_TIMES = ["Lunch", "Dinner", "Both"];

/* ---------- state ---------- */
let USER_ID = null;
let USER_EMAIL = null;
let HOUSEHOLD_ID = null;        // the shared household this account belongs to
let MEALS = [];                 // meals, each with .ingredients / .always_sides / .sides as names
let SIDES = [];                 // sides (Sides tab), each with .ingredients as item names
let ITEMS = [];                 // things you buy: { id, name, aisle, is_staple }
let PRODUCTS = [];              // scanned products: { id, item_id, barcode, name, brand, … }
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

/* ---------- lookups ----------
 * In the database everything is linked by id: meals → items and sides,
 * sides → items, products → item, stock → product. Names are unique per
 * household, so in memory each meal/side also carries its items and sides
 * as names (for display), and these helpers go between the two.            */
const lc = (s) => String(s || "").trim().toLowerCase();
function mealByName(name) { return MEALS.find((m) => m.name === name); }
function mealById(id) { return MEALS.find((m) => m.id === id); }
// The meal a planned night points at (by id; older rows only had the name).
function mealOf(entry) { return entry && ((entry.meal_id && mealById(entry.meal_id)) || mealByName(entry.meal_name)); }
function itemById(id) { return ITEMS.find((i) => i.id === id); }
function itemByName(name) { const k = lc(name); return ITEMS.find((i) => lc(i.name) === k); }
function sideById(id) { return SIDES.find((s) => s.id === id); }
function sideByName(name) { const k = lc(name); return SIDES.find((s) => lc(s.name) === k); }
// When a meal is eaten: "Lunch", "Dinner" or "Both". Older meals are dinners.
function mealTime(meal) { return MEAL_TIMES.includes(meal && meal.category) ? meal.category : "Dinner"; }
function mealFits(meal, slot) { const t = mealTime(meal); return t === "Both" || t === slot; }
// A meal's sides: the ones it always comes with, and optional extras.
function alwaysSides(meal) { return (meal && meal.always_sides) || []; }
function maybeSides(meal) {
  const always = new Set(alwaysSides(meal));
  return ((meal && meal.sides) || []).filter((s) => !always.has(s));
}
// The items to buy for a side (by name).
function sideShopping(name) {
  const side = sideByName(name);
  return side ? side.ingredients : [];
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

// Ids of items with stock due to run out within EXPIRY_SOON_DAYS.
function expiringIngredientSet() {
  const set = new Set();
  (typeof CUPBOARD !== "undefined" ? CUPBOARD : []).forEach((it) => {
    if (!it.item_id || (it.quantity || 0) <= 0) return;
    const days = cupDaysToExpiry(it.expiry_date);
    // Include items expiring soon and up to EXPIRY_GRACE_DAYS already past.
    if (days !== null && days >= -EXPIRY_GRACE_DAYS && days <= EXPIRY_SOON_DAYS) set.add(it.item_id);
  });
  return set;
}
// Does this meal (or a side it always comes with) use an item that's expiring soon?
function mealUsesExpiringStock(meal, set) {
  const exp = set || expiringIngredientSet();
  if (!exp.size) return false;
  return [...(meal.ingredients || []), ...alwaysSides(meal).flatMap(sideShopping)]
    .some((n) => { const it = itemByName(n); return it && exp.has(it.id); });
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
// "day|slot" → meal name for meals already filled (including earlier picks in
// this same roll); `avoid` maps "day|slot" → a meal we're re-rolling away from.
function planContext(chosen, avoid) {
  return { chosen, avoid: avoid || {}, expiring: expiringIngredientSet() };
}
function mealScore(meal, dayKey, slot, ctx) {
  if ((meal.rating | 0) < 0) return 0;
  const key = ekey(dayKey, slot);
  const others = Object.entries(ctx.chosen).filter(([k]) => k !== key)
    .map(([k, n]) => { const [d, s] = k.split("|"); return { d, s, n }; });
  // Nothing twice in the same slot in a week, nor for lunch and dinner on the same day.
  if (others.some((o) => o.n === meal.name && (o.s === slot || o.d === dayKey))) return 0;
  if (ctx.avoid[key] === meal.name) return 0;
  let score = 10;
  const ago = daysSinceEaten(meal.name, dayKey);
  if (ago !== null) score -= ago <= 7 ? 7 : ago <= 14 ? 4 : 2;
  if ((meal.rating | 0) > 0) score += 4;
  if (mealUsesExpiringStock(meal, ctx.expiring)) score += 5;
  if (WEEKNIGHTS.includes(dayKey) && mealDifficulty(meal) >= 4) score -= 6;
  const i = dayIndex(dayKey);
  const mains = mealMains(meal);
  // The same main on neighbouring days, or for lunch and dinner on one day.
  const neighbours = others.filter((o) => (o.s === slot && Math.abs(dayIndex(o.d) - i) === 1) || o.d === dayKey)
    .map((o) => mealByName(o.n)).filter(Boolean);
  if (mains.length && neighbours.some((m) => mealMains(m).some((x) => mains.includes(x)))) score -= 5;
  return Math.max(score, 0.5);
}
// Weighted random pick. If everything scores 0 (e.g. only one meal allowed
// that night and it's already used), fall back to any meal not marked "never".
function smartPick(pool, dayKey, slot, ctx) {
  if (!pool.length) return null;
  const scored = pool.map((m) => ({ m, w: mealScore(m, dayKey, slot, ctx) ** 2 })).filter((x) => x.w > 0);
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
  // Meals for this slot (lunch / dinner / both), split by whether it's a
  // treat (takeaway / eating out), on the days it's allowed.
  return MEALS.filter((m) => {
    const isTreat = m.location !== "Home";
    if (treat !== isTreat) return false;
    return mealFits(m, slot) && (m.days || []).includes(dayKey);
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
  const m = mealOf(entry);
  return (m && m.location === "Home") ? mealDifficulty(m) : 0;
}
function entryText(entry) {
  if (!entry || !entry.meal_name) return "";
  const s = entry.sides || [];
  if (s.length === 0) return entry.meal_name;
  if (s.length === 1) return `${entry.meal_name} with ${s[0]}`;
  return `${entry.meal_name} with ${s.slice(0, -1).join(", ")} & ${s[s.length - 1]}`;
}
// The effective state of a cell. Lunch and dinner are each marked "not
// cooking" on their own entry (status "out"); older weeks marked a dinner off
// with a plan_days row, which still counts for dinner only.
function cellState(dayKey, slot) {
  if (slot === "Dinner" && plan.days[dayKey] && plan.days[dayKey].is_out) {
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

/* ---------- library: items, sides, meals ---------- */
async function loadLibrary(seeded) {
  const H = HOUSEHOLD_ID;
  const q = (t, order) => sb.from(t).select("*").eq("household_id", H).order(order || "name");
  const [items, sides, sideItems, meals, mealItems, mealSides] = await Promise.all([
    q("items"), q("sides"), q("side_items", "position"), q("meals"), q("meal_items", "position"), q("meal_sides", "position"),
  ]);
  const err = [items, sides, sideItems, meals, mealItems, mealSides].find((r) => r.error);
  if (err) { flash("Couldn't load meals."); console.error(err.error); return; }
  if (!meals.data.length && !seeded) { await seedLibrary(); return loadLibrary(true); }
  ITEMS = items.data;
  const itemName = (id) => (itemById(id) || {}).name;
  SIDES = sides.data.map((sd) => ({
    ...sd,
    ingredients: sideItems.data.filter((x) => x.side_id === sd.id).map((x) => itemName(x.item_id)).filter(Boolean),
  }));
  const sideName = (id) => (sideById(id) || {}).name;
  MEALS = meals.data.map((m) => ({
    ...m,
    ingredients: mealItems.data.filter((x) => x.meal_id === m.id).map((x) => itemName(x.item_id)).filter(Boolean),
    always_sides: mealSides.data.filter((x) => x.meal_id === m.id && x.kind === "comes_with").map((x) => sideName(x.side_id)).filter(Boolean),
    sides: mealSides.data.filter((x) => x.meal_id === m.id && x.kind === "extra").map((x) => sideName(x.side_id)).filter(Boolean),
  }));
}

// Find an item by name, or create it (with a best-guess aisle).
async function ensureItem(name) {
  const clean = (name || "").trim();
  if (!clean) return null;
  const have = itemByName(clean);
  if (have) return have;
  const { data, error } = await sb.from("items")
    .insert({ household_id: HOUSEHOLD_ID, name: clean, aisle: shopAisle(clean) }).select().single();
  if (error) { console.error(error); return null; }
  ITEMS.push(data);
  return data;
}
async function ensureSide(name) {
  const clean = (name || "").trim();
  if (!clean) return null;
  const have = sideByName(clean);
  if (have) return have;
  const { data, error } = await sb.from("sides").insert({ household_id: HOUSEHOLD_ID, name: clean }).select().single();
  if (error) { console.error(error); return null; }
  const side = { ...data, ingredients: [] };
  SIDES.push(side);
  return side;
}

// Replace a meal's items and sides with these names (creating any new ones).
async function saveMealLinks(mealId, itemNames, comesWith, extras) {
  const H = HOUSEHOLD_ID;
  const items = (await Promise.all(itemNames.map(ensureItem))).filter(Boolean);
  const cw = (await Promise.all(comesWith.map(ensureSide))).filter(Boolean);
  const ex = (await Promise.all(extras.map(ensureSide))).filter((sd) => sd && !cw.includes(sd));
  await Promise.all([
    sb.from("meal_items").delete().eq("meal_id", mealId),
    sb.from("meal_sides").delete().eq("meal_id", mealId),
  ]);
  const uniq = (list) => list.filter((x, i) => list.indexOf(x) === i);
  const mi = uniq(items).map((it, i) => ({ household_id: H, meal_id: mealId, item_id: it.id, position: i }));
  const ms = [
    ...uniq(cw).map((sd, i) => ({ household_id: H, meal_id: mealId, side_id: sd.id, kind: "comes_with", position: i })),
    ...uniq(ex).map((sd, i) => ({ household_id: H, meal_id: mealId, side_id: sd.id, kind: "extra", position: i })),
  ];
  const res = await Promise.all([
    mi.length ? sb.from("meal_items").insert(mi) : { error: null },
    ms.length ? sb.from("meal_sides").insert(ms) : { error: null },
  ]);
  const bad = res.find((r) => r.error);
  if (bad) { console.error(bad.error); return false; }
  return true;
}

async function addSideOption(name) {
  const clean = (name || "").trim();
  if (!clean) return;
  if (sideByName(clean)) { flash("That side is already in the list."); return; }
  await ensureSide(clean);
  renderSidesList();
}

// "What to buy" for a side: replace its items with these names.
async function saveSideIngredients(side, text) {
  const names = splitList(text);
  if (names.join(",") === (side.ingredients || []).join(",")) return;
  const items = (await Promise.all(names.map(ensureItem))).filter(Boolean)
    .filter((it, i, all) => all.indexOf(it) === i);
  await sb.from("side_items").delete().eq("side_id", side.id);
  if (items.length) {
    const { error } = await sb.from("side_items")
      .insert(items.map((it, i) => ({ household_id: HOUSEHOLD_ID, side_id: side.id, item_id: it.id, position: i })));
    if (error) { flash("Couldn't save side."); console.error(error); return; }
  }
  side.ingredients = items.map((it) => it.name);
  flash(`Saved what to buy for ${side.name}.`);
}

async function deleteSideOption(id) {
  const { error } = await sb.from("sides").delete().eq("id", id);
  if (error) { flash("Couldn't remove side."); console.error(error); return; }
  await loadLibrary();
  renderSidesList();
}

// A brand-new household starts with the meals and sides in meals.js.
async function seedLibrary() {
  const H = HOUSEHOLD_ID;
  const defs = window.DEFAULT_MEALS || [];
  const sideDefs = window.DEFAULT_SIDES || {};
  const itemNames = new Set();
  defs.forEach((m) => (m.ingredients || []).forEach((n) => itemNames.add(n)));
  Object.values(sideDefs).forEach((list) => list.forEach((n) => itemNames.add(n)));
  const sideNames = new Set(Object.keys(sideDefs));
  defs.forEach((m) => [...(m.always || []), ...(m.sides || [])].forEach((n) => sideNames.add(n)));

  // upsert + ignoreDuplicates so seeding twice (two tabs on a brand-new
  // account) can't create duplicates; each table has a unique name per household.
  const up = async (t, rows, onConflict) => {
    if (!rows.length) return [];
    await sb.from(t).upsert(rows, { onConflict, ignoreDuplicates: true });
    const { data } = await sb.from(t).select("*").eq("household_id", H);
    return data || [];
  };
  const items = await up("items", [...itemNames].map((name) => ({ household_id: H, name, aisle: shopAisle(name) })), "household_id,name");
  const sides = await up("sides", [...sideNames].map((name) => ({ household_id: H, name })), "household_id,name");
  const meals = await up("meals", defs.map((m) => ({
    household_id: H, user_id: USER_ID, name: m.name, category: m.category || "Dinner", location: m.location || "Home",
    difficulty: m.difficulty || DEFAULT_DIFFICULTY, days: m.days || [],
  })), "household_id,name");
  const iid = (n) => (items.find((x) => lc(x.name) === lc(n)) || {}).id;
  const sid = (n) => (sides.find((x) => lc(x.name) === lc(n)) || {}).id;
  const mid = (n) => (meals.find((x) => x.name === n) || {}).id;
  const sideItems = Object.entries(sideDefs).flatMap(([sn, list]) =>
    list.map((n, i) => ({ household_id: H, side_id: sid(sn), item_id: iid(n), position: i })));
  const mealItems = defs.flatMap((m) => (m.ingredients || []).map((n, i) => ({ household_id: H, meal_id: mid(m.name), item_id: iid(n), position: i })));
  const mealSides = defs.flatMap((m) => [
    ...(m.always || []).map((n, i) => ({ household_id: H, meal_id: mid(m.name), side_id: sid(n), kind: "comes_with", position: i })),
    ...(m.sides || []).map((n, i) => ({ household_id: H, meal_id: mid(m.name), side_id: sid(n), kind: "extra", position: i })),
  ]);
  await Promise.all([
    up("side_items", sideItems, "side_id,item_id"),
    up("meal_items", mealItems, "meal_id,item_id"),
    up("meal_sides", mealSides, "meal_id,side_id"),
  ]);
}

/* ---------- the week ---------- */
async function loadPlan() {
  const ws = isoDate(weekStart);
  plan = { entries: {}, days: {} };
  const [{ data: entries }, { data: days }] = await Promise.all([
    sb.from("plan_entries").select("*").eq("household_id", HOUSEHOLD_ID).eq("week_start", ws),
    sb.from("plan_days").select("*").eq("household_id", HOUSEHOLD_ID).eq("week_start", ws),
    loadHistory(),
    loadShopItems(),
  ]);
  const ids = (entries || []).map((e) => e.id);
  const { data: es } = ids.length
    ? await sb.from("plan_entry_sides").select("*").in("entry_id", ids).order("position")
    : { data: [] };
  (entries || []).forEach((e) => {
    e.sides = (es || []).filter((x) => x.entry_id === e.id).map((x) => (sideById(x.side_id) || {}).name).filter(Boolean);
    plan.entries[ekey(e.day, e.slot)] = e;
  });
  (days || []).forEach((d) => { plan.days[d.day] = d; });
}

// Build the database row for one planned night. `difficulty` snapshots the
// effort of the meal at the moment it's planned (home meals only), and
// `source` records whether it was auto-filled or chosen by a person. The
// sides on the night are stored separately, in plan_entry_sides.
function entryRow(dayKey, slot, entry) {
  const meal = entry.meal_name ? mealByName(entry.meal_name) : null;
  return {
    user_id: USER_ID,
    household_id: HOUSEHOLD_ID,
    week_start: isoDate(weekStart),
    day: dayKey,
    slot,
    status: entry.status || "planned",
    meal_id: meal ? meal.id : null,
    meal_name: entry.meal_name || null,
    note: entry.note || null,
    difficulty: (entry.difficulty === undefined ? null : entry.difficulty),
    source: entry.source || null,
    updated_at: new Date().toISOString(),
  };
}

async function saveEntry(dayKey, slot, entry) { await saveEntries([{ day: dayKey, slot, entry }]); }

async function saveEntries(list) {
  // list: [{day, slot, entry}]
  if (!list.length) return;
  const rows = list.map(({ day, slot, entry }) => entryRow(day, slot, entry));
  list.forEach(({ day, slot, entry }, i) => { plan.entries[ekey(day, slot)] = { ...rows[i], sides: entry.sides || [] }; });
  const { data, error } = await sb.from("plan_entries")
    .upsert(rows, { onConflict: "household_id,week_start,day,slot" }).select("id,day,slot");
  if (error) { flash("Couldn't save."); console.error(error); return; }
  // Then the sides on each night.
  const ids = data.map((r) => r.id);
  await sb.from("plan_entry_sides").delete().in("entry_id", ids);
  const sideRows = data.flatMap((r) => {
    const e = plan.entries[ekey(r.day, r.slot)];
    e.id = r.id;
    return (e.sides || []).map((n) => sideByName(n)).filter(Boolean)
      .map((sd, i) => ({ household_id: HOUSEHOLD_ID, entry_id: r.id, side_id: sd.id, position: i }));
  });
  if (sideRows.length) {
    const { error: se } = await sb.from("plan_entry_sides").insert(sideRows);
    if (se) { flash("Couldn't save sides."); console.error(se); }
  }
}

async function deleteEntry(dayKey, slot) {
  delete plan.entries[ekey(dayKey, slot)];
  const { error } = await sb.from("plan_entries")
    .delete().eq("household_id", HOUSEHOLD_ID).eq("week_start", isoDate(weekStart)).eq("day", dayKey).eq("slot", slot);
  if (error) console.error(error);
}

// Older weeks marked a dinner off with a plan_days row; this removes it.
async function clearOldDayOut(dayKey) {
  if (!plan.days[dayKey]) return;
  delete plan.days[dayKey];
  const { error } = await sb.from("plan_days").delete().eq("household_id", HOUSEHOLD_ID)
    .eq("week_start", isoDate(weekStart)).eq("day", dayKey);
  if (error) console.error(error);
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
 * Each day has a lunch and a dinner ("slots"). A slot is either empty, a
 * suggestion (source "auto"), something you chose or changed yourself
 * (source "manual"), or not cooking. "Suggest week" only ever refills empty
 * slots and suggestions, so anything you touched stays.                   */

function eligible(dayKey, slot) {
  // A slot can be filled only if it isn't marked "not cooking".
  const st = cellState(dayKey, slot);
  return !st.out;
}
function isChosen(e) { return !!(e && e.meal_name && e.status !== "out" && e.source === "manual"); }

// Smart-fill the given slots ([{day, slot}]), one at a time, so each pick
// knows about the meals around it (including ones picked earlier in this go).
function smartUpdates(targets, source) {
  const chosen = {}, avoid = {};
  const filling = new Set(targets.map((t) => ekey(t.day, t.slot)));
  DAYS.forEach((d) => SLOTS.forEach((slot) => {
    const key = ekey(d.key, slot);
    const e = plan.entries[key];
    if (!e || !e.meal_name || e.status === "out") return;
    if (filling.has(key)) avoid[key] = e.meal_name; // replacing it: try something else
    else chosen[key] = e.meal_name;
  }));
  const ctx = planContext(chosen, avoid);
  const updates = [];
  targets.forEach(({ day, slot }) => {
    const meal = smartPick(candidates(slot, day, { treat: false }), day, slot, ctx);
    if (!meal) return;
    chosen[ekey(day, slot)] = meal.name;
    updates.push({ day, slot, entry: makeEntry(meal, source || "auto") });
  });
  return updates;
}

// Fill every lunch and dinner that's empty or still a suggestion.
async function suggestWeek() {
  const targets = DAYS.flatMap((d) => SLOTS.map((slot) => ({ day: d.key, slot })))
    .filter(({ day, slot }) => eligible(day, slot) && !isChosen(plan.entries[ekey(day, slot)]));
  if (!targets.length) { flash("Every meal is already chosen. Use ⇄ on one to change it."); return; }
  const updates = smartUpdates(targets, "auto");
  if (!updates.length) { flash("No meals to suggest — add some in the Meals tab."); return; }
  await saveEntries(updates);
  render();
  const missed = new Set(targets.filter((t) => !updates.some((u) => u.day === t.day && u.slot === t.slot)).map((t) => t.slot));
  if (missed.size) flash(`No ${[...missed].map((s) => s.toLowerCase()).join(" or ")} meals to suggest — mark some as ${[...missed].join(" / ")} or Both in the Meals tab.`);
}

// Wipe the whole week (meals and nights off) for a fresh start.
async function startWeekAgain() {
  if (!confirm("Start this week again?\n\nThis clears every lunch and dinner, including ones you chose and ones marked not cooking.")) return;
  await clearWeekData();
  render();
}

// "Something else" for one lunch or dinner. The new meal counts as your choice.
async function swapSlot(dayKey, slot) {
  const [u] = smartUpdates([{ day: dayKey, slot }], "manual");
  if (!u) { flash(`No other ${slot.toLowerCase()} meals fit this day.`); return; }
  await saveEntry(dayKey, slot, u.entry);
  render();
}

// Put a specific meal on a lunch or dinner (from the meal list, or a takeaway).
async function setSlotMeal(dayKey, slot, meal) {
  if (slot === "Dinner") await clearOldDayOut(dayKey);
  await saveEntry(dayKey, slot, makeEntry(meal, "manual"));
  render();
}

async function clearSlot(dayKey, slot) {
  if (slot === "Dinner") await clearOldDayOut(dayKey);
  await deleteEntry(dayKey, slot);
  render();
}

// Mark a lunch or dinner as not cooking (or cooking after all). The meal that
// was planned is kept underneath, so "cooking after all" brings it back.
async function setNotCooking(dayKey, slot, isOut) {
  const e = plan.entries[ekey(dayKey, slot)];
  if (!isOut) {
    if (slot === "Dinner") await clearOldDayOut(dayKey);
    if (e && e.meal_name) await saveEntry(dayKey, slot, { ...e, status: "planned" });
    else if (e) await deleteEntry(dayKey, slot);
  } else {
    await saveEntry(dayKey, slot, { ...(e || {}), status: "out", source: "manual" });
  }
  render();
}

/* ============================================================
 *  Shopping list
 * ============================================================ */
function buildShoppingList() {
  const items = {};
  DAYS.forEach((d) => {
    SLOTS.forEach((slot) => {
      const st = cellState(d.key, slot);
      if (st.out || !st.entry || !st.entry.meal_name) return;
      const meal = mealOf(st.entry);
      const names = [...((meal && meal.ingredients) || []), ...(st.entry.sides || []).flatMap(sideShopping)];
      names.forEach((n) => {
        const item = itemByName(n);
        if (!item) return;
        if (!items[item.id]) items[item.id] = { item, label: item.name, count: 0, meals: new Set() };
        items[item.id].count += 1;
        items[item.id].meals.add(st.entry.meal_name);
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

// Summary line in the planner hero, e.g. "5 dinners · 3 lunches · 4 to plan".
function renderStats() {
  const box = $("week-stats");
  if (!box) return;
  const planned = { Lunch: 0, Dinner: 0 };
  let empty = 0, off = 0;
  DAYS.forEach((d) => SLOTS.forEach((slot) => {
    const st = cellState(d.key, slot);
    if (st.out) off += 1;
    else if (st.entry && st.entry.meal_name) planned[slot] += 1;
    else empty += 1;
  }));
  const chips = [];
  if (planned.Dinner) chips.push(`<span class="stat-chip">${planned.Dinner} dinner${planned.Dinner === 1 ? "" : "s"} planned</span>`);
  if (planned.Lunch)  chips.push(`<span class="stat-chip">${planned.Lunch} lunch${planned.Lunch === 1 ? "" : "es"} planned</span>`);
  if (empty)          chips.push(`<span class="stat-chip">${empty} to plan</span>`);
  if (off)            chips.push(`<span class="stat-chip">${off} not cooking</span>`);
  box.innerHTML = chips.join("");
}

function renderWeekNav() { $("week-title").textContent = weekTitle(); }

// Each day is a card with its date, then a line for lunch and one for dinner.
function renderGrid() {
  const list = $("grid-body");
  list.innerHTML = "";
  const todayIso = isoDate(new Date());

  DAYS.forEach((d) => {
    const dateObj = dateForDay(d.key);
    const row = document.createElement("div");
    row.className = "day-row";
    if (isoDate(dateObj) === todayIso) row.classList.add("is-today");
    row.innerHTML =
      `<div class="day-date"><span class="d-name">${d.label.slice(0, 3).toUpperCase()}</span>` +
      `<span class="d-num">${dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></div>`;
    const slots = document.createElement("div");
    slots.className = "day-slots";
    SLOTS.forEach((slot) => slots.appendChild(slotRow(d, slot)));
    row.appendChild(slots);
    list.appendChild(row);
  });
}

function slotRow(d, slot) {
  const st = cellState(d.key, slot);
  const entry = st.out ? null : st.entry;
  const meal = entry && entry.meal_name ? mealOf(entry) : null;

  const row = document.createElement("div");
  row.className = "slot-row slot-" + slot.toLowerCase();
  const main = document.createElement("div");
  main.className = "day-main";
  const label = `<div class="slot-label">${slot}</div>`;
  if (st.out) {
    row.classList.add("is-off");
    main.innerHTML = label + `<div class="day-meal dim">Not cooking</div>` +
      (st.note ? `<div class="day-hint">${escapeHtml(st.note)}</div>` : "");
  } else if (entry && entry.meal_name) {
    const isTreat = meal && meal.location !== "Home";
    if (isTreat) row.classList.add("is-treat");
    const tags = [];
    if (isTreat) tags.push(`<span class="tag treat">✨ ${meal.location === "Takeaway" ? "Takeaway" : "Eating out"}</span>`);
    if (meal && (meal.rating | 0) > 0) tags.push(`<span class="tag">❤️</span>`);
    if (meal && !isTreat && mealUsesExpiringStock(meal)) tags.push(`<span class="tag expiring">🕒 uses up food</span>`);
    main.innerHTML = label + `<div class="day-meal">${escapeHtml(entry.meal_name)}</div>` +
      (tags.length ? `<div class="day-tags">${tags.join("")}</div>` : "");
  } else {
    row.classList.add("is-empty");
    main.innerHTML = label + `<div class="day-meal dim">Nothing yet</div>`;
  }
  row.appendChild(main);

  // ⇄ on planned/empty slots: give me something else (or a first idea).
  if (!st.out) {
    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "swap-btn";
    swap.textContent = "⇄";
    swap.title = entry && entry.meal_name ? "Something else" : "Suggest something";
    swap.setAttribute("aria-label", `${swap.title} for ${d.label} ${slot.toLowerCase()}`);
    swap.addEventListener("click", (ev) => { ev.stopPropagation(); swapSlot(d.key, slot); });
    row.appendChild(swap);
  }

  row.addEventListener("click", () => openNight(d.key, slot));
  return row;
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
    // Old ticks were keyed by name ("m:rice"); ticks are now by item id ("i:…").
    ...(Array.isArray(old.done) ? old.done : []).map((key) => {
      const it = key.startsWith("m:") ? itemByName(key.slice(2)) : null;
      return it ? { kind: "done", key: "i:" + it.id, label: it.name } : { kind: "done", key, label: key };
    }),
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
  ["Snacks & drinks", ["sweets", "jelly", "laces", "pastilles", "crisps", "chocolate", "biscuits", "squash", "juice",
    "cereal", "fizzy", "cola", "lemonade"]],
  ["Tins, jars & dry", ["sauce", "tin", "chopped tomatoes", "plum tomatoes", "purée", "puree", "passata", "baked beans",
    "kidney beans", "mushy peas", "pasta", "spaghetti", "macaroni", "pappardelle", "lasagne", "noodle", "rice", "stock",
    "gravy", "stuffing", "flour", "pesto", "mayo", "salsa", "oil", "seasoning", "spice", "tortilla chips", "crackers",
    "popadoms", "poppadoms", "kit", "taco", "gherkins", "croutons", "dressing", "crispy onions", "sweetcorn", "jalapeño",
    "jalapeno", "ketchup", "mustard", "vinegar", "lentils", "breadcrumbs", "black pepper", "salt", "granules", "soup"]],
  ["Meat & fish", ["chicken", "beef", "mince", "steak", "pork", "sausage", "bacon", "ham", "lamb", "turkey", "duck",
    "fish", "salmon", "cod", "prawn", "pancetta", "pepperoni", "kebab", "meatballs"]],
  ["Fridge", ["milk", "cheese", "butter", "cream", "egg", "yoghurt", "yogurt", "mozzarella", "parmesan", "pecorino",
    "houmous", "hummus", "coleslaw", "pizza dough", "guacamole"]],
  ["Bread", ["bread", "bun", "rolls", "wraps", "tortilla", "naan", "panini", "bagel", "pancakes", "toast"]],
  ["Fruit & veg", ["potato", "carrot", "onion", "pepper", "tomato", "lettuce", "cucumber", "mushroom", "garlic",
    "broccoli", "cauliflower", "parsnip", "green beans", "rocket", "salad", "lemon", "lime", "avocado", "apple", "banana"]],
];
const AISLE_ICON = { "Fruit & veg": "🥕", "Bread": "🍞", "Meat & fish": "🥩", "Fridge": "🧀", "Tins, jars & dry": "🥫", "Frozen": "❄️", "Snacks & drinks": "🍬", "Other": "🛒" };
const AISLE_ORDER = ["Fruit & veg", "Bread", "Meat & fish", "Fridge", "Tins, jars & dry", "Frozen", "Snacks & drinks", "Other"];
// Best guess at a new item's aisle from its name. Each item stores its own
// aisle, so this is only used when an item is first created.
function shopAisle(label) {
  const t = (label || "").toLowerCase();
  const hit = AISLES.find(([, words]) => words.some((w) => t.includes(w)));
  return hit ? hit[0] : "Other";
}

/* ---------- cupboard check ----------
 * An item is "probably in the cupboard" when any product linked to it has
 * stock. Returns the stock row with the most in it, for the "You have" note. */
function cupboardHas(item) {
  if (!item) return null;
  const rows = CUPBOARD.filter((it) => it.item_id === item.id && (it.quantity || 0) > 0);
  return rows.sort((a, b) => (b.quantity || 0) - (a.quantity || 0))[0] || null;
}

// The full list of shopping rows for the week: meal items + your extras.
function shoppingRows() {
  const rows = buildShoppingList().map((it) => ({
    key: "i:" + it.item.id,
    label: cap(it.label),
    qty: it.count > 1 ? "×" + it.count : "",
    sub: [...it.meals].join(", "),
    extra: false,
    aisle: it.item.aisle || shopAisle(it.label),
    inCupboard: cupboardHas(it.item),
  }));
  SHOP.extras.forEach((label) => {
    const known = itemByName(label);
    rows.push({
      key: "x:" + label.toLowerCase(), label: cap(label), qty: "", sub: "Added by you", extra: true,
      aisle: (known && known.aisle) || shopAisle(label), inCupboard: null,
    });
  });
  rows.forEach((r) => { if (!AISLE_ORDER.includes(r.aisle)) r.aisle = "Other"; });
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
let nightDay = null;       // the day the sheet is open for
let nightSlot = "Dinner";  // …and whether it's lunch or dinner
let chooseMode = "all";    // "all" meals, or only "treat"s
const byName = (a, b) => a.name.localeCompare(b.name);

function openNight(dayKey, slot) {
  nightDay = dayKey;
  nightSlot = slot || "Dinner";
  showNightView();
  $("modal").hidden = false;
}
function closeNight() { $("modal").hidden = true; nightDay = null; }

function showNightView() {
  $("choose-view").hidden = true;
  $("night-view").hidden = false;
  renderNight();
}

// The sheet for one lunch or dinner: what's on, what it comes with, extras
// to tick, and actions.
function renderNight() {
  if (!nightDay) return;
  const d = DAYS.find((x) => x.key === nightDay);
  $("modal-title").textContent = `${d.label} ${nightSlot.toLowerCase()} · ${dateForDay(nightDay).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  const st = cellState(nightDay, nightSlot);
  const entry = st.out ? null : st.entry;
  const meal = entry && entry.meal_name ? mealOf(entry) : null;
  const isHome = !!meal && meal.location === "Home";

  $("night-meal").textContent = st.out ? "Not cooking" : (entry && entry.meal_name) || "Nothing planned yet";
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
  $("night-off").textContent = st.out ? "↩ Cooking after all" : `🚫 Not cooking ${nightSlot === "Lunch" ? "lunch" : "tonight"}`;
  $("night-clear").textContent = `Clear this ${nightSlot.toLowerCase()}`;
  $("night-clear").hidden = !(entry && entry.meal_name);
}

async function toggleExtra(name) {
  const e = plan.entries[ekey(nightDay, nightSlot)];
  if (!e) return;
  const sides = (e.sides || []).includes(name) ? e.sides.filter((x) => x !== name) : [...(e.sides || []), name];
  await saveEntry(nightDay, nightSlot, { ...e, sides, source: "manual" });
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

/* ---------- choosing a meal for a lunch or dinner ---------- */
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
  const home = MEALS.filter((m) => m.location === "Home" && match(m)).sort(byName);
  const fits = { label: "Home cooked", items: home.filter((m) => mealFits(m, nightSlot)) };
  const treats = { label: "Takeaway & eating out", items: MEALS.filter((m) => m.location !== "Home" && match(m)).sort(byName) };
  // Meals usually had at the other time are still there, at the bottom.
  const other = SLOTS.find((s) => s !== nightSlot);
  const rest = { label: `Usually for ${other.toLowerCase()}`, items: home.filter((m) => !mealFits(m, nightSlot)) };
  return (chooseMode === "treat" ? [treats] : [fits, treats, rest]).filter((g) => g.items.length);
}
function renderChooseList(query) {
  const list = $("choose-list");
  list.innerHTML = "";
  const groups = chooseGroups(query);
  if (!groups.length) { list.innerHTML = '<p class="muted empty-note">No meals match.</p>'; return; }
  const current = (plan.entries[ekey(nightDay, nightSlot)] || {}).meal_name;
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
        await setSlotMeal(nightDay, nightSlot, m);
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
  $("m-days-summary").textContent = days.length === DAYS.length ? "(every day)"
    : days.length ? "(" + DAYS.filter((d) => days.includes(d.key)).map((d) => d.label.slice(0, 3)).join(", ") + ")"
    : "(no days — it won't be suggested)";
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
  input.setAttribute("list", box.dataset.sides ? "side-names" : "item-names");
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
  setRadio("m-time", meal ? mealTime(meal) : "Dinner");
  setRadio("m-effort", effortBucket(meal ? mealDifficulty(meal) : DEFAULT_DIFFICULTY));
  setRadio("m-rating", meal ? Math.sign(meal.rating | 0) : 0);
  $("side-names").innerHTML = SIDES.map((x) => `<option value="${escapeHtml(x.name)}"></option>`).join("");
  $("item-names").innerHTML = ITEMS.map((x) => `<option value="${escapeHtml(x.name)}"></option>`).join("");
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
  const buy = location === "Home" ? chipValues("m-buy") : [];
  const row = {
    name,
    category: getRadio("m-time") || "Dinner", // Lunch, Dinner or Both
    location,
    difficulty,
    rating: location === "Home" ? (parseInt(getRadio("m-rating"), 10) || 0) : 0,
    days: editorDays(),
  };
  const before = editingMealId ? mealById(editingMealId) : null;
  const res = editingMealId
    ? await sb.from("meals").update(row).eq("id", editingMealId).select().single()
    : await sb.from("meals").insert({ ...row, user_id: USER_ID, household_id: HOUSEHOLD_ID }).select().single();
  if (res.error) { flash(res.error.code === "23505" ? "There's already a meal with that name." : "Couldn't save meal."); console.error(res.error); return; }
  const newSides = [...always, ...extras].filter((x) => !sideByName(x));
  const ok = await saveMealLinks(res.data.id, buy, always, extras);
  // Keep planned nights showing the new name if the meal was renamed.
  if (before && before.name !== name) {
    await sb.from("plan_entries").update({ meal_name: name }).eq("meal_id", before.id);
    Object.values(plan.entries).forEach((e) => { if (e.meal_id === before.id) e.meal_name = name; });
  }
  closeMealEditor();
  await loadLibrary();
  renderMealsList();
  render();
  if (!ok) flash("Meal saved, but its items or sides didn't all save. Try again.");
  else flash(newSides.length ? `Meal saved. Add what to buy for ${newSides.join(", ")} on the Sides tab.` : "Meal saved.");
}

async function deleteMeal() {
  if (!editingMealId) return;
  if (!confirm("Delete this meal? It won't remove it from weeks you've already planned.")) return;
  const { error } = await sb.from("meals").delete().eq("id", editingMealId);
  if (error) { flash("Couldn't delete."); console.error(error); return; }
  closeMealEditor();
  await loadLibrary();
  renderMealsList();
}

let mealTypeFilter = "all"; // all | home | treat | Lunch | Dinner

function renderMealsList() {
  const box = $("meals-list");
  box.innerHTML = "";
  if (!MEALS.length) { box.innerHTML = '<p class="muted empty-note">No meals yet — add your first one.</p>'; return; }
  const q = mealFilter.trim().toLowerCase();
  const shown = MEALS.slice().sort(byName).filter((m) => {
    if (q && !m.name.toLowerCase().includes(q)) return false;
    if (mealTypeFilter === "home" && m.location !== "Home") return false;
    if (mealTypeFilter === "treat" && m.location === "Home") return false;
    if (SLOTS.includes(mealTypeFilter) && !mealFits(m, mealTypeFilter)) return false;
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
    tags.push(`<span class="tag">${({ Lunch: "Lunch", Dinner: "Dinner", Both: "Lunch & dinner" })[mealTime(m)]}</span>`);
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
  if (!SIDES.length) {
    box.innerHTML = '<p class="muted empty-note">No sides yet — add your first one above.</p>';
    return;
  }
  SIDES.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((s) => {
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
      const users = MEALS.filter((m) => [...alwaysSides(m), ...maybeSides(m)].includes(s.name)).map((m) => m.name);
      if (!confirm(`Remove "${s.name}" from the sides list?` + (users.length ? `\n\nIt will also come off: ${users.join(", ")}.` : ""))) return;
      deleteSideOption(s.id);
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

/* ============================================================
 *  Cupboard (barcode scanning -> products + stock)
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

/* ---- data layer ----
 * Stock rows point at a product (a barcode), and products point at an item.
 * CUPBOARD holds one entry per stock row with its product's details and the
 * item's name copied on, so the list can show and search them directly.   */
const STOCK_FIELDS = ["quantity", "fullness", "fullness_pct", "opened", "expiry_date", "location", "notes"];
const PRODUCT_FIELDS = { product_name: "name", brand: "brand", category: "category", size_text: "size_text", size_value: "size_value", size_unit: "size_unit" };
function cupRow(stock) {
  const p = PRODUCTS.find((x) => x.id === stock.product_id) || {};
  const item = p.item_id ? itemById(p.item_id) : null;
  return {
    ...stock,
    barcode: p.barcode || null, product_name: p.name || null, brand: p.brand || null, category: p.category || null,
    size_text: p.size_text || null, size_value: p.size_value, size_unit: p.size_unit,
    item_id: p.item_id || null, ingredient_name: item ? item.name : null,
  };
}
function refreshCupRows() { CUPBOARD = CUPBOARD.map(cupRow); }
async function loadCupboard() {
  const [prod, stock] = await Promise.all([
    sb.from("products").select("*").eq("household_id", HOUSEHOLD_ID),
    sb.from("stock").select("*").eq("household_id", HOUSEHOLD_ID).order("created_at", { ascending: false }),
  ]);
  if (prod.error || stock.error) { console.error(prod.error || stock.error); CUPBOARD = []; return; }
  PRODUCTS = prod.data || [];
  CUPBOARD = (stock.data || []).map(cupRow);
}
async function insertProduct(row) {
  const { data, error } = await sb.from("products").insert({ ...row, household_id: HOUSEHOLD_ID }).select().single();
  if (error) { flash("Couldn't save item."); console.error(error); return null; }
  PRODUCTS.push(data);
  return data;
}
async function updateProduct(id, patch) {
  const { data, error } = await sb.from("products")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error) { flash("Couldn't update."); console.error(error); return; }
  const i = PRODUCTS.findIndex((x) => x.id === id);
  if (i >= 0) PRODUCTS[i] = data;
  refreshCupRows(); // every stock row of this product shows the change
}
async function insertStock(row) {
  const { data, error } = await sb.from("stock").insert({ ...row, household_id: HOUSEHOLD_ID }).select().single();
  if (error) { flash("Couldn't save item."); console.error(error); return null; }
  const r = cupRow(data);
  CUPBOARD.unshift(r);
  return r;
}
// Update a cupboard entry: stock fields go to its stock row, product details
// to its product, and "counts as" links the product to an item.
async function updateCupboardItem(id, patch) {
  const it = CUPBOARD.find((x) => x.id === id);
  if (!it) return;
  const stockPatch = {}, productPatch = {};
  Object.entries(patch).forEach(([k, v]) => {
    if (STOCK_FIELDS.includes(k)) stockPatch[k] = v;
    else if (PRODUCT_FIELDS[k]) productPatch[PRODUCT_FIELDS[k]] = v;
  });
  if ("ingredient_name" in patch) {
    const item = patch.ingredient_name ? await ensureItem(patch.ingredient_name) : null;
    productPatch.item_id = item ? item.id : null;
  }
  if (Object.keys(productPatch).length) await updateProduct(it.product_id, productPatch);
  if (Object.keys(stockPatch).length) {
    const { data, error } = await sb.from("stock")
      .update({ ...stockPatch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (error) { flash("Couldn't update."); console.error(error); return; }
    const i = CUPBOARD.findIndex((x) => x.id === id);
    if (i >= 0) CUPBOARD[i] = cupRow(data);
  }
}
// Removes the stock row only; the product (and what it counts as) is kept,
// so scanning the same barcode again knows what it is.
async function deleteCupboardItem(id) {
  const { error } = await sb.from("stock").delete().eq("id", id);
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
  cupFeedback();
  const known = PRODUCTS.find((x) => x.barcode === code);
  if (known) {
    // Seen this barcode before: one more of it (on the row without a use-by
    // date, if there is one; a new row otherwise).
    const open = CUPBOARD.find((x) => x.product_id === known.id && !x.expiry_date);
    if (open) await updateCupboardItem(open.id, { quantity: (open.quantity || 0) + 1 });
    else await insertStock({ product_id: known.id, quantity: 1, location: "Cupboard" });
    renderCupboard();
    cupSetStatus("Added another " + (known.name || code), "ok");
    return;
  }
  const product = await insertProduct({ barcode: code });
  if (!product) return;
  await insertStock({ product_id: product.id, quantity: 1, location: "Cupboard" });
  renderCupboard();
  cupSetStatus("Added " + code + " — looking up…");
  const info = await cupLookup(code);
  if (info && info.name) {
    const sz = cupParseSize(info.size);
    const match = itemByName(info.name);
    await updateProduct(product.id, {
      name: info.name, brand: info.brand || null,
      size_text: info.size || null, size_value: sz.value, size_unit: sz.unit,
      item_id: match ? match.id : null,
    });
    renderCupboard();
    cupSetStatus("Found: " + info.name + (info.size ? " (" + info.size + ")" : "") +
      (match ? "" : ". What does it count as? Fill in “Counts as” below."), "ok");
  } else {
    cupSetStatus("Added " + code + " — not found online. Add its name and what it counts as below.", "");
  }
}

/* ---- rendering ---- */
function renderCupboard() {
  const box = $("cup-list");
  const count = $("cup-count");
  if (!box) return;
  $("item-names").innerHTML = ITEMS.map((x) => `<option value="${escapeHtml(x.name)}"></option>`).join("");
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
      <label class="cup-lbl">Counts as <span class="hint-inline">(the item your meals use)</span></label>
      <input class="cup-ing select${it.item_id ? "" : " needs-item"}" data-field="ingredient_name" list="item-names" value="${escapeHtml(it.ingredient_name || "")}" placeholder="e.g. curry sauce" />
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
  } else if (field === "ingredient_name") {
    // Linking the product to an item (creating the item if it's new).
    await updateCupboardItem(id, { ingredient_name: el.value.trim() || null });
    renderCupboard();
  } else if (field === "product_name") {
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
    const row = {};
    ["id", "product_id", "household_id", "created_at", "last_seen_at", ...STOCK_FIELDS].forEach((k) => { row[k] = saved[k]; });
    const { data, error } = await sb.from("stock").insert(row).select().single();
    if (error) { flash("Couldn't put it back."); console.error(error); return; }
    CUPBOARD.unshift(cupRow(data));
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
  await loadLibrary();
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
  $("night-swap").addEventListener("click", async () => { if (nightDay) { await swapSlot(nightDay, nightSlot); renderNight(); } });
  $("night-choose").addEventListener("click", () => openChooser("all"));
  $("night-treat").addEventListener("click", () => openChooser("treat"));
  $("night-off").addEventListener("click", async () => {
    if (!nightDay) return;
    const out = cellState(nightDay, nightSlot).out;
    await setNotCooking(nightDay, nightSlot, !out);
    if (out) renderNight(); else closeNight();
  });
  $("night-clear").addEventListener("click", async () => { if (nightDay) { await clearSlot(nightDay, nightSlot); renderNight(); } });
  $("night-rating").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rating]");
    const e2 = nightDay && plan.entries[ekey(nightDay, nightSlot)];
    const meal = b && e2 && mealOf(e2);
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
