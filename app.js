/* ============================================================
 *  Dinner Planner — app logic
 *  (You normally don't need to touch this file. The meals live
 *   in meals.js.)
 * ============================================================ */

const DAYS = [
  { key: "mon",   label: "Monday" },
  { key: "tue",   label: "Tuesday" },
  { key: "wed",   label: "Wednesday" },
  { key: "thurs", label: "Thursday" },
  { key: "fri",   label: "Friday" },
  { key: "sat",   label: "Saturday" },
  { key: "sun",   label: "Sunday" },
];
const SLOTS = ["Lunch", "Dinner"];
const STORAGE_KEY = "dinner-planner-week-v1";

// The current week. Shape: week[dayKey][slot] = { name, sides:[] } | null
let week = {};
let selected = null; // { day, slot }

/* ---------- helpers ---------- */

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

function randInt(min, max) {
  if (max < min) max = min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Pick a random subset of `n` items from a list (no repeats).
function pickSides(pool, n) {
  const copy = pool.slice();
  const out = [];
  n = Math.min(n, copy.length);
  for (let i = 0; i < n; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

// Meals allowed for a given slot + day + "home vs treat".
function candidates(slot, dayKey, { treat } = { treat: false }) {
  return MEALS.filter((m) => {
    if (m.category !== slot) return false;
    const isTreat = m.location !== "Home";
    if (treat !== isTreat) return false;
    return m.days.includes(dayKey);
  });
}

// Build one meal entry (meal + random sides within min/max).
function makeEntry(meal) {
  const n = randInt(meal.min, meal.max);
  return { name: meal.name, sides: pickSides(meal.sides, n) };
}

// Turn an entry into its display string, e.g. "Meatballs with mash, gravy & wedges".
function entryText(entry) {
  if (!entry) return "";
  const s = entry.sides;
  if (!s || s.length === 0) return entry.name;
  if (s.length === 1) return `${entry.name} with ${s[0]}`;
  return `${entry.name} with ${s.slice(0, -1).join(", ")} & ${s[s.length - 1]}`;
}

function mealByName(name) {
  return MEALS.find((m) => m.name === name);
}

/* ---------- actions ---------- */

function fillCell(dayKey, slot, { treat } = { treat: false }) {
  let pool = candidates(slot, dayKey, { treat });
  // Fallback: if a treat is requested but none allowed that day, allow any treat.
  if (treat && pool.length === 0) {
    pool = MEALS.filter((m) => m.category === slot && m.location !== "Home");
  }
  if (pool.length === 0) return false;
  week[dayKey][slot] = makeEntry(rand(pool));
  return true;
}

function generateWeek() {
  DAYS.forEach((d) => {
    SLOTS.forEach((slot) => {
      fillCell(d.key, slot, { treat: false });
    });
  });
  save();
  render();
}

function treatWeek() {
  DAYS.forEach((d) => {
    SLOTS.forEach((slot) => {
      if (!fillCell(d.key, slot, { treat: true })) {
        // No treat exists for this slot (e.g. no lunch treats that day) — leave home meal.
        fillCell(d.key, slot, { treat: false });
      }
    });
  });
  save();
  render();
}

function swapSelected() {
  if (!requireSelection()) return;
  fillCell(selected.day, selected.slot, { treat: false });
  save();
  render();
}

function treatSelected() {
  if (!requireSelection()) return;
  fillCell(selected.day, selected.slot, { treat: true });
  save();
  render();
}

function clearWeek() {
  DAYS.forEach((d) => SLOTS.forEach((slot) => (week[d.key][slot] = null)));
  save();
  render();
}

function requireSelection() {
  if (!selected) {
    flash("Tap a meal in the table first, then use this button.");
    return false;
  }
  return true;
}

/* ---------- shopping list ---------- */
// Counts every ingredient AND every chosen side across the week.
function buildShoppingList() {
  const items = {}; // item -> { count, meals:Set }
  DAYS.forEach((d) => {
    SLOTS.forEach((slot) => {
      const entry = week[d.key][slot];
      if (!entry) return;
      const meal = mealByName(entry.name);
      if (!meal) return;
      const parts = [...(meal.ingredients || []), ...(entry.sides || [])];
      parts.forEach((p) => {
        const key = p.trim().toLowerCase();
        if (!key) return;
        if (!items[key]) items[key] = { label: p.trim(), count: 0, meals: new Set() };
        items[key].count += 1;
        items[key].meals.add(entry.name);
      });
    });
  });
  return Object.values(items).sort((a, b) => a.label.localeCompare(b.label));
}

/* ---------- rendering ---------- */

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function render() {
  renderGrid();
  renderShopping();
}

function renderGrid() {
  const tbody = document.getElementById("grid-body");
  tbody.innerHTML = "";
  DAYS.forEach((d) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.className = "day";
    th.textContent = d.label;
    tr.appendChild(th);
    SLOTS.forEach((slot) => {
      const td = document.createElement("td");
      td.className = "cell";
      const entry = week[d.key][slot];
      const meal = entry ? mealByName(entry.name) : null;
      const isTreat = meal && meal.location !== "Home";
      if (isTreat) td.classList.add("is-treat");
      if (selected && selected.day === d.key && selected.slot === slot) td.classList.add("is-selected");

      if (entry) {
        const txt = document.createElement("span");
        txt.className = "cell-text";
        txt.textContent = entryText(entry);
        td.appendChild(txt);
        if (isTreat) {
          const tag = document.createElement("span");
          tag.className = "badge";
          tag.textContent = meal.location === "Takeaway" ? "Takeaway" : "Eating out";
          td.appendChild(tag);
        }
      } else {
        td.classList.add("empty");
        td.innerHTML = '<span class="cell-text muted">—</span>';
      }

      td.addEventListener("click", () => {
        selected = { day: d.key, slot };
        render();
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  // Update the selection hint.
  const hint = document.getElementById("selection-hint");
  if (selected) {
    const dayLabel = DAYS.find((x) => x.key === selected.day).label;
    hint.textContent = `Selected: ${dayLabel} ${selected.slot}`;
  } else {
    hint.textContent = "No meal selected — tap one to swap or treat it.";
  }
}

function renderShopping() {
  const list = buildShoppingList();
  const box = document.getElementById("shopping-body");
  const count = document.getElementById("shopping-count");
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
    row.innerHTML = `
      <span class="shop-name">${cap(it.label)}</span>
      <span class="shop-qty">×${it.count}</span>
      <span class="shop-meal">${[...it.meals].join(", ")}</span>`;
    box.appendChild(row);
  });
}

function flash(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ---------- persistence ---------- */

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(week));
  } catch (e) {
    /* storage may be unavailable (private mode) — that's fine */
  }
}

function load() {
  // start empty
  week = {};
  DAYS.forEach((d) => (week[d.key] = { Lunch: null, Dinner: null }));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      DAYS.forEach((d) => {
        if (saved[d.key]) {
          SLOTS.forEach((slot) => {
            if (saved[d.key][slot]) week[d.key][slot] = saved[d.key][slot];
          });
        }
      });
    }
  } catch (e) {
    /* ignore corrupt storage */
  }
}

/* ---------- wire up ---------- */

function init() {
  load();
  document.getElementById("btn-generate").addEventListener("click", generateWeek);
  document.getElementById("btn-swap").addEventListener("click", swapSelected);
  document.getElementById("btn-treat-cell").addEventListener("click", treatSelected);
  document.getElementById("btn-treat-week").addEventListener("click", treatWeek);
  document.getElementById("btn-clear").addEventListener("click", clearWeek);
  document.getElementById("btn-print").addEventListener("click", () => window.print());
  render();
}

document.addEventListener("DOMContentLoaded", init);
