import { add } from '@/lib';
import type { Cfg } from './types';
const m = await import('./lazy');
export const run = (c: Cfg) => add(c.n, m.default);
