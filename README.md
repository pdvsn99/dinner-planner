# 🍽️ Dinner Planner

A web version of the meal-planning spreadsheet. Plan the week's lunches and
dinners, roll the dice on what to eat, treat yourself, and get an automatic
shopping list — all in the browser, nothing to install.

**Live buttons**

| Button | What it does |
| --- | --- |
| 🎲 **Generate week** | Fills every lunch & dinner with a random *home* meal, picking sides at random and only using meals allowed on that day. |
| 🔀 **Swap selected** | Tap a meal in the table first, then this re-rolls just that one. |
| ✨ **Treat selected** | Tap a meal, then this swaps it for a takeaway / eating-out treat. |
| 🎉 **Treat the week!** | Turns the whole week into treats. |
| 🖨️ **Print** | Print or save the week + shopping list as a PDF. |
| 🧹 **Clear** | Empties the week. |

Your plan is saved automatically **on your device** (nothing is uploaded).

---

## Changing your meals

Open **`meals.js`** — it's the only file you need to touch. Every meal is one
block like this:

```js
{
  name: "Meatballs",
  category: "Dinner",          // "Lunch" or "Dinner"
  location: "Home",            // "Home", "Takeaway" or "Eating Out"
  ease: "Medium",              // "Easy" / "Medium" / "Hard" (just a label)
  sides: ["mash", "gravy", "peas", "sweetcorn", "carrots", "wedges"],
  min: 2, max: 4,              // how many sides to pick (2 to 4 here)
  days: ["mon", "tue", "wed", "thurs", "fri", "sat", "sun"],
  ingredients: ["meatballs"],  // goes on the shopping list
},
```

To **add** a meal: copy an existing block, paste it right after, and change the
words in the quotes. Keep the commas where they are. Save the file — that's it.

---

## Putting it on the internet (Netlify)

You've chosen the GitHub route, so it's a one-time setup:

1. Go to **[app.netlify.com](https://app.netlify.com)** and sign in (you can
   sign in with GitHub).
2. Click **Add new site → Import an existing project → GitHub**.
3. Pick the **`dinner-planner`** repository.
4. Netlify will show a build screen. Leave everything as the defaults
   (publish directory `.`, no build command) and click **Deploy**.
5. After a few seconds you get a live link like
   `https://your-name.netlify.app`. Done!

From then on, **every time you (or I) push a change to GitHub, Netlify
re-deploys automatically** within a minute. To change your meals: edit
`meals.js`, save, commit & push — the live site updates itself.

> Prefer no GitHub? You can also drag this whole folder onto
> [app.netlify.com/drop](https://app.netlify.com/drop) for an instant site,
> but then you'd re-drag it each time you make a change.
