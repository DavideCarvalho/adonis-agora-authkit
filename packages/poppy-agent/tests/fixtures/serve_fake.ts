/**
 * Runs the fake Poppy Company standalone, to try the CLI by hand:
 *   node --import=@poppinss/ts-exec tests/fixtures/serve_fake.ts [port]
 */
import { FakeCompany } from './fake_company.js';

const fake = await new FakeCompany({ devicePendingPolls: 1 }).start(Number(process.argv[2] ?? 0));
console.log(`fake Poppy Company at ${fake.origin}`);
setInterval(() => {
  if (fake.violations.length) console.error('VIOLATIONS:', fake.violations.splice(0));
}, 500);
