// Gives Artemis its own access token for MarketGenius (Inana), once. No sign-in, no password.
//
//   npm run inana:token                       your MarketGenius on this PC (localhost:8080)
//   npm run inana:token -- --hosted           your hosted MarketGenius (Render), see below
//   npm run inana:token -- --dry-run          check everything, write nothing
//   options: --email you@example.com  --days 3650  --dir <MarketGenius\server>
//            --api <url>  --web <url>  --env <file>  --keep   (the last four are for --hosted)
//
// MarketGenius only hands data to a session token, and its own sign-in makes those. This makes
// one the same way (its own signing code, for your own owner account) but valid for years, and
// saves it in Artemis's data folder as inana.json, next to the two URLs. The only thing read from
// MarketGenius's database is your account record, read-only. Nothing secret is printed, and
// MarketGenius's own files are not changed.
//
// --hosted: the deployed MarketGenius has its own secret key and database, so those two values
// (JWT_SECRET and DATABASE_URI, from Render: marketinggenius-backend-server > Environment) go in
// %USERPROFILE%\.artemis-inana\hosted.env, outside OneDrive. Before saving anything, the token is
// tried against the hosted server itself. Once it has worked, the values are cleared from that file.
//
// To revoke a token: deactivate the account in MarketGenius, or change JWT_SECRET (that signs every
// session out).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);
const dryRun = has('dry-run');
const hosted = has('hosted');
const days = Number(flag('days', 3650));
const wantedEmail = flag('email', '')?.trim().toLowerCase();

const projects = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverDir = path.resolve(flag('dir', process.env.MARKETGENIUS_DIR ?? path.join(projects, 'MarketGenius', 'server')));
const appData = process.env.APPDATA ? path.join(process.env.APPDATA, 'com.artemis.ai') : null;
const hostedEnvFile = path.resolve(flag('env', path.join(os.homedir(), '.artemis-inana', 'hosted.env')));
const HOSTED_API = 'https://marketinggenius-backend-server.onrender.com';
const HOSTED_WEB = 'https://marketinggenius-nu.vercel.app';
const HOSTED_TEMPLATE = [
  '# The two values from Render (marketinggenius-backend-server > Environment).',
  '# Paste each one after the = sign, save, then run: npm run inana:token -- --hosted',
  '# This file lives outside OneDrive, and the script clears the values as soon as it has used them.',
  'JWT_SECRET=',
  'DATABASE_URI=',
  '',
].join('\r\n');

// True once the database is open, so leaving can close it first: exiting with it open makes
// Windows print a crash line (a libuv assertion) after the message.
let connected = false;

function stop(message) {
  console.error(`\n${message}\n`);
  if (!connected) process.exit(1);
  mongoose.disconnect().catch(() => {}).finally(() => process.exit(1));
  return new Promise(() => {}); // never resolves: nothing after `await stop(...)` runs
}

if (!Number.isFinite(days) || days < 1 || days > 36500) await stop('--days must be a number of days between 1 and 36500.');
if (!fs.existsSync(path.join(serverDir, 'package.json'))) await stop(`Could not find MarketGenius's server at ${serverDir}. Pass its folder with --dir.`);
if (!appData) await stop("This makes Artemis's Windows data folder (%APPDATA%\\com.artemis.ai); %APPDATA% is not set here.");

// MarketGenius's own packages, so the token is made by the same code that checks it.
const need = createRequire(path.join(serverDir, 'package.json'));
const dotenv = need('dotenv');
const jwt = need('jsonwebtoken');
const mongoose = need('mongoose');

// Where the secret and the database come from: MarketGenius's own .env, or the hosted values.
let secrets;
if (hosted) {
  if (!fs.existsSync(hostedEnvFile)) await stop(`${hostedEnvFile} does not exist yet. It holds the two values from Render.`);
  secrets = dotenv.parse(fs.readFileSync(hostedEnvFile));
  const empty = ['JWT_SECRET', 'DATABASE_URI'].filter((name) => !(secrets[name] ?? '').trim());
  if (empty.length > 0) await stop(`${hostedEnvFile} still has no value for ${empty.join(' and ')}. Paste them from Render (marketinggenius-backend-server > Environment), save, and run this again.`);
  if (!/^mongodb(\+srv)?:\/\//i.test(secrets.DATABASE_URI.trim())) await stop('DATABASE_URI in hosted.env should start with mongodb:// or mongodb+srv://.');
} else {
  secrets = dotenv.parse(fs.readFileSync(path.join(serverDir, '.env')));
  for (const name of ['JWT_SECRET', 'DATABASE_URI']) if (!secrets[name]) await stop(`MarketGenius's .env has no ${name}, which making a token needs.`);
}
const apiUrl = (hosted ? flag('api', HOSTED_API) : null) ?? '';
const webUrl = hosted ? flag('web', HOSTED_WEB) : '';

mongoose.set('strictQuery', true);
try {
  await mongoose.connect(secrets.DATABASE_URI.trim(), { maxPoolSize: 1, serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
  connected = true;
} catch (error) {
  await stop(
    `Could not reach ${hosted ? 'the hosted' : "MarketGenius's"} database (${error.name}). ` +
      (hosted ? "If it is MongoDB Atlas, this PC's address may need adding under Network Access; otherwise check the internet connection and the value in hosted.env." : 'Check the internet connection and try again.'),
  );
}

let exitCode = 0;
try {
  const User = need(path.join(serverDir, 'models', 'User'));
  const filter = { status: 'Active', role: 'Owner', ...(wantedEmail ? { email: wantedEmail } : {}) };
  const found = await User.find(filter).select('_id email workspaceId createdAt').sort({ createdAt: 1 }).lean().exec();
  // MarketGenius's own test runs leave qa-...@example.com accounts behind; never pick one of those.
  const owners = wantedEmail ? found : found.filter((account) => !/^qa-|@example\.com$/i.test(account.email));
  if (owners.length === 0) await stop(wantedEmail ? `No active owner account with the email ${wantedEmail}.` : 'MarketGenius has no active owner account that is not a test account. Pass yours with --email.');
  if (owners.length > 1) await stop(`MarketGenius has ${owners.length} owner accounts that are not test accounts (${owners.map((account) => account.email).join(', ')}). Pass the one to use with --email.`);
  const owner = owners[0];

  const token = jwt.sign({ _id: owner._id, email: owner.email, workspaceId: owner.workspaceId }, secrets.JWT_SECRET.trim(), { expiresIn: `${days}d` });
  const decoded = jwt.verify(token, secrets.JWT_SECRET.trim());
  if (!decoded || String(decoded._id) !== String(owner._id)) await stop('The token failed its own check, so nothing was saved.');
  const until = new Date(decoded.exp * 1000).toISOString().slice(0, 10);

  // The hosted server has the last word: it must accept the token before anything is saved.
  let products = null;
  if (hosted) {
    let response;
    try {
      response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/products`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    } catch (error) {
      await stop(`Could not reach the hosted server at ${apiUrl} (${error.message}). Nothing was saved.`);
    }
    if (response.status !== 200) {
      const said = await response.json().catch(() => ({}));
      const hint =
        said?.message === 'Invalid or expired token'
          ? 'so the JWT_SECRET in hosted.env is not the one the running server signs with (copy it from the marketinggenius-backend-server service itself, not from another Render service or a local file)'
          : /no longer exists|not active/i.test(said?.message ?? '')
            ? 'so the DATABASE_URI in hosted.env is not the database that server uses'
            : 'so the values in hosted.env do not match that server';
      await stop(`The hosted server answered HTTP ${response.status}${said?.message ? ` ("${said.message}")` : ''} to the new token, ${hint}. Nothing was saved.`);
    }
    const list = await response.json().catch(() => []);
    products = Array.isArray(list) ? list.map((product) => product.name ?? product.id).filter(Boolean) : [];
  }

  const file = path.join(appData, 'inana.json');
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first time */
  }
  const origin = (process.env.APP_ORIGIN ?? '').trim();
  const config = hosted
    ? { api_url: apiUrl.replace(/\/+$/, ''), web_url: webUrl.replace(/\/+$/, ''), email: owner.email, token }
    : {
        api_url: existing.api_url || `http://localhost:${process.env.PORT || 8080}`,
        web_url: existing.web_url || (/^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, '') : 'http://localhost:5173'),
        email: owner.email,
        token,
      };

  if (dryRun) {
    console.log(`Dry run: would link Artemis to ${hosted ? apiUrl : 'MarketGenius on this PC'} as ${owner.email}, token good until ${until}. Nothing was written.`);
    if (products) console.log(`The hosted server accepted the token and lists ${products.length} product${products.length === 1 ? '' : 's'}: ${products.join(', ') || 'none'}.`);
  } else {
    fs.mkdirSync(appData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
    console.log(`Linked Artemis to ${config.api_url} as ${owner.email}. The access token is good until ${until}; nothing else to do.`);
    if (products) console.log(`The hosted server accepted it and lists ${products.length} product${products.length === 1 ? '' : 's'}: ${products.join(', ') || 'none'}.`);
    console.log(`Saved in ${file}.`);
    // The two values were only needed to make the token: clear them (--keep leaves them).
    if (hosted && !has('keep')) {
      fs.writeFileSync(hostedEnvFile, HOSTED_TEMPLATE);
      console.log(`Cleared the values from ${hostedEnvFile}.`);
    }
  }
} catch (error) {
  console.error(`\nFailed: ${error?.message ?? error}\n`);
  exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
process.exit(exitCode);
