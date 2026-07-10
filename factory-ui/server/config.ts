import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  root: path.resolve(here, '..', '..'),   // factory-ui/ の親 = ファクトリールート
  port: Number(process.env.FACTORY_UI_PORT ?? 4700),
};
