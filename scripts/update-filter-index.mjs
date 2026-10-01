import { writeFile } from 'node:fs/promises';

const STORE_API = 'https://isabellamayorista.com.ar/wp-json/wc/store/v1';
const ATTRIBUTE_KEYS = new Map([
  ['pa_marca', 'brand'],
  ['pa_talle', 'size'],
  ['pa_color', 'color'],
]);
const VARIATION_ATTRIBUTE_KEYS = new Map([
  ['marca', 'brand'],
  ['talle', 'size'],
  ['color', 'color'],
  ['brand', 'brand'],
  ['size', 'size'],
]);

async function requestJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`);
  return response;
}

async function loadProducts(params) {
  params.set('per_page', '100');
  params.set('page', '1');
  params.set('stock_status', 'instock');
  params.set('_fields', 'id,name,sku,type,attributes,variations,is_in_stock');

  const firstResponse = await requestJson(`${STORE_API}/products?${params}`);
  const totalPages = Math.max(1, Number(firstResponse.headers.get('x-wp-totalpages')) || 1);
  const products = await firstResponse.json();
  if (totalPages === 1) return products;

  const pages = await Promise.all(Array.from({ length: totalPages - 1 }, async (_, index) => {
    const pageParams = new URLSearchParams(params);
    pageParams.set('page', String(index + 2));
    const response = await requestJson(`${STORE_API}/products?${pageParams}`);
    return response.json();
  }));
  return products.concat(...pages);
}

function normalizeProduct(product, terms) {
  const productTerms = {};
  (product.attributes || []).forEach((attribute) => {
    const key = ATTRIBUTE_KEYS.get(attribute.taxonomy);
    if (key) productTerms[key] = attribute.terms || [];
  });
  const attributes = { brand: [], size: [], color: [] };
  const variations = product.variations || [];
  const combinations = [];
  if (product.type === 'variable') {
    (productTerms.brand || []).forEach(({ name, slug }) => {
      attributes.brand.push(slug);
      terms.brand[slug] = name;
    });
    variations.forEach((variation) => {
      const variationAttributes = {};
      (variation.attributes || []).forEach(({ name, value }) => {
        const normalizedName = name.replace(/^pa_/, '').replace(/[-_]/g, ' ').trim().toLowerCase();
        const key = VARIATION_ATTRIBUTE_KEYS.get(normalizedName);
        if (!key) return;
        const term = productTerms[key]?.find(({ name: termName, slug }) =>
          slug === value || termName.toLocaleLowerCase('es') === value.toLocaleLowerCase('es'));
        const slug = term?.slug || value.toLowerCase().replace(/\s+/g, '-');
        if (slug) {
          variationAttributes[key] = slug;
          terms[key][slug] = term?.name || value;
        }
      });
      Object.entries(variationAttributes).forEach(([key, slug]) => {
        attributes[key].push(slug);
      });
      if (variationAttributes.size || variationAttributes.color) combinations.push({
        ...(variationAttributes.size ? { size: variationAttributes.size } : {}),
        ...(variationAttributes.color ? { color: variationAttributes.color } : {}),
      });
    });
  } else {
    Object.entries(productTerms).forEach(([key, productAttributeTerms]) => {
      productAttributeTerms.forEach(({ name, slug }) => {
        attributes[key].push(slug);
        terms[key][slug] = name;
      });
    });
  }
  Object.entries(attributes).forEach(([key, values]) => {
    attributes[key] = [...new Set(values)];
  });
  return {
    id: product.id,
    search: `${product.name} ${product.sku || ''}`.toLocaleLowerCase('es'),
    categories: [],
    attributes,
    combinations: product.type === 'variable' ? combinations : null,
  };
}

const categoriesResponse = await requestJson(`${STORE_API}/products/categories?per_page=100`);
const categories = (await categoriesResponse.json())
  .filter(({ parent, count }) => parent === 0 && count > 0)
  .map(({ id, name }) => ({ id, name }));
const scopes = await Promise.all([
  loadProducts(new URLSearchParams()).then((products) => ['all', products]),
  ...categories.map(({ id }) => {
    const params = new URLSearchParams({ category: String(id) });
    return loadProducts(params).then((products) => [String(id), products]);
  }),
]);
const terms = { brand: {}, size: {}, color: {} };
const products = scopes.find(([key]) => key === 'all')[1]
  .filter((product) => product.is_in_stock)
  .map((product) => normalizeProduct(product, terms));
const productsById = new Map(products.map((product) => [product.id, product]));
scopes.filter(([key]) => key !== 'all').forEach(([categoryId, categoryProducts]) => {
  categoryProducts.forEach(({ id, is_in_stock }) => {
    const product = is_in_stock ? productsById.get(id) : undefined;
    if (product) product.categories.push(Number(categoryId));
  });
});

const index = {
  version: 1,
  generatedAt: new Date().toISOString(),
  categories,
  terms,
  products,
};

await writeFile(new URL('../filter-index.json', import.meta.url), `${JSON.stringify(index)}\n`);
console.log(`Updated filter-index.json: ${products.length} products across ${categories.length} categories`);
