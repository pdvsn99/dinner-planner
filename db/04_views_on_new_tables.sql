-- ============================================================
--  Read-only views, now reading the new tables
-- ============================================================
--  Same names and columns as before, so whatever reads them keeps working.
--  Run at switch-over, after 03_copy_to_items.sql.

-- One row per dinner date: the meal, its sides, and whether it's a night off.
create or replace view public.public_dinner_plan as
with day_offset(day, off) as (
  values ('mon', 0), ('tue', 1), ('wed', 2), ('thurs', 3), ('fri', 4), ('sat', 5), ('sun', 6)
), entries as (
  select pe.week_start + d.off as dinner_date,
         coalesce(m.name, pe.meal_name) as meal_name,
         coalesce((select array_agg(s.name order by pes.position)
                   from public.plan_entry_sides pes join public.sides s on s.id = pes.side_id
                   where pes.entry_id = pe.id), '{}'::text[]) as sides,
         pe.status
  from public.plan_entries pe
  join day_offset d on d.day = pe.day
  left join public.meals m on m.id = pe.meal_id
  where pe.slot = 'Dinner'
), days as (
  select pd.week_start + d.off as dinner_date, pd.is_out, pd.note
  from public.plan_days pd join day_offset d on d.day = pd.day
)
select coalesce(e.dinner_date, dd.dinner_date) as dinner_date,
       e.meal_name,
       e.sides,
       (coalesce(dd.is_out, false) or e.status = 'out') as is_out,
       dd.note
from entries e
full join days dd on dd.dinner_date = e.dinner_date;

-- What's in stock: one row per stock row, named by product (else item).
create or replace view public.public_food_stock as
select coalesce(nullif(trim(p.name), ''), nullif(trim(i.name), '')) as item_name,
       nullif(trim(p.category), '') as category,
       coalesce(nullif(trim(st.location), ''), 'Cupboard') as location,
       greatest(coalesce(st.quantity, 1), 1) as quantity,
       st.expiry_date
from public.stock st
join public.products p on p.id = st.product_id
left join public.items i on i.id = p.item_id
where st.quantity > 0
  and coalesce(nullif(trim(p.name), ''), nullif(trim(i.name), '')) is not null;
