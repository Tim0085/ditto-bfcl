import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
registerHooks({load(url,context,next){const result=next(url,context);return url.endsWith('/src/ts/deploy.ts')?{...result,source:readFileSync(resolve('before/src/ts/deploy.ts'),'utf8')}:result;}});
