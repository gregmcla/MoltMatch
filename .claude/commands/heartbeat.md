# Run SkillLinker Heartbeat

Run a full heartbeat cycle and analyze the results.

```bash
npx ts-node src/index.ts heartbeat
```

After running, summarize:
1. How many posts were observed
2. How many matches were created
3. Whether a fallback post was generated (if no matches)
4. Any errors encountered

If there are errors, investigate the logs and suggest fixes.
