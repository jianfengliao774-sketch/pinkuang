export function resolveQuoteBase(basePath = '') {
  if (basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw new Error('Invalid site base path.');
  return basePath && basePath !== '/bemine' ? `${basePath}/firsto-api` : '/pinkuang-deploy/firsto-api';
}
export const QUOTE_BASE = resolveQuoteBase(process.env.NEXT_PUBLIC_BASE_PATH || '');
