const CHROME = process.env.CHROME_PATH || "/home/user/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const BASE = process.env.VELOCITY_URL || "http://localhost:8080";
const { chromium } = require("/tmp/node_modules/playwright-core");
(async () => {
	const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
	const page = await browser.newPage();
	const R = []; const mark = (n, ok) => R.push([n, !!ok]);
	await page.goto("http://localhost:8080/", { waitUntil: "load" });
	await page.waitForSelector("#status.status-ok", { timeout: 30000 });
	// option exists in UI
	mark("turbo in transport select", (await page.locator("#set-transport option").allTextContents()).some((t) => /turbo/i.test(t)));
	// enable turbo
	await page.click(await page.locator("#open-settings").isVisible() ? "#open-settings" : "#open-settings-2");
	await page.waitForSelector("#settings:not([hidden])");
	await page.selectOption("#set-transport", "turbo");
	await page.click("#save-settings");
	await page.waitForTimeout(3000);
	mark("turbo saved", (await page.evaluate(() => JSON.parse(localStorage.getItem("vx.settings")).transport)) === "turbo");
	// navigate through turbo (wisp turbo region direct)
	await page.fill("#address", "https://example.com");
	await page.press("#address", "Enter");
	let ok = false;
	for (let i = 0; i < 40 && !ok; i++) {
		await page.waitForTimeout(700);
		for (const f of page.frames().filter((x) => x.url().includes("/scramjet/"))) {
			try { if (await f.evaluate(() => document.title === "Example Domain")) ok = true; } catch {}
		}
	}
	mark("example.com over turbo transport", ok);
	// turbo + tor via region (works: region owns socks)
	const openBtn = async () => ((await page.locator("#browser").isVisible()) ? "#open-settings-2" : "#open-settings");
	await page.click(await openBtn());
	await page.waitForSelector("#settings:not([hidden])");
	if (!(await page.isChecked("#set-tor"))) await page.click("#set-tor");
	await page.click("#save-settings");
	await page.waitForTimeout(900);
	await page.fill("#omnibox", "https://check.torproject.org/api/ip");
	await page.press("#omnibox", "Enter");
	let torOk = false;
	for (let i = 0; i < 50 && !torOk; i++) {
		await page.waitForTimeout(700);
		for (const f of page.frames().filter((x) => x.url().includes("/scramjet/"))) {
			try { if (await f.evaluate(() => document.body && document.body.innerText.includes('"IsTor":true'))) torOk = true; } catch {}
		}
	}
	mark("turbo + tor region → IsTor:true", torOk);
	for (const [n, o] of R) console.log((o ? "PASS" : "FAIL") + "  " + n);
	console.log(R.every((r) => r[1]) ? "ALL-PASS" : "SOME-FAILED");
	await browser.close();
})();
