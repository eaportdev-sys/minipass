// Release-health helpers for the deploy gate. Pure functions - unit-testable.
//
// The gate polls container state; a crash-looping container can read as
// `running` when caught mid-iteration. Tracking the container StartedAt
// across polls closes that hole: any restart resets the steady streak, so
// only releases that stay up pass.
function steadyPoll(prev, curr) {
  if (!curr.size) return { steady: false };
  for (const [id, c] of curr) {
    if (!c || !c.running) return { steady: false };
    const p = prev.get(id);
    if (!p || !p.startedAt || p.startedAt !== c.startedAt) return { steady: false };
  }
  return { steady: true };
}

module.exports = { steadyPoll };
