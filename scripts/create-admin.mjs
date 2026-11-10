// Creates the first administrator (or promotes an existing account).
// Usage:  npm run create-admin -- admin@example.org "Full Name"
// You are asked for a password; nothing is printed or stored in plain text.
import readline from "node:readline";
import { loadEnv } from "./env.mjs";
loadEnv();
const { one, query, closePool } = await import("../lib/db.js");
const { hashPassword, validatePassword } = await import("../lib/auth.js");

const [email, ...nameParts] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-admin -- admin@example.org "Full Name"');
  process.exit(1);
}
const fullName = nameParts.join(" ") || "Administrator";

async function ask(q) {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  return new Promise((res) => rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); res(a); }));
}

try {
  const existing = await one("SELECT id FROM users WHERE lower(email)=lower($1)", [email]);
  if (existing) {
    await query("UPDATE users SET role='admin', status='active', token_version=token_version+1 WHERE id=$1", [existing.id]);
    console.log(`${email} is now an administrator. Log in with the existing password.`);
  } else {
    const pw = validatePassword(await ask("Password for the new administrator (min 8 chars, letters + numbers): "));
    await query("INSERT INTO users (email, password_hash, full_name, role) VALUES (lower($1), $2, $3, 'admin')", [email, await hashPassword(pw), fullName]);
    console.log(`Administrator ${email} created.`);
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
