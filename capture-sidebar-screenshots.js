const fs = require("fs/promises");
const path = require("path");
const readline = require("readline");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { chromium } = require("playwright");

/** Application sign-in URL — set ERP_BASE_URL in `.env` (see `.env.example`). Not committed. */
const LOGIN_URL = (process.env.ERP_BASE_URL || "").trim();
const OUTPUT_ROOT = path.join(__dirname, "screenshots");
/** Extra wait after load so tables and menus settle before capture */
const POST_LOAD_WAIT_MS = 3000;
const GOTO_TIMEOUT_MS = 60000;

function sanitizeName(input) {
  const trimmed = (input || "").trim();
  const safe = trimmed
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safe || "Unnamed";
}

function waitForEnter(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function ensureStablePage(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    await page.waitForTimeout(1500);
  }
}

async function waitAfterNavigation(page) {
  await page.waitForTimeout(POST_LOAD_WAIT_MS);
}

/**
 * Metronic/Keen aside often stays visually "full width" during automation (submenu overlay).
 * Collapse the rail (<< toggler), add minimize classes, and cap aside + submenu width so
 * main content stays visible in screenshots.
 */
async function preparePageLayoutForCapture(page) {
  await page.evaluate(() => {
    document.body.classList.add("kt-aside--minimize");
    document.querySelector("#kt_aside")?.classList.add("kt-aside--minimize");
    document.querySelectorAll("aside.kt-aside").forEach((a) => a.classList.add("kt-aside--minimize"));

    const menu = document.querySelector("#AsideMenu_userMenu");
    let el = menu;
    for (let i = 0; i < 22 && el; i++, el = el.parentElement) {
      const isAside =
        el.tagName === "ASIDE" ||
        el.id === "kt_aside" ||
        (el.classList && el.classList.contains("kt-aside"));
      if (isAside) {
        el.style.setProperty("width", "78px", "important");
        el.style.setProperty("min-width", "78px", "important");
        el.style.setProperty("max-width", "78px", "important");
        el.style.setProperty("flex", "0 0 78px", "important");
        break;
      }
    }
  });

  const asideStillWide = await page.evaluate(() => {
    const aside =
      document.querySelector("#kt_aside") ||
      document.querySelector("aside.kt-aside") ||
      document.querySelector("#AsideMenu_userMenu")?.closest("aside");
    if (!aside) return false;
    return aside.getBoundingClientRect().width > 130;
  });

  if (asideStillWide) {
    const toggler = page
      .locator(
        "#kt_aside_toggler, #kt_aside_toggle, .kt-aside__brand-aside-toggler, .kt-aside__brand-tools button, a.kt-aside__brand-aside-toggler"
      )
      .first();
    if (await toggler.isVisible({ timeout: 700 }).catch(() => false)) {
      await toggler.click();
      await page.waitForTimeout(450);
    }
  }

  await page.evaluate(() => {
    if (document.getElementById("erp-capture-aside-fix")) return;
    const s = document.createElement("style");
    s.id = "erp-capture-aside-fix";
    s.textContent = `
      #kt_aside, aside.kt-aside {
        width: 78px !important;
        min-width: 78px !important;
        max-width: 78px !important;
        overflow-x: hidden !important;
      }
      .kt-aside .kt-menu__submenu,
      .kt-aside-menu .kt-menu__submenu,
      #AsideMenu_userMenu .kt-menu__submenu {
        max-width: min(380px, 46vw) !important;
        width: auto !important;
        left: 78px !important;
        right: auto !important;
        box-sizing: border-box !important;
      }
    `;
    document.head.appendChild(s);
  });

  await page.waitForTimeout(200);
}

async function resetToDefault(page) {
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
    await ensureStablePage(page);
    await waitAfterNavigation(page);
  } catch (e) {
    console.warn("Could not reset to Default:", e.message);
  }
}

/**
 * Clicks an "Add New" control if present, waits, full-page screenshot; does not navigate back.
 */
async function tryCaptureAddNew(page, outputDir, sidebarItemName) {
  const addNew = page
    .getByRole("link", { name: /Add\s+New/i })
    .or(page.getByRole("button", { name: /Add\s+New/i }))
    .first();

  const visible = await addNew.isVisible({ timeout: 2500 }).catch(() => false);
  if (!visible) return;

  const fileName = `${sanitizeName(sidebarItemName)} - add new.png`;
  const outputPath = path.join(outputDir, fileName);
  console.log(`  -> Add New found, capturing: ${fileName}`);
  await addNew.click({ timeout: 10000 });
  await ensureStablePage(page);
  await waitAfterNavigation(page);
  await preparePageLayoutForCapture(page);
  await page.screenshot({ path: outputPath, fullPage: true });
}

async function readSidebarItems(page) {
  return page.evaluate(() => {
    const topItems = Array.from(
      document.querySelectorAll("#AsideMenu_userMenu > li.kt-menu__item")
    );

    function textFromLink(linkEl) {
      const textEl = linkEl.querySelector(".kt-menu__link-text");
      return (textEl?.textContent || linkEl.textContent || "").trim();
    }

    function getDirectLink(liEl) {
      return liEl.querySelector(":scope > a.kt-menu__link");
    }

    function collectItemsFromLi(liEl, topParentName) {
      const directLink = getDirectLink(liEl);
      const label = directLink ? textFromLink(directLink) : "";
      const href = directLink ? (directLink.getAttribute("href") || "").trim() : "";

      const items = [];
      const hasValidHref = href && !href.startsWith("javascript:");
      if (hasValidHref) {
        items.push({
          parent: topParentName || "Root",
          name: label || "Unnamed",
          href,
        });
      }

      const childLis = Array.from(
        liEl.querySelectorAll(":scope > .kt-menu__submenu > .kt-menu__subnav > li.kt-menu__item")
      );
      for (const childLi of childLis) {
        items.push(...collectItemsFromLi(childLi, topParentName || label || "Root"));
      }
      return items;
    }

    const all = [];
    for (const topLi of topItems) {
      const topLink = getDirectLink(topLi);
      const topName = topLink ? textFromLink(topLink) : "Root";
      all.push(...collectItemsFromLi(topLi, topName));
    }

    const byUrl = new Map();
    for (const item of all) {
      const absoluteUrl = new URL(item.href, location.origin).href;
      const key = `${item.parent}__${item.name}__${absoluteUrl}`;
      if (!byUrl.has(key)) {
        byUrl.set(key, { ...item, href: absoluteUrl });
      }
    }
    return Array.from(byUrl.values());
  });
}

async function main() {
  if (!LOGIN_URL) {
    console.error(
      "Missing ERP_BASE_URL. Copy .env.example to .env and set your sign-in page URL."
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  console.log(`Opening login page: ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  console.log("\nLogin manually, then press Enter in this terminal.");
  await waitForEnter("Press Enter after you click Sign In and land on dashboard/modules page... ");
  await ensureStablePage(page);

  const items = await readSidebarItems(page);
  if (!items.length) {
    throw new Error("No sidebar modules found. Make sure you are logged in and the sidebar is visible.");
  }

  console.log(`\nFound ${items.length} sidebar targets. Starting screenshots...`);
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  for (const item of items) {
    const parentFolder = sanitizeName(item.parent);
    const fileName = `${sanitizeName(item.name)}.png`;
    const outputDir = path.join(OUTPUT_ROOT, parentFolder);
    const outputPath = path.join(outputDir, fileName);

    try {
      await fs.mkdir(outputDir, { recursive: true });

      console.log(`Capturing: ${item.parent} -> ${item.name}`);
      await page.goto(item.href, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      await ensureStablePage(page);
      await waitAfterNavigation(page);
      await preparePageLayoutForCapture(page);

      await page.screenshot({ path: outputPath, fullPage: true });

      try {
        await tryCaptureAddNew(page, outputDir, item.name);
      } catch (addErr) {
        console.warn(`  -> Add New step failed (${item.name}):`, addErr.message);
        await resetToDefault(page);
      }
    } catch (err) {
      console.warn(`Failed: ${item.parent} -> ${item.name}:`, err.message);
      await resetToDefault(page);
    }
  }

  console.log(`\nDone. Screenshots saved in: ${OUTPUT_ROOT}`);
  await browser.close();
}

main().catch((error) => {
  console.error("\nAutomation failed:", error.message);
  process.exitCode = 1;
});
