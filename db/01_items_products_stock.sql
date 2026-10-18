-- ============================================================
--  Items, products, stock, sides and the links between them
-- ============================================================
--  item      a thing you buy ("baked beans"), with its aisle
--  product   a specific thing you scan (a barcode), belongs to one item
--  stock     what's in the cupboard: one row per product per use-by date
--  side      a reusable bundle of items ("mash" = potatoes, butter, milk)
--  meal      a dinner; its items, plus sides it comes with / extras
--  plan_entry_sides  the sides on a planned night
--
--  Every table carries household_id so the same row-level security rule
--  ("only my household") works everywhere.

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  aisle text,
  is_staple boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists items_household_name on public.items (household_id, lower(name));
create unique index if not exists items_household_name_exact on public.items (household_id, name); -- lets the app upsert by name

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid references public.items(id) on delete set null,
  barcode text,
  name text,
  brand text,
  size_text text,
  size_value numeric,
  size_unit text,
  category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists products_household_barcode on public.products (household_id, barcode) where barcode is not null;
create index if not exists products_item on public.products (item_id);

create table if not exists public.stock (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null default 1 check (quantity >= 0),
  fullness text,
  fullness_pct smallint,
  opened boolean,
  expiry_date date,
  location text not null default 'Cupboard',
  notes text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stock_product on public.stock (product_id);

create table if not exists public.sides (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists sides_household_name on public.sides (household_id, lower(name));
create unique index if not exists sides_household_name_exact on public.sides (household_id, name);

create table if not exists public.side_items (
  household_id uuid not null references public.households(id) on delete cascade,
  side_id uuid not null references public.sides(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  position smallint not null default 0,
  primary key (side_id, item_id)
);
create index if not exists side_items_item on public.side_items (item_id);

create table if not exists public.meal_items (
  household_id uuid not null references public.households(id) on delete cascade,
  meal_id uuid not null references public.meals(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  position smallint not null default 0,
  primary key (meal_id, item_id)
);
create index if not exists meal_items_item on public.meal_items (item_id);

create table if not exists public.meal_sides (
  household_id uuid not null references public.households(id) on delete cascade,
  meal_id uuid not null references public.meals(id) on delete cascade,
  side_id uuid not null references public.sides(id) on delete cascade,
  kind text not null check (kind in ('comes_with', 'extra')),
  position smallint not null default 0,
  primary key (meal_id, side_id)
);
create index if not exists meal_sides_side on public.meal_sides (side_id);

alter table public.plan_entries add column if not exists meal_id uuid references public.meals(id) on delete set null;
create index if not exists plan_entries_meal on public.plan_entries (meal_id);

create table if not exists public.plan_entry_sides (
  household_id uuid not null references public.households(id) on delete cascade,
  entry_id uuid not null references public.plan_entries(id) on delete cascade,
  side_id uuid not null references public.sides(id) on delete cascade,
  position smallint not null default 0,
  primary key (entry_id, side_id)
);
create index if not exists plan_entry_sides_side on public.plan_entry_sides (side_id);

-- Row-level security: everything is visible/editable only by the household.
alter table public.items enable row level security;
alter table public.products enable row level security;
alter table public.stock enable row level security;
alter table public.sides enable row level security;
alter table public.side_items enable row level security;
alter table public.meal_items enable row level security;
alter table public.meal_sides enable row level security;
alter table public.plan_entry_sides enable row level security;
create policy items_hh on public.items for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
create policy products_hh on public.products for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
create policy stock_hh on public.stock for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
create policy sides_hh on public.sides for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
create policy side_items_hh on public.side_items for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
create policy meal_items_hh on public.meal_items for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
create policy meal_sides_hh on public.meal_sides for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
create policy plan_entry_sides_hh on public.plan_entry_sides for all using (household_id in (select my_household_ids())) with check (household_id in (select my_household_ids()));
grant select, insert, update, delete on public.items, public.products, public.stock, public.sides, public.side_items, public.meal_items, public.meal_sides, public.plan_entry_sides to authenticated;
