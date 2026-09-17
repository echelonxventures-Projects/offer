import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SpatialAuthority } from "../src/universal/spatial/authority.ts";
import { spatialNodeRegistry } from "../src/universal/spatial/node.ts";
import { unwrap } from "../src/kernel/result.ts";

describe("spatial hierarchy", () => {
  test("resolves a root-to-leaf path", async () => {
    const s = new SpatialAuthority();
    assert.deepEqual(unwrap(s.path("earth.in.br.patna")), ["sol", "earth", "earth.in", "earth.in.br", "earth.in.br.patna"]);
  });

  test("containment includes the node itself", async () => {
    const s = new SpatialAuthority();
    assert.equal(unwrap(s.contains("earth.in", "earth.in.br.patna")), true);
    assert.equal(unwrap(s.contains("earth.in", "earth.in")), true);
    assert.equal(unwrap(s.contains("earth.in", "earth.us.ny")), false);
    assert.equal(unwrap(s.contains("mars", "earth.in")), false);
  });

  test("jurisdiction walks up to the nearest declaration", async () => {
    const s = new SpatialAuthority();
    assert.equal(unwrap(s.jurisdictionOf("earth.in.br.patna.store-01")), "IN-BR");
    assert.equal(unwrap(s.jurisdictionOf("earth.in.mh.mumbai")), "IN-MH");
    assert.equal(unwrap(s.jurisdictionOf("sol")), undefined);
  });

  test("finds the nearest ancestor of a kind", async () => {
    const s = new SpatialAuthority();
    assert.equal(unwrap(s.ancestorOfKind("mars.olympus.sector-7", "body"))?.key, "mars");
    assert.equal(unwrap(s.ancestorOfKind("net.marketplace.app", "body")), undefined);
  });

  test("detects a cycle rather than looping forever", async () => {
    const nodes = spatialNodeRegistry()
      .register({ key: "a", label: "a", kind: "zone", parent: "b" })
      .register({ key: "b", label: "b", kind: "zone", parent: "a" });
    const s = new SpatialAuthority({ nodes });
    const result = s.path("a");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /cycle/);
  });

  test("reports an unknown node rather than treating it as a root", async () => {
    const s = new SpatialAuthority();
    assert.equal(s.path("earth.atlantis").ok, false);
  });
});

describe("scope evaluation", () => {
  const s = new SpatialAuthority();

  test("an empty include means everywhere", async () => {
    assert.equal(unwrap(s.evaluateScope({}, "mars.olympus")).inside, true);
  });

  test("exclude beats include, however specific the include", async () => {
    const scope = { include: ["earth.in.mh"], exclude: ["earth.in.mh.mumbai"] };
    assert.equal(unwrap(s.evaluateScope(scope, "earth.in.mh")).inside, true);
    const excluded = unwrap(s.evaluateScope(scope, "earth.in.mh.mumbai"));
    assert.equal(excluded.inside, false);
    assert.equal(excluded.excludedBy, "earth.in.mh.mumbai");
  });

  test("reports which include matched, for the trace", async () => {
    const verdict = unwrap(s.evaluateScope({ include: ["earth", "mars"] }, "earth.in.br.patna"));
    assert.equal(verdict.matchedBy, "earth");
  });

  test("virtual places sit outside the physical tree entirely", async () => {
    assert.equal(unwrap(s.contains("earth", "net.marketplace.app")), false);
    assert.equal(unwrap(s.contains("net.marketplace", "net.marketplace.app")), true);
  });
});
