import { loadLiveConfig, validateProductGraph } from './live-config.mjs';
import { loadFreshLiveConfig, validateFreshProductGraph } from './fresh-product-config.mjs';

export function loadProductConfig(options = {}) {
  const family = options.productFamily ?? process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY;
  if (family === 'fresh-v4') return loadFreshLiveConfig(options);
  if (family === undefined || family === '' || family === 'legacy') return loadLiveConfig(options);
  throw new Error('Unknown product build family.');
}

export function validateCurrentProductGraph(input, config) {
  return config?.productFamily === 'fresh-v4'
    ? validateFreshProductGraph(input, config.pinnedManifest)
    : validateProductGraph(input);
}
