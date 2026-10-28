const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { selectModel, storedModelValue } = require('./model-picker-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-settings-layout-'));
  const output = path.join(root, 'output/playwright', process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'settings-layout-stage' : 'settings-layout-source');
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], layouts = [], errors = [];
  let app, page;
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  async function until(check, label) {
    for (let i = 0; i < 160; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
  }
  async function call(operation, input) {
    const result = await page.evaluate(({ operation, input }) => window.workday.call(operation, input), { operation, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  const sourceById = async id => (await call('state.get', {})).sources.find(source => source.id === id);
  const openSettings = async () => page.getByRole('button', { name: '设置', exact: true }).click();
  const resetScroll = async () => page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) {
      if (element.scrollTop) element.scrollTop = 0;
      if (element.scrollLeft) element.scrollLeft = 0;
    }
    window.scrollTo(0, 0);
  });
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1440, 980); window.hide();
      const original = ipcMain._invokeHandlers.get('workday:call');
      globalThis.__settingsExternalOperations = [];
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) {
          globalThis.__settingsExternalOperations.push(operation);
          throw new Error('External operations disabled in settings layout fixture');
        }
        return original(event, operation, input);
      });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const longName = '合成模型源 · 用于检查很长名称在窄窗口中的整齐排版与省略显示';
    const alias = '自定义显示名称用于验证长模型别名和模型标识均完整保留'.repeat(2);
    const models = Array.from({ length: 13 }, (_, index) => {
      const id = `fixture-model-${String(index + 1).padStart(2, '0')}`;
      return { id, name: index === 0 ? alias : id, supportsTools: false };
    });
    const baseUrl = 'https://fixture.invalid/' + 'a-very-long-endpoint-segment/'.repeat(6) + 'v1';
    const sourceA = await call('sources.save', { name: longName, baseUrl, models });
    const sourceB = await call('sources.save', { name: 'Source B', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'source-b-model', name: 'source-b-model', supportsTools: false }] });
    await openSettings();
    assert.equal(await page.locator('.settings-page').count(), 1, 'Settings should retain its page layout');
    const catalog = page.locator('.model-catalog');
    await catalog.waitFor();
    const cards = catalog.locator('.model-card');
    assert.equal(await catalog.getByRole('table').count(), 0, 'Models should use simple cards instead of a table');
    assert.equal(await page.getByRole('list', { name: '可选模型列表', exact: true }).count(), 1, 'The model catalog should expose list semantics');
    assert.equal(await catalog.getByRole('listitem').count(), 13);
    assert.equal(await cards.count(), 13);
    const firstText = await cards.first().innerText();
    assert.ok(firstText.includes(alias) && firstText.includes(models[0].id), 'Alias and underlying model ID must both remain available');
    for (let index = 1; index < models.length; index++) {
      assert.equal((await cards.nth(index).innerText()).trim(), models[index].id, 'Identical name/ID should be shown once');
    }
    record('Thirteen accessible model cards remove duplicate names while preserving a custom alias and its actual model ID');

    for (const theme of ['mono', 'custom', 'blue']) {
      await setFixtureTheme(page, theme); await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await openSettings();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      for (const width of [1440, 1000, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
        await page.waitForFunction(width => innerWidth === width, width);
        // Compare actual rendered geometry with the existing standalone pages so
        // a smaller settings-only cap cannot reintroduce large outer gutters.
        const references = [];
        for (const name of ['知识库', '定时任务']) {
          await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name, exact: true }).click();
          await page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
          references.push(await page.locator('.page').evaluate(element => {
            const rect = element.getBoundingClientRect(), heading = element.querySelector('h1');
            const style = getComputedStyle(element), headingStyle = getComputedStyle(heading);
            return { name: heading.textContent.trim(), width: rect.width, left: rect.left,
              maxWidth: style.maxWidth, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
              titleSize: headingStyle.fontSize,
              titleWeight: headingStyle.fontWeight, titleLineHeight: headingStyle.lineHeight };
          }));
        }
        await openSettings(); await catalog.waitFor(); await resetScroll();
        const bounds = await page.locator('.settings-page').evaluate(element => {
          const catalog = element.querySelector('.model-catalog'), list = element.querySelector('.source-list'), detail = element.querySelector('.source-detail');
          const rect = element.getBoundingClientRect(), listRect = list.getBoundingClientRect(), detailRect = detail.getBoundingClientRect();
          const catalogRect = catalog.getBoundingClientRect(), cardRects = [...catalog.querySelectorAll('.model-card')].map(card => card.getBoundingClientRect());
          const input = element.querySelector('.test-connection select').getBoundingClientRect();
          const button = element.querySelector('.test-connection button').getBoundingClientRect();
          const headingElement = element.querySelector('h1'), heading = headingElement.getBoundingClientRect(), tabs = element.querySelector('.tabs').getBoundingClientRect();
          const workspace = element.closest('.workspace'), workspaceRect = workspace.getBoundingClientRect();
          const style = getComputedStyle(element), headingStyle = getComputedStyle(headingElement), catalogStyle = getComputedStyle(catalog);
          return {
            controlHeightDelta: Math.abs(input.height - button.height), controlTopDelta: Math.abs(input.top - button.top),
            headingGap: tabs.top - heading.bottom, headingLeftDelta: Math.abs(tabs.left - heading.left),
            titleSize: headingStyle.fontSize, titleWeight: headingStyle.fontWeight, titleLineHeight: headingStyle.lineHeight,
            viewportWidth: innerWidth, pageWidth: rect.width, pageLeft: rect.left, pageMaxWidth: style.maxWidth,
            pagePaddingLeft: style.paddingLeft, pagePaddingRight: style.paddingRight,
            workspaceWidth: workspaceRect.width, pageToWorkspaceRatio: rect.width / workspaceRect.width,
            sidebarWidth: listRect.width, catalogTop: catalogRect.top,
            catalogColumns: cardRects.filter(card => Math.abs(card.top - cardRects[0].top) <= 1).length,
            catalogRowGap: catalogStyle.rowGap, catalogColumnGap: catalogStyle.columnGap,
            documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            workspaceOverflow: workspace.scrollWidth > workspace.clientWidth + 1,
            pageOverflow: element.scrollWidth > element.clientWidth + 1,
            catalogOverflowX: catalog.scrollWidth > catalog.clientWidth + 1,
            catalogHeight: catalog.clientHeight, catalogScrollHeight: catalog.scrollHeight,
            cardsContained: cardRects.every(card => card.left >= catalogRect.left - 1 && card.right <= catalogRect.right + 1),
            childrenContained: [listRect, detailRect].every(child => child.left >= rect.left - 1 && child.right <= rect.right + 1)
          };
        });
        assert.ok(!bounds.documentOverflow && !bounds.workspaceOverflow && !bounds.pageOverflow && !bounds.catalogOverflowX && bounds.childrenContained && bounds.cardsContained, JSON.stringify(bounds));
        assert.ok(bounds.controlHeightDelta <= 1 && bounds.controlTopDelta <= 1, 'Test input and button should align: ' + JSON.stringify(bounds));
        assert.ok(bounds.headingGap >= 8 && bounds.headingLeftDelta <= 1, 'Settings title should occupy its own row above the category tabs: ' + JSON.stringify(bounds));
        for (const reference of references) {
          assert.ok(Math.abs(bounds.pageWidth - reference.width) <= 2 && Math.abs(bounds.pageLeft - reference.left) <= 2,
            'Settings should use the same available page width as ' + reference.name + ': ' + JSON.stringify({ bounds, reference }));
          assert.deepEqual([bounds.pageMaxWidth, bounds.pagePaddingLeft, bounds.pagePaddingRight], [reference.maxWidth, reference.paddingLeft, reference.paddingRight],
            'Settings should share the page width constraint and horizontal padding of ' + reference.name);
          assert.deepEqual([bounds.titleSize, bounds.titleWeight, bounds.titleLineHeight], [reference.titleSize, reference.titleWeight, reference.titleLineHeight],
            'Settings title should match ' + reference.name);
        }
        if (width >= 1000) {
          assert.ok(bounds.catalogColumns >= 2, 'Wide windows should lay models out in at least two card columns: ' + JSON.stringify(bounds));
          assert.ok(bounds.sidebarWidth <= 220, 'The model-source rail should not consume a third of the page: ' + JSON.stringify(bounds));
          assert.ok(bounds.catalogTop < 400, 'Source metadata should keep the model cards near the top: ' + JSON.stringify(bounds));
        }
        for (let index = 0; index < models.length; index++) {
          const card = cards.nth(index);
          await card.scrollIntoViewIfNeeded();
          const visible = await card.evaluate(element => {
            const card = element.getBoundingClientRect(), catalog = element.closest('.model-catalog').getBoundingClientRect();
            const workspace = element.closest('.workspace').getBoundingClientRect();
            return card.top >= Math.max(catalog.top, workspace.top, 0) - 1 &&
              card.bottom <= Math.min(catalog.bottom, workspace.bottom, innerHeight) + 1;
          });
          assert.ok(visible, `Model ${index + 1} should remain reachable at ${theme}/${width}`);
        }
        layouts.push({ theme, width, ...bounds, references });
        await resetScroll(); await page.mouse.move(0, 0);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
        await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), animations: 'disabled' });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      }
    }
    record('Three themes at 1440, 1000 and 660 pixels match standard page width and titles; responsive cards contain long names and all 13 models remain reachable');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 980));
    await page.waitForFunction(() => innerWidth === 1440); await resetScroll();
    await page.locator('.source-detail').getByRole('button', { name: /编辑/ }).click();
    let dialog = page.getByRole('dialog', { name: '编辑模型源', exact: true }); await dialog.waitFor();
    assert.equal(await dialog.getByLabel('源名称', { exact: true }).inputValue(), longName);
    assert.equal(await dialog.getByLabel('Base URL', { exact: true }).inputValue(), baseUrl);
    assert.equal(await dialog.getByRole('textbox', { name: '模型 1 名称', exact: true }).inputValue(), alias);
    assert.equal(await dialog.getByRole('textbox', { name: '模型 1 ID', exact: true }).inputValue(), models[0].id);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.locator('.source-list').getByRole('button', { name: /添加/ }).click();
    dialog = page.getByRole('dialog', { name: '添加模型源', exact: true }); await dialog.waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await call('state.get', {})).sources.length, 2);
    record('Compact edit and add controls still open and dismiss the existing editor without losing source fields or creating data');

    await page.locator('.source-card').filter({ hasText: 'Source B' }).click();
    assert.equal(await cards.count(), 1);
    await page.locator('.source-detail').getByRole('button', { name: '停用', exact: true }).click();
    await until(async () => !(await sourceById(sourceB.id)).enabled, 'source disabled');
    assert.equal(await page.locator('.test-connection').getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
    await page.locator('.source-detail').getByRole('button', { name: '启用', exact: true }).click();
    await until(async () => (await sourceById(sourceB.id)).enabled, 'source enabled');
    await page.locator('.source-card').filter({ hasText: longName }).click();
    assert.equal(await cards.count(), 13);
    const model = { sourceId: sourceA.id, modelId: models[12].id };
    await selectModel(page.locator('.default-model').getByRole('combobox'), JSON.stringify([model.sourceId, model.modelId]));
    await until(async () => JSON.stringify((await call('state.get', {})).defaultModel) === JSON.stringify(model), 'default model saved');
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await openSettings();
    assert.equal(await storedModelValue(page.locator('.default-model').getByRole('combobox')), JSON.stringify([model.sourceId, model.modelId]));
    record('Source switching, enable/disable and the new-chat default model continue to save correctly across reload');

    for (const name of ['主题', '天气', '数据与备份', '模型源']) {
      const tab = page.getByRole('tab', { name, exact: true }); await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.equal(await page.getByRole('tabpanel').count(), 1);
    }
    assert.equal(await page.locator('.model-catalog .model-card').count(), 13);
    assert.deepEqual(await app.evaluate(() => globalThis.__settingsExternalOperations), []);
    assert.deepEqual(errors, []);
    record('All settings categories still switch; validation never sends model requests or touches personal credentials');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, layouts, personalData: false, modelRequests: 0, dataDirectory: data, executable: await app.evaluate(() => process.execPath) }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }, null, 2));
  } catch (error) {
    if (page && !page.isClosed()) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive()).catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
    }
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
