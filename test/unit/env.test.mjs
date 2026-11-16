// Environment readers (src/env.ts): every boolean setting takes the same
// spellings, an unset MCPB placeholder means unset, and an unrecognised
// boolean or enum value is reported once, naming the variable, and falls back
// to the default.
import test from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv } from "../helpers/env.mjs";

hermeticEnv();
const lib = await import("../../server/lib.js");

/** Run `fn` with `vars` set (undefined deletes), restoring afterwards; returns
 * its result and the stderr lines it logged. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return { value: fn(), logged };
  } finally {
    console.error = error;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("bool: 1/true/yes/on and 0/false/no/off, case-insensitive, for every boolean setting", () => {
  for (const name of ["AMIRA_TEST_BOOL", "AMIRA_GUIDANCE", "AMIRA_SKILLS"]) {
    for (const [raw, expected] of [["1", true], ["TRUE", true], [" yes ", true], ["On", true], ["0", false], ["False", false], ["no", false], ["OFF", false]]) {
      assert.equal(withEnv({ [name]: raw }, () => lib.bool(name, !expected)).value, expected, `${name}=${raw}`);
    }
  }
  assert.equal(withEnv({ AMIRA_GUIDANCE: "false" }, () => lib.guidanceEnabled()).value, false, "AMIRA_GUIDANCE=false turns guidance off");
});

test("bool: unset, empty or an unsubstituted placeholder means the default, silently", () => {
  for (const raw of [undefined, "", "  ", "${user_config.live_refresh}"]) {
    for (const fallback of [true, false]) {
      const { value, logged } = withEnv({ AMIRA_TEST_UNSET: raw }, () => lib.bool("AMIRA_TEST_UNSET", fallback));
      assert.equal(value, fallback, JSON.stringify(raw));
      assert.deepEqual(logged, []);
    }
  }
});

test("bool and enumOf: an unrecognised value warns once, naming the variable, and falls back", () => {
  const first = withEnv({ AMIRA_TEST_TYPO: "ture" }, () => lib.bool("AMIRA_TEST_TYPO", false));
  assert.equal(first.value, false);
  assert.equal(first.logged.length, 1);
  assert.match(first.logged[0], /AMIRA_TEST_TYPO="ture"/);
  assert.equal(withEnv({ AMIRA_TEST_TYPO: "ture" }, () => lib.bool("AMIRA_TEST_TYPO", false)).logged.length, 0, "once per variable and value");

  const level = withEnv({ AMIRA_EXPOSURE: "minimial" }, () => lib.exposureLevel());
  assert.equal(level.value, "full");
  assert.equal(level.logged.length, 1);
  assert.match(level.logged[0], /AMIRA_EXPOSURE="minimial"/);
  assert.equal(withEnv({ AMIRA_EXPOSURE: "Minimal" }, () => lib.exposureLevel()).value, "minimal", "case-insensitive");
  assert.equal(withEnv({ AMIRA_EXPOSURE: "${user_config.exposure}" }, () => lib.exposureLevel()).value, "full");
});

test("nonNegative: a number, else the default", () => {
  for (const [raw, expected] of [["2.5", 2.5], ["0", 0], [" 7 ", 7], ["-1", 3], ["abc", 3], ["", 3], [undefined, 3], ["${user_config.n}", 3]]) {
    assert.equal(withEnv({ AMIRA_TEST_NUM: raw }, () => lib.nonNegative("AMIRA_TEST_NUM", 3)).value, expected, JSON.stringify(raw));
  }
});

test("envValue trims and treats the MCPB placeholder as unset", () => {
  assert.equal(withEnv({ AMIRA_TEST_VALUE: "  x  " }, () => lib.envValue("AMIRA_TEST_VALUE")).value, "x");
  assert.equal(withEnv({ AMIRA_TEST_VALUE: "${user_config.value}" }, () => lib.envValue("AMIRA_TEST_VALUE")).value, undefined);
  assert.equal(withEnv({ AMIRA_TEST_VALUE: "https://a/{b}" }, () => lib.envValue("AMIRA_TEST_VALUE")).value, "https://a/{b}");
});
