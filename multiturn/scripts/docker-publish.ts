import {publishImage} from '../src/ts/docker/release.ts';
const args=process.argv.slice(2),version=args.shift();
if(!version||args.some(a=>!/^--(ledger|tests|logs|source-tag)=.+/.test(a)))throw Error('Usage: docker-publish.ts <x.y.z> [--ledger=path] [--tests=path] [--logs=path] [--source-tag=test-*]');
const option=(key:string)=>args.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
await publishImage({version,ledger:option('ledger'),tests:option('tests'),logs:option('logs'),sourceTag:option('source-tag')});
