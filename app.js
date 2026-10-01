const state = { page: 1, category: 0, search: '', brand: '', size: '', color: '', totalPages: 1, order: new Map(), products: [], activeProduct: null };
const $ = (selector) => document.querySelector(selector);
const apiUrl = (params) => `/api/products?${new URLSearchParams(params)}`;
let filterIndexPromise;
let attributeFilterRequestId = 0;
let productsRequestId = 0;

function cleanText(value = '') {
  const node = document.createElement('div');
  node.innerHTML = value;
  return node.textContent.trim();
}

async function loadCategories() {
  const response = await fetch('/api/products?resource=categories');
  if (!response.ok) throw new Error('No se pudieron cargar las categorías');
  const categories = await response.json();
  const list = $('#category-list');
  list.innerHTML = '<button class="category-button active" data-category="0">Todo</button>';
  categories.filter((category) => category.count > 0).forEach((category) => {
    const button = document.createElement('button');
    button.className = 'category-button';
    button.dataset.category = category.id;
    button.textContent = category.name;
    list.append(button);
  });
}

function renderProducts(products) {
  const grid = $('#product-grid');
  grid.innerHTML = '';
  $('#status').className = 'status';
  if (!products.length) {
    $('#status').textContent = 'No encontramos productos con esa búsqueda.';
    $('#status').hidden = false;
    return;
  }
  $('#status').hidden = true;
  products.forEach((product) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    const stockText = product.stock_quantity !== null && product.stock_quantity !== undefined
      ? `${product.stock_quantity} disponibles`
      : product.is_in_stock ? 'Disponible' : 'Sin stock';
    card.innerHTML = `<a class="product-card-link" href="#producto-${product.id}"><span class="product-image">${product.images?.[0]?.src ? `<img src="${product.images[0].src}" alt="${product.name}" loading="lazy">` : ''}</span><span class="product-info"><span class="product-name">${product.name}</span><span class="product-code">${product.sku ? `SKU ${product.sku}` : 'Sin SKU'}</span><span class="stock ${product.is_in_stock ? '' : 'out'}">${stockText}</span><span class="button button-dark select-options">Seleccionar opciones</span></span></a>`;
    card.querySelector('.product-card-link').addEventListener('click', (event) => {
      event.preventDefault();
      openOptions(product);
    });
    grid.append(card);
  });
}

function renderPagination() {
  const pagination = $('#pagination');
  pagination.innerHTML = '';
  if (state.totalPages <= 1) return;
  const addButton = (label, page, disabled = false, className = '') => {
    const button = document.createElement('button');
    button.className = `page-button ${className}${page === state.page ? ' active' : ''}`;
    button.textContent = label;
    button.disabled = disabled;
    if (!disabled) {
      button.addEventListener('click', () => {
        state.page = page;
        loadProducts();
        window.scrollTo({ top: $('#catalogo').offsetTop - 30, behavior: 'smooth' });
      });
    }
    pagination.append(button);
  };
  const addEllipsis = () => {
    const ellipsis = document.createElement('span');
    ellipsis.className = 'pagination-ellipsis';
    ellipsis.textContent = '…';
    pagination.append(ellipsis);
  };

  addButton('‹', Math.max(1, state.page - 1), state.page === 1, 'page-arrow');
  const pages = [];
  for (let page = 1; page <= Math.min(3, state.totalPages); page += 1) pages.push(page);
  for (let page = Math.max(4, state.page - 1); page <= Math.min(state.totalPages - 3, state.page + 1); page += 1) {
    if (!pages.includes(page)) pages.push(page);
  }
  for (let page = Math.max(1, state.totalPages - 2); page <= state.totalPages; page += 1) {
    if (!pages.includes(page)) pages.push(page);
  }
  pages.sort((a, b) => a - b).forEach((page, index) => {
    if (index > 0 && page > pages[index - 1] + 1) addEllipsis();
    addButton(String(page), page);
  });
  addButton('›', Math.min(state.totalPages, state.page + 1), state.page === state.totalPages, 'page-arrow');
}

async function loadProducts() {
  const requestId = ++productsRequestId;
  updateAttributeFilters();
  $('#status').textContent = 'Cargando catálogo...';
  $('#status').hidden = false;
  const params = { page: state.page, per_page: 16 };
  if (state.category) params.category = state.category;
  if (state.search) params.search = state.search;
  if (state.brand) params.brand = state.brand;
  if (state.size) params.size = state.size;
  if (state.color) params.color = state.color;
  try {
    const response = await fetch(apiUrl(params));
    if (!response.ok) throw new Error(`Error al consultar el catálogo (HTTP ${response.status})`);
    const products = await response.json();
    if (requestId !== productsRequestId) return;
    state.products = products;
    state.totalPages = Number(response.headers.get('X-WP-TotalPages')) || 1;
    $('#result-count').textContent = `${response.headers.get('X-WP-Total') || products.length} productos`;
    renderProducts(products.filter((product) => product.is_in_stock));
    renderPagination();
  } catch (error) {
    if (requestId !== productsRequestId) return;
    $('#status').textContent = 'No se pudo cargar el catálogo. Intentá nuevamente en unos minutos.';
    $('#status').className = 'status error';
  }
}

function updateOrder(product, rawQuantity, options = '', variationId = '') {
  const requested = Math.max(1, Number.parseInt(rawQuantity, 10) || 1);
  const quantity = product.stock_quantity !== null && product.stock_quantity !== undefined
    ? Math.min(requested, product.stock_quantity) : requested;
  const key = `${product.id}:${variationId || options}`;
  if (quantity) state.order.set(key, { key, product, quantity, options, variationId, stock: product.variations.find((variation) => String(variation.id) === String(variationId))?.stock_quantity ?? null });
  else state.order.delete(key);
  renderOrder();
}

async function updateAttributeFilters() {
  const requestId = ++attributeFilterRequestId;
  $('#filter-status span').textContent = 'Cargando opciones de filtros...';
  $('#retry-filters').hidden = true;
  $('#filter-status').hidden = false;
  try {
    if (!filterIndexPromise) {
      filterIndexPromise = fetch('./filter-index.json')
        .then((response) => {
          if (!response.ok) throw new Error(`No se pudo cargar el índice de filtros (HTTP ${response.status})`);
          return response.json();
        })
        .catch((error) => {
          filterIndexPromise = undefined;
          throw error;
        });
    }
    const index = await filterIndexPromise;
    if (requestId !== attributeFilterRequestId) return;
    renderAttributeFilters(index);
    $('#filter-status').hidden = true;
  } catch (error) {
    if (requestId !== attributeFilterRequestId) return;
    console.error('No se pudieron cargar los filtros de producto', error);
    $('#filter-status span').textContent = 'No se pudieron actualizar los filtros. Podés volver a intentarlo.';
    $('#retry-filters').hidden = false;
    $('#filter-status').hidden = false;
  }
}

function renderAttributeFilters(index) {
  const products = index.products || [];
  const filters = [
    { id: 'brand-filter', name: 'Marca', key: 'brand', selected: state.brand },
    { id: 'size-filter', name: 'Talle', key: 'size', selected: state.size },
    { id: 'color-filter', name: 'Color', key: 'color', selected: state.color },
  ];
  filters.forEach(({ id, name, key, selected }) => {
    const select = $(`#${id}`);
    const selectedLabel = [...select.options].find((option) => option.value === selected)?.textContent;
    const values = new Map();
    const matchingProducts = products.filter((product) =>
      (!state.category || product.categories.includes(state.category))
      && (!state.search || product.search.includes(state.search.trim().toLocaleLowerCase('es')))
      && filters.every((filter) => filter.key === key || !filter.selected
        || product.attributes[filter.key]?.includes(filter.selected)));
    matchingProducts.forEach((product) => {
      (product.attributes[key] || []).forEach((slug) => values.set(slug, index.terms[key][slug] || slug));
    });
    if (selected && !values.has(selected)) values.set(selected, selectedLabel || selected);
    select.innerHTML = `<option value="">${name === 'Marca' ? 'Todas las marcas' : name === 'Talle' ? 'Todos los talles' : 'Todos los colores'}</option>${[...values].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([slug, label]) => `<option value="${slug}">${label}</option>`).join('')}`;
    select.value = selected;
  });
}

async function openOptions(product) {
  state.activeProduct = product;
  if (product.variations_loaded === false) {
    $('#options-content').innerHTML = '<div class="dialog-copy"><p class="eyebrow">Cargando</p><h2>Buscando opciones disponibles…</h2></div>';
    if (!$('#options-dialog').open) $('#options-dialog').showModal();
    try {
      const response = await fetch(apiUrl({ resource: 'variations', product_id: product.id }));
      if (!response.ok) throw new Error(`Error al cargar las opciones (HTTP ${response.status})`);
      const variations = await response.json();
      if (!variations.length) throw new Error('No se encontraron opciones disponibles para este producto');
      if (state.activeProduct !== product) return;
      product.variations = variations;
      product.variations_loaded = true;
    } catch (error) {
      console.error('No se pudieron cargar las opciones del producto', error);
      if (state.activeProduct !== product) return;
      $('#options-content').innerHTML = '<div class="dialog-copy"><p class="eyebrow">No disponible</p><h2>No se pudieron cargar las opciones.</h2><p>Revisá tu conexión e intentá nuevamente.</p><button class="button button-dark" id="retry-options" type="button">Reintentar</button></div>';
      $('#retry-options').addEventListener('click', () => openOptions(product));
      return;
    }
  }
  const availableVariations = product.variations.filter((variation) => variation.is_in_stock === true);
  const optionValues = new Map();
  availableVariations.forEach((variation) => variation.attributes.forEach((attribute) => {
    const name = normalizeName(attribute.name);
    if (!['talle', 'color'].includes(name)) return;
    if (!optionValues.has(name)) optionValues.set(name, new Map());
    optionValues.get(name).set(normalizeValue(attribute.value), attribute.value);
  }));
  const attributes = ['talle', 'color']
    .filter((name) => optionValues.has(name))
    .map((name) => ({
      name,
      terms: [...optionValues.get(name)].map(([slug, label]) => ({ slug, name: label })),
    }));
  const gallery = product.images?.length
    ? `<div class="product-gallery"><div class="gallery-main"><img id="gallery-image" src="${product.images[0].src}" alt="${product.name}"></div><div class="gallery-thumbs">${product.images.map((image, index) => `<button type="button" class="gallery-thumb${index === 0 ? ' active' : ''}" data-image="${image.src}"><img src="${image.thumbnail || image.src}" alt=""></button>`).join('')}</div></div>`
    : '';
  const selectors = attributes.map((attribute) => `<label>${attribute.name}<select data-option="${normalizeName(attribute.name)}">${attribute.terms.map((term) => `<option value="${normalizeValue(term.slug || term.name)}">${term.name}</option>`).join('')}</select></label>`).join('');
  $('#options-content').innerHTML = `${gallery}<div class="dialog-copy"><p class="eyebrow">Seleccionar opción</p><h2>${product.name}</h2><p>${product.sku ? `SKU: ${product.sku}` : ''}</p><div class="option-fields">${selectors}</div><p id="variation-availability" class="stock"></p><div class="quantity-control"><label for="option-quantity">Cantidad</label><div class="quantity-stepper"><button id="quantity-decrease" type="button" aria-label="Disminuir cantidad"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg></button><input id="option-quantity" type="number" min="1" value="1" step="1" inputmode="numeric"><button id="quantity-increase" type="button" aria-label="Aumentar cantidad"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg></button></div></div><button class="button button-dark add-option" id="add-option" type="button">Agregar a la lista</button></div>`;
  document.querySelectorAll('.gallery-thumb').forEach((button) => button.addEventListener('click', () => {
    $('#gallery-image').src = button.dataset.image;
    document.querySelectorAll('.gallery-thumb').forEach((item) => item.classList.toggle('active', item === button));
  }));
  const optionSets = new Map([...document.querySelectorAll('[data-option]')].map((select) => [
    select.dataset.option,
    [...select.options].map((option) => ({ value: normalizeValue(option.value), label: option.textContent })),
  ]));
  const refresh = () => {
    const hasVariations = product.variations.length > 0;
    let selected = Object.fromEntries([...document.querySelectorAll('[data-option]')].map((select) => [select.dataset.option, normalizeValue(select.value)]));
    for (let pass = 0; pass < 2; pass += 1) {
      document.querySelectorAll('[data-option]').forEach((select) => {
        const optionName = select.dataset.option;
        const otherSelections = { ...selected };
        delete otherSelections[optionName];
        const availableOptions = (optionSets.get(optionName) || []).filter((option) => {
          const candidate = { ...otherSelections, [optionName]: option.value };
          return !hasVariations || product.variations.some((item) => item.is_in_stock === true
            && item.attributes.every((attribute) => candidate[normalizeName(attribute.name)] === normalizeValue(attribute.value)));
        });
        const currentValue = selected[optionName];
        select.innerHTML = availableOptions.map((option) => `<option value="${option.value}">${option.label}</option>`).join('');
        if (availableOptions.some((option) => option.value === currentValue)) {
          select.value = currentValue;
        } else if (availableOptions[0]) {
          select.value = availableOptions[0].value;
        }
        selected[optionName] = normalizeValue(select.value);
      });
    }
    const variation = product.variations.find((item) => item.attributes.every((attribute) => selected[normalizeName(attribute.name)] === normalizeValue(attribute.value)));
    const available = hasVariations
      ? Boolean(variation) && variation.is_in_stock === true
      : product.is_in_stock;
    const stock = variation?.stock_quantity ?? product.stock_quantity ?? null;
    $('#variation-availability').textContent = available ? (stock === null ? 'Disponible' : `${stock} disponibles`) : 'Sin stock para esta opción';
    $('#variation-availability').className = `stock ${available ? '' : 'out'}`;
    const quantityInput = $('#option-quantity');
    quantityInput.disabled = !available;
    quantityInput.max = stock === null ? '' : stock;
    setOptionQuantity(quantityInput.value, stock, available);
    $('#add-option').disabled = !available;
    return { selected, variation, available, stock };
  };
  document.querySelectorAll('[data-option]').forEach((select) => select.addEventListener('change', refresh));
  $('#quantity-decrease').addEventListener('click', () => {
    const result = refresh();
    setOptionQuantity(Number($('#option-quantity').value) - 1, result.stock, result.available);
  });
  $('#quantity-increase').addEventListener('click', () => {
    const result = refresh();
    setOptionQuantity(Number($('#option-quantity').value) + 1, result.stock, result.available);
  });
  $('#option-quantity').addEventListener('input', () => {
    const result = refresh();
    setOptionQuantity($('#option-quantity').value, result.stock, result.available);
  });
  $('#add-option').addEventListener('click', () => {
    const result = refresh();
    const quantity = Number.parseInt($('#option-quantity').value, 10) || 1;
    if (!result.available) return;
    const options = Object.entries(result.selected).map(([name, value]) => {
      const select = document.querySelector(`[data-option="${name}"]`);
      return `${name}: ${select?.options[select.selectedIndex]?.text || value}`;
    }).join(' · ');
    updateOrder(product, result.stock === null ? quantity : Math.min(quantity, result.stock), options, result.variation?.id || '');
    $('#options-dialog').close();
    showToast('Producto agregado correctamente a la lista de pedidos');
  });
  refresh();
  $('#options-dialog').showModal();
}

function setOptionQuantity(value, stock, available) {
  const input = $('#option-quantity');
  const parsed = Number.parseInt(value, 10);
  const requested = Number.isFinite(parsed) ? parsed : 1;
  const maximum = stock === null ? Number.POSITIVE_INFINITY : Math.max(1, stock);
  const quantity = Math.min(maximum, Math.max(1, requested));
  input.value = String(quantity);
  $('#quantity-decrease').disabled = !available || quantity <= 1;
  $('#quantity-increase').disabled = !available || quantity >= maximum;
}

function normalizeName(value = '') {
  return value.replace(/^pa_/, '').replace(/[-_]/g, ' ').trim().toLowerCase();
}

function normalizeValue(value = '') {
  return value.toString().trim().toLowerCase().replace(/\s+/g, '-');
}

function renderOrder() {
  const items = [...state.order.values()];
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  $('#order-count').textContent = `${count} ${count === 1 ? 'producto seleccionado' : 'productos seleccionados'}`;
  $('#order-badge').textContent = String(count);
  $('#order-badge').hidden = count === 0;
  $('#order-list-button').setAttribute('aria-label', `Ver lista de pedido, ${count} ${count === 1 ? 'producto' : 'productos'}`);
  $('#order-items').innerHTML = items.map(({ key, product, quantity, options, stock }) => `<div class="order-item order-page-item"><div class="order-item-info"><span>${product.name}</span>${product.sku ? `<small>SKU: ${product.sku}</small>` : ''}${options ? `<small>${options}</small>` : ''}<small class="order-stock">${stock === null ? 'Stock disponible' : `${stock} disponibles`}</small></div><div class="order-item-controls"><button type="button" aria-label="Disminuir cantidad" data-decrease-key="${key}">−</button><strong>${quantity}</strong><button type="button" aria-label="Aumentar cantidad" data-increase-key="${key}" ${stock !== null && quantity >= stock ? 'disabled' : ''}>+</button><button type="button" class="remove-order" aria-label="Quitar ${product.name}" data-remove-key="${key}">Eliminar</button></div></div>`).join('');
  $('#empty-order').hidden = items.length > 0;
}

function showToast(message) {
  $('#toast-message').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000);
}

function showView(view) {
  document.querySelectorAll('.app-view').forEach((item) => { item.hidden = item.id !== view; });
  window.location.hash = view;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function printOrder() {
  if (!state.order.size) {
    window.alert('Seleccioná al menos un producto para generar el PDF.');
    return;
  }

  const jspdf = window.jspdf;
  if (!jspdf?.jsPDF) {
    window.alert('No se pudo preparar el PDF. Revisá tu conexión e intentá nuevamente.');
    return;
  }
  const doc = new jspdf.jsPDF();
  const items = [...state.order.values()];
  let y = 22;
  doc.setFontSize(18);
  doc.text('Lista de pedido', 15, y);
  y += 12;
  doc.setFontSize(10);
  items.forEach(({ product, quantity, options }) => {
    const lines = doc.splitTextToSize(`${product.name}${product.sku ? ` | SKU: ${product.sku}` : ''}${options ? ` | ${options}` : ''} | Cantidad: ${quantity}`, 180);
    if (y + lines.length * 6 > 280) {
      doc.addPage();
      y = 20;
    }
    doc.text(lines, 15, y);
    y += lines.length * 6 + 4;
  });
  doc.save(`lista-pedido-${new Date().toISOString().slice(0, 10)}.pdf`);
}

$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.search = $('#search').value.trim();
  state.page = 1;
  loadProducts();
});
$('#search').addEventListener('input', () => {
  $('#search-clear').hidden = !$('#search').value;
});
$('#search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#search-form').requestSubmit();
});
$('#search-clear').addEventListener('click', () => {
  $('#search').value = '';
  $('#search-clear').hidden = true;
  state.search = '';
  state.page = 1;
  loadProducts();
  $('#search').focus();
});
$('#retry-filters').addEventListener('click', () => {
  updateAttributeFilters();
});
[['brand-filter', 'brand'], ['size-filter', 'size'], ['color-filter', 'color']].forEach(([id, key]) => $(`#${id}`).addEventListener('change', (event) => {
  state[key] = event.target.value;
  state.page = 1;
  loadProducts();
}));
$('#category-list').addEventListener('click', (event) => {
  if (!event.target.matches('.category-button')) return;
  state.category = Number(event.target.dataset.category);
  state.brand = '';
  state.size = '';
  state.color = '';
  $('#brand-filter').value = '';
  $('#size-filter').value = '';
  $('#color-filter').value = '';
  state.page = 1;
  document.querySelectorAll('.category-button').forEach((button) => button.classList.toggle('active', button === event.target));
  loadProducts();
});
$('#order-items').addEventListener('click', (event) => {
  const key = event.target.dataset.removeKey;
  if (key) { state.order.delete(key); renderOrder(); return; }
  const increaseKey = event.target.dataset.increaseKey;
  const decreaseKey = event.target.dataset.decreaseKey;
  const itemKey = increaseKey || decreaseKey;
  if (itemKey && state.order.has(itemKey)) {
    const item = state.order.get(itemKey);
    const nextQuantity = increaseKey ? item.quantity + 1 : item.quantity - 1;
    if (nextQuantity > 0 && (item.stock === null || nextQuantity <= item.stock)) item.quantity = nextQuantity;
    else if (nextQuantity <= 0) state.order.delete(itemKey);
    renderOrder();
  }
});
$('#print-order').addEventListener('click', printOrder);
$('#back-catalog').addEventListener('click', () => showView('catalogo'));
$('#order-list-button').addEventListener('click', () => showView('pedido'));
$('#toast-view-order').addEventListener('click', () => {
  $('#toast').classList.remove('visible');
  showView('pedido');
});
$('#dialog-close').addEventListener('click', () => $('#options-dialog').close());

loadCategories().catch(() => {
  console.error('No se pudieron cargar las categorías');
  $('#category-list').innerHTML = '<button class="category-button active" data-category="0">Todo</button>';
});
loadProducts();
renderOrder();
