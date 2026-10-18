# 🍽️ Dinner Planner

A web app for planning the week's lunches and dinners. Roll the dice on
meals, treat yourself, mark days you're out, and get an automatic shopping
list. Your meals and plans are saved to your own private account in the
cloud (Supabase), so they're there on every device you log in on.

**What it does**

| Thing | What it does |
| --- | --- |
| ✨ **Suggest week** | Fills every lunch and dinner in the week, each with its usual sides. Lunches come from meals marked *Lunch* or *Both*, dinners from *Dinner* or *Both*. Suggestions favour ❤️ meals and anything that uses up food about to go off, and avoid what you've had lately, the same main two days running (or at lunch and dinner on one day), 👎 "don't suggest" meals and big cooks on Mon–Thu. It only refills meals you haven't touched. |
| ⇄ **on a lunch or dinner** | Something else for that meal. |
| **Tap a lunch or dinner** | See what it comes with and tick any extras; ❤️ / 👎 the meal; choose a specific meal, a takeaway or eating out; or mark it *not cooking* (lunch and dinner each have their own). |
| **Start week again** | Clears the whole week, including your own picks and nights off. |
| ‹ › **week arrows** | Move between real calendar weeks. Past and future weeks are all saved. |
| 🛒 **Shopping list** | Builds itself from the week, counting every ingredient and side, grouped by aisle. Things your Cupboard says you already have go in a "check the cupboard first" section. Ticks and extras are shared, so you both see the same list. Ignores days/meals marked out. |
| 🍲 **Meals tab** | Add, edit and delete meals: whether it's for **lunch, dinner or both**, where it's from, how long it takes (Quick / Normal / Big cook), what to buy, what it **comes with** every time, **optional extras**, and (if needed) which days it's allowed on. |
| 🥔 **Sides tab** | Your list of sides, each with what to buy for it (e.g. mash = potatoes, butter, milk). |
| 🗄️ **Cupboard tab** | Scan food in; tap **Used some** or **Used it up** as you go (with undo). |

---

## The files

| File | What it's for |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app itself. |
| `config.js` | The two settings that connect the app to your database. Safe to be public. |
| `meals.js` | Your **starter meals**. Only used once, to fill a brand-new account. After that you edit meals in the app's Meals tab. |
| `netlify.toml` | Tells Netlify there's nothing to build — just serve the files. |
| `db/` | The database tables (and the one-off steps that moved the old data into them). |

You normally won't need to touch any of these now — everything is managed
inside the app.

---

## How the data is stored

Everything is linked by id, so renaming something once updates it everywhere.

| Table | Holds | Links to |
| --- | --- | --- |
| `items` | each thing you buy (e.g. *rice*), its aisle, whether it's a staple | — |
| `products` | each scanned barcode (e.g. *Aldi Basmati Rice 1kg*): name, brand, size | one item |
| `stock` | what's in the cupboard: how many, how full, use-by date, where | one product |
| `sides` | e.g. *mash* | its items (`side_items`) |
| `meals` | name, lunch / dinner / both (`category`), where from, effort, nights, ❤️/👎 | its items (`meal_items`), and the sides it comes with or can have extra (`meal_sides`) |
| `plan_entries` | a meal at lunch or dinner (`slot`) on a day, or *not cooking* (`status` = out) | the meal, and the sides that night (`plan_entry_sides`) |
| `plan_days` | dinners off from older weeks (new ones are `plan_entries` marked out) | — |
| `shopping_items` | ticks and extras on the shared shopping list | items, by id |

The shopping list for a week is every planned meal's items plus the items
in each side on that night, added up. Anything with a product in stock goes
under "check the cupboard first". Scanning a new barcode asks what item it
counts as, once; after that every scan of it just adds to the cupboard.

---

## One-time setup (do this once)

There are two services: **Netlify** (hosts the web page) and **Supabase**
(stores your data and handles login). Both are already created; you just
need to connect and configure them.

### 1. Put the site on Netlify

1. Go to **[app.netlify.com](https://app.netlify.com)** → sign in with GitHub.
2. **Add new site → Import an existing project → GitHub → `dinner-planner`**.
3. Leave the defaults (publish directory `.`, no build command) → **Deploy**.
4. The site is served at **`https://dinner.pdvsn.com`**.

### 2. Tell Supabase your web address (so login links work) ⚠️ important

Login sends you an email with a link. Supabase will only allow that link to
return to web addresses you've approved, so the site's address must be added:

1. Go to **[supabase.com/dashboard](https://supabase.com/dashboard)** and open
   the **dinner-planner** project.
2. Left menu: **Authentication → URL Configuration**.
3. Set **Site URL** to `https://dinner.pdvsn.com`.
4. Under **Redirect URLs**, click **Add URL** and add `https://dinner.pdvsn.com/**`.
5. **Save.**

That's it. Open **https://dinner.pdvsn.com**, enter your email, click the link
in the email, and you're in.

### Sharing (household)

This planner is set up as a **shared household**: everyone in the household
sees and edits the *same* meals and weekly plans. Two people are already in
it — `mrpauldavidson99@gmail.com` and `taylorwatson785@gmail.com` — so each
just signs in with their own email at the same address and lands in the same
planner. (Adding more people, or a view-only role, is a small future change.)

> **Free-tier note:** Supabase's built-in email sender is limited to a few
> messages per hour — fine for a household. If you ever want nicer/faster
> emails you can plug in your own email service later.

---

## Making changes later

Because the site auto-deploys from GitHub, any change committed and pushed
goes live within a minute. But for everyday use you won't need to: **add and
edit meals right in the Meals tab**, and plan weeks on the Planner tab —
it's all saved to your account automatically.
