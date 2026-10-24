import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { scaleNetworkObservation } from "./qualification/network-observation.mjs";
const request = (url, method = "GET", body = null) => ({ url: () => url, method: () => method, postDataBuffer: () => body });
test("bounded inventory preserves methods and byte counts without retaining request bodies", () => {
  const context = new EventEmitter(), observation = scaleNetworkObservation(context);
  context.emit("request", request("http://127.0.0.1/audio", "POST", Buffer.from("private-source-body")));
  const body = observation.serialize(true); assert.equal(body.includes("private-source-body"), false); assert.equal(JSON.parse(body).requests[0].bytes, 19); observation.assert(); observation.close();
  context.emit("request", request("http://127.0.0.1/after-close")); assert.equal(observation.requests.length, 1);
});
test("request-count overflow remains incomplete and fails instead of truncating to a privacy pass", () => {
  const context = new EventEmitter(), observation = scaleNetworkObservation(context);
  for (let index = 0; index < 1025; index++) context.emit("request", request("http://127.0.0.1/" + index));
  assert.equal(observation.requests.length, 1024); assert.throws(() => observation.assert(), /bound exceeded/u); assert.equal(JSON.parse(observation.serialize(true)).complete, false); observation.close();
});
test("serialized byte and URL bounds fail closed while publication remains bounded", () => {
  for (const url of ["http://127.0.0.1/" + "a".repeat(2048), "http://127.0.0.1/" + "a".repeat(1800)]) {
    const context = new EventEmitter(), observation = scaleNetworkObservation(context);
    for (let index = 0; index < 1024; index++) context.emit("request", request(url));
    assert.throws(() => observation.assert(), /bound exceeded/u); const body = observation.serialize(true); assert.ok(Buffer.byteLength(body) <= 544 * 1024); assert.equal(JSON.parse(body).complete, false); observation.close();
  }
});
