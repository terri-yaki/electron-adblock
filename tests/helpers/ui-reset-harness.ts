// QA interaction harness for reset appearance. Runs the built mock app, drives the real
// renderer through CDP and leaves screenshots in _shots. Run with:
//   node --import tsx tests/helpers/ui-reset-harness.ts
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectToPage, delay, type CdpPage } from './cdp';
import { PROJECT_ROOT, launchBuiltApp } from './fixture';

const SHOT_DIR = path.join(PROJECT_ROOT, '_shots');
const REPORT_PATH = path.join(SHOT_DIR, 'qa-reset-report.json');

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

interface ResetView {
  pickerActive: boolean;
  layoutEditing: boolean;
  cosmeticRules: unknown[];
  layoutRules: unknown[];
}

const checks: CheckResult[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}

async function capture(page: CdpPage, name: string): Promise<string> {
  const result = await page.send('Page.captureScreenshot', { format: 'png' });
  const data = result.data;
  if (typeof data !== 'string' || data.length === 0) throw new Error('captureScreenshot returned no data');
  const file = path.join(SHOT_DIR, name);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

async function clickByText(page: CdpPage, selector: string, text: string): Promise<boolean> {
  return page.evaluate<boolean>(
    '(() => { const target = [...document.querySelectorAll(' +
      JSON.stringify(selector) +
      ')].find((item) => (item.textContent || "").includes(' +
      JSON.stringify(text) +
      ')); if (!target) return false; target.click(); return true; })()',
  );
}

async function main(): Promise<void> {
  const app = await launchBuiltApp({
    mock: true,
    env: { EAB_WINDOW_WIDTH: '1240', EAB_WINDOW_HEIGHT: '820' },
  });

  let passed = 0;
  try {
    const { connection, page } = await connectToPage(app.port, { timeoutMs: 30000 });
    try {
      await page.waitFor('document.querySelectorAll(".app-row").length === 4', {
        timeoutMs: 15000,
        description: 'mock shell with four apps',
      });

      // --- Phase A: reset while layout mode is active, through the confirm dialog.
      await page.evaluate('document.getElementById("tab-layout")?.click() ?? false');
      await page.waitFor('!!document.querySelector(".layout-panel")', { timeoutMs: 6000 });
      await page.waitFor('document.querySelectorAll(".layout-panel .rule-row").length === 1', {
        timeoutMs: 6000,
        description: 'initial layout rule',
      });
      check('layout tab lists the initial layout rule', true);

      const adjustClicked = await clickByText(page, '.layout-panel .panel-actions button', 'Adjust layout');
      check('adjust layout action is available', adjustClicked);
      await page.waitFor('!!document.querySelector(".picker-banner.is-layout")', {
        timeoutMs: 6000,
        description: 'layout mode banner',
      });
      check('layout mode banner is active before reset', true);

      const resetClicked = await clickByText(page, '.layout-panel .panel-actions button', 'Reset appearance');
      check('reset appearance button is available during layout mode', resetClicked);
      await page.waitFor('!!document.querySelector(".dialog")', {
        timeoutMs: 5000,
        description: 'reset confirm dialog',
      });
      // Let the dialog fade-in transition finish before capturing it.
      await delay(300);
      const dialogTitle = await page.evaluate<string>('document.querySelector(".dialog-title")?.textContent ?? ""');
      const dialogMessage = await page.evaluate<string>('document.querySelector(".confirm-message")?.textContent ?? ""');
      check('reset confirm dialog opens', dialogTitle === 'Reset appearance', dialogTitle);
      check(
        'confirm copy names OP.GG and keeps network blocking',
        dialogMessage.includes('OP.GG') && dialogMessage.includes('Network blocking stays on'),
        dialogMessage.slice(0, 140),
      );
      const confirmShot = await capture(page, 'qa-reset-confirm.png');
      console.log('screenshot ' + confirmShot);

      const confirmed = await page.evaluate<boolean>(
        '(() => { const target = [...document.querySelectorAll(".dialog-footer button")].find((item) => (item.textContent || "").trim() === "Reset appearance"); if (!target) return false; target.click(); return true; })()',
      );
      check('confirm button triggers the reset', confirmed);
      await page.waitFor('!document.querySelector(".dialog")', { timeoutMs: 6000 });
      await page.waitFor('document.querySelectorAll(".layout-panel .rule-row").length === 0', {
        timeoutMs: 8000,
        description: 'layout rules cleared after reset',
      });
      check('reset clears layout rules', true);
      await page.waitFor('!document.querySelector(".picker-banner.is-layout")', { timeoutMs: 5000 });
      check('reset stops layout mode banner', true);
      const toastText = await page.evaluate<string>(
        '[...document.querySelectorAll(".toast")].map((item) => item.textContent || "").join(" | ")',
      );
      check(
        'reset toast reports removed rules',
        toastText.includes('Restored original appearance in OP.GG'),
        toastText.slice(0, 180),
      );
      const layoutShot = await capture(page, 'qa-reset-after-layout.png');
      console.log('screenshot ' + layoutShot);

      await page.evaluate('document.getElementById("tab-hidden")?.click() ?? false');
      await page.waitFor('!!document.querySelector(".rules-panel")', { timeoutMs: 5000 });
      await page.waitFor('document.querySelectorAll(".rule-row").length === 0', {
        timeoutMs: 5000,
        description: 'hidden rules cleared after reset',
      });
      check('reset clears hidden element rules', true);
      const hiddenShot = await capture(page, 'qa-reset-after-hidden.png');
      console.log('screenshot ' + hiddenShot);

      // --- Phase B: resetAppearance while the picker is active.
      const addRule = await page.evaluate<boolean>(
        '(() => { const input = document.querySelector(' +
          JSON.stringify('input[aria-label="CSS selector to hide"]') +
          '); if (!input) return false; input.value = "div.qa-reset-check"; input.dispatchEvent(new Event("input", { bubbles: true })); const submit = document.querySelector(' +
          JSON.stringify('.add-rule-row button[type="submit"]') +
          '); if (!submit) return false; submit.click(); return true; })()',
      );
      check('hidden rule can be re-added before the picker reset', addRule);
      await page.waitFor('document.querySelectorAll(".rule-row").length === 1', {
        timeoutMs: 6000,
        description: 're-added hidden rule',
      });

      await page.evaluate('document.getElementById("tab-overview")?.click() ?? false');
      await page.waitFor('!!document.querySelector(".toolbar .btn-primary")', { timeoutMs: 6000 });
      const pickerStarted = await clickByText(page, '.toolbar button', 'Pick element');
      check('picker can be started', pickerStarted);
      await page.waitFor('!!document.querySelector(".picker-banner")', {
        timeoutMs: 6000,
        description: 'picker banner',
      });
      check('picker banner is active before resetAppearance', true);

      const resetResult = await page.evaluate<ResetView>(
        '(async () => await window.adblock.resetAppearance("opgg"))()',
      );
      check(
        'resetAppearance reports the picker stopped',
        resetResult.pickerActive === false,
        'pickerActive=' + String(resetResult.pickerActive),
      );
      check(
        'resetAppearance reports cosmetic rules cleared',
        Array.isArray(resetResult.cosmeticRules) && resetResult.cosmeticRules.length === 0,
        'count=' + String(resetResult.cosmeticRules?.length),
      );
      check(
        'resetAppearance reports layout rules cleared',
        Array.isArray(resetResult.layoutRules) && resetResult.layoutRules.length === 0,
        'count=' + String(resetResult.layoutRules?.length),
      );
      check('resetAppearance reports layout editing stopped', resetResult.layoutEditing === false);
      await page.waitFor('!document.querySelector(".picker-banner")', {
        timeoutMs: 5000,
        description: 'picker banner cleared by resetAppearance',
      });
      check('picker banner is removed after resetAppearance', true);
      const afterPickerShot = await capture(page, 'qa-reset-after-picker.png');
      console.log('screenshot ' + afterPickerShot);
    } finally {
      await connection.close();
    }
  } catch (error) {
    console.error('HARNESS FAILURE: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
    console.error('--- app output tail ---\n' + app.output().slice(-3000));
    process.exitCode = 2;
  } finally {
    await app.close();
    passed = checks.filter((item) => item.pass).length;
    console.log('RESULT ' + String(passed) + '/' + String(checks.length) + ' checks passed');
    await writeFile(REPORT_PATH, JSON.stringify({ checks, passed, total: checks.length }, null, 2), 'utf8').catch(
      () => undefined,
    );
    if (checks.some((item) => !item.pass) && process.exitCode === undefined) process.exitCode = 1;
  }
}

void main();
