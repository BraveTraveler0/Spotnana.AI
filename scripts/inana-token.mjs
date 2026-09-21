// Gives Artemis its own access token for MarketGenius (Inana), once. No sign-in, no password.
//
//   npm run inana:token                 make (or renew) the token
//   npm run inana:token -- --dry-run    check everything, write nothing
//   npm run inana:token -- --email you@example.com --days 3650 --dir <MarketGenius\server>
//
// MarketGenius only hands data to a session token, and its own sign-in makes those. This makes
// one the same way (its own signing code and secret, for your own owner account) but valid for
// years, and saves it in Artemis's data folder as inana.json, next to the two URLs. The only
// thing read from MarketGenius's database is your account record, read-only. Nothing secret is
// printed, and MarketGenius's own files are not changed. To revoke the token: deactivate the
// account in MarketGenius, or change JWT_SECRET in its .env (that signs every session out).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const dryRun = process.argv.includes('--dry-run');
const days = Number(flag('days', 3650));
const wantedEmail = flag('email', '')?.trim().toLowerCase();

const projects = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverDir = path.resolve(flag('dir', process.env.MARKETGENIUS_DIR ?? path.join(projects, 'MarketGenius', 'server')));
const appData = process.env.APPDATA ? path.join(process.env.APPDATA, 'com.artemis.ai') : null;

function stop(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!Number.isFinite(days) || days < 1 || days > 36500) stop('--days must be a number of days between 1 and 36500.');
if (!fs.existsSync(path.join(serverDir, 'package.json'))) stop(`Could not find MarketGenius's server at ${serverDir}. Pass its folder with --dir.`);
if (!appData) stop("This makes Artemis's Windows data folder (%APPDATA%\\com.artemis.ai); %APPDATA% is not set here.");

// MarketGenius's own packages, so the token is made by the same code that checks it.
const need = createRequire(path.join(serverDir, 'package.json'));
const dotenv = need('dotenv');
const jwt = need('jsonwebtoken');
const mongoose = need('mongoose');
dotenv.config({ path: path.join(serverDir, '.env'), quiet: true });
for (const name of ['JWT_SECRET', 'DATABASE_URI']) {
  if (!process.env[name]) stop(`MarketGenius's .env has no ${name}, which making a token needs.`);
}

try {
  await mongoose.connect(process.env.DATABASE_URI, { maxPoolSize: 1, serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
} catch (error) {
  stop(`Could not reach MarketGenius's database (${error.name}). Check the internet connection and try again.`);
}

let exitCode = 0;
try {
  const User = need(path.join(serverDir, 'models', 'User'));
  const filter = { status: 'Active', role: 'Owner', ...(wantedEmail ? { email: wantedEmail } : {}) };
  const found = await User.find(filter).select('_id email workspaceId createdAt').sort({ createdAt: 1 }).lean().exec();
  // MarketGenius's own test runs leave qa-...@example.com accounts behind; never pick one of those.
  const owners = wantedEmail ? found : found.filter((account) => !/^qa-|@example\.com$/i.test(account.email));
  if (owners.length === 0) stop(wantedEmail ? `No active owner account with the email ${wantedEmail}.` : 'MarketGenius has no active owner account that is not a test account. Pass yours with --email.');
  if (owners.length > 1) stop(`MarketGenius has ${owners.length} owner accounts that are not test accounts (${owners.map((account) => account.email).join(', ')}). Pass the one to use with --email.`);
  const owner = owners[0];

  const token = jwt.sign({ _id: owner._id, email: owner.email, workspaceId: owner.workspaceId }, process.env.JWT_SECRET, { expiresIn: `${days}d` });

  // Prove MarketGenius's own check accepts it before saving anything.
  const { verifyToken } = need(path.join(serverDir, 'utils', 'jwtUtils'));
  const decoded = verifyToken(token);
  if (!decoded || String(decoded._id) !== String(owner._id)) stop("MarketGenius's own check rejected the token it was just given, so nothing was saved.");
  const until = new Date(decoded.exp * 1000).toISOString().slice(0, 10);

  const file = path.join(appData, 'inana.json');
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first time */
  }
  const origin = (process.env.APP_ORIGIN ?? '').trim();
  const config = {
    api_url: existing.api_url || `http://localhost:${process.env.PORT || 8080}`,
    web_url: existing.web_url || (/^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, '') : 'http://localhost:5173'),
    email: owner.email,
    token,
  };

  if (dryRun) {
    console.log(`Dry run: would link Artemis to MarketGenius as ${owner.email} (${owners.length} active owner account${owners.length === 1 ? '' : 's'}), token good until ${until}. Nothing was written.`);
  } else {
    fs.mkdirSync(appData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
    console.log(`Linked Artemis to MarketGenius as ${owner.email}. The access token is good until ${until}; nothing else to do.`);
    console.log(`Saved in ${file}. Artemis talks to ${config.api_url}, so MarketGenius's server has to be running for the numbers to show.`);
  }
} catch (error) {
  console.error(`\nFailed: ${error?.message ?? error}\n`);
  exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
process.exit(exitCode);
