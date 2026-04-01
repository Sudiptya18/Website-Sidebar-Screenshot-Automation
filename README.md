# Website Sidebar Screenshot Automation

Node.js utility that drives a Chromium browser with [Playwright](https://playwright.dev/) to capture full-page screenshots of every linked item in a left-hand application menu, plus optional **Add New** form screens when that action exists.

Typical use: documentation, QA reference packs, or onboarding materials for web apps that expose a large sidebar hierarchy (for example ERP or admin portals built with Metronic-style layouts).

## Prerequisites

- **Node.js** 18 or newer
- Network access to your target application
- A valid user account on that application (you sign in manually once per run)

## Setup

1. Clone the repository and install dependencies:

   ```bash
   npm install
   ```

2. Install the Chromium build Playwright uses (one-time):

   ```bash
   npx playwright install chromium
   ```

3. Configure your sign-in URL (not stored in the repository):

   ```bash
   copy .env.example .env
   ```

   On macOS or Linux, use `cp .env.example .env`.

4. Edit `.env` and set `ERP_BASE_URL` to the full URL of your app’s login or landing page (the page you open before authenticating).

## Usage

```bash
npm run capture
```

1. A browser window opens on your configured URL.
2. **Sign in manually** in the browser.
3. When the main shell is visible (dashboard or home with the sidebar), return to the terminal and **press Enter**.
4. The script walks the sidebar, saves PNGs under `screenshots/`, and closes the browser when finished.

The `screenshots/` directory is cleared at the start of each run so every execution produces a fresh tree of images.

## How it works

1. **Discovery** — After login, the script reads menu structure from the DOM (`#AsideMenu_userMenu` and nested Metronic-style `kt-menu` items), collecting unique absolute URLs for each leaf or linked entry.

2. **Navigation** — For each URL it performs a `goto`, waits for network settle, then applies an extra fixed delay so tables and dynamic regions can render.

3. **Layout before capture** — Many such themes leave the aside or flyout submenu visually wide. The script applies a small layout preparation step: minimized-aside classes, optional toggler click, and scoped CSS so the main content area remains visible in the PNG.

4. **Screenshots** — Each page is saved as `screenshots/<section>/<item name>.png` (file names are sanitized for the filesystem).

5. **Add New** — If a control with accessible name matching “Add New” (link or button) is present, it is clicked once, the script waits again, and a second image is saved as `<item name> - add new.png` in the same folder. Navigation does not rely on the browser Back control; the next item is opened via direct URL.

6. **Errors** — If a navigation or capture step fails, the script returns to the configured sign-in URL (session permitting) and continues with the next menu item.

## Project layout

| Path | Purpose |
|------|--------|
| `capture-sidebar-screenshots.js` | Main automation script |
| `.env` | Your `ERP_BASE_URL` (local only; create from `.env.example`) |
| `screenshots/` | Output images (gitignored; created at runtime) |

## Security and privacy

- Do **not** commit `.env` or real credentials. The repository is set up so `screenshots/` and `.env` stay out of version control.
- Captured PNGs may contain personal or business data; treat `screenshots/` like sensitive output.
- The script does not store passwords; authentication is always manual in the browser.

## Tech stack

- **Runtime:** Node.js  
- **Automation:** Playwright (Chromium)  
- **Configuration:** `dotenv` for local environment variables  

## License

ISC (see `package.json`).
