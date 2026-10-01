const STORE_API = 'https://isabellamayorista.com.ar/wp-json/wc/store/v1';
const WC_API = 'https://isabellamayorista.com.ar/wp-json/wc/v3';
const CACHE_TTL = 5 * 60 * 1000;
const FILTER_CACHE_TTL = 60 * 60 * 1000;
const responseCache = new Map();
const variationCache = new Map();

export default async function handler(request, response) {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const requestedResource = url.searchParams.get('resource') || 'products';
  const resource = requestedResource === 'categories' ? 'products/categories' : 'products';
  const allowed = new URLSearchParams();
  ['page', 'per_page', 'search', 'category', 'orderby', 'order'].forEach((key) => {
    const value = url.searchParams.get(key);
    if (value) allowed.set(key, value);
  });
  allowed.set('stock_status', 'instock');
  if (resource === 'products/categories') allowed.set('per_page', '100');
  const consumerKey = process.env.WC_CONSUMER_KEY;
  const consumerSecret = process.env.WC_CONSUMER_SECRET;
  const useAuthenticatedApi = Boolean(consumerKey && consumerSecret);
  const apiBase = useAuthenticatedApi ? WC_API : STORE_API;
  const headers = useAuthenticatedApi
    ? { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}` }
    : {};
  const cacheKey = `${useAuthenticatedApi ? 'private' : 'public'}:${url.pathname}${url.search}`;
  const cachedResponse = responseCache.get(cacheKey);
  if (cachedResponse && cachedResponse.expiresAt > Date.now()) {
    response.setHeader('Cache-Control', requestedResource === 'filters'
      ? 's-maxage=3600, stale-while-revalidate=86400'
      : 's-maxage=300, stale-while-revalidate=600');
    Object.entries(cachedResponse.headers).forEach(([name, value]) => response.setHeader(name, value));
    response.status(200).json(cachedResponse.data);
    return;
  }
  if (requestedResource === 'variations') {
    const productId = url.searchParams.get('product_id') || '';
    if (!/^[1-9]\d*$/.test(productId)) {
      response.status(400).json({ error: 'El identificador del producto no es válido' });
      return;
    }
    if (!useAuthenticatedApi) {
      response.status(503).json({ error: 'No están disponibles las opciones de este producto' });
      return;
    }
    let variations;
    try {
      variations = await loadVariations(productId, headers);
    } catch (error) {
      console.error(`No se pudieron cargar las opciones del producto ${productId}`, error);
      response.status(502).json({ error: 'No se pudieron cargar las opciones de este producto' });
      return;
    }
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    responseCache.set(cacheKey, { data: variations, headers: {}, expiresAt: Date.now() + CACHE_TTL });
    response.status(200).json(variations);
    return;
  }
  if (requestedResource === 'filters') {
    try {
      const result = await loadScopedFilterOptions(url);
      response.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      responseCache.set(cacheKey, { data: result, headers: {}, expiresAt: Date.now() + FILTER_CACHE_TTL });
      response.status(200).json(result);
    } catch (error) {
      console.error('No se pudieron cargar los filtros para la selección actual', error);
      response.status(502).json({ error: 'No se pudieron cargar los filtros para la selección actual' });
    }
    return;
  }
  const selectedAttributes = [
    { key: 'brand', slug: 'pa_marca' },
    { key: 'size', slug: 'pa_talle' },
    { key: 'color', slug: 'pa_color' },
  ].filter(({ key }) => url.searchParams.get(key));
  if (selectedAttributes.length > 0) {
    const filteredParams = new URLSearchParams();
    ['page', 'per_page', 'search', 'category'].forEach((key) => {
      const value = url.searchParams.get(key);
      if (value) filteredParams.set(key, value);
    });
    filteredParams.set('stock_status', 'instock');
    filteredParams.set('attribute_relation', 'and');
    selectedAttributes.forEach(({ key, slug }, index) => {
      filteredParams.set(`attributes[${index}][attribute]`, slug);
      filteredParams.set(`attributes[${index}][slug]`, url.searchParams.get(key));
    });
    const filteredResponse = await fetch(`${STORE_API}/products?${filteredParams}`);
    if (!filteredResponse.ok) {
      response.status(filteredResponse.status).json({ error: 'No se pudieron filtrar los productos' });
      return;
    }
    const filteredProducts = await filteredResponse.json();
    const total = filteredResponse.headers.get('x-wp-total') || String(filteredProducts.length);
    const totalPages = filteredResponse.headers.get('x-wp-totalpages') || '1';
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    response.setHeader('x-wp-total', total);
    response.setHeader('x-wp-totalpages', totalPages);
    const products = await Promise.all(filteredProducts.map((product) => normalizeProduct(product, headers, false, useAuthenticatedApi)));
    responseCache.set(cacheKey, {
      data: products,
      headers: { 'x-wp-total': total, 'x-wp-totalpages': totalPages },
      expiresAt: Date.now() + CACHE_TTL,
    });
    response.status(200).json(products);
    return;
  }
  if (useAuthenticatedApi && resource === 'products') {
    const upstreamParams = new URLSearchParams(allowed);
    const requestedPage = Math.max(1, Number(allowed.get('page') || 1));
    const requestedPerPage = Math.min(100, Math.max(1, Number(allowed.get('per_page') || 16)));
    const search = allowed.get('search');
    if (search) {
      upstreamParams.set('page', '1');
      upstreamParams.set('per_page', '100');
    }
    const upstream = await fetch(`${WC_API}/products?${upstreamParams}`, { headers });
    if (!upstream.ok) {
      response.status(upstream.status).json({ error: 'No se pudo consultar el catálogo' });
      return;
    }
    const data = await upstream.json();
    const normalizedProducts = await Promise.all(data.map((product) => normalizeProduct(product, headers, true)));
    const availableProducts = normalizedProducts.filter((product) => product.is_in_stock);
    const total = search
      ? availableProducts.length
      : Number(upstream.headers.get('x-wp-total')) || availableProducts.length;
    const totalPages = search
      ? Math.max(1, Math.ceil(total / requestedPerPage))
      : Number(upstream.headers.get('x-wp-totalpages')) || 1;
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    response.setHeader('x-wp-total', String(total));
    response.setHeader('x-wp-totalpages', String(totalPages));
    const result = search
      ? availableProducts.slice((requestedPage - 1) * requestedPerPage, requestedPage * requestedPerPage)
      : availableProducts;
    responseCache.set(cacheKey, {
      data: result,
      headers: {
        'x-wp-total': String(total),
        'x-wp-totalpages': String(totalPages),
      },
      expiresAt: Date.now() + CACHE_TTL,
    });
    response.status(200).json(result);
    return;
  }
  const upstream = await fetch(`${apiBase}/${resource}?${allowed}`, { headers });
  if (!upstream.ok) {
    response.status(upstream.status).json({ error: 'No se pudo consultar WooCommerce' });
    return;
  }
  const data = await upstream.json();
  response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  ['x-wp-total', 'x-wp-totalpages'].forEach((header) => {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  });
  if (resource === 'products/categories') {
    response.status(200).json(data.filter(({ parent, count, product_count }) => parent === 0 && (count || product_count) > 0).slice(0, 4).map(({ id, name, count, product_count, parent }) => ({ id, name, count: count || product_count, parent })));
    return;
  }
  const products = await Promise.all(data.map((product) => normalizeProduct(product, headers, useAuthenticatedApi)));
  const headersToCache = {};
  ['x-wp-total', 'x-wp-totalpages'].forEach((header) => {
    const value = upstream.headers.get(header);
    if (value) headersToCache[header] = value;
  });
  responseCache.set(cacheKey, { data: products, headers: headersToCache, expiresAt: Date.now() + CACHE_TTL });
  response.status(200).json(products);
}

const FILTER_ATTRIBUTES = [
  { key: 'brand', slug: 'pa_marca', name: 'Marca' },
  { key: 'size', slug: 'pa_talle', name: 'Talle' },
  { key: 'color', slug: 'pa_color', name: 'Color' },
];

async function loadScopedFilterOptions(url) {
  const matchingProducts = new Map();
  const getMatchingProducts = async (excludedFilter) => {
    const params = new URLSearchParams({
      page: '1',
      per_page: '100',
      stock_status: 'instock',
    });
    ['category', 'search'].forEach((key) => {
      const value = url.searchParams.get(key);
      if (value) params.set(key, value);
    });
    const selectedAttributes = FILTER_ATTRIBUTES.filter(({ key }) =>
      key !== excludedFilter && url.searchParams.get(key));
    if (selectedAttributes.length > 0) {
      params.set('attribute_relation', 'and');
      selectedAttributes.forEach(({ key, slug }, index) => {
        params.set(`attributes[${index}][attribute]`, slug);
        params.set(`attributes[${index}][slug]`, url.searchParams.get(key));
      });
    }
    const cacheKey = params.toString();
    if (!matchingProducts.has(cacheKey)) {
      matchingProducts.set(cacheKey, fetchAllMatchingProducts(params));
    }
    return matchingProducts.get(cacheKey);
  };

  const attributes = await Promise.all(FILTER_ATTRIBUTES.map(async ({ key, name }) => {
    const products = await getMatchingProducts(key);
    const terms = new Map();
    products.forEach(({ attributes: productAttributes = [] }) => {
      productAttributes.forEach((attribute) => {
        if (getFilterAttributeKey(attribute) !== key) return;
        const values = attribute.terms?.length
          ? attribute.terms.map(({ name: termName, slug }) => ({ name: termName, slug }))
          : (attribute.options || []).map((option) => ({ name: option, slug: normalizeAttributeValue(option) }));
        values.forEach((term) => {
          if (term.slug) terms.set(term.slug, term);
        });
      });
    });
    return { name, terms: [...terms.values()] };
  }));

  return [{ attributes }];
}

async function fetchAllMatchingProducts(params) {
  const firstResponse = await fetch(`${STORE_API}/products?${params}`);
  if (!firstResponse.ok) throw new Error(`Error HTTP ${firstResponse.status} al consultar productos para los filtros`);
  const products = await firstResponse.json();
  const totalPages = Math.max(1, Number(firstResponse.headers.get('x-wp-totalpages')) || 1);
  if (totalPages === 1) return products;

  const pageResponses = await Promise.all(Array.from({ length: totalPages - 1 }, (_, index) => {
    const pageParams = new URLSearchParams(params);
    pageParams.set('page', String(index + 2));
    return fetch(`${STORE_API}/products?${pageParams}`);
  }));
  const failedResponse = pageResponses.find((pageResponse) => !pageResponse.ok);
  if (failedResponse) throw new Error(`Error HTTP ${failedResponse.status} al completar los productos para los filtros`);
  const remainingProducts = await Promise.all(pageResponses.map((pageResponse) => pageResponse.json()));
  return products.concat(...remainingProducts);
}

function getFilterAttributeKey(attribute) {
  const name = normalizeAttributeName(attribute.taxonomy || attribute.name);
  if (name === 'pa marca' || name === 'marca' || name === 'brand') return 'brand';
  if (name === 'pa talle' || name === 'talle' || name === 'size') return 'size';
  if (name === 'pa color' || name === 'color') return 'color';
  return '';
}

async function normalizeProduct({ id, name, sku, slug, type, description, short_description, images, categories, attributes = [], variations = [], is_in_stock, stock_quantity, stock_status }, headers, authenticated, lazyVariations = false) {
  const normalizedVariations = authenticated ? await loadVariations(id, headers) : variations;
  const hasAvailableVariation = normalizedVariations.some((variation) => variation.is_in_stock);
  const hasAvailableStock = stock_status === 'instock'
    && (stock_quantity === null || stock_quantity === undefined || stock_quantity > 0);
  return {
    id, name, sku, slug, type, description, short_description, images, categories,
    attributes: attributes.map(({ name: attributeName, terms = [], options = [] }) => ({
      name: attributeName,
      terms: terms.length
        ? terms.map(({ name: termName, slug }) => ({ name: termName, slug }))
        : options.map((option) => ({ name: option, slug: option.toLowerCase().replace(/\s+/g, '-') })),
    })),
    variations: normalizedVariations,
    variations_loaded: !lazyVariations || type !== 'variable',
    is_in_stock: authenticated && type === 'variable'
      ? normalizedVariations.length > 0 && hasAvailableVariation
      : (authenticated ? hasAvailableStock : is_in_stock),
    stock_quantity: authenticated ? stock_quantity : undefined,
  };
}

async function loadVariations(productId, headers) {
  const cached = variationCache.get(productId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const response = await fetch(`${WC_API}/products/${productId}/variations?per_page=100`, { headers });
  if (!response.ok) return [];
  const variations = await response.json();
  const result = variations.map((variation) => ({
    id: variation.id,
    stock_quantity: variation.stock_quantity,
    stock_status: variation.stock_status,
    is_in_stock: variation.stock_status === 'instock'
      && (variation.stock_quantity === null || variation.stock_quantity > 0),
    attributes: (variation.attributes || []).map(({ name, option }) => ({ name: normalizeAttributeName(name), value: normalizeAttributeValue(option) })),
  }));
  variationCache.set(productId, { data: result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

function normalizeAttributeName(value = '') {
  return value.replace(/^pa_/, '').replace(/[-_]/g, ' ').trim().toLowerCase();
}

function normalizeAttributeValue(value = '') {
  return value.toString().trim().toLowerCase().replace(/\s+/g, '-');
}
