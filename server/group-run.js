// Runs a group action (FE-7). Sleep steps split the group into phases that run one after the other. Within a phase
// all steps start together, so e.g. "stop lower third, play coming next" happen at the same moment; only steps on
// the same entry run in their listed order (e.g. update, then play). A failing step does not stop the others.
export function groupPhases(steps) {
  const phases = [[]];
  for (const step of steps) {
    if (step.type === 'sleep') phases.push({ sleep: step.ms }, []);
    else phases.at(-1).push(step);
  }
  return phases.filter((phase) => !Array.isArray(phase) || phase.length);
}

export const stepLabel = (step) => ({ play: 'Play', stop: 'Stop', update: 'Update', custom: 'Custom action', sleep: 'Sleep' })[step.type] ?? step.type;

export async function runGroupAction(group, { entries, execute, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  const failures = [];
  let ran = 0;
  for (const phase of groupPhases(group.steps)) {
    if (!Array.isArray(phase)) { await sleep(phase.sleep); continue; }
    const chains = new Map();
    for (const step of phase) chains.set(step.entryId, [...(chains.get(step.entryId) ?? []), step]);
    await Promise.all([...chains.entries()].map(async ([entryId, steps]) => {
      const entry = byId.get(entryId);
      for (const step of steps) {
        ran += 1;
        try {
          if (!entry) throw new Error('the graphic is no longer in this rundown');
          await execute(entry, step);
        } catch (error) {
          failures.push({ step, entry, message: error.message });
        }
      }
    }));
  }
  return { ran, failures };
}
