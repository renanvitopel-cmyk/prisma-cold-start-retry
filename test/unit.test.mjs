import { test } from "node:test";
import assert from "node:assert/strict";
import { withConnectionRetry, isConnectionError, coldStartRetry } from "../dist/index.js";

const known = (code) => Object.assign(new Error(code), { name: "PrismaClientKnownRequestError", code });
const init = () => Object.assign(new Error("init"), { name: "PrismaClientInitializationError" });

function failing(...errors) {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (errors.length) throw errors.shift();
    return "ok";
  };
  return { fn, calls: () => calls };
}

test("returns at once when the query succeeds", async () => {
  const q = failing();
  assert.equal(await withConnectionRetry(q.fn, { delayMs: 0 }), "ok");
  assert.equal(q.calls(), 1);
});

for (const code of ["P1001", "P1017", "P2024"]) {
  test(`retries once on ${code}`, async () => {
    const q = failing(known(code));
    assert.equal(await withConnectionRetry(q.fn, { delayMs: 0 }), "ok");
    assert.equal(q.calls(), 2);
  });
}

test("retries on PrismaClientInitializationError", async () => {
  const q = failing(init());
  assert.equal(await withConnectionRetry(q.fn, { delayMs: 0 }), "ok");
  assert.equal(q.calls(), 2);
});

test("can skip initialization errors", async () => {
  const q = failing(init());
  await assert.rejects(withConnectionRetry(q.fn, { delayMs: 0, retryInitializationErrors: false }));
  assert.equal(q.calls(), 1);
});

test("never retries business errors like a unique violation", async () => {
  const q = failing(known("P2002"));
  await assert.rejects(withConnectionRetry(q.fn, { delayMs: 0 }), { code: "P2002" });
  assert.equal(q.calls(), 1);
});

test("never retries plain errors", async () => {
  const q = failing(new Error("boom"));
  await assert.rejects(withConnectionRetry(q.fn, { delayMs: 0 }), /boom/);
  assert.equal(q.calls(), 1);
});

test("gives up after `retries` and throws the last error", async () => {
  const q = failing(known("P1001"), known("P1001"), known("P1017"));
  await assert.rejects(withConnectionRetry(q.fn, { delayMs: 0, retries: 2 }), { code: "P1017" });
  assert.equal(q.calls(), 3);
});

test("retries: 0 disables retrying", async () => {
  const q = failing(known("P1001"));
  await assert.rejects(withConnectionRetry(q.fn, { retries: 0 }));
  assert.equal(q.calls(), 1);
});

test("waits delayMs before retrying", async () => {
  const q = failing(known("P1001"));
  const start = Date.now();
  await withConnectionRetry(q.fn, { delayMs: 150 });
  assert.ok(Date.now() - start >= 140, `waited only ${Date.now() - start} ms`);
});

test("calls onRetry with attempt, error and delay", async () => {
  const seen = [];
  const q = failing(known("P1001"), known("P1017"));
  await withConnectionRetry(q.fn, { delayMs: 0, retries: 2, onRetry: (i) => seen.push(i) });
  assert.deepEqual(seen.map((i) => [i.attempt, i.error.code, i.delayMs]), [[1, "P1001", 0], [2, "P1017", 0]]);
});

test("custom codes replace the defaults", async () => {
  assert.equal(isConnectionError(known("P1002"), { codes: ["P1002"] }), true);
  assert.equal(isConnectionError(known("P1001"), { codes: ["P1002"] }), false);
});

test("isConnectionError ignores non-objects", () => {
  for (const v of [null, undefined, "P1001", 42]) assert.equal(isConnectionError(v), false);
});

test("rejects invalid options at setup time", () => {
  assert.throws(() => coldStartRetry({ retries: -1 }), RangeError);
  assert.throws(() => coldStartRetry({ retries: 1.5 }), RangeError);
  assert.throws(() => coldStartRetry({ delayMs: -5 }), RangeError);
});
