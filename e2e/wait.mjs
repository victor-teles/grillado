// Condition waits for the e2e suites, in place of fixed sleeps. They poll from Node, so a page clock
// (pg.clock.install) can't stall them.

/** Wait until `probe()` returns something truthy, and return it. */
export async function until(probe, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every finite animation and transition has finished (an endless one, like a live dot, doesn't count), two polls in a row. */
export async function quiet(pg, ms = 5000) {
  let calm = 0;
  await until(
    async () => {
      const busy = await pg.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime)).length);
      calm = busy ? 0 : calm + 1;
      return calm >= 2;
    },
    "animations to finish",
    ms,
  );
}
