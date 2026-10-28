async function selectDropdown(picker, value) {
  await picker.click();
  const listId = await picker.getAttribute('aria-controls');
  if (!listId) throw new Error('Missing open dropdown listbox');
  await picker.page().locator(`[id=${JSON.stringify(listId)}] [role="option"][value=${JSON.stringify(value)}]`).click();
}

const storedDropdownValue = picker => picker.evaluate(input => {
  const hidden = input.closest('.dropdown')?.nextElementSibling;
  if (!(hidden instanceof HTMLInputElement) || hidden.type !== 'hidden') throw new Error('Missing dropdown value input');
  return hidden.value;
});

module.exports = { selectDropdown, storedDropdownValue, selectModel: selectDropdown, storedModelValue: storedDropdownValue };
