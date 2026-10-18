-- ============================================================
--  Read-only view for the portal's meals tile: lunch and dinner
-- ============================================================
--  Like public_dinner_plan, but one row per date *and* slot, so lunch
--  shows too. public_dinner_plan is left as it is for anything still
--  reading it. Older weeks marked a dinner off with a plan_days row,
--  which still counts for dinner only.

create or replace view public.public_meal_plan as
with day_offset(day, off) as (
  values ('mon', 0), ('tue', 1), ('wed', 2), ('thurs', 3), ('fri', 4), ('sat', 5), ('sun', 6)
), entries as (
  select pe.week_start + d.off as meal_date,
         pe.slot,
         coalesce(m.name, pe.meal_name) as meal_name,
         coalesce((select array_agg(s.name order by pes.position)
                   from public.plan_entry_sides pes join public.sides s on s.id = pes.side_id
                   where pes.entry_id = pe.id), '{}'::text[]) as sides,
         pe.status,
         pe.note
  from public.plan_entries pe
  join day_offset d on d.day = pe.day
  left join public.meals m on m.id = pe.meal_id
  where pe.slot in ('Lunch', 'Dinner')
), days as (
  select pd.week_start + d.off as meal_date, 'Dinner'::text as slot, pd.is_out, pd.note
  from public.plan_days pd join day_offset d on d.day = pd.day
)
select coalesce(e.meal_date, dd.meal_date) as meal_date,
       coalesce(e.slot, dd.slot) as slot,
       e.meal_name,
       e.sides,
       (coalesce(dd.is_out, false) or e.status = 'out') as is_out,
       -- Only an "out" note is shown; other notes stay private.
       case when coalesce(dd.is_out, false) or e.status = 'out'
            then coalesce(dd.note, e.note) end as note
from entries e
full join days dd on dd.meal_date = e.meal_date and dd.slot = e.slot;

-- The portal reads this with the publishable key: read-only, nothing more.
revoke all on public.public_meal_plan from anon, authenticated;
grant select on public.public_meal_plan to anon, authenticated;
