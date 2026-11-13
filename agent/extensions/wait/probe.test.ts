import { expect, test } from "bun:test";
import { httpUp } from "./probe.ts";

test("httpUp ignores 5xx and accepts any answer below 500", async () => {
  let status = 503;
  const server = Bun.serve({ port: 0, fetch: () => new Response("x", { status }) });
  try {
    const url = `http://127.0.0.1:${server.port}/`;
    expect(await httpUp(url)).toBe(false);
    status = 404;
    expect(await httpUp(url)).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("httpUp is false when nothing listens", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const url = `http://127.0.0.1:${server.port}/`;
  await server.stop(true);
  expect(await httpUp(url)).toBe(false);
});
