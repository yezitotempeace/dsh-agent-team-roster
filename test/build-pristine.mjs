/**
 * Materialize the pristine (unpatched) Agent Teams core module next to the
 * tests, so the roster plugin is exercised against the code a stock dsh
 * installation loads.
 *
 * The source is always the **installed** dsh package, never a vendored copy:
 * this repository does not redistribute upstream code. Point
 * `DSH_AGENT_TEAM_MODULE` at `.../dsh-experimental-agent-team/lib/index.js`
 * when dsh lives somewhere unusual.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'core-pristine.js');
const PRISTINE_MD5 = '512150bb996ca45cde8a5b6ea298e35a';
const CANDIDATES = [
	process.env.DSH_AGENT_TEAM_MODULE,
	join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-experimental-agent-team', 'lib', 'index.js'),
	'/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

const source = CANDIDATES.find((candidate) => existsSync(candidate));
if (source === undefined) {
	throw new Error('cannot find the installed @deepseek-ai/dsh-experimental-agent-team; set DSH_AGENT_TEAM_MODULE to its lib/index.js');
}
const bytes = readFileSync(source);
const md5 = createHash('md5').update(bytes).digest('hex');
if (md5 !== PRISTINE_MD5) {
	throw new Error(`pristine core hash mismatch: got ${md5}, expected ${PRISTINE_MD5} from ${source}`);
}

copyFileSync(source, out);
console.log(JSON.stringify({ source, out, md5, bytes: bytes.length }));
