# Getting These Two Updated Files Live

Same process as last time, just with two files this round instead of one.

## Step 1: Download both files

From the message above, download both:
- `unplug-member-dashboard.html`
- `unplug-admin-dashboard.html`

They'll both land in your Downloads folder.

## Step 2: Go to your GitHub repository

1. Go to **github.com**, log in.
2. Open your **Unplug-ecosystem** repository (same one as last time).

## Step 3: Upload and replace both files

1. Click **Add file** (top right) → **Upload files**.
2. Drag **both** downloaded files into the upload area at once — GitHub
   will recognize both already exist and offer to replace them.
3. Scroll down to the commit message box, type something like:
   ```
   Add entry gate, free registration, and forgot password to both dashboards
   ```
4. Click the green **Commit changes** button.

## Step 4: Wait for Netlify to redeploy

Usually takes 1-2 minutes. If you have a Netlify tab open, you can watch
the new deployment happen there.

## Step 5: Test both, with a hard refresh

For each page, press **Ctrl+Shift+R** first (forces a fresh reload, not
a cached copy), then try:

**Member Dashboard** (`relaxed-cupcake-2e5b2e.netlify.app/unplug-member-dashboard`):
- You should now see the new entry menu: **Visit Site / Become a Member / Sign In**
- Try "Become a Member" with a brand new test email to confirm registration works
- Try "Forgot Password?" from the Sign In screen

**Admin Dashboard** (`relaxed-cupcake-2e5b2e.netlify.app/unplug-admin-dashboard`):
- Sign in as normal with your admin account
- Confirm the new "Forgot Password?" button is there, in case you ever need it

---

Send a screenshot at any point if something looks different from what's
described above, same as always.
