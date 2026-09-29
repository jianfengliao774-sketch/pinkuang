import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const config = {output: 'export', basePath, devIndicators: false, turbopack: {root: path.dirname(fileURLToPath(import.meta.url))}};
export default config;
