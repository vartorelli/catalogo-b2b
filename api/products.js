const STORE_API = 'https://isabellamayorista.com.ar/wp-json/wc/store/v1';
const WC_API = 'https://isabellamayorista.com.ar/wp-json/wc/v3';
const CACHE_TTL = 5 * 60 * 1000;
const FILTER_PAGE_CONCURRENCY = 5;
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
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    Object.entries(cachedResponse.headers).forEach(([name, value]) => response.setHeader(name, value));
    response.status(200).json(cachedResponse.data);
    return;
  }
  if (requestedResource === 'filters') {
    const filterParams = new URLSearchParams({ page: '1', per_page: '100', stock_status: 'instock', _fields: 'attributes' });
    const category = url.searchParams.get('category');
    if (category && category !== '0') filterParams.set('category', category);
    const filterResponse = await fetch(`${apiBase}/products?${filterParams}`, { headers });
    if (!filterResponse.ok) {
      response.status(filterResponse.status).json({ error: 'No se pudieron cargar los filtros' });
      return;
    }
    const filterProducts = await filterResponse.json();
    const totalPages = Math.max(1, Number(filterResponse.headers.get('x-wp-totalpages')) || 1);
    for (let firstPage = 2; firstPage <= totalPages; firstPage += FILTER_PAGE_CONCURRENCY) {
      const pages = Array.from(
        { length: Math.min(FILTER_PAGE_CONCURRENCY, totalPages - firstPage + 1) },
        (_, index) => firstPage + index,
      );
      const pageResponses = await Promise.all(pages.map((page) => {
        const params = new URLSearchParams(filterParams);
        params.set('page', String(page));
        return fetch(`${apiBase}/products?${params}`, { headers });
      }));
      const failedResponse = pageResponses.find((pageResponse) => !pageResponse.ok);
      if (failedResponse) {
        response.status(failedResponse.status).json({ error: 'No se pudieron cargar todos los atributos de los productos' });
        return;
      }
      const pageProducts = await Promise.all(pageResponses.map((pageResponse) => pageResponse.json()));
      filterProducts.push(...pageProducts.flat());
    }
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    const attributeValues = new Map();
    filterProducts.forEach(({ attributes = [] }) => {
      attributes.forEach(({ name, terms = [], options = [] }) => {
        if (!attributeValues.has(name)) attributeValues.set(name, new Map());
        const values = terms.length
          ? terms.map(({ name: termName, slug }) => ({ name: termName, slug }))
          : options.map((option) => ({ name: option, slug: option.toLowerCase().replace(/\s+/g, '-') }));
        values.forEach((term) => attributeValues.get(name).set(term.slug, term));
      });
    });
    const result = [{
      attributes: [...attributeValues].map(([name, values]) => ({ name, terms: [...values.values()] })),
    }];
    responseCache.set(cacheKey, { data: result, headers: {}, expiresAt: Date.now() + CACHE_TTL });
    response.status(200).json(result);
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
    let products;
    if (useAuthenticatedApi && filteredProducts.length > 0) {
      const includeParams = new URLSearchParams({
        include: filteredProducts.map(({ id }) => id).join(','),
        per_page: String(filteredProducts.length),
        orderby: 'include',
        stock_status: 'instock',
      });
      const productResponse = await fetch(`${WC_API}/products?${includeParams}`, { headers });
      if (!productResponse.ok) {
        response.status(productResponse.status).json({ error: 'No se pudieron cargar los productos filtrados' });
        return;
      }
      const productData = await productResponse.json();
      const orderedProducts = new Map(productData.map((product) => [product.id, product]));
      products = await Promise.all(filteredProducts
        .map(({ id }) => orderedProducts.get(id))
        .filter(Boolean)
        .map((product) => normalizeProduct(product, headers, true)));
      products = products.filter((product) => product.is_in_stock);
    } else {
      products = await Promise.all(filteredProducts.map((product) => normalizeProduct(product, headers, false)));
    }
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

async function normalizeProduct({ id, name, sku, slug, type, description, short_description, images, categories, attributes = [], variations = [], is_in_stock, stock_quantity, stock_status }, headers, authenticated) {
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
