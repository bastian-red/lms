#!/usr/bin/env node
/**
 * Mint a service token by hand, for poking the API with curl.
 *
 * The web app does this on every request; this is the same thing for a terminal.
 * It exists because the manual verification in the README ("prove a segment on
 * disk is not playable") needs a real token, and typing one out is not a thing
 * a person can do.
 *
 * Usage: node scripts/mint-token.mjs <userId> [email] [role]
 */
import jwt from 'jsonwebtoken';

const [userId, email = 'cli@lms.local', role = 'STUDENT'] = process.argv.slice(2);

if (!userId) {
  process.stderr.write('Usage: node scripts/mint-token.mjs <userId> [email] [role]\n');
  process.exit(1);
}
if (!process.env.AUTH_SECRET) {
  process.stderr.write('AUTH_SECRET is not set. Run: set -a && . ./.env && set +a\n');
  process.exit(1);
}

process.stdout.write(
  jwt.sign({ sub: userId, email, role }, process.env.AUTH_SECRET, {
    algorithm: 'HS256',
    expiresIn: '30m',
  }) + '\n',
);
