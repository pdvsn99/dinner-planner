-- ============================================================
--  Copy the old typed-text data into items / products / stock / sides
-- ============================================================
--  Safe to run again: it clears the new tables for each household and
--  rebuilds them from the old columns (meals.ingredients/sides/always_sides,
--  side_options, cupboard_items, plan_entries.sides), which it never
--  changes. Run once for testing, then again right before switching the app
--  over so nothing done in between is lost. Needs 02_item_map.sql.

-- 0. Start clean (children first).
delete from public.plan_entry_sides;
delete from public.meal_sides;
delete from public.meal_items;
delete from public.side_items;
delete from public.stock;
delete from public.products;
delete from public.sides;
delete from public.items;
update public.plan_entries set meal_id = null where meal_id is not null;

-- 1. Items: every name used by a meal, a side or the cupboard, after the
--    agreed matching. A meal's spelling wins over a side's, over the cupboard's.
insert into public.items (household_id, name)
select household_id, (array_agg(name order by pri, name))[1]
from (
  select m.household_id, migration.norm(i) as name, 1 as pri from public.meals m, unnest(m.ingredients) i
  union all
  select s.household_id, migration.norm(i), 2 from public.side_options s, unnest(s.ingredients) i
  union all
  select c.household_id, migration.norm(c.ingredient_name), 3 from public.cupboard_items c
  where c.ingredient_name is not null and coalesce(c.barcode, '') not in (select barcode from migration.skip_barcodes)
) x
where coalesce(name, '') <> ''
group by household_id, lower(name);

-- Staples and aisles: from the cupboard products linked to each item.
update public.items i set
  is_staple = coalesce(c.staple, false),
  aisle = migration.guess_aisle(i.name, c.category)
from (
  select i2.id, bool_or(c.is_staple) as staple, (array_agg(c.category) filter (where c.category is not null))[1] as category
  from public.items i2
  left join public.cupboard_items c
    on c.household_id = i2.household_id and lower(migration.norm(c.ingredient_name)) = lower(i2.name)
  group by i2.id
) c
where c.id = i.id;

-- 2. Products: one per barcode (scans without a barcode: one per name).
insert into public.products (household_id, item_id, barcode, name, brand, size_text, size_value, size_unit, category, created_at)
select distinct on (c.household_id, coalesce(c.barcode, 'name:' || lower(c.product_name)))
  c.household_id, i.id, c.barcode, c.product_name, c.brand, c.size_text, c.size_value, c.size_unit, c.category, c.created_at
from public.cupboard_items c
left join public.items i on i.household_id = c.household_id and lower(i.name) = lower(migration.norm(c.ingredient_name))
where coalesce(c.barcode, '') not in (select barcode from migration.skip_barcodes)
  and coalesce(c.barcode, c.product_name, c.ingredient_name) is not null
order by c.household_id, coalesce(c.barcode, 'name:' || lower(c.product_name)), c.created_at;

-- 3. Stock: one row per product per use-by date, quantities added up.
insert into public.stock (household_id, product_id, quantity, fullness, fullness_pct, opened, expiry_date, location, notes, last_seen_at, created_at, updated_at)
select c.household_id, p.id,
  sum(greatest(coalesce(c.quantity, 1), 0)),
  (array_agg(c.fullness order by c.updated_at desc))[1],
  (array_agg(c.fullness_pct order by c.updated_at desc))[1],
  (array_agg(c.opened order by c.updated_at desc))[1],
  c.expiry_date,
  (array_agg(coalesce(c.location, 'Cupboard') order by c.updated_at desc))[1],
  string_agg(nullif(trim(c.notes), ''), '; '),
  max(coalesce(c.last_seen_at, now())), min(c.created_at), max(c.updated_at)
from public.cupboard_items c
join public.products p on p.household_id = c.household_id and (
  (c.barcode is not null and p.barcode = c.barcode) or
  (c.barcode is null and p.barcode is null and lower(p.name) = lower(c.product_name)))
group by c.household_id, p.id, c.expiry_date;

-- 4. Sides: the Sides list, plus any side name a meal or a planned night uses.
insert into public.sides (household_id, name)
select household_id, (array_agg(name order by pri, name))[1]
from (
  select household_id, migration.side_norm(name) as name, 1 as pri from public.side_options
  union all select household_id, migration.side_norm(s), 2 from public.meals, unnest(always_sides || sides) s
  union all select household_id, migration.side_norm(s), 3 from public.plan_entries, unnest(sides) s
) x
where coalesce(name, '') <> ''
group by household_id, lower(name);

insert into public.side_items (household_id, side_id, item_id, position)
select so.household_id, sd.id, i.id, min(t.ord)
from public.side_options so
cross join lateral unnest(so.ingredients) with ordinality t(name, ord)
join public.sides sd on sd.household_id = so.household_id and lower(sd.name) = lower(migration.side_norm(so.name))
join public.items i on i.household_id = so.household_id and lower(i.name) = lower(migration.norm(t.name))
group by so.household_id, sd.id, i.id;

-- 5. Meals: their items, and the sides they come with / can have extra.
insert into public.meal_items (household_id, meal_id, item_id, position)
select m.household_id, m.id, i.id, min(t.ord)
from public.meals m
cross join lateral unnest(m.ingredients) with ordinality t(name, ord)
join public.items i on i.household_id = m.household_id and lower(i.name) = lower(migration.norm(t.name))
group by m.household_id, m.id, i.id;

insert into public.meal_sides (household_id, meal_id, side_id, kind, position)
select m.household_id, m.id, sd.id, 'comes_with', min(t.ord)
from public.meals m
cross join lateral unnest(m.always_sides) with ordinality t(name, ord)
join public.sides sd on sd.household_id = m.household_id and lower(sd.name) = lower(migration.side_norm(t.name))
group by m.household_id, m.id, sd.id;

insert into public.meal_sides (household_id, meal_id, side_id, kind, position)
select m.household_id, m.id, sd.id, 'extra', min(t.ord)
from public.meals m
cross join lateral unnest(m.sides) with ordinality t(name, ord)
join public.sides sd on sd.household_id = m.household_id and lower(sd.name) = lower(migration.side_norm(t.name))
group by m.household_id, m.id, sd.id
on conflict (meal_id, side_id) do nothing;

-- 6. Planned nights: link to the meal, and the sides on the night.
update public.plan_entries pe set meal_id = m.id
from public.meals m
where m.household_id = pe.household_id and m.name = pe.meal_name;

insert into public.plan_entry_sides (household_id, entry_id, side_id, position)
select pe.household_id, pe.id, sd.id, min(t.ord)
from public.plan_entries pe
cross join lateral unnest(pe.sides) with ordinality t(name, ord)
join public.sides sd on sd.household_id = pe.household_id and lower(sd.name) = lower(migration.side_norm(t.name))
group by pe.household_id, pe.id, sd.id;

-- 7. Shopping-list ticks: add an item-id tick next to each old text tick.
--    (The old ticks are left for the old app until it's switched off.)
insert into public.shopping_items (household_id, user_id, week_start, kind, key, label)
select distinct s.household_id, s.user_id, s.week_start, 'done', 'i:' || i.id, i.name
from public.shopping_items s
join public.items i on i.household_id = s.household_id and lower(i.name) = lower(migration.norm(substr(s.key, 3)))
where s.kind = 'done' and s.key like 'm:%'
on conflict (household_id, week_start, kind, key) do nothing;
