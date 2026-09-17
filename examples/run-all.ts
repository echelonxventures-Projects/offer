/**
 * Runs every example in order. Each gets a fresh platform, so they cannot
 * interfere with one another.
 */
const examples = [
  "01-coupon.ts",
  "02-cashback.ts",
  "03-government-subsidy.ts",
  "04-affiliate-settlement.ts",
  "05-off-world.ts",
  "06-stacking-conflict.ts",
  "07-durability.ts",
];

for (const example of examples) {
  await import(`./${example}`);
}

console.log("=".repeat(74));
console.log("All examples completed.");
console.log("=".repeat(74));
