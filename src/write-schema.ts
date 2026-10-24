/** Regenerates config/judges.schema.json from the Zod schema the loader validates with. */
import { writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { JudgesFile } from './judge-config.js';

const schema = {
  title: 'Design review judges',
  ...z.toJSONSchema(JudgesFile, { io: 'input' }),
};
await writeFile(new URL('../config/judges.schema.json', import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
console.log('Wrote config/judges.schema.json');
