import fs from "node:fs";
import path from "node:path";

const pluginPath = path.join(process.cwd(), "pydeps", "yt_dlp_plugins", "extractor", "getpot_wpc.py");

if (!fs.existsSync(pluginPath)) {
  console.error(`[youtube-wpc-setup] Provider file not found: ${pluginPath}`);
  process.exit(1);
}

let source = fs.readFileSync(pluginPath, "utf8");
const original = source;

source = source.replace(
  "        browser_args = []",
  "        browser_args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']"
);

source = source.replace(
  "            headless=False,",
  "            headless=True,"
);

source = source.replace(
`    # minimize browser window
    window_id, _ = await browser.main_tab.get_window()
    await browser.main_tab.send(nodriver.cdp.browser.set_window_bounds(
        window_id=window_id,
        bounds=nodriver.cdp.browser.Bounds(window_state=nodriver.cdp.browser.WindowState.MINIMIZED)))`,
`    # Headless server environments (Render, containers) may not expose a normal window.
    try:
        window_id, _ = await browser.main_tab.get_window()
        await browser.main_tab.send(nodriver.cdp.browser.set_window_bounds(
            window_id=window_id,
            bounds=nodriver.cdp.browser.Bounds(window_state=nodriver.cdp.browser.WindowState.MINIMIZED)))
    except Exception:
        pass`
);

if (source === original) {
  console.error("[youtube-wpc-setup] No expected WPC provider patterns were patched.");
  process.exit(1);
}

fs.writeFileSync(pluginPath, source, "utf8");
console.log(`[youtube-wpc-setup] Patched WPC provider for headless Render runtime: ${pluginPath}`);
