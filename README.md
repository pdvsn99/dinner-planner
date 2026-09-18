# 🍽️ Dinner Planner

A web app for planning the week's lunches and dinners. Roll the dice on
meals, treat yourself, mark days you're out, and get an automatic shopping
list. Your meals and plans are saved to your own private account in the
cloud (Supabase), so they're there on every device you log in on.

**What it does**

| Thing | What it does |
| --- | --- |
| 🎲 **Generate week** | Fills every empty lunch & dinner with a random *home* meal, only using meals allowed on that day, and picks sides at random. Skips days/meals you've marked out. |
| 🔀 **Swap selected** | Tap a meal, then re-roll just that one. |
| ✨ **Treat selected / Treat the week!** | Swap a meal (or the whole week) for takeaways / eating out. |
| ✏️ **Edit selected / the pencil** | Choose an exact meal and tick the sides you want. |
| **⋯ on a day** | Mark a whole day *out of the planner* (away on a trip, etc.) with a note. Tap **↩** to bring it back. |
| 🚫 **Mark out** (in the meal picker) | Mark a single meal as out (e.g. dinner out on Friday) with a note. |
| ‹ › **week arrows** | Move between real calendar weeks. Past and future weeks are all saved. |
| 🛒 **Shopping list** | Builds itself from the week, counting every ingredient and side. Ignores days/meals marked out. |
| 🍲 **Meals tab** | Add, edit and delete your meals, sides and rules — no spreadsheet or code needed. |

---

## The files

| File | What it's for |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app itself. |
| `config.js` | The two settings that connect the app to your database. Safe to be public. |
| `meals.js` | Your **starter meals**. Only used once, to fill a brand-new account. After that you edit meals in the app's Meals tab. |
| `netlify.toml` | Tells Netlify there's nothing to build — just serve the files. |

You normally won't need to touch any of these now — everything is managed
inside the app.

---

## One-time setup (do this once)

There are two services: **Netlify** (hosts the web page) and **Supabase**
(stores your data and handles login). Both are already created; you just
need to connect and configure them.

### 1. Put the site on Netlify

1. Go to **[app.netlify.com](https://app.netlify.com)** → sign in with GitHub.
2. **Add new site → Import an existing project → GitHub → `dinner-planner`**.
3. Leave the defaults (publish directory `.`, no build command) → **Deploy**.
4. You'll get a live web address like `https://YOUR-NAME.netlify.app`.
   **Copy it — you need it in the next step.**

### 2. Tell Supabase your web address (so login links work) ⚠️ important

Login sends you an email with a link. Supabase will only allow that link to
return to web addresses you've approved, so you must add your Netlify one:

1. Go to **[supabase.com/dashboard](https://supabase.com/dashboard)** and open
   the **dinner-planner** project.
2. Left menu: **Authentication → URL Configuration**.
3. Set **Site URL** to your Netlify address (e.g. `https://YOUR-NAME.netlify.app`).
4. Under **Redirect URLs**, click **Add URL** and add the same address with
   `/**` on the end: `https://YOUR-NAME.netlify.app/**`.
5. **Save.**

That's it. Open your Netlify address, enter your email, click the link in
the email, and you're in. Anyone you want to share it with just visits the
same address and signs in with *their* email — everyone gets their own
private meals and plans.

> **Free-tier note:** Supabase's built-in email sender is limited to a few
> messages per hour — fine for a household. If you ever want nicer/faster
> emails you can plug in your own email service later.

---

## Making changes later

Because the site auto-deploys from GitHub, any change committed and pushed
goes live within a minute. But for everyday use you won't need to: **add and
edit meals right in the Meals tab**, and plan weeks on the Planner tab —
it's all saved to your account automatically.
