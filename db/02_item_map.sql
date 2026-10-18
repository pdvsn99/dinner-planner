-- ============================================================
--  One-off: the agreed matching of old typed names to items
-- ============================================================
--  Lives in a "migration" schema that the app's API can't see. Used by
--  03_copy_to_items.sql; drop the schema once the switch-over is done.

create schema if not exists migration;

create table if not exists migration.item_map (from_name text primary key, to_name text not null);
insert into migration.item_map (from_name, to_name) values
  ('baked beans', 'baked beans'),
  ('basmati rice', 'rice'),
  ('beef lasagne', 'ready meal lasagne'),
  ('beef stock', 'beef stock'),
  ('beef stock cubes', 'beef stock'),
  ('cheese', 'grated cheese'),
  ('cheese sauce', 'cheese sauce'),
  ('cheesy singles', 'cheese slices'),
  ('chocolate flavour dessert sauce ingredients: parti', 'chocolate sauce'),
  ('classic barbecue smokey & rich', 'bbq sauce'),
  ('condimania www smokey dragon bright&deliciously sa', 'smokey dragon sauce'),
  ('cooked ham', 'ham'),
  ('crispy fried onions', 'crispy onions'),
  ('curry sauce', 'curry sauce'),
  ('egg', 'eggs'),
  ('extra virgin cold pressed rapeseed oil', 'rapeseed oil'),
  ('fruit pastilles pouch', 'fruit pastilles'),
  ('garlic', 'garlic'),
  ('garlic chopped', 'garlic'),
  ('garlic naan', 'naan bread'),
  ('gherkins', 'gherkins'),
  ('gravy granules', 'gravy granules'),
  ('heinz est 1869 tomato ketchup sweet sriracha flavo', 'sriracha ketchup'),
  ('honey nut', 'honey nut cereal'),
  ('kebab house garlic sauce', 'garlic sauce'),
  ('light and low blended with buttermilk', 'butter'),
  ('light mayonnaise', 'mayo'),
  ('light mozzarella', 'mozzarella'),
  ('long grain rice', 'rice'),
  ('macaroni pasta', 'macaroni pasta'),
  ('mayo', 'mayo'),
  ('mushy peas', 'mushy peas'),
  ('naan bread', 'naan bread'),
  ('orange and mango quad strength', 'squash (drink)'),
  ('parmigiano reggiano', 'parmesan'),
  ('peeled tomatoes', 'plum tomatoes'),
  ('penne pasta', 'pasta'),
  ('pilau rice', 'pilau rice'),
  ('plain flour', 'plain flour'),
  ('plain tortilla wraps', 'tortilla wraps'),
  ('popadoms', 'poppadoms'),
  ('poppadoms', 'poppadoms'),
  ('prawn crackers', 'prawn crackers'),
  ('quad summer squash', 'squash (drink)'),
  ('real dairy cream light', 'cream'),
  ('salsa', 'salsa'),
  ('scottish free range eggs', 'eggs'),
  ('seeded brioche burger buns', 'burger buns'),
  ('slightly salted spreadable butter', 'butter'),
  ('soft white rolls', 'bread rolls'),
  ('sour cream & chive dip', 'sour cream & chive dip'),
  ('taco seasoning', 'taco seasoning'),
  ('tartare sauce', 'tartare sauce'),
  ('whole cucumber', 'cucumber'),
  ('wonky mixed peppers', 'peppers')
on conflict (from_name) do update set to_name = excluded.to_name;

-- Barcodes to leave out (the scan with no name).
create table if not exists migration.skip_barcodes (barcode text primary key);
insert into migration.skip_barcodes values ('5054070357873') on conflict do nothing;

-- Old side names that are now another side.
create table if not exists migration.side_map (from_name text primary key, to_name text not null);
insert into migration.side_map values ('mashed potatoes', 'mash'), ('rice', 'boiled rice')
on conflict (from_name) do update set to_name = excluded.to_name;

-- Old typed name -> item name.
create or replace function migration.norm(t text) returns text language sql stable as $$
  select coalesce((select to_name from migration.item_map where from_name = lower(trim(t))), trim(t))
$$;
create or replace function migration.side_norm(t text) returns text language sql stable as $$
  select coalesce((select to_name from migration.side_map where from_name = lower(trim(t))), trim(t))
$$;

-- Best-guess aisle from the name (same rules the app used), then from the
-- cupboard category. The first matching group wins.
create or replace function migration.guess_aisle(n text, category text) returns text language sql immutable as $$
  select case
    when t ~ '(frozen|oven chips|fries|wedges|hash brown|yorkshire|onion rings|dinosaur|fish burger|breaded|southern fried|chicken bites|chicken burgers|ice cream)' then 'Frozen'
    when t ~ '(sweets|jelly|laces|pencils|straws|pastilles|tots|belly flops|squash|cereal|honey nut|transport traffic|caramel|chocolate|snack noodles)' then 'Snacks & drinks'
    when t ~ 'ready meal' then 'Fridge'
    when t ~ '(sauce|tin|chopped tomatoes|plum tomatoes|purée|puree|passata|baked beans|kidney beans|mushy peas|pasta|spaghetti|macaroni|pappardelle|lasagne|noodle|rice|stock|gravy|stuffing|flour|pesto|mayo|salsa|oil|seasoning|spice|tortilla chips|crackers|popadoms|poppadoms|kit|taco|gherkins|croutons|dressing|crispy onions|sweetcorn|jalapeño|jalapeno|ketchup|mustard|vinegar|lentils|breadcrumbs|yeast|baking powder|cornflour|sesame|soup|broth|black pepper|white pepper|cayenne|granules|salt|cumin|turmeric|paprika|nutmeg|cinnamon|curry powder|bay leaves|basil|rosemary|thyme|chilli|ginger|lasagne|pickled)' then 'Tins, jars & dry'
    when t ~ '(chicken|beef|mince|steak|pork|sausage|bacon|ham|lamb|turkey|duck|fish|salmon|cod|prawn|pancetta|pepperoni|kebab|meatballs)' then 'Meat & fish'
    when t ~ '(milk|cheese|butter|cream|egg|yoghurt|yogurt|mozzarella|parmesan|pecorino|houmous|hummus|coleslaw|pizza dough|guacamole|dip)' then 'Fridge'
    when t ~ '(bread|bun|rolls|wraps|tortilla|naan|panini|bagel|pancake|toast)' then 'Bread'
    when t ~ '(potato|carrot|onion|pepper|tomato|lettuce|cucumber|mushroom|garlic|broccoli|cauliflower|parsnip|green beans|rocket|salad|lemon|lime|avocado|apple|banana|strawberr)' then 'Fruit & veg'
    when category in ('spice','herb','seasoning','baking','rice','pasta','sauce','stock','tinned','condiment','paste','pulses','noodles','oil','soup','topping') then 'Tins, jars & dry'
    when category = 'bread' then 'Bread'
    when category = 'dip' then 'Fridge'
    when category = 'snack' then 'Snacks & drinks'
    else 'Other' end
  from (select lower(n) as t) x
$$;
