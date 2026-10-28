const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const data = path.join(root, 'test-data', 'task-corner-calendar-' + kind), output = path.join(root, 'output', 'playwright', 'task-corner-calendar-' + kind);
  await fs.rm(data, { recursive: true, force: true }); await fs.mkdir(data, { recursive: true }); await fs.mkdir(output, { recursive: true });
  const { parseHolidayNotice } = require('../dist/main/holidays.js');
  const days = parseHolidayNotice(await fs.readFile(path.join(root, 'tests/fixtures/holidays-2026.html'), 'utf8'), 2026);
  await fs.mkdir(path.join(data, 'holidays'), { recursive: true });
  await fs.writeFile(path.join(data, 'holidays/2026.json'), JSON.stringify({ parserVersion: 1, year: 2026, sourceUrl: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm', sourceTitle: '国务院办公厅关于2026年部分节假日安排的通知', queriedAt: new Date().toISOString(), days }));
  await fs.rm(path.join(output, 'result.json'), { force: true });
  await fs.rm(path.join(output, 'failure.png'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], measurements = [], errors = [], baseline = new Map(); let app, page;
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const call = (op, input) => page.evaluate(async ({ op, input }) => { const result = await window.workday.call(op, input); if (!result.ok) throw new Error(result.error.message); return result.value; }, { op, input });
  async function month(year, number) {
    const current = (await page.locator('.calendar h1').textContent()).match(/(\d+)年(\d+)月/);
    const offset = (year - Number(current[1])) * 12 + number - Number(current[2]);
    for (let i = 0; i < Math.abs(offset); i++) await page.getByRole('button', { name: offset > 0 ? '下个月' : '上个月', exact: true }).click();
    await page.getByRole('button', { name: '刷新日历', exact: true }).click({ trial: true });
    await settle();
  }
  async function resize(width, height) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.waitForFunction(width => innerWidth === width, width); await settle();
    const actualSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], actualSize);
  }
  async function inspect(label) {
    const geometry = await page.locator('.calendar').evaluate(calendar => {
      const bounds = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height, width: r.width }; };
      return { viewport: [innerWidth, innerHeight], panel: bounds(calendar), heading: bounds(calendar.querySelector('h1')), refresh: bounds(calendar.querySelector('button[aria-label="刷新日历"]')), grid: bounds(calendar.querySelector('.month-grid')), cells: [...calendar.querySelectorAll('.day')].map(cell => {
        const style = getComputedStyle(cell);
        return { ...bounds(cell), bottomInset: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth), leftInset: parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth), lunar: bounds(cell.querySelector('.lunar-date')), summaries: [...cell.querySelectorAll('.day-tasks>span')].map(summary => ({ ...bounds(summary), icon: bounds(summary.querySelector('svg')), text: summary.textContent, clipped: summary.scrollWidth > summary.clientWidth })) };
      }) };
    });
    const inside = (outer, inner) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    assert.equal(geometry.cells.length, 42, label + ': 42 cells');
    assert.ok(geometry.refresh.left >= geometry.heading.right && Math.abs(geometry.refresh.top + geometry.refresh.height / 2 - geometry.heading.top - geometry.heading.height / 2) <= 1, label + ': refresh button sits beside the month title');
    assert.equal(await page.locator('.holiday-panel').count(), 0, label + ': old holiday footer removed');
    const heights = geometry.cells.map(cell => cell.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, label + ': equal cell heights');
    assert.ok(inside(geometry.panel, geometry.grid), label + ': grid remains inside calendar panel');
    for (let i = 0; i < geometry.cells.length; i++) {
      const cell = geometry.cells[i], rowStart = geometry.cells[Math.floor(i / 7) * 7];
      assert.ok(Math.abs(cell.top - rowStart.top) <= 1, label + ': seven cells per row');
      assert.ok(inside(geometry.grid, cell), label + ': cell ' + i + ' not clipped by grid');
      assert.ok(cell.lunar.width > 0 && cell.lunar.height > 0 && inside(cell, cell.lunar), label + ': lunar label ' + i + ' remains visible');
      for (const summary of cell.summaries) {
        assert.ok(summary.width > 0 && summary.height > 0 && inside(cell, summary) && !summary.clipped, label + ': ' + summary.text + ' is fully visible in cell ' + i);
        assert.ok(summary.icon.width > 0 && summary.icon.height > 0 && inside(summary, summary.icon), label + ': status icon remains visible in cell ' + i);
        assert.match(summary.text, /^\d+$/, label + ': counts have no visible wording or task titles');
        assert.ok(Math.abs(cell.bottom - summary.bottom - cell.bottomInset) <= 1, label + ': status counts align to the padded bottom in cell ' + i);
      }
      if (cell.summaries.length) {
        assert.ok(Math.abs(cell.summaries[0].left - cell.left - cell.leftInset) <= 1, label + ': status counts share the cell left padding');
        assert.ok(cell.summaries.every(summary => Math.abs(summary.top - cell.summaries[0].top) <= 1), label + ': status counts fit on one row');
      }
      if (i >= 7) assert.ok(Math.abs(cell.top - geometry.cells[i - 7].bottom) <= 1, label + ': consecutive rows');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label + ': no horizontal page overflow');
    const last = page.locator('.month-grid .day').last();
    await last.scrollIntoViewIfNeeded(); await last.click(); await settle();
    assert.equal(await last.getAttribute('aria-pressed'), 'true', label + ': last row can be selected');
    await last.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' })); await settle();
    const lastBounds = await last.boundingBox();
    assert.ok(lastBounds.y >= 49 && lastBounds.y + lastBounds.height <= await page.evaluate(() => innerHeight) + 1, label + ': last row fully reachable ' + JSON.stringify(lastBounds) + ' viewport=' + await page.evaluate(() => innerHeight));
    await page.mouse.move(0, 0); await page.screenshot({ path: path.join(output, label + '.png'), fullPage: true, animations: 'disabled' });
    const result = { label, viewport: geometry.viewport, cellHeight: heights[0], minHeight: Math.min(...heights), maxHeight: Math.max(...heights), gridHeight: geometry.grid.height, panelHeight: geometry.panel.height, lastDate: (await last.getAttribute('aria-label')).slice(0, 10) };
    measurements.push(result); return result;
  }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'stage' ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await resize(1500, 980);
    for (const [theme, label] of [['custom', '自定义'], ['mono', '黑白'], ['blue', '蓝白']]) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('tab', { name: '主题', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await page.getByRole('button', { name: 'Home', exact: true }).click(); await month(2026, 10);
      const colors = {};
      for (const [date, kind] of [['2026-10-01', 'rest'], ['2026-10-03', 'rest'], ['2026-09-27', 'rest'], ['2026-10-10', 'work']]) {
        const cell = page.locator(`.day[aria-label^="${date}"]`);
        assert.equal(await cell.getAttribute('data-holiday'), kind);
        const expected = await cell.locator('.holiday-mark').evaluate(el => getComputedStyle(el).backgroundColor);
        for (const action of ['idle', 'hover', 'selected']) {
          if (action === 'hover') await cell.hover();
          if (action === 'selected') { await cell.click(); await page.mouse.move(0, 0); }
          await page.waitForFunction(({ date, expected }) => getComputedStyle(document.querySelector(`.day[aria-label^="${date}"]`)).backgroundColor === expected, { date, expected });
          if (action === 'selected') assert.notEqual(await cell.evaluate(el => getComputedStyle(el).boxShadow), 'none', `${theme}/${date}: selection border retained`);
        }
        colors[kind] = expected;
      }
      const ordinary = page.locator('.day[aria-label^="2026-10-09"]');
      assert.equal(await ordinary.getAttribute('data-holiday'), null);
      assert.notEqual(colors.rest, colors.work);
      assert.ok(!Object.values(colors).includes(await ordinary.evaluate(el => getComputedStyle(el).backgroundColor)));
      await page.locator('.calendar').screenshot({ path: path.join(output, `holiday-colors-${theme}.png`), animations: 'disabled' });
      checks.push(`${theme}: rest/work whole-cell colors remain distinct from ordinary days on weekdays, weekends, adjacent-month dates, hover and selection`);
    }
    for (const [width, height] of [[1500, 980], [1100, 620], [660, 620]]) {
      await resize(width, height); let previous;
      for (const [year, number] of [[2026, 2], [2026, 11], [2026, 12], [2027, 5], [2027, 6]]) {
        await month(year, number);
        const measured = await inspect(`${width}x${height}-${year}-${String(number).padStart(2, '0')}`);
        if (previous) assert.ok(Math.abs(measured.cellHeight - previous.cellHeight) <= 1, 'same cell height across months at ' + width);
        previous = measured;
        if (year === 2027 && number === 5) baseline.set(width, measured.cellHeight);
      }
      checks.push(`${width}x${height}: former four/five/six-week months, including November/December 2026, have 42 equal cells, consistent heights, contained bounds and a selectable last row`);
    }
    await resize(1500, 980); await month(2027, 5);
    const refreshDay = page.locator('.day[aria-label^="2027-05-14"]');
    await call('tasks.save', { title: '刷新读取待办', notes: '', date: '2027-05-14', projectId: null, completed: false });
    await page.getByRole('button', { name: '刷新日历', exact: true }).click();
    await refreshDay.locator('.pending-count[aria-label="待办 1 项"]').waitFor();
    assert.equal(await refreshDay.locator('.pending-count').textContent(), '1');
    assert.equal(await refreshDay.locator('.done-count').count(), 0, 'zero completed count is hidden');
    assert.equal(await refreshDay.locator('.overdue-count').count(), 0, 'zero overdue count is hidden');
    assert.doesNotMatch(await page.locator('.month-grid').textContent(), /刷新读取待办/);
    assert.match(await page.locator('.calendar h1').textContent(), /2027年5月/);
    checks.push('refresh beside the month title reloads saved tasks without a page reload or month change');
    const deadlines = await page.evaluate(() => [-1, 0, 1].map(offset => { const day = new Date(); day.setDate(day.getDate() + offset); return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-'); }));
    const longTitle = '同日布局待办 1：检查长标题与项目首字同一行展示，保留完整提示且不挤出编辑删除按钮', projectName = 'done-design-项目展示与长标题布局验证';
    const projectFolder = path.join(data, 'layout-project'); await fs.mkdir(projectFolder);
    const project = await call('projects.save', { name: projectName, description: '', directory: projectFolder });
    const fixtureTasks = [];
    for (let i = 1; i <= 5; i++) fixtureTasks.push(await call('tasks.save', { title: i === 1 ? longTitle : '同日布局待办 ' + i, notes: '保留备注 ' + i, date: '2027-05-15', dueDate: deadlines[i - 1] ?? null, projectId: i === 1 ? project.id : null, completed: false }));
    for (let i = 1; i <= 2; i++) await call('tasks.save', { title: '同日完成记录 ' + i, notes: '', date: '2027-05-15', dueDate: deadlines[0], projectId: null, completed: true, completedDate: '2027-05-15' });
    const deleted = await call('tasks.save', { title: '已删除过期待办', notes: '', date: '2027-05-15', dueDate: deadlines[0], projectId: null, completed: false });
    await call('tasks.delete', { id: deleted.id, expectedVersion: deleted.version });
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    for (const [width, height] of [[1500, 980], [1100, 620], [660, 620]]) {
      await resize(width, height); await month(2027, 5);
      const taskDay = page.locator('.day[aria-label^="2027-05-15"]');
      assert.match(await taskDay.getAttribute('aria-label'), /5项未完成，2项已完成/);
      assert.deepEqual(await taskDay.locator('.day-tasks>span').allTextContents(), ['5', '2', '1']);
      assert.deepEqual(await taskDay.locator('.day-tasks>span').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['待办 5 项', '已完成 2 项', '逾期 1 项（包含在待办中）']);
      for (const [status, icon] of [['pending', 'circle'], ['done', 'check'], ['overdue', 'triangle-alert']]) assert.equal(await taskDay.locator(`.${status}-count svg.lucide-${icon}[aria-hidden="true"]`).count(), 1);
      assert.equal(await refreshDay.locator('.done-count').count(), 0, 'zero completed count stays hidden after reload');
      assert.equal(await refreshDay.locator('.overdue-count').count(), 0, 'zero overdue count stays hidden after reload');
      assert.doesNotMatch(await page.locator('.month-grid').textContent(), /同日布局待办|同日完成记录|刷新读取待办|已删除过期待办/);
      await taskDay.click();
      const row = page.locator(`.day-panel .task-row[data-task-id="${fixtureTasks[0].id}"]`);
      const title = row.getByRole('textbox', { name: `待办内容 ${longTitle}`, exact: true });
      await title.waitFor();
      assert.equal(await page.locator('.day-panel .task-row').count(), 7, 'selected day still displays task details');
      const badge = row.locator('.task-project-picker');
      await title.hover(); await page.getByRole('tooltip', { name: longTitle, exact: true }).waitFor();
      assert.equal(await badge.textContent(), 'd', 'project badge shows only the first character');
      await badge.hover(); await page.getByRole('tooltip', { name: projectName, exact: true }).waitFor();
      assert.equal(await badge.getAttribute('aria-label'), `关联项目 ${longTitle}：${projectName}`, 'project picker names both the task and its complete project');
      const deadline = row.locator('.task-deadline');
      assert.equal(await deadline.locator('svg').count(), 1, 'a deadline is represented by an icon');
      await deadline.hover(); await page.getByRole('tooltip').filter({ hasText: deadlines[0] }).waitFor();
      const noDeadline = page.locator(`.day-panel .task-row[data-task-id="${fixtureTasks[3].id}"]`);
      assert.equal(await noDeadline.locator('.task-deadline').count(), 0, 'tasks without a deadline have no time icon');
      assert.equal(await noDeadline.locator('.task-project-picker').textContent(), '空', 'unassigned tasks keep an empty project picker');
      await noDeadline.locator('.task-project-picker').hover(); await page.getByRole('tooltip', { name: '未关联项目', exact: true }).waitFor();
      const layout = await row.evaluate(row => {
        const bounds = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, centerY: r.top + r.height / 2, width: r.width, height: r.height }; };
        const title = row.querySelector('.task-title input'), style = getComputedStyle(title);
        const measure = document.createElement('canvas').getContext('2d'); measure.font = style.font;
        const textWidth = measure.measureText(title.value).width + Math.max(0, Array.from(title.value).length - 1) * (parseFloat(style.letterSpacing) || 0);
        const contentWidth = title.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { row: bounds(row), title: bounds(title), deadline: bounds(row.querySelector('.task-deadline')), priority: bounds(row.querySelector('.task-priority-picker')), badge: bounds(row.querySelector('.task-project-picker')), actions: [...row.querySelectorAll('button[aria-label^="编辑与改期 "], button[aria-label^="删除 "]')].map(bounds), clipped: textWidth > contentWidth, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflow: style.overflowX };
      });
      assert.ok(layout.clipped && layout.whiteSpace === 'nowrap' && layout.textOverflow === 'ellipsis' && ['hidden', 'clip'].includes(layout.overflow), width + ': long task title input truncates on one line: ' + JSON.stringify(layout));
      assert.ok(layout.title.width > 0 && layout.title.right <= layout.deadline.left && layout.deadline.right <= layout.badge.left, width + ': deadline precedes the project picker without overlapping the title');
      assert.ok(Math.abs(layout.title.centerY - layout.badge.centerY) <= 1, width + ': title and project badge share one line');
      assert.ok(Math.abs(layout.title.centerY - layout.deadline.centerY) <= 1, width + ': deadline icon stays on the same line');
      assert.equal(layout.actions.length, 2, 'edit and delete actions remain available');
      assert.ok(layout.actions[0].right <= layout.actions[1].left, width + ': corner edit and delete buttons do not overlap');
      const controlCenters = [layout.deadline, layout.priority, layout.badge].map(control => control.left + control.width / 2);
      const controlGaps = controlCenters.slice(1).map((center, index) => center - controlCenters[index]);
      assert.ok(Math.max(...controlGaps) - Math.min(...controlGaps) <= 1, width + ': deadline, priority and project have uniform spacing');
      for (const action of layout.actions) assert.ok(action.width > 0 && action.height > 0 && action.right <= layout.row.right + 1 && action.centerY + action.height / 2 <= layout.badge.centerY - layout.badge.height / 2 + 1, width + ': corner actions sit above the inline metadata');
      const rows = await page.locator('.day-panel .task-row').evaluateAll(rows => rows.map(row => ({ height: row.getBoundingClientRect().height, pickerLeft: row.querySelector('.task-project-picker').getBoundingClientRect().left, editLeft: row.querySelector('button[aria-label^="编辑与改期 "]').getBoundingClientRect().left })));
      assert.ok(rows.every(item => Math.abs(item.height - layout.row.height) <= 1 && Math.abs(item.pickerLeft - layout.badge.left) <= 1 && Math.abs(item.editLeft - layout.actions[0].left) <= 1), width + ': every task remains one equal-height row with aligned project and edit controls');
      await page.mouse.move(0, 0); await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      await page.locator('.day-panel').screenshot({ path: path.join(output, `${width}x${height}-task-project-row.png`), animations: 'disabled' });
      const measured = await inspect(`${width}x${height}-task-counts-after-reload`);
      assert.ok(Math.abs(measured.cellHeight - baseline.get(width)) <= 1, 'task content does not change row heights at ' + width);
      checks.push(`${width}x${height}: three icon counts survive reload on one bottom-aligned row with consistent padding, hide titles and zeroes, exclude completed/deleted deadlines, and retain selected-day details`);
      checks.push(`${width}x${height}: titles truncate on one equal-height row; deadline icons, project initials/empty pickers and edit/delete controls stay ordered and aligned with full tooltips`);
    }
    await page.locator('.day[aria-label^="2027-05-15"]').click();
    const secondFolder = path.join(data, 'second-project'); await fs.mkdir(secondFolder);
    const secondProject = await call('projects.save', { name: '第二个快捷项目', description: '', directory: secondFolder });
    await page.getByRole('button', { name: '刷新日历', exact: true }).click();
    const task = fixtureTasks[0], row = page.locator(`.day-panel .task-row[data-task-id="${task.id}"]`);
    const fields = task => ({ title: task.title, notes: task.notes, date: task.date, dueDate: task.dueDate, completed: task.completed, deletedAt: task.deletedAt });
    async function chooseProject(task, name, id) {
      const row = page.locator(`.day-panel .task-row[data-task-id="${task.id}"]`);
      await row.locator('.task-project-picker').click();
      const menu = page.getByRole('menu');
      await menu.getByRole('menuitem', { name, exact: true }).click();
      await menu.waitFor({ state: 'hidden' });
      await row.getByRole('button', { name: `关联项目 ${task.title}：${id ? name : '空'}`, exact: true }).waitFor();
      const saved = (await call('state.get', {})).tasks.find(item => item.id === task.id);
      assert.equal(saved.projectId, id); assert.deepEqual(fields(saved), fields(task), 'quick reassignment preserves all non-project task fields');
      assert.equal(await page.locator('.calendar').isVisible(), true, 'quick reassignment stays on Home');
      return saved;
    }
    const reassigned = await chooseProject(task, secondProject.name, secondProject.id);
    assert.equal(reassigned.version, task.version + 1, 'quick reassignment saves once with the current task version');
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await month(2027, 5); await page.locator('.day[aria-label^="2027-05-15"]').click();
    await row.getByRole('button', { name: `关联项目 ${longTitle}：${secondProject.name}`, exact: true }).waitFor();
    const cleared = await chooseProject(task, '空', null);
    assert.equal(cleared.version, reassigned.version + 1, 'clearing project saves once');
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await month(2027, 5); await page.locator('.day[aria-label^="2027-05-15"]').click();
    assert.equal(await row.locator('.task-project-picker').textContent(), '空');
    assert.deepEqual(fields((await call('state.get', {})).tasks.find(item => item.id === task.id)), fields(task));
    const completedTask = (await call('state.get', {})).tasks.find(item => item.title === '同日完成记录 1');
    const completedReassigned = await chooseProject(completedTask, projectName, project.id);
    assert.equal(completedReassigned.completed, true, 'reassigning a completed record does not reopen it');
    assert.equal(completedReassigned.version, completedTask.version + 1);
    checks.push('project picker changes and clears association inline, persists both across reload, and preserves title/notes/date/deadline/pending or completed status with one guarded save per action');
    for (let i = 8; i <= 30; i++) await call('tasks.save', { title: '列表独立滚动待办 ' + i, notes: '', date: '2027-05-15', projectId: null, completed: false });
    await page.getByRole('button', { name: '刷新日历', exact: true }).click();
    const column = page.locator('.workspace.home .conversation-column'), list = column.locator('.task-list'), input = column.getByRole('textbox', { name: '消息输入', exact: true });
    const panelLayout = () => column.evaluate(column => {
      const bounds = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      const list = column.querySelector('.task-list');
      return { viewport: innerHeight, header: bounds(column.querySelector('.day-heading')), list: bounds(list), add: bounds(column.querySelector('.task-add')), composer: bounds(column.querySelector('.composer')), input: bounds(column.querySelector('textarea')), scrollTop: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, outerScroll: [scrollY, document.querySelector('.workspace').scrollTop, column.querySelector('.daily-wrapper').scrollTop] };
    });
    const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
    function fixedPanel(before, after, label) {
      for (const part of ['header', 'add', 'composer']) {
        near(after[part].top, before[part].top, label + ': fixed ' + part + ' top');
        near(after[part].bottom, before[part].bottom, label + ': fixed ' + part + ' bottom');
      }
      assert.deepEqual(after.outerScroll, before.outerScroll, label + ': task scrolling does not move outer containers');
    }
    function boundedPanel(layout, label) {
      const gap = layout.composer.top - layout.add.bottom;
      assert.ok(gap >= 20 && gap <= 40, label + ': add footer stays close to the composer, got ' + gap);
      assert.ok(layout.add.top >= layout.list.bottom - 1 && layout.add.top - layout.list.bottom <= 8 && layout.add.height >= 28, label + ': list extends to the fixed add footer without a large gap');
      assert.ok(layout.list.height > 40 && layout.header.bottom <= layout.list.top + 1, label + ': list has bounded space below the header');
      assert.ok(layout.header.top >= 49 && layout.composer.bottom <= layout.viewport + 1, label + ': header and composer remain reachable in the viewport');
    }
    for (const [width, height] of [[1500, 980], [1100, 620], [900, 700], [660, 620]]) {
      await resize(width, height); await month(2027, 5);
      await page.locator('.day[aria-label^="2027-05-15"]').click();
      await input.fill(''); await column.scrollIntoViewIfNeeded(); await settle();
      await list.evaluate(element => { element.scrollTop = 0; }); await settle();
      const label = `${width}x${height}-home-task-scroll`, before = await panelLayout();
      assert.equal(await list.locator('.task-row').count(), 30, label + ': all fixture tasks are present');
      assert.ok(before.scrollHeight > before.clientHeight + 100, label + ': only the task list has overflowing content');
      boundedPanel(before, label);
      await page.mouse.move((before.list.left + before.list.right) / 2, (before.list.top + before.list.bottom) / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelector('.day-panel .task-list').scrollTop > 0);
      await settle(); fixedPanel(before, await panelLayout(), label);
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; }); await settle();
      const lastRow = await list.locator('.task-row').last().boundingBox(), end = await panelLayout();
      assert.ok(lastRow.y >= end.list.top - 1 && lastRow.y + lastRow.height <= end.list.bottom + 1, label + ': final task is fully reachable');
      await page.mouse.wheel(0, 400); await page.waitForTimeout(100); await settle();
      fixedPanel(before, await panelLayout(), label + ' at end');
      await input.fill('第一行\n第二行\n第三行\n第四行\n第五行\n第六行');
      await page.waitForFunction(original => document.querySelector('.composer textarea').getBoundingClientRect().height > original + 30, before.input.height);
      await settle();
      const expanded = await panelLayout();
      boundedPanel(expanded, label + ' with six-line draft');
      near(expanded.header.top, before.header.top, label + ': typing does not move the date/weather header');
      near(expanded.composer.bottom, before.composer.bottom, label + ': growing composer stays anchored');
      assert.ok(expanded.list.height < before.list.height - 30 && expanded.scrollHeight > expanded.clientHeight, label + ': taller draft reduces the scrollable list instead of pushing it out');
      near(expanded.composer.top - expanded.add.bottom, before.composer.top - before.add.bottom, label + ': composer gap stays uniform');
      near(expanded.add.top - expanded.list.bottom, before.add.top - before.list.bottom, label + ': list-to-add gap stays uniform');
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; }); await settle();
      const finalBounds = await list.locator('.task-row').last().boundingBox();
      assert.ok(finalBounds.y >= expanded.list.top - 1 && finalBounds.y + finalBounds.height <= expanded.list.bottom + 1, label + ': final task remains reachable with a tall draft');
      await page.mouse.move(0, 0);
      await column.screenshot({ path: path.join(output, label + '.png'), animations: 'disabled' });
      await page.locator('.day[aria-label^="2027-05-16"]').click();
      await column.scrollIntoViewIfNeeded(); await settle();
      assert.equal(await list.locator('.task-row').count(), 0, label + ': switching to an empty date clears the list');
      assert.equal(await input.inputValue(), '第一行\n第二行\n第三行\n第四行\n第五行\n第六行', label + ': changing dates preserves the draft');
      boundedPanel(await panelLayout(), label + ' with empty date');
      await input.fill(''); await settle();
      boundedPanel(await panelLayout(), label + ' after clearing draft');
      checks.push(`${width}x${height}: only the 30-task list scrolls, header/weather, add footer and composer stay fixed, final task is reachable, compact gaps survive six-line drafts and empty-date changes`);
    }
    const deadlineTitle = '截止日独立标记：计划在另一月，完整内容仅在提示中展示';
    const dueTasks = [];
    for (const title of [deadlineTitle, '同日第二项截止']) dueTasks.push(await call('tasks.save', { title, notes: '', date: '2027-05-20', dueDate: '2026-10-01', projectId: null, completed: false }));
    await call('tasks.save', { title: '已完成不显示截止标记', notes: '', date: '2027-05-20', dueDate: '2026-10-01', projectId: null, completed: true, completedDate: '2027-05-20' });
    const deletedDue = await call('tasks.save', { title: '已删除不显示截止标记', notes: '', date: '2027-05-20', dueDate: '2026-10-01', projectId: null, completed: false });
    await call('tasks.delete', { id: deletedDue.id, expectedVersion: deletedDue.version });
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await month(2027, 5);
    const plannedDay = page.locator('.day[aria-label^="2027-05-20"]');
    assert.deepEqual(await plannedDay.locator('.day-tasks>span').allTextContents(), ['2', '1', '2'], 'deadline marker does not change planned-day or overdue counts');
    assert.equal(await plannedDay.locator('.deadline-mark').count(), 0, 'planned day does not substitute for the actual deadline');
    const deadlineDetails = `本日截止 2 项：${deadlineTitle}；同日第二项截止`;
    for (const [width, height] of [[1500, 980], [1100, 620], [971, 700], [660, 620]]) {
      await resize(width, height); await month(2026, 10);
      const cell = page.locator('.day[aria-label^="2026-10-01"]'), marker = cell.locator('.deadline-mark');
      assert.equal(await marker.count(), 1, 'same-day deadlines share one marker');
      assert.equal(await marker.getAttribute('aria-label'), '本日截止 2 项', 'completed and deleted tasks are excluded');
      assert.match(await cell.getAttribute('aria-label'), /2项待办本日截止/);
      assert.equal(await marker.locator('svg.lucide-calendar-clock').count(), 1);
      assert.equal(await cell.locator('.day-tasks>span').count(), 0, 'deadline cell does not duplicate planned tasks');
      assert.doesNotMatch(await cell.textContent(), /截止日独立标记|第二项截止/);
      await cell.scrollIntoViewIfNeeded();
      const geometry = await cell.evaluate(cell => {
        const bounds = selector => { const r = (selector ? cell.querySelector(selector) : cell).getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width }; };
        return { cell:bounds(), number:bounds('.day-number'), marker:bounds('.deadline-mark'), holidayBadge:bounds('.holiday-mark'), holiday:bounds('.holiday-kind') };
      });
      assert.ok(geometry.number.right <= geometry.marker.left && geometry.marker.right <= geometry.holiday.left, width + ': date, deadline icon and holiday do not overlap');
      assert.ok(geometry.holiday.left >= geometry.holidayBadge.left && geometry.holiday.right <= geometry.holidayBadge.right, width + ': holiday kind is not clipped by its badge');
      for (const item of [geometry.marker, geometry.holiday]) assert.ok(item.width > 0 && item.left >= geometry.cell.left && item.right <= geometry.cell.right && item.top >= geometry.cell.top && item.bottom <= geometry.cell.bottom, width + ': icon and holiday kind remain inside cell');
      await marker.hover(); await page.getByRole('tooltip').filter({ hasText:deadlineDetails }).waitFor();
      await page.mouse.move(0, 0); await cell.focus();
      await page.getByRole('tooltip').filter({ hasText:`2026-10-01 ·` }).filter({ hasText:deadlineDetails }).waitFor();
      await cell.evaluate(element => element.blur()); await page.getByRole('tooltip').waitFor({ state:'hidden' });
      await page.locator('.calendar').screenshot({ path:path.join(output, `${width}x${height}-deadline-marker.png`), animations:'disabled' });
      checks.push(`${width}x${height}: deadline icon fits beside date and holiday, full task names and count appear on hover/keyboard focus, no duplicate task counts`);
    }
    async function updateDeadline(task, change) {
      const saved = await call('tasks.save', { id:task.id, expectedVersion:task.version, title:task.title, notes:task.notes, date:task.date, dueDate:task.dueDate, projectId:task.projectId, completed:task.completed, ...change });
      await page.getByRole('button', { name:'刷新日历', exact:true }).click();
      return saved;
    }
    await updateDeadline(dueTasks[0], { completed:true });
    const oldMarker = page.locator('.day[aria-label^="2026-10-01"] .deadline-mark');
    await oldMarker.locator('svg').waitFor();
    assert.equal(await oldMarker.getAttribute('aria-label'), '本日截止 1 项', 'completion removes only that task from the marker');
    const rescheduled = await updateDeadline(dueTasks[1], { dueDate:'2027-01-01' });
    await oldMarker.waitFor({ state:'hidden' });
    await month(2026, 12);
    const nextYearMarker = page.locator('.day[aria-label^="2027-01-01"] .deadline-mark');
    await nextYearMarker.waitFor();
    assert.equal(await nextYearMarker.getAttribute('aria-label'), '本日截止 1 项', 'deadline updates across years and appears on adjacent-month cells');
    await page.reload(); await page.getByRole('navigation', { name:'全局导航' }).waitFor(); await month(2026, 12);
    await nextYearMarker.waitFor();
    const clearedDue = await updateDeadline(rescheduled, { dueDate:null });
    await nextYearMarker.waitFor({ state:'hidden' });
    const restoredDue = await updateDeadline(clearedDue, { dueDate:'2027-01-01' });
    await nextYearMarker.waitFor();
    await call('tasks.delete', { id:restoredDue.id, expectedVersion:restoredDue.version });
    await page.getByRole('button', { name:'刷新日历', exact:true }).click();
    await nextYearMarker.waitFor({ state:'hidden' });
    checks.push('deadline markers persist across reload, stay independent of planned dates, update on completion, move across months/years, and disappear when cleared or deleted');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, realElectron: true, executable: await app.evaluate(() => process.execPath), checks, measurements, dataDirectory: data, weatherAndHolidays: 'fixtures installed before main entry', personalData: false, modelRequests: 0 }, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
