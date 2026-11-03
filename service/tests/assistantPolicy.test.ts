import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyConfirmationAnswer,
  needsActionConfirmation,
} from "../src/assistantPolicy";

test("protects opening actions and bulk destructive actions", () => {
  assert.equal(needsActionConfirmation("Unlock the front door"), true);
  assert.equal(needsActionConfirmation("Open the garage"), true);
  assert.equal(needsActionConfirmation("Turn off all lights"), true);
  assert.equal(needsActionConfirmation("Turn off the bathroom light"), false);
  assert.equal(needsActionConfirmation("Is the garage door open?"), false);
});

test("confirmation answers must be unambiguous", () => {
  assert.equal(classifyConfirmationAnswer("yes"), "confirmed");
  assert.equal(classifyConfirmationAnswer("go ahead"), "confirmed");
  assert.equal(classifyConfirmationAnswer("don't"), "declined");
  assert.equal(classifyConfirmationAnswer("maybe"), "unclear");
});
