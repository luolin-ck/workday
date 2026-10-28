const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { setFixtureTheme } = require('./appearance-fixture.cjs');
const { selectModel, storedModelValue } = require('./model-picker-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-model-picker-'));
  const output = path.join(root, 'output/playwright/model-picker');
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [], checks = [], layouts = [], widthEvidence = [];
  async function call(op, input) {
    const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  const picker = () => page.getByRole('combobox', { name: '选择模型与模型源', exact: true });
  const option = value => page.locator(`[role="option"][value=${JSON.stringify(value)}]`);
  const valueOf = () => storedModelValue(picker());
  const select = value => selectModel(picker(), value);
  const contentGeometry = () => picker().evaluate(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.font = s.font;
    const expected = context.measureText(el.value || el.placeholder).width + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) + parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth);
    const footer = el.closest('.composer-footer').getBoundingClientRect(), send = el.closest('.composer-footer').lastElementChild.getBoundingClientRect();
    return { text: el.value, width: r.width, expected, footerRight: footer.right, sendRight: send.right,
      overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  async function checkContentWidth() {
    const geometry = await contentGeometry(); widthEvidence.push(geometry);
    assert.ok(Math.abs(geometry.width - geometry.expected) < 3, 'The trigger follows the selected text width: ' + JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.footerRight - geometry.sendRight) <= 1, 'Send stays at the right edge');
    assert.equal(geometry.overflow, false); return geometry.width;
  }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: require('electron'), args: [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      const original = ipcMain._invokeHandlers.get('workday:call');
      globalThis.__pickerExternalCalls = [];
      globalThis.__pickerDefaults = [];
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, op, input) => {
        if (op === 'settings.defaultModel') globalThis.__pickerDefaults.push(input);
        if (['chat.send', 'chat.retry', 'sources.test', 'sources.models', 'schedules.run'].includes(op)) {
          globalThis.__pickerExternalCalls.push(op); throw Error('Model requests disabled in picker fixture');
        }
        return original(event, op, input);
      });
    });
    const models = [
      { id: 'gpt-6-astra', name: 'gpt-6-astra', supportsTools: true },
      { id: 'shared', name: '同名模型', supportsTools: false },
      ...Array.from({ length: 16 }, (_, i) => ({ id: `model-${i}`, name: `model-${i}`, supportsTools: false })),
      { id: 'long-name', name: '用于验证超长模型名称自适应和窄窗口省略的显示名称'.repeat(4), supportsTools: false }
    ];
    const a = await call('sources.save', { name: 'OpenAI', baseUrl: 'https://fixture.invalid/v1', models });
    const b = await call('sources.save', { name: '另一个模型源', baseUrl: 'https://fixture.invalid/v1', models: [models[1]] });
    const first = JSON.stringify([a.id, models[0].id]), sharedA = JSON.stringify([a.id, 'shared']), sharedB = JSON.stringify([b.id, 'shared']);
    await call('settings.defaultModel', { model: { sourceId: a.id, modelId: models[0].id } });
    await page.waitForFunction(() => document.querySelector('[aria-label="选择模型与模型源"]')?.value);
    assert.equal(await picker().inputValue(), 'gpt-6-astra', 'Selected model shows only its name');
    assert.equal(await page.evaluate(() => CSS.supports('field-sizing', 'content')), true);
    const firstWidth = await checkContentWidth();
    await picker().click();
    assert.deepEqual(await page.locator('.model-picker-dropdown .mantine-Select-groupLabel').allTextContents(), ['OpenAI', '另一个模型源']);
    assert.deepEqual(await page.locator('.model-picker-dropdown').getByRole('option').allTextContents(), [...models.map(m => m.name), models[1].name]);
    await option(first).click(); assert.equal(await valueOf(), first, 'Selecting the active option does not clear it');
    await select(sharedA); assert.equal(await valueOf(), sharedA);
    assert.ok(await checkContentWidth() < firstWidth, 'A shorter model name shrinks the trigger');
    await select(sharedB); assert.equal(await valueOf(), sharedB);
    assert.equal(await picker().inputValue(), '同名模型');
    checks.push('Grouped labels omit source/tool suffixes; duplicate model names retain distinct source IDs and active selection cannot be cleared');

    await select(first);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await picker().focus(); await page.keyboard.press('ArrowDown');
    await page.getByRole('listbox').waitFor();
    await page.waitForFunction(value => document.querySelector(`[role="option"][value=${JSON.stringify(value)}]`)?.hasAttribute('data-combobox-selected'), first);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await valueOf(), sharedA);
    await picker().click(); await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('listbox').count(), 0); assert.equal(await valueOf(), sharedA);
    checks.push('Arrow keys/Enter select an option and Escape closes without changing it');

    for (const theme of ['mono', 'blue', 'custom']) {
      await setFixtureTheme(page, theme);
      for (const width of [1440, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
        await page.waitForFunction(width => innerWidth === width, width);
        await checkContentWidth();
        if (theme === 'mono' && width === 1440) await page.locator('.composer-input').screenshot({ path: path.join(output, 'composer-content.png') });
        await picker().click();
        const dropdown = page.locator('.model-picker-dropdown'); await dropdown.waitFor();
        const geometry = await dropdown.evaluate(el => {
          const r = el.getBoundingClientRect(), s = getComputedStyle(el), viewport = el.querySelector('[data-radix-scroll-area-viewport]') || el.querySelector('.mantine-ScrollArea-viewport');
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, radius: s.borderRadius, shadow: s.boxShadow,
            scrollable: viewport.scrollHeight > viewport.clientHeight, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.top >= 0 && geometry.bottom <= 901, JSON.stringify(geometry));
        assert.ok(geometry.height < 400 && geometry.scrollable); assert.equal(geometry.pageOverflow, false);
        assert.ok(parseFloat(geometry.radius) > 0); assert.notEqual(geometry.shadow, 'none');
        layouts.push({ theme, width, ...geometry });
        await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
      }
    }
    checks.push('Three themes at 1440/660px keep a rounded, shadowed, scrollable menu inside the viewport');

    const sizing = await picker().evaluate(el => {
      const root = el.closest('.dropdown'), classes = root.className, style = root.getAttribute('style');
      root.classList.remove('dropdown-content'); root.classList.add('dropdown-fixed'); root.style.width = '180px';
      const fixed = root.getBoundingClientRect().width;
      root.classList.remove('dropdown-fixed'); root.classList.add('dropdown-fill'); root.style.removeProperty('width');
      const fill = root.getBoundingClientRect().width;
      root.className = classes;
      if (style === null) root.removeAttribute('style'); else root.setAttribute('style', style);
      return { fixed, fill, content: root.getBoundingClientRect().width };
    });
    assert.ok(Math.abs(sizing.fixed - 180) < 1, JSON.stringify(sizing));
    assert.ok(sizing.fill > sizing.fixed && sizing.fixed > sizing.content, JSON.stringify(sizing));
    widthEvidence.push(sizing);
    for (const width of [1440, 660]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
      await page.waitForFunction(width => innerWidth === width, width);
      await select(JSON.stringify([a.id, 'long-name']));
      const geometry = await contentGeometry(); widthEvidence.push({ viewport: width, ...geometry });
      assert.ok(geometry.width < geometry.expected, 'Long names shrink to the available row width');
      assert.equal(geometry.overflow, false); assert.ok(Math.abs(geometry.footerRight - geometry.sendRight) <= 1);
      assert.equal(await picker().evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
      await page.locator('.composer-input').screenshot({ path: path.join(output, `composer-long-${width}.png`) });
      await select(first); await checkContentWidth();
    }
    checks.push('Fixed/fill/content widths render independently; long names truncate and shrink back without displacing Send');

    await page.getByRole('button', { name: '设置', exact: true }).click();
    const formWidth = await picker().evaluate(el => {
      const root = el.closest('.dropdown'); return { width: root.getBoundingClientRect().width, parent: root.parentElement.clientWidth };
    });
    assert.ok(Math.abs(formWidth.width - formWidth.parent) <= 1, 'Settings keeps the default fill width');
    await select(sharedB);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await call('state.get', {})).defaultModel?.sourceId === b.id) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual((await call('state.get', {})).defaultModel, { sourceId: b.id, modelId: 'shared' }, JSON.stringify(await app.evaluate(() => globalThis.__pickerDefaults)));
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await picker().inputValue(), '同名模型'); assert.equal(await valueOf(), sharedB);
    checks.push('Default model saves and restores the source/model pair after reload');

    await call('settings.defaultModel', { model: null });
    await page.waitForFunction(() => document.querySelector('.default-model input[role="combobox"]').value === '');
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    await page.getByRole('button', { name: '创建计划', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建定时任务' }); await dialog.waitFor();
    await dialog.getByLabel('计划名称', { exact: true }).fill('模型选择测试');
    await dialog.getByLabel('提示词', { exact: true }).fill('仅测试，不运行');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByText('请选择固定的模型源与模型。', { exact: true }).waitFor();
    assert.equal((await call('state.get', {})).schedules.length, 0);
    await select(first); assert.equal(await valueOf(), first);
    const pickerId = await picker().getAttribute('id');
    assert.equal(await dialog.locator(`label[for=${JSON.stringify(pickerId)}]`).textContent(), '固定模型 · 模型源');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    checks.push('The schedule dialog preserves label association, rejects an empty model, and accepts selection');

    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await select(first);
    await call('sources.save', { id: a.id, name: a.name, baseUrl: a.baseUrl, models: a.models.filter(m => m.id !== 'gpt-6-astra'), expectedVersion: a.version });
    await page.waitForFunction(() => document.querySelector('.model-picker input[role="combobox"]').value.includes('不可用'));
    await picker().click(); assert.equal(await option(first).getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('Escape');
    checks.push('Removed models remain visibly unavailable and cannot be selected');
    assert.deepEqual(errors, []); assert.deepEqual(await app.evaluate(() => globalThis.__pickerExternalCalls), []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, layouts, widthEvidence, personalData: false, modelRequests: false }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
