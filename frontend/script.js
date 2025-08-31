document.addEventListener('DOMContentLoaded', () => {
  const pageSelector = document.getElementById('pageSelector');
  const savedFilterTabs = document.getElementById('savedFilterTabs');
  const tableHead = document.querySelector('#dataTable thead');
  const tableBody = document.querySelector('#dataTable tbody');
  const pagination = document.getElementById('pagination');
  const filterPanel = document.getElementById('filterPanel');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const filterPopoverModalEl = document.getElementById('filterPopoverModal');
  const filterPopoverForm = document.getElementById('filterPopoverForm');
  const filterPopoverTitle = document.getElementById('filterPopoverTitle');
  const filterPopoverApply = document.getElementById('filterPopoverApply');
  const filterPopoverModal = filterPopoverModalEl ? new bootstrap.Modal(filterPopoverModalEl) : null;
  let popoverContext = null;

  let currentSavedFilter = null;
  let userFilters = {};
  let paginationState = { page: 1, pageSize: 10 };

  function renderTabs(savedFilters) {
    savedFilterTabs.innerHTML = '';
    const allTab = document.createElement('li');
    allTab.className = 'nav-item';
    allTab.innerHTML = `<button class="nav-link ${currentSavedFilter ? '' : 'active'}" data-id="__all__">All</button>`;
    savedFilterTabs.appendChild(allTab);

    const maxInlineTabs = 4; // simple POC overflow
    const inline = savedFilters.slice(0, maxInlineTabs);
    const overflow = savedFilters.slice(maxInlineTabs);

    inline.forEach((sf) => {
      const li = document.createElement('li');
      li.className = 'nav-item';
      li.innerHTML = `<button class="nav-link ${currentSavedFilter === sf.identifier ? 'active' : ''}" data-id="${sf.identifier}">${sf.displayName}</button>`;
      savedFilterTabs.appendChild(li);
    });

    if (overflow.length > 0) {
      const dropdown = document.createElement('li');
      dropdown.className = 'nav-item dropdown';
      dropdown.innerHTML = `
        <button class="nav-link dropdown-toggle" data-bs-toggle="dropdown">More</button>
        <ul class="dropdown-menu">
          ${overflow.map((sf) => `<li><a class="dropdown-item" data-id="${sf.identifier}" href="#">${sf.displayName}</a></li>`).join('')}
        </ul>
      `;
      savedFilterTabs.appendChild(dropdown);

      dropdown.querySelectorAll('.dropdown-item').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          currentSavedFilter = a.getAttribute('data-id');
          fetchAndRender();
        });
      });
    }

    savedFilterTabs.querySelectorAll('button.nav-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        currentSavedFilter = id === '__all__' ? null : id;
        console.log('[TRIGGER] Tabs click -> fetch start', { savedFilter: currentSavedFilter });
        fetchAndRender('tabs_click');
      });
    });
  }

  function pickColumnWidthClass(key) {
    // Simple heuristic: longer keys get 200px, else 120px
    return key.length > 10 ? 'col-w-200' : 'col-w-120';
  }

  function renderTable(headers, data) {
    tableHead.innerHTML = '';
    tableBody.innerHTML = '';

    const tr = document.createElement('tr');
    headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h.displayName;
      th.classList.add(pickColumnWidthClass(h.key));
      tr.appendChild(th);
    });
    tableHead.appendChild(tr);

    data.forEach((row) => {
      const trb = document.createElement('tr');
      headers.forEach((h) => {
        const td = document.createElement('td');
        const value = row[h.key];
        td.textContent = value;
        td.title = value == null ? '' : String(value);
        td.classList.add(pickColumnWidthClass(h.key));
        trb.appendChild(td);
      });
      tableBody.appendChild(trb);
    });
  }

  function renderPagination(p) {
    pagination.innerHTML = '';
    const prev = document.createElement('li');
    prev.className = `page-item ${p.currentPage <= 1 ? 'disabled' : ''}`;
    prev.innerHTML = `<a class="page-link" href="#">Previous</a>`;
    prev.addEventListener('click', (e) => {
      e.preventDefault();
      if (p.currentPage > 1) {
        paginationState.page = p.currentPage - 1;
        console.log('[TRIGGER] Pagination prev -> fetch start', { toPage: paginationState.page });
        fetchAndRender('pagination_prev');
      }
    });
    pagination.appendChild(prev);

    const info = document.createElement('li');
    info.className = 'page-item disabled';
    info.innerHTML = `<span class="page-link">showing ${p.currentPage} of ${p.totalPages} pages</span>`;
    pagination.appendChild(info);

    const next = document.createElement('li');
    next.className = `page-item ${p.currentPage >= p.totalPages ? 'disabled' : ''}`;
    next.innerHTML = `<a class="page-link" href="#">Next</a>`;
    next.addEventListener('click', (e) => {
      e.preventDefault();
      if (p.currentPage < p.totalPages) {
        paginationState.page = p.currentPage + 1;
        console.log('[TRIGGER] Pagination next -> fetch start', { toPage: paginationState.page });
        fetchAndRender('pagination_next');
      }
    });
    pagination.appendChild(next);
  }

  function renderFilters(filterConfig, headers) {
    filterPanel.innerHTML = '';
    const headerMap = new Map((headers || []).map((h) => [h.key, h.displayName]));
    const savedDef = (window.__appliedSavedFilter && window.__appliedSavedFilter.filterDefinition) || {};
    filterConfig.forEach((fc) => {
      const group = document.createElement('div');
      group.className = 'mb-3';
      const title = document.createElement('div');
      title.className = 'fw-bold mb-1';
      title.textContent = headerMap.get(fc.columnName) || fc.columnName;
      group.appendChild(title);

      const chips = document.createElement('div');
      chips.className = 'd-flex flex-wrap gap-2';

      // Build a set of saved values for this column to suppress duplicates in quick/user chips
      const savedValuesSet = new Set();
      const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());

      // Saved filter chips (visual, non-interactive)
      if (savedDef[fc.columnName]) {
        const def = savedDef[fc.columnName];
        const values = Array.isArray(def.values) ? def.values : [];
        const modalityRaw = def.modality;
        const modalityStr = Array.isArray(modalityRaw) ? String(modalityRaw[0]) : String(modalityRaw || '');
        const modalityLower = modalityStr.toLowerCase();
        const showMod = modalityStr && !['exact', 'is'].includes(modalityLower);
        // Add value chips (e.g., LIST saved values)
        values.forEach((v) => {
          savedValuesSet.add(String(v));
          const savedBtn = document.createElement('button');
          savedBtn.type = 'button';
          savedBtn.className = 'btn btn-sm btn-danger';
          savedBtn.disabled = true;
          savedBtn.textContent = showMod ? `${titleCase(modalityStr)}: ${String(v)}` : String(v);
          chips.appendChild(savedBtn);
        });
        // Add modality-only chip (e.g., Is Empty / Is Not Empty), but skip trivial 'is'/'exact'
        if (!values.length && modalityStr && !['exact', 'is'].includes(modalityLower)) {
          const savedBtn = document.createElement('button');
          savedBtn.type = 'button';
          savedBtn.className = 'btn btn-sm btn-danger';
          savedBtn.disabled = true;
          savedBtn.textContent = titleCase(modalityStr);
          chips.appendChild(savedBtn);
        }
      }

      const current = userFilters[fc.columnName];
      const currentValues = current && Array.isArray(current.values) ? current.values : [];
      const isSelected = (val) => currentValues.some((v) => v === val);
      (fc.options || []).slice(0, 6).forEach((opt) => {
        // Suppress duplicate quick chip if value already represented by a saved chip
        if (savedValuesSet.has(String(opt))) return;
        const btn = document.createElement('button');
        const selected = isSelected(opt);
        btn.className = `btn btn-sm ${selected ? 'btn-secondary active' : 'btn-outline-secondary'}`;
        btn.textContent = String(opt);
        btn.addEventListener('click', async () => {
          btn.classList.add('chip-loading');
          const existing = userFilters[fc.columnName];
          const type = fc.filterType;
          // Toggle behaviour
          if (type === 'FREETEXT') {
            if (existing && Array.isArray(existing.values) && existing.values[0] === opt) {
              delete userFilters[fc.columnName];
            } else {
              userFilters[fc.columnName] = { type, values: [opt] };
            }
          } else {
            const values = existing && Array.isArray(existing.values) ? [...existing.values] : [];
            const idx = values.findIndex((v) => v === opt);
            if (idx >= 0) { values.splice(idx, 1); } else { values.push(opt); }
            if (values.length === 0) { delete userFilters[fc.columnName]; } else { userFilters[fc.columnName] = { type, values }; }
          }
          console.log('[TRIGGER] Filter chip toggle -> fetch start', { column: fc.columnName, value: opt, newState: userFilters[fc.columnName] });
          await fetchAndRender('filter_chip_toggle');
          btn.classList.remove('chip-loading');
        });
        chips.appendChild(btn);
      });

      // Chips for popover-applied selections (including empty/not-empty modalities)
      if (current) {
        const quick = new Set((fc.options || []).slice(0, 6).map(String));
        const modalityLower = (current.modality || '').toLowerCase();
        const modalityOnly = current.values && current.values.length === 0 && current.modality;
        if (modalityOnly) {
          const chip = document.createElement('button');
          chip.className = 'btn btn-sm btn-secondary';
          chip.textContent = titleCase(current.modality);
          chip.title = 'Click to remove';
          chip.addEventListener('click', async () => {
            delete userFilters[fc.columnName];
            await fetchAndRender('remove_popover_modality_chip');
          });
          chips.appendChild(chip);
        }
        (current.values || []).forEach((v) => {
          // Skip if already represented by saved selection or quick chip
          if (savedValuesSet.has(String(v)) || quick.has(String(v))) return;
          const chip = document.createElement('button');
          chip.className = 'btn btn-sm btn-secondary';
          const label = current.modality && !['exact', 'is'].includes(modalityLower) ? `${titleCase(current.modality)}: ${v}` : String(v);
          chip.textContent = label;
          chip.title = 'Click to remove';
          chip.addEventListener('click', async () => {
            const vals = (userFilters[fc.columnName]?.values || []).filter((x) => x !== v);
            if (vals.length === 0) delete userFilters[fc.columnName]; else userFilters[fc.columnName] = { ...userFilters[fc.columnName], values: vals };
            await fetchAndRender('remove_popover_value_chip');
          });
          chips.appendChild(chip);
        });
      }

      group.appendChild(chips);

      // More button for advanced filtering
      const moreBtn = document.createElement('button');
      moreBtn.className = 'btn btn-sm btn-outline-primary mt-2';
      moreBtn.textContent = 'More';
      moreBtn.addEventListener('click', () => openFilterPopover({
        columnName: fc.columnName,
        filterType: fc.filterType,
        header: headerMap.get(fc.columnName) || fc.columnName,
        options: fc.options || []
      }));
      group.appendChild(moreBtn);
      filterPanel.appendChild(group);
    });
  }

  function openFilterPopover(ctx) {
    if (!filterPopoverModal) return;
    popoverContext = ctx;
    filterPopoverTitle.textContent = `Filter: ${ctx.header}`;
    filterPopoverForm.innerHTML = '';
    const existing = userFilters[ctx.columnName] || { type: ctx.filterType, values: [] };
    if (ctx.filterType === 'FREETEXT') {
      const modality = document.createElement('select'); modality.setAttribute('data-role','modality');
      modality.className = 'form-select mb-2';
      ['Contains', 'Exact', 'Starts With', 'Is Empty', 'Is Not Empty'].forEach((m) => {
        const opt = document.createElement('option'); opt.value = m.toLowerCase(); opt.textContent = m; modality.appendChild(opt);
      });
      modality.value = existing.modality || 'contains';
      const input = document.createElement('input'); input.setAttribute('data-role','value1');
      input.className = 'form-control'; input.type = 'text'; input.value = existing.values && existing.values[0] ? existing.values[0] : '';
      const updateVisibility = () => {
        const m = modality.value;
        input.style.display = (m === 'is empty' || m === 'is not empty') ? 'none' : '';
      };
      modality.addEventListener('change', updateVisibility);
      updateVisibility();
      filterPopoverForm.appendChild(modality);
      filterPopoverForm.appendChild(input);
    } else if (ctx.filterType === 'NUMERIC') {
      const modality = document.createElement('select'); modality.setAttribute('data-role','modality');
      modality.className = 'form-select mb-2';
      ['Equals', 'Between', 'Greater Than', 'Less Than', 'Is Empty', 'Is Not Empty'].forEach((m) => { const opt = document.createElement('option'); opt.value = m.toLowerCase(); opt.textContent = m; modality.appendChild(opt); });
      modality.value = existing.modality || 'equals';
      const input1 = document.createElement('input'); input1.setAttribute('data-role','value1'); input1.type = 'number'; input1.className = 'form-control mb-2'; input1.value = existing.values && existing.values[0] != null ? existing.values[0] : '';
      const input2 = document.createElement('input'); input2.setAttribute('data-role','value2'); input2.type = 'number'; input2.className = 'form-control'; input2.value = existing.values && existing.values[1] != null ? existing.values[1] : '';
      const updateVisibility = () => {
        const m = modality.value;
        if (m === 'between') { input1.style.display = ''; input2.style.display = ''; }
        else if (m === 'is empty' || m === 'is not empty') { input1.style.display = 'none'; input2.style.display = 'none'; }
        else { input1.style.display = ''; input2.style.display = 'none'; }
      };
      modality.addEventListener('change', updateVisibility);
      updateVisibility();
      filterPopoverForm.appendChild(modality);
      filterPopoverForm.appendChild(input1);
      filterPopoverForm.appendChild(input2);
    } else if (ctx.filterType === 'DATE') {
      const modality = document.createElement('select'); modality.setAttribute('data-role','modality'); modality.className = 'form-select mb-2';
      ['On', 'Between', 'Before', 'After'].forEach((m) => { const opt = document.createElement('option'); opt.value = m.toLowerCase(); opt.textContent = m; modality.appendChild(opt); });
      modality.value = existing.modality || 'on';
      const input1 = document.createElement('input'); input1.setAttribute('data-role','value1'); input1.type = 'date'; input1.className = 'form-control mb-2'; input1.value = existing.values && existing.values[0] ? existing.values[0] : '';
      const input2 = document.createElement('input'); input2.setAttribute('data-role','value2'); input2.type = 'date'; input2.className = 'form-control'; input2.value = existing.values && existing.values[1] ? existing.values[1] : '';
      const updateVisibility = () => {
        const m = modality.value;
        if (m === 'between') { input1.style.display = ''; input2.style.display = ''; }
        else { input1.style.display = ''; input2.style.display = 'none'; }
      };
      modality.addEventListener('change', updateVisibility);
      updateVisibility();
      filterPopoverForm.appendChild(modality);
      filterPopoverForm.appendChild(input1);
      filterPopoverForm.appendChild(input2);
    } else if (ctx.filterType === 'LIST') {
      const modality = document.createElement('select'); modality.setAttribute('data-role','modality'); modality.className = 'form-select mb-2';
      ['Is', 'Contains', 'Exact', 'Starts With', 'Is Empty', 'Is Not Empty'].forEach((m) => { const opt = document.createElement('option'); opt.value = m.toLowerCase(); opt.textContent = m; modality.appendChild(opt); });
      modality.value = existing.modality || 'is';
      // Container to swap between select and input
      const valueContainer = document.createElement('div');
      const select = document.createElement('select'); select.setAttribute('data-role','valueSelect'); select.className = 'form-select';
      (ctx.options || []).forEach((o) => { const opt = document.createElement('option'); opt.value = String(o); opt.textContent = String(o); select.appendChild(opt); });
      if (existing.values && existing.values[0] != null) select.value = String(existing.values[0]);
      const input = document.createElement('input'); input.setAttribute('data-role','value1'); input.type = 'text'; input.className = 'form-control'; input.placeholder = 'Type value'; input.value = existing.values && existing.values[0] ? existing.values[0] : '';
      const updateVisibility = () => {
        const m = modality.value;
        if (m === 'is') { select.style.display = ''; input.style.display = 'none'; }
        else if (m === 'is empty' || m === 'is not empty') { select.style.display = 'none'; input.style.display = 'none'; }
        else { select.style.display = 'none'; input.style.display = ''; }
      };
      modality.addEventListener('change', updateVisibility);
      updateVisibility();
      valueContainer.appendChild(select);
      valueContainer.appendChild(input);
      filterPopoverForm.appendChild(modality);
      filterPopoverForm.appendChild(valueContainer);
    } else if (ctx.filterType === 'BOOLEAN') {
      const modality = document.createElement('select'); modality.setAttribute('data-role','modality'); modality.className = 'form-select mb-2';
      ['Is', 'Is Empty', 'Is Not Empty'].forEach((m) => { const opt = document.createElement('option'); opt.value = m.toLowerCase(); opt.textContent = m; modality.appendChild(opt); });
      modality.value = existing.modality || 'is';
      const select = document.createElement('select'); select.setAttribute('data-role','boolValue'); select.className = 'form-select';
      [{v:'true',t:'True'},{v:'false',t:'False'}].forEach((o)=>{const opt=document.createElement('option'); opt.value=o.v; opt.textContent=o.t; select.appendChild(opt);});
      if (existing.values && existing.values[0] != null) { select.value = String(!!existing.values[0]); }
      const updateVisibility = () => { const m = modality.value; select.style.display = (m === 'is') ? '' : 'none'; };
      modality.addEventListener('change', updateVisibility);
      updateVisibility();
      filterPopoverForm.appendChild(modality);
      filterPopoverForm.appendChild(select);
    }
    filterPopoverModal.show();
  }

  if (filterPopoverApply) {
    filterPopoverApply.addEventListener('click', async () => {
      if (!popoverContext) return;
      const { columnName, filterType } = popoverContext;
      const modalityEl = filterPopoverForm.querySelector('[data-role="modality"]');
      const value1El = filterPopoverForm.querySelector('[data-role="value1"]');
      const value2El = filterPopoverForm.querySelector('[data-role="value2"]');
      const boolEl = filterPopoverForm.querySelector('[data-role="boolValue"]');
      const valueSelectEl = filterPopoverForm.querySelector('[data-role="valueSelect"]');
      let modality = modalityEl ? modalityEl.value : undefined;
      let values = [];
      if (filterType === 'FREETEXT') {
        if (modality === 'is empty' || modality === 'is not empty') { values = []; }
        else { values = [value1El ? value1El.value : '']; }
      } else if (filterType === 'NUMERIC') {
        if (modality === 'between') { values = [value1El ? value1El.value : '', value2El ? value2El.value : '']; }
        else if (modality === 'is empty' || modality === 'is not empty') { values = []; }
        else { values = [value1El ? value1El.value : '']; }
      } else if (filterType === 'DATE') {
        if (modality === 'between') { values = [value1El ? value1El.value : '', value2El ? value2El.value : '']; }
        else { values = [value1El ? value1El.value : '']; }
      } else if (filterType === 'LIST') {
        if (modality === 'is') { values = [valueSelectEl ? valueSelectEl.value : '']; }
        else if (modality === 'is empty' || modality === 'is not empty') { values = []; }
        else { values = [value1El ? value1El.value : '']; }
      } else if (filterType === 'BOOLEAN') {
        if (modality === 'is empty' || modality === 'is not empty') { values = []; }
        else { values = [boolEl ? (boolEl.value === 'true') : null]; }
      }
      userFilters[columnName] = { type: filterType, modality, values };
      filterPopoverModal.hide();
      await fetchAndRender('filter_popover_apply');
    });
  }

  async function fetchAndRender(reason = 'unknown') {
    // Loading state
    console.log('[LOADING_START] disabling selector, showing spinner', { reason });
    pageSelector.disabled = true;
    if (loadingIndicator) loadingIndicator.style.visibility = 'visible';
    const payload = {
      pageIdentifier: pageSelector.value,
      savedFilterIdentifier: currentSavedFilter,
      userFilters,
      pagination: paginationState
    };
    try {
      console.log('[FETCH] POST /api/page-data', { reason, payload });
      const res = await fetch('/api/page-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log('[FETCH_OK] /api/page-data', { reason, received: { headers: (data.tableHeaders||[]).length, rows: (data.data||[]).length } });
      window.__appliedSavedFilter = data.appliedSavedFilter || null;
      renderTabs(data.savedFilters || []);
      renderFilters(data.filterConfig || [], data.tableHeaders || []);
      renderTable(data.tableHeaders || [], data.data || []);
      renderPagination(data.pagination || { currentPage: 1, totalPages: 1 });
    } catch (err) {
      console.error('[FETCH_ERR] /api/page-data', { reason, err });
    } finally {
      pageSelector.disabled = false;
      if (loadingIndicator) loadingIndicator.style.visibility = 'hidden';
      console.log('[LOADING_END] enabling selector, hiding spinner', { reason });
    }
  }

  pageSelector.addEventListener('change', () => {
    currentSavedFilter = null;
    userFilters = {};
    paginationState = { page: 1, pageSize: 10 };
    console.log('[TRIGGER] Page selector change -> fetch start', { page: pageSelector.value });
    fetchAndRender('page_selector_change');
  });

  console.log('[TRIGGER] Initial load -> fetch start');
  fetchAndRender('initial_load');
});


