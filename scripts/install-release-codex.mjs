// Same official binary/version/digest as the saved-session CI qualification.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const version = '0.164.0', digest = '90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Hosted release client requires Linux x64');
const directory = resolve(process.env.CODEX_DIRECTORY);
await mkdir(directory, {mode:0o700});
const response = await fetch(`https://github.com/openai/codex/releases/download/rust-v${version}/codex-x86_64-unknown-linux-musl.tar.gz`, {signal:AbortSignal.timeout(120_000)});
if (!response.ok) throw new Error('Official qualification client download failed');
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Official qualification client checksum failed');
const archive = join(directory,'codex.tar.gz'), binary = join(directory,'codex-x86_64-unknown-linux-musl');
await writeFile(archive,bytes,{mode:0o600,flag:'wx'});
execFileSync('tar',['-xzf',archive,'-C',directory],{timeout:30_000});
await rm(archive);
if (execFileSync(binary,['--version'],{encoding:'utf8',timeout:10_000}).trim() !== 'codex-cli '+version) throw new Error('Qualification client version mismatch');
await appendFile(process.env.GITHUB_ENV, 'CLAWROUTER_CODEX_BINARY='+binary+'\n');
