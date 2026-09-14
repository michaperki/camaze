import { Tabulator, FormatModule, SortModule, FilterModule, SelectRowModule, DownloadModule, ExportModule, GroupRowsModule, ResizeTableModule, AccessorModule } from 'tabulator-tables';
import 'tabulator-tables/dist/css/tabulator.min.css';
import './entity-table.css';

Tabulator.registerModule([FormatModule, SortModule, FilterModule, SelectRowModule, DownloadModule, ExportModule, GroupRowsModule, ResizeTableModule, AccessorModule]);
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const text = value => { const el = document.createElement('span'); el.textContent = value ?? ''; return el; };
const csvValue = value => typeof value === 'string' && /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
const key = entity => JSON.stringify([entity.provider, entity.scope, entity.id]);

export function createEntityTable(mount, getState, persist) {
  let table, busy = false;
  mount.innerHTML = `<div class="entity-tools">
    <label>Search entities<input type="search" placeholder="Name, provider, department…" data-search></label>
    <label>Group by<select data-group><option value="">No grouping</option><option value="departmentName">Department</option><option value="provider">Provider</option></select></label>
    <button class="btn btn-sm" type="button" data-export>Export CSV</button>
  </div><div class="entity-bulk">
    <span data-count>0 selected</span><label>Department<select data-department></select></label>
    <button class="btn btn-sm" type="button" data-apply disabled>Assign selected</button>
    <button class="btn btn-sm" type="button" data-clear>Clear selection</button>
  </div><p role="status" aria-live="polite" data-status></p><div class="entity-grid" aria-label="Attribution entities"></div>`;
  const search = mount.querySelector('[data-search]');
  const department = mount.querySelector('[data-department]');
  const apply = mount.querySelector('[data-apply]');
  const status = mount.querySelector('[data-status]');
  function rows() {
    return getState().entities.map(e => ({ ...e, name: e.name || e.id, rowKey: key(e), departmentName: e.department.name, personName: e.person?.name || '', unassigned: e.department.id === null ? 1 : 0 }));
  }
  function options(select, values, current, empty) {
    select.replaceChildren(new Option(empty, ''), ...values.map(v => new Option(v.name, v.id)));
    select.value = current || '';
  }
  function counts() {
    const count = table.getSelectedRows().length;
    mount.querySelector('[data-count]').textContent = `${count} selected`;
    apply.disabled = busy || !count;
  }
  function setBusy(value) {
    busy = value;
    mount.querySelectorAll('select, input, button').forEach(el => { el.disabled = value; });
    counts();
  }
  async function save(row, departmentId, personId) {
    const e = row.getData();
    await persist(e, departmentId, personId);
    const fresh = rows().find(item => item.rowKey === e.rowKey);
    if (fresh) await row.update(fresh);
    row.reformat();
  }
  function assignmentSelect(cell, role) {
    const e = cell.getRow().getData();
    const select = document.createElement('select');
    select.className = 'row-select';
    select.setAttribute('aria-label', `${role === 'department' ? 'Department' : 'Owner'} for ${e.name || e.id}`);
    options(select, role === 'department' ? getState().departments : getState().people,
      role === 'department' ? e.department.id : e.person?.id, role === 'department' ? '— Unassigned —' : '— None —');
    select.addEventListener('click', event => event.stopPropagation());
    select.addEventListener('change', async () => {
      if (busy) return;
      const departmentId = role === 'department' ? select.value || null : e.department.id;
      const personId = role === 'person' ? select.value || null : e.person?.id || null;
      setBusy(true); status.textContent = 'Saving assignment…';
      try { await save(cell.getRow(), departmentId, personId); status.textContent = 'Assignment saved.'; }
      catch (error) { cell.getRow().reformat(); status.textContent = `Could not save: ${error.message}`; }
      finally { setBusy(false); }
    });
    return select;
  }
  table = new Tabulator(mount.querySelector('.entity-grid'), {
    index: 'rowKey', data: rows(), layout: 'fitColumns', height: 440,
    placeholder: 'No matching entities. Connect a provider to discover projects and keys.',
    selectableRows: true,
    groupHeader: (value, count) => text(`${value} (${count})`),
    downloadConfig: { rowGroups: false },
    columnDefaults: { accessorDownload: csvValue },
    initialSort: [{ column: 'amount_usd', dir: 'desc' }, { column: 'unassigned', dir: 'desc' }],
    rowFormatter(row) { row.getElement().classList.toggle('is-unassigned', row.getData().department.id === null); },
    columns: [
      { formatter: 'rowSelection', titleFormatter: 'rowSelection', titleFormatterParams: { rowRange: 'active' }, hozAlign: 'center', headerSort: false, width: 44, download: false },
      { title: 'Provider', field: 'provider', width: 105, formatter: cell => text(cell.getValue()) },
      { title: 'Entity', field: 'name', minWidth: 180, widthGrow: 2, formatter(cell) {
        const e = cell.getRow().getData(), el = document.createElement('div');
        const name = text(e.name || e.id), scope = document.createElement('small');
        scope.textContent = `${e.scope.replaceAll('_', ' ')}${e.department.id === null ? ' · Unassigned' : ''}`;
        el.append(name, scope); return el;
      } },
      { title: 'This month', field: 'amount_usd', sorter: 'number', hozAlign: 'right', width: 115, formatter: cell => text(money(cell.getValue())) },
      { title: 'Department', field: 'departmentName', minWidth: 160, formatter: cell => assignmentSelect(cell, 'department') },
      { title: 'Owner', field: 'personName', minWidth: 150, formatter: cell => assignmentSelect(cell, 'person') },
      { field: 'unassigned', visible: false, download: false },
    ],

  });
  table.on('rowSelectionChanged', counts);
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    table.setFilter(row => [row.name, row.id, row.provider, row.departmentName, row.personName].some(v => String(v || '').toLowerCase().includes(query)));
  });
  mount.querySelector('[data-group]').addEventListener('change', event => table.setGroupBy(event.target.value || false));
  mount.querySelector('[data-export]').addEventListener('click', () => table.download('csv', `camaze-assignments-${getState().month}.csv`, { bom: true }, 'active'));
  mount.querySelector('[data-clear]').addEventListener('click', () => table.deselectRow());
  apply.addEventListener('click', async () => {
    const selected = table.getSelectedRows(), departmentId = department.value || null;
    let saved = 0; const failures = [];
    setBusy(true);
    for (const row of selected) {
      status.textContent = `Saving ${saved + failures.length + 1} of ${selected.length}…`;
      try { await save(row, departmentId, row.getData().person?.id || null); row.deselect(); saved++; }
      catch (error) { failures.push(`${row.getData().name || row.getData().id}: ${error.message}`); }
    }
    setBusy(false);
    status.textContent = `${saved} assignment${saved === 1 ? '' : 's'} saved.${failures.length ? ' Failed rows remain selected. ' + failures.join('; ') : ''}`;
  });
  async function update() {
    options(department, getState().departments, department.value, '— Unassigned (owner fallback applies) —');
    await table.replaceData(rows());
    counts();
  }
  options(department, getState().departments, null, '— Unassigned (owner fallback applies) —');
  return { update, destroy: () => table.destroy() };
}
