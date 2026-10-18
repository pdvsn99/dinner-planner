-- ============================================================
--  Lunch planning: a meal can be for lunch, dinner or both
-- ============================================================
--  meals.category was 'Lunch' or 'Dinner'; it can now also be 'Both'.
--  plan_entries already has a slot ('Lunch' / 'Dinner'), so the week
--  needs no change. A lunch or dinner you're not cooking is a
--  plan_entries row with status 'out' for that slot.

alter table public.meals drop constraint if exists meals_category_check;
alter table public.meals add constraint meals_category_check
  check (category = any (array['Lunch'::text, 'Dinner'::text, 'Both'::text]));
