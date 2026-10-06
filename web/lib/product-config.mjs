import { loadLiveConfig, validateProductGraph } from './live-config.mjs';
import { loadFreshDisplayConfig, loadFreshLiveConfig, validateFreshProductGraph } from './fresh-product-config.mjs';

export function loadProductConfig(options = {}) {
  const family = options.productFamily ?? process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY;
  if (family === 'fresh-v4') return loadFreshLiveConfig(options);
  if (family === undefined || family === '' || family === 'legacy') return loadLiveConfig(options);
  throw new Error('Unknown product build family.');
}

/** Fresh public browsing uses static identities; actions keep loadProductConfig. */
export function loadProductDisplayConfig(options = {}) {
  const family = options.productFamily ?? process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY;
  if (family === 'fresh-v4') return loadFreshDisplayConfig(options);
  if (family === undefined || family === '' || family === 'legacy') return loadLiveConfig(options);
  throw new Error('Unknown product build family.');
}

export function validateCurrentProductGraph(input, config) {
  return config?.productFamily === 'fresh-v4'
    ? validateFreshProductGraph(input, config.pinnedManifest)
    : validateProductGraph(input);
}
